// Mac driver: same interface as the browser Driver, but the "page" is whatever
// app is in front. Eyes = Accessibility tree, hands = synthetic input, both via
// the compiled Swift helper (mac/axhelper). The real cursor moves, and a caption
// bar + red highlight ring are drawn as floating overlay windows.
import { spawn, execFile, execFileSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankElements } from "./browser.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_SRC = path.join(HERE, "..", "mac", "axhelper.swift");
const HELPER_BIN = path.join(HERE, "..", "mac", "axhelper");

// Apps we never want to drive (that's where the user is typing).
const HOST_APPS = new Set(["Terminal", "iTerm2", "iTerm", "Warp", "Alacritty", "kitty", "Ghostty", "Claude", "Code", "Cursor", "Hyper"]);

export const HOTKEYS = {
  save: { combo: "cmd+s", description: "Press Cmd+S to save the current document" },
  new_item: { combo: "cmd+n", description: "Press Cmd+N to create a new document/note/window/message" },
  new_tab: { combo: "cmd+t", description: "Press Cmd+T to open a new tab" },
  close_window: { combo: "cmd+w", description: "Press Cmd+W to close the current window or tab" },
  undo: { combo: "cmd+z", description: "Press Cmd+Z to undo" },
  find: { combo: "cmd+f", description: "Press Cmd+F to open find/search in the current app" },
  select_all: { combo: "cmd+a", description: "Press Cmd+A to select all" },
  copy: { combo: "cmd+c", description: "Press Cmd+C to copy the selection" },
  paste: { combo: "cmd+v", description: "Press Cmd+V to paste" },
  spotlight: { combo: "cmd+space", description: "Open Spotlight search" },
  escape: { combo: "escape", description: "Press Escape to dismiss a dialog/menu" },
  enter: { combo: "return", description: "Press Return/Enter to confirm" },
  quit_app: { combo: "cmd+q", description: "Press Cmd+Q to quit the current app" },
};

export function ensureHelper() {
  const stale = !fs.existsSync(HELPER_BIN) || fs.statSync(HELPER_BIN).mtimeMs < fs.statSync(HELPER_SRC).mtimeMs;
  if (stale) {
    console.log("⚙️  compiling mac/axhelper (first run) …");
    execFileSync("swiftc", ["-O", "-framework", "Cocoa", "-framework", "ApplicationServices", "-framework", "AVFoundation", HELPER_SRC, "-o", HELPER_BIN], { stdio: "inherit" });
  }
}

export async function launchMac({ record = false, recordingsDir } = {}) {
  ensureHelper();
  const d = new MacDriver();
  await d.start();
  if (record) d.startRecording(recordingsDir);
  return d;
}

export class MacDriver {
  constructor() { this.pending = new Map(); this.rid = 0; this.caption = { text: "", status: "" }; this.targetApp = null; this.recorder = null; }

