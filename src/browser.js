// Real Chrome via Playwright: element discovery (pierces shadow DOM), visible
// cursor + highlight before every click, captions, optional video recording.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OVERLAY_INIT } from "./overlay.js";

const VIEWPORT = { width: 1440, height: 900 };
// Start page served by Playwright itself (never hits the network). It has to be
// https: speech recognition needs a secure context, and about:blank isn't one.
export const HOME_URL = "https://jev-guide.local/";
const HOME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>jev-guide</title>
<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
font:18px/1.5 -apple-system,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#202124}
h1{font-size:34px;margin:0 0 8px}p{margin:4px 0;color:#5f6368}kbd{background:#fff;border:1px solid #ccc;border-radius:4px;padding:1px 6px}</style>
</head><body><h1>jev-guide</h1><p>Click the blue 🎤 button (bottom-right) or press <kbd>⌥ Option</kbd>+<kbd>Space</kbd>, then say what to do.</p>
<p>e.g. “go to google cloud console, then click on billing”</p><p>Click the mic again (or just stop talking) to send.</p></body></html>`;

export async function launchBrowser({ record = false, recordingsDir, profileDir } = {}) {
  profileDir ??= path.join(os.homedir(), ".jev-guide", "chrome-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  if (record) fs.mkdirSync(recordingsDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chrome",
    headless: false,
    viewport: VIEWPORT,
    // --use-fake-ui-for-media-stream auto-accepts Chrome's mic prompt for the voice button.
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", "--use-fake-ui-for-media-stream"],
    ignoreDefaultArgs: ["--enable-automation"],
    recordVideo: record ? { dir: recordingsDir, size: VIEWPORT } : undefined,
  });
  await context.grantPermissions(["microphone"]).catch(() => {});
  await context.route(HOME_URL + "**", (route) => route.fulfill({ contentType: "text/html", body: HOME_HTML }));
  await context.addInitScript(OVERLAY_INIT);
  const page = context.pages()[0] ?? (await context.newPage());
  const driver = new Driver(context, page);
  // Voice button in the overlay -> Node. Bindings survive navigation and new tabs.
  await context.exposeBinding("__jevVoiceSubmit", (_src, text) => driver.onVoice?.(String(text || "")));
  await context.exposeBinding("__jevVoiceStop", () => driver.onVoiceStop?.());
  return driver;
}

export class Driver {
  constructor(context, page) {
    this.context = context;
    this.page = page;
    this.caption = { text: "", status: "" };
    this.busy = false;
    this.onVoice = null;      // (text) => void, set by the CLI
    this.onVoiceStop = null;
    this.closed = new Promise((r) => context.on("close", r));
    // Chrome on macOS keeps running after its last window closes; treat that as quitting.
    const watch = (p) => p.on("close", () => { if (!context.pages().length) context.close().catch(() => {}); });
    context.pages().forEach(watch);
    context.on("page", watch);
    // Follow new tabs (target=_blank links) so the walkthrough continues there.
    context.on("page", async (p) => {
      this.page = p;
      try { await p.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch {}
      await this.applyCaption();
    });
  }

  async close() {
    const videos = [];
    for (const p of this.context.pages()) {
      const v = p.video();
      if (v) videos.push(v);
    }
    await this.context.close();
    const paths = [];
    for (const v of videos) { try { paths.push(await v.path()); } catch {} }
    return paths;
  }

  // ---------- overlay ----------
  async setCaption(text, status = "") {
    this.caption = { text, status };
    await this.applyCaption();
  }
  async applyCaption() {
    const { text, status } = this.caption;
    await this.safeEval((a) => { window.__jev?.setCaption(a.text, a.status); window.__jev?.setBusy(a.busy); }, { text, status, busy: this.busy });
  }
  async setBusy(busy) {
    this.busy = busy;
    await this.safeEval((b) => window.__jev?.setBusy(b), busy);
  }
  async safeEval(fn, arg) {
    try { return await this.page.evaluate(fn, arg); } catch { return undefined; }
  }

  // ---------- navigation ----------
  async goto(url) {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await this.settle();
  }
  async back() { await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {}); await this.settle(); }
  async scroll(dir) {
    await this.page.mouse.wheel(0, dir === "up" ? -600 : 600);
    await this.page.waitForTimeout(500);
  }
  async settle(ms = 900) {
    try { await this.page.waitForLoadState("domcontentloaded", { timeout: 10000 }); } catch {}
    await this.page.waitForTimeout(ms);
    await this.applyCaption();
  }

  // ---------- observation ----------
  async snapshot(maxElements = 240, focusWords = []) {
    await this.safeEval(() => window.__jev && 0);
    const raw = await this.page.evaluate(collectElements).catch(() => []);
    const ranked = rankElements(raw, focusWords).slice(0, maxElements);
    const text = await this.page.evaluate(() => (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 1500)).catch(() => "");
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      elements: ranked,
      truncated: raw.length > ranked.length,
      text,
    };
  }

  // ---------- actions ----------
  locator(id) { return this.page.locator(`[data-jev-id="${id}"]`).first(); }

  async pointAt(id) {
    const loc = this.locator(id);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    const box = await loc.boundingBox();
    if (!box) return null;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await this.safeEval((b) => { window.__jev?.highlight(b); window.__jev?.moveTo(b.x + b.width / 2, b.y + b.height / 2); }, box);
    await this.page.mouse.move(x, y, { steps: 12 });
    await this.page.waitForTimeout(650);
    return { x, y, box };
  }

  async click(id) {
    const pt = await this.pointAt(id);
    if (!pt) throw new Error("element not visible");
    await this.safeEval((p) => window.__jev?.clickFx(p.x, p.y), pt);
    try {
      await this.page.mouse.click(pt.x, pt.y);
    } catch {
      await this.locator(id).click({ timeout: 5000, force: true });
    }
    await this.safeEval(() => window.__jev?.highlight(null));
    await this.settle();
  }

  async type(id, text, { submit = false } = {}) {
    const pt = await this.pointAt(id);
    if (pt) await this.page.mouse.click(pt.x, pt.y).catch(() => {});
    const loc = this.locator(id);
    await loc.focus().catch(() => {});
    await this.page.keyboard.press("Meta+A").catch(() => {});
    // Long text (e.g. a question the agent wrote) is inserted at once; short text is typed visibly.
    if (text.length > 60 || text.includes("\n")) await this.page.keyboard.insertText(text);
    else await this.page.keyboard.type(text, { delay: 35 });
    if (submit) await this.page.keyboard.press("Enter");
    await this.safeEval(() => window.__jev?.highlight(null));
    await this.settle();
  }

  async pressEnter() { await this.page.keyboard.press("Enter"); await this.settle(); }

  // ---------- agent tools ----------
  // Page text + links (with real hrefs) so the planner can resolve "this file" to a URL.
  async readPage(maxText = 6000) {
    const info = await this.page.evaluate((max) => {
      const links = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const text = (a.innerText || a.getAttribute("aria-label") || a.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const href = a.href;
        if (!href || href.startsWith("javascript")) continue;
        const r = a.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        links.push({ text, href });
        if (links.length >= 80) break;
      }
      // Buttons and choices with their state, so the planner can tell a locked Next button
      // or which quiz answer is picked.
      const controls = [];
      for (const el of document.querySelectorAll('button,input[type=submit],input[type=button],input[type=radio],input[type=checkbox],[role=button],[role=radio],[role=checkbox],[role=option]')) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const lab = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        // Radios/checkboxes take their text from a label; their value is often just "on".
        const label = (el.getAttribute("aria-label") || lab?.innerText || el.closest("label")?.innerText || el.innerText || (el.tagName === "INPUT" && !/radio|checkbox/.test(el.type) ? el.value : "") || "").replace(/\s+/g, " ").trim().slice(0, 80);
        if (!label) continue;
        const state = [];
        if (el.disabled || el.getAttribute("aria-disabled") === "true") state.push("disabled");
        if (el.checked || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true") state.push("selected");
        const kind = el.type === "radio" || el.getAttribute("role") === "radio" ? "choice" : el.type === "checkbox" || el.getAttribute("role") === "checkbox" ? "checkbox" : "button";
        controls.push(`${kind}: ${label}${state.length ? ` (${state.join(", ")})` : ""}`);
        if (controls.length >= 60) break;
      }
      return {
        text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, max),
        links,
        controls,
        file_inputs: document.querySelectorAll('input[type="file"]').length,
      };
    }, maxText).catch(() => ({ text: "", links: [], controls: [], file_inputs: 0 }));
    const media = await this.mediaState();
    return { url: this.page.url(), title: await this.page.title().catch(() => ""), ...info, ...(media.length ? { media } : {}) };
  }

  // Videos/audio on the page, including embedded players in other-origin iframes.
  async mediaState() {
    const out = [];
    for (const f of this.page.frames()) {
      const m = await f.evaluate(() => [...document.querySelectorAll("video,audio")].filter((v) => v.duration || v.currentSrc).map((v) => ({
        kind: v.tagName.toLowerCase(), position_s: Math.round(v.currentTime), duration_s: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
        state: v.ended ? "ended" : v.paused ? "paused" : "playing",
      }))).catch(() => []);
      out.push(...m);
    }
    return out;
  }

  // Wait until a condition holds on the page, or up to `seconds`. Polls every 2s; `isStopped`
  // lets the user's stop end the wait early. Returns what happened.
  async waitFor({ seconds = 60, text, gone, enabled, media_ended } = {}, isStopped = () => false) {
    const t0 = Date.now();
    const limit = Math.min(Math.max(seconds, 1), 900) * 1000;
    const check = async () => {
      if (text && !(await this.page.getByText(text, { exact: false }).first().isVisible().catch(() => false))) return false;
      if (gone && (await this.page.getByText(gone, { exact: false }).first().isVisible().catch(() => false))) return false;
      if (enabled) {
        const loc = this.page.getByRole("button", { name: enabled }).or(this.page.getByRole("link", { name: enabled })).first();
        if (!(await loc.isVisible().catch(() => false)) || !(await loc.isEnabled().catch(() => false))) return false;
        if ((await loc.getAttribute("aria-disabled").catch(() => null)) === "true") return false;
      }
      if (media_ended) {
        const m = await this.mediaState();
        if (m.length && m.some((v) => v.state !== "ended")) return false;
      }
      return true;
    };
    const hasCondition = !!(text || gone || enabled || media_ended);
    while (Date.now() - t0 < limit) {
      if (isStopped()) return { met: false, stopped: true, waited_s: Math.round((Date.now() - t0) / 1000) };
      if (hasCondition && (await check())) return { met: true, waited_s: Math.round((Date.now() - t0) / 1000) };
      await this.page.waitForTimeout(Math.min(2000, limit - (Date.now() - t0)));
    }
    return { met: !hasCondition, timed_out: hasCondition, waited_s: Math.round((Date.now() - t0) / 1000) };
  }

  // Fetch a URL with this browser's cookies and save it to ~/Downloads. Works for PDFs
  // too (clicking a PDF link would just open Chrome's viewer).
  async downloadUrl(url, dir = path.join(os.homedir(), "Downloads")) {
    const res = await this.context.request.get(url, { timeout: 60000 });
    if (!res.ok()) throw new Error(`download failed: HTTP ${res.status()}`);
    const cd = res.headers()["content-disposition"] || "";
    let name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i) || [])[1] || "");
    if (!name) name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "download");
    name = name.replace(/[\/:*?"<>|]+/g, "_").slice(0, 150);
    const type = res.headers()["content-type"] || "";
    if (!path.extname(name) && /pdf/.test(type)) name += ".pdf";
    fs.mkdirSync(dir, { recursive: true });
    let file = path.join(dir, name);
    for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, `${path.basename(name, path.extname(name))} (${i})${path.extname(name)}`);
    const body = await res.body();
    fs.writeFileSync(file, body);
    return { path: file, bytes: body.length, content_type: type };
  }

  // Hand a local file to the page's upload control, so the OS file picker never opens.
  // Uses the page's <input type=file> when there is one; otherwise clickAttach() must
  // click the site's attach button and we answer the file chooser it raises.
  async attachFile(file, clickAttach) {
    if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
    const input = this.page.locator('input[type="file"]');
    if (await input.count()) {
      await input.first().setInputFiles(file);
      await this.settle(1500);
      return { how: "file input" };
    }
    if (!clickAttach) throw new Error("this page has no file upload control");
    const chooser = this.page.waitForEvent("filechooser", { timeout: 20000 });
    await clickAttach();
    await (await chooser).setFiles(file);
    await this.settle(1500);
    return { how: "file chooser" };
  }
}

// Runs inside the page. Pierces open shadow roots (GCP console uses them heavily).
function collectElements() {
  const SEL = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="searchbox"],[role="textbox"],[role="combobox"],[role="treeitem"],[contenteditable="true"],[onclick]';
  const out = [];
  let n = 0;
  const vw = window.innerWidth, vh = window.innerHeight;
  const seen = new Set();

  function labelOf(el) {
    const tryAttr = (a) => (el.getAttribute(a) || "").trim();
    const byId = tryAttr("aria-labelledby");
    if (byId) {
      const t = byId.split(/\s+/).map((i) => (el.getRootNode().getElementById?.(i) || document.getElementById(i))?.innerText || "").join(" ").trim();
      if (t) return t;
    }
    const cands = [tryAttr("aria-label"), (el.innerText || "").trim(), tryAttr("placeholder"), tryAttr("title"), tryAttr("alt"), tryAttr("name")];
    if (el.tagName === "INPUT" && ["submit", "button"].includes(el.type)) cands.unshift(el.value || "Submit");
    const img = el.querySelector?.("img[alt], svg[aria-label], [aria-label]");
    if (img) cands.push(img.getAttribute("alt") || img.getAttribute("aria-label") || "");
    if (el.tagName === "INPUT" && el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) cands.push(l.innerText); }
    const t = cands.find((c) => c && c.trim());
    return (t || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }
  function visible(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  }
  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "select") return "select";
    if (tag === "textarea" || role === "textbox" || role === "searchbox" || el.isContentEditable) return "text field";
    if (tag === "input") {
      if (["checkbox", "radio"].includes(type)) return type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "password") return "password field";
      if (type === "search") return "search box";
      return "text field";
    }
    if (role === "combobox") return "dropdown";
    if (role) return role;
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    return "clickable";
  }
  function walk(root) {
    const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of nodes) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (!el.matches || !el.matches(SEL)) continue;
      if (el.id && el.id.startsWith("__jev")) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      // Skip wrappers whose only purpose is to contain another interactive element.
      const inner = el.querySelector?.(SEL);
      if (inner && el.tagName !== "A" && el.tagName !== "BUTTON" && inner.getBoundingClientRect().width > 0) continue;
      const label = labelOf(el);
      if (!label && !["text field", "search box", "select", "dropdown"].includes(kindOf(el))) continue;
      const r = el.getBoundingClientRect();
      const id = "j" + ++n;
      el.setAttribute("data-jev-id", id);
      const kind = kindOf(el);
      const extra = [];
      if (el.tagName === "A") { const h = el.getAttribute("href") || ""; if (h && !h.startsWith("javascript") && h !== "#") extra.push("href=" + h.slice(0, 60)); }
      if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || el.checked) extra.push("selected");
      if (el.getAttribute("aria-expanded") === "true") extra.push("expanded");
      if (el.value && ["text field", "search box"].includes(kind)) extra.push("value=" + String(el.value).slice(0, 40));
      out.push({
        id, kind, label,
        extra: extra.join(", "),
        inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
        top: Math.round(r.top), left: Math.round(r.left),
      });
      if (out.length >= 2000) return;
    }
  }
  walk(document);
  return out;
}

// Keep the list under Jev's 255-choice limit: in-viewport first, then lexical
// overlap with the instruction, then document order.
export function rankElements(elements, focusWords) {
  const words = focusWords.map((w) => w.toLowerCase()).filter((w) => w.length > 2);
  const scored = elements.map((e, i) => {
    const l = (e.label + " " + e.extra).toLowerCase();
    let s = 0;
    for (const w of words) if (l.includes(w)) s += 3;
    if (e.inViewport) s += 2;
    if (["text field", "search box", "dropdown", "select"].includes(e.kind)) s += 1;
    return { e, s, i };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored.map((x) => x.e);
}