  async start() {
    this.proc = spawn(HELPER_BIN, [], { stdio: ["pipe", "pipe", "inherit"] });
    const rl = readline.createInterface({ input: this.proc.stdout });
    const ready = new Promise((res) => (this.onReady = res));
    rl.on("line", (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready !== undefined) { this.trusted = msg.trusted; this.onReady(); return; }
      if (msg.event) { this.onEvent?.(msg); return; }
      const p = this.pending.get(msg.rid); if (p) { this.pending.delete(msg.rid); p(msg); }
    });
    this.dead = false;
    const proc = this.proc;
    proc.stdin.on("error", () => {}); // writing to a dead helper must not crash node
    proc.on("exit", (code, signal) => {
      if (proc !== this.proc) return;
      this.dead = true;
      for (const p of this.pending.values()) p({ error: "helper exited" });
      this.pending.clear();
      if (!this.closing) { console.log(`⚠ mac helper exited (code ${code}, signal ${signal}) at ${new Date().toLocaleTimeString()}`); this.onExit?.(code, signal); }
    });
    await ready;
    if (!this.trusted) {
      await this.cmd({ op: "check", prompt: true });
      throw new Error("Accessibility permission is required. macOS just asked (or: System Settings → Privacy & Security → Accessibility → turn on Jev Guide (or your terminal app, when run from a terminal)), then open it again.");
    }
  }

  cmd(obj, timeoutMs = 30000) {
    if (this.dead) return Promise.resolve({ error: "helper not running" });
    return new Promise((res) => {
      const rid = ++this.rid;
      const timer = setTimeout(() => { if (this.pending.delete(rid)) res({ error: `helper timed out on ${obj.op}` }); }, timeoutMs);
      this.pending.set(rid, (msg) => { clearTimeout(timer); res(msg); });
      this.proc.stdin.write(JSON.stringify({ ...obj, rid }) + "\n");
    });
  }

  async close() {
    this.closing = true;
    await this.cmd({ op: "caption", text: "", status: "" });
    await this.cmd({ op: "quit" }).catch(() => {});
    return this.stopRecording();
  }

  // ---------- recording (whole screen) ----------
  startRecording(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `mac-${new Date().toISOString().replace(/[:.]/g, "-")}.mov`);
    this.recorder = { proc: spawn("screencapture", ["-v", "-x", file], { stdio: ["ignore", "ignore", "inherit"] }), file };
    console.log(`🎬 recording screen → ${file}  (needs Screen Recording permission for your terminal)`);
  }
  async stopRecording() {
    if (!this.recorder) return [];
    const { proc, file } = this.recorder;
    proc.kill("SIGINT");
    await new Promise((r) => proc.on("exit", r));
    return fs.existsSync(file) ? [file] : [];
  }

  // ---------- overlay ----------
  async setCaption(text, status = "") { this.caption = { text, status }; await this.cmd({ op: "caption", text, status }); }
  async applyCaption() {}

  // Hold-to-talk anywhere on the Mac + a menu bar item. Events arrive via onEvent.
  // stream: mic audio arrives as "mic" events instead of a WAV file at release (Gemini Live).
  async enablePushToTalk(keyCode, { stream = false } = {}) { return this.cmd({ op: "ptt", key: keyCode, stream }); }
  play(b64) { return this.cmd({ op: "play", data: b64 }); } // 24 kHz mono 16-bit PCM
  stopPlayback() { return this.cmd({ op: "play_stop" }); }
  async setStatus(title) { return this.cmd({ op: "status", title }); }
  async setBusy(busy) { return this.cmd({ op: "busy", busy }); }

  // ---------- app focus ----------
  async apps() { return this.cmd({ op: "apps" }); }
  async installedApps() {
    const names = new Set();
    for (const dir of ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(process.env.HOME || "", "Applications")]) {
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".app")) names.add(f.slice(0, -4)); } catch {}
    }
    return [...names].sort();
  }
  async openApp(name) {
    await new Promise((res, rej) => execFile("open", ["-a", name], (e) => (e ? rej(new Error(`could not open ${name}`)) : res())));
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      const a = await this.apps();
      const hit = a.running.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (hit) { await this.cmd({ op: "target", app: hit.name }); this.targetApp = hit.name; break; }
    }
    await sleep(900);
  }
  async goto(url) {
    await new Promise((res, rej) => execFile("open", [url], (e) => (e ? rej(new Error("could not open url")) : res())));
    await sleep(2500);
    const a = await this.apps();
    if (a.frontmost && !HOST_APPS.has(a.frontmost)) { this.targetApp = a.frontmost; await this.cmd({ op: "target", app: a.frontmost }); }
  }
  async ensureTarget() {
    const a = await this.apps();
    if (this.targetApp && a.running.some((r) => r.name === this.targetApp)) {
      if (a.frontmost !== this.targetApp) await this.cmd({ op: "target", app: this.targetApp });
      return;
    }
    if (a.frontmost && !HOST_APPS.has(a.frontmost)) { this.targetApp = a.frontmost; await this.cmd({ op: "target", app: a.frontmost }); return; }
    // The terminal is in front: fall back to the most useful non-host app.
    const pick = a.running.find((r) => !HOST_APPS.has(r.name) && r.name !== "Finder") || a.running.find((r) => r.name === "Finder");
    if (pick) { this.targetApp = pick.name; await this.cmd({ op: "target", app: pick.name }); }
  }

  // ---------- observation ----------
  async snapshot(maxElements = 240, focusWords = []) {
    await this.ensureTarget();
    const s = await this.cmd({ op: "snapshot", max: 1500 });
    if (s.error) return { url: "", title: "", elements: [], text: "", truncated: false, app: "" };
    const ranked = rankElements(s.elements, focusWords).slice(0, maxElements);
    return { url: `app:${s.app}`, title: `${s.app}${s.window ? " — " + s.window : ""}`, app: s.app, elements: ranked, text: s.text, truncated: s.elements.length > ranked.length };
  }
  async menus(max = 120) { const m = await this.cmd({ op: "menus", max }); return m.items || []; }

  // ---------- actions ----------
  async click(id) {
    const r = await this.cmd({ op: "press", id });
    if (r.error) throw new Error(r.error);
    await this.settle();
  }
  async type(id, text, { submit = false } = {}) {
    if (id) { const r = await this.cmd({ op: "focus", id }); if (r.error) throw new Error(r.error); await sleep(150); }
    // Long text is pasted (a 190-character prompt took 5.3 s to type); short text is typed so it
    // still looks like typing on screen.
    const t = await this.cmd(text.length > 40 && !text.includes("\n") ? { op: "paste", text } : { op: "type", text, delay: 28 });
    if (t.error) throw new Error(t.error);
    if (submit) await this.cmd({ op: "key", combo: "return" });
    await this.settle();
  }
  async hotkey(combo) { const r = await this.cmd({ op: "key", combo }); if (r.error) throw new Error(r.error); await this.settle(); }
  async pressEnter() { await this.hotkey("return"); }
  async scroll(dir) { await this.cmd({ op: "scroll", lines: dir === "up" ? 10 : -10 }); await sleep(400); }
  async back() { await this.hotkey("cmd+["); }
  async settle(ms = 700) { await sleep(ms); }
  get page() { return { url: () => `app:${this.targetApp ?? ""}`, waitForTimeout: sleep, waitForURL: async () => { throw new Error("n/a"); } }; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
