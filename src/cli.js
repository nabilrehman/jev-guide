// jev-guide: say (or type) what to do; Chrome opens and clicks through it live.
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { loadEnv } from "./env.js";
import { launchBrowser, HOME_URL } from "./browser.js";
import { launchMac, HOTKEYS } from "./mac.js";
import { createBrain } from "./brain.js";
import { loadSites, extractUrls } from "./sites.js";
import { splitSteps, extractTextCandidates, classifyStepHint } from "./instructions.js";
import { voiceAvailable, recordAndTranscribe, listMics } from "./voice.js";

const HELP = `
jev-guide — voice/text driven live browser walkthroughs (Jev + real Chrome)

Usage:
  jev-guide [options] ["instruction ..."]

Options:
  --agent            Voice assistant for the whole Mac: hold right Option anywhere, speak, let go.
                     A planner (Gemini on Google Cloud) splits the task across Chrome and Mac apps;
                     Jev (via OpenRouter) does the clicks. Speech-to-text is Google Cloud Chirp 3.
  --quiet            (--agent) don't read replies aloud
  --mac              Control the whole Mac (any app) via Accessibility, not just Chrome
  --voice            Push-to-talk voice input (needs: brew install whisper-cpp ffmpeg)
  --record           Record the session to ./recordings/<timestamp>.mp4
  --start <url>      Open this URL first (default: keeps whatever tab is open / about:blank)
  --max-steps <n>    Max actions per instruction step (default 12)
  --lexical          Offline keyword matcher instead of Jev (smoke tests only)
  --list-mics        Print avfoundation audio devices and exit
  --app              No terminal prompt: voice button only; quits when the Chrome window closes
                     (used by the "Jev Guide" Mac app, see: npm run install-app)
  -h, --help

Interactive commands:  /quit   /record   /steps on|off   /url

Auth: put OPENROUTER_API_KEY=... or TYPESAFE_API_KEY=... in .env

Voice in the browser: click the blue mic button in Chrome (or press Option+Space), speak,
then click again or just stop talking. Click it while a command runs to stop it.

Zero-install voice: in text mode, press Fn twice (macOS Dictation) and speak into the prompt.
`;

function parseArgs(argv) {
  const o = { agent: false, quiet: false, verbose: false, app: false, voice: false, record: false, start: null, maxSteps: 12, lexical: false, mac: false, instruction: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--voice") o.voice = true;
    else if (a === "--agent") o.agent = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--app") o.app = true;
    else if (a === "--mac") o.mac = true;
    else if (a === "--record") o.record = true;
    else if (a === "--lexical") o.lexical = true;
    else if (a === "--list-mics") { listMics(); process.exit(0); }
    else if (a === "--start") o.start = argv[++i];
    else if (a === "--max-steps") o.maxSteps = Number(argv[++i]) || 12;
    else if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
    else o.instruction.push(a);
  }
  o.instruction = o.instruction.join(" ").trim();
  return o;
}

export async function main(argv) {
  loadEnv();
  const opts = parseArgs(argv);
  if (opts.agent) return (await import("./agent/main.js")).runAgent(opts);
  const sites = loadSites();
  const brain = createBrain({ provider: opts.lexical ? "lexical" : "jev", sites, log: (m) => console.log(`   · ${m}`) });

  if (opts.voice && !voiceAvailable().ok) {
    console.log("⚠ --voice needs whisper.cpp + ffmpeg:  brew install whisper-cpp ffmpeg   (falling back to text; tip: macOS Dictation works in the prompt)");
    opts.voice = false;
  }

  const recordingsDir = path.join(process.cwd(), "recordings");
  let driver;
  if (opts.mac) {
    driver = await launchMac({ record: opts.record, recordingsDir });
    console.log(`\n🖥  Mac mode: I will drive whatever app is in front (never the terminal). Say e.g. "open notes, then create a new note, then type hello".`);
  } else {
    driver = await launchBrowser({ record: opts.record, recordingsDir });
    console.log(`\n🌐 Chrome is up${opts.record ? " (recording)" : ""}. Profile: ~/.jev-guide/chrome-profile (log in to Google once; it persists).`);
    console.log(`🎙  Voice: click the blue mic in Chrome (or ⌥Space), say what to do, click again to send.`);
  }
  if (opts.start) await driver.goto(opts.start);
  else if (!opts.mac && driver.page.url() === "about:blank") await driver.goto(HOME_URL);

  const runner = new Runner({ driver, brain, sites, maxSteps: opts.maxSteps, showSteps: true, mac: opts.mac });
  if (opts.mac) runner.installedApps = await driver.installedApps();

  // Typed and spoken commands share one queue so they never drive Chrome at the same time.
  let queue = Promise.resolve();
  let pending = 0;
  const enqueue = (text) => {
    pending++;
    queue = queue.then(async () => {
      await driver.setBusy?.(true);
      try { await runner.run(text); } catch (e) { console.log(`✖ ${e.message}`); }
      finally { pending--; await driver.setBusy?.(pending > 0); }
    });
    return queue;
  };

  if (opts.app && !opts.mac) {
    // Launched from the Dock/Spotlight: there is no terminal, so the mic button is the only input.
    driver.onVoice = (text) => { console.log(`🗣  "${text}"`); enqueue(text); };
    driver.onVoiceStop = () => { if (pending) runner.stop(); };
    await driver.closed;
    await queue.catch(() => {});
    process.exit(0);
  }

  if (opts.instruction) {
    await enqueue(opts.instruction);
    await finish(driver, opts.record);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  driver.onVoice = (text) => {
    console.log(`\n🗣  "${text}"${pending ? "  (queued)" : ""}`);
    enqueue(text).then(() => rl.prompt(true));
  };
  driver.onVoiceStop = () => {
    if (!pending) return;
    console.log("\n⏹  stop requested from the browser");
    runner.stop();
  };
  console.log(opts.voice ? "🎤 Voice mode: press Enter to start talking, Enter again to stop." : "⌨️  Type an instruction (or use macOS dictation). /quit to exit.\n");

  for (;;) {
    let text;
    if (opts.voice) {
      await ask("🎤 [Enter] to talk… ");
      process.stdout.write("● recording — [Enter] to stop ");
      text = await recordAndTranscribe(ask(""));
      console.log(`\n🗣  "${text}"`);
    } else {
      text = (await ask("🎤 > ")).trim();
    }
    if (!text) continue;
    if (text === "/quit" || text === "/exit") break;
    if (text === "/url") { console.log(driver.page.url()); continue; }
    if (text.startsWith("/steps")) { runner.showSteps = !/off/.test(text); continue; }
    if (text === "/record") { console.log("Recording can only be enabled at launch: restart with --record"); continue; }
    await enqueue(text);
  }
  rl.close();
  await finish(driver, opts.record);
}

async function finish(driver, record) {
  const videos = await driver.close();
  if (record && videos.length) {
    for (const v of videos) {
      if (!v.endsWith(".webm")) { console.log(`🎬 saved ${v}`); continue; }
      const mp4 = v.replace(/\.webm$/, ".mp4");
      try {
        execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", v, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
        fs.rmSync(v, { force: true });
        console.log(`🎬 saved ${mp4}`);
      } catch { console.log(`🎬 saved ${v} (install ffmpeg to get mp4)`); }
    }
  }
}

export class Runner {
  constructor({ driver, brain, sites, maxSteps = 12, showSteps = true, mac = false }) {
    Object.assign(this, { driver, brain, sites, maxSteps, showSteps, mac, installedApps: [], stopRequested: false });
  }

  stop() { this.stopRequested = true; }

  // Mac mode: apps the model may open (installed + running, capped), menus of the front app, hotkeys.
  async macContext(snap, focusWords) {
    if (!this.mac) return {};
    const running = (await this.driver.apps()).running.map((r) => r.name);
    const words = focusWords.map((w) => w.toLowerCase());
    const mentioned = this.installedApps.filter((a) => words.some((w) => w.length > 2 && a.toLowerCase().includes(w)));
    const apps = [...new Set([...mentioned, ...running, ...COMMON_APPS.filter((a) => this.installedApps.includes(a))])].slice(0, 30);
    const menus = (await this.driver.menus(300));
    const rankedMenus = menus.map((m) => ({ m, s: words.reduce((acc, w) => acc + (w.length > 2 && m.label.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.m);
    return { apps, menus: rankedMenus, hotkeys: HOTKEYS };
  }

  async run(instruction) {
    const steps = splitSteps(instruction);
    if (!steps.length) return;
    this.stopRequested = false;
    console.log(`\n📋 ${steps.length} step${steps.length > 1 ? "s" : ""}: ${steps.map((s, i) => `(${i + 1}) ${s}`).join("  ")}`);
    for (let i = 0; i < steps.length; i++) {
      const ok = await this.runStep(steps[i], steps, i);
      if (this.stopRequested) { console.log("⏹  stopped"); await this.driver.setCaption(instruction, "⏹ stopped"); return; }
      if (!ok) { console.log(`⚠ stopping: could not complete step ${i + 1}`); break; }
    }
    await this.driver.setCaption(instruction, "✓ done");
  }

  // One already-planned step (from the agent). No splitting on "then", and the text to
  // type is given explicitly instead of parsed out of quotes.
  async runOne(step, { text } = {}) {
    this.stopRequested = false;
    const ok = await this.runStep(step, [step], 0, { text });
    await this.driver.setCaption(step, this.stopRequested ? "⏹ stopped" : ok ? "✓ done" : "✖ could not finish");
    return ok && !this.stopRequested;
  }

  async runStep(step, allSteps, stepIndex, { text } = {}) {
    const d = this.driver;
    const textCandidates = text ? [text] : extractTextCandidates(step);
    const urls = extractUrls(step);
    const hints = classifyStepHint(step);
    const focusWords = step.split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 2);
    const history = [];
    console.log(`\n▶ Step ${stepIndex + 1}/${allSteps.length}: ${step}`);
    await d.setCaption(step, `step ${stepIndex + 1} of ${allSteps.length}`);
    let lastSig = "";
    let noopCount = 0;

    for (let n = 0; n < this.maxSteps; n++) {
      if (this.stopRequested) return false;
      const snap = await d.snapshot(this.mac ? 150 : 240, focusWords);
      const ctx = await this.macContext(snap, focusWords);
      const decision = await this.brain.decide({ step, allSteps, stepIndex, snapshot: snap, history, textCandidates, urls, hints, ...ctx });
      const sig = `${snap.url}|${snap.elements.length}|${snap.text.slice(0, 200)}`;

      const tgt = snap.elements.find((e) => e.id === decision.target);
      const describe = () => {
        if (decision.action === "click") return `click ${tgt?.kind ?? ""} "${tgt?.label ?? decision.target}"`;
        if (decision.action === "type") return `type "${decision.text}"${decision.target ? ` into "${tgt?.label || decision.target}"` : " (focused control)"}${decision.submit ? " + Enter" : ""}`;
        if (decision.action === "goto" || decision.action === "gotourl") return `go to ${decision.url}`;
        if (decision.action === "open_app") return `open app "${decision.appName}"`;
        if (decision.action === "hotkey") return `press ${decision.combo}`;
        return decision.action;
      };
      if (this.showSteps) console.log(`   ${n + 1}. ${describe()}  [p=${decision.confidence.toFixed(2)} goal=${decision.goal.toFixed(2)} stuck=${decision.stuck.toFixed(2)}]`);

      // Stop conditions (jev-browser thresholds): goal met, or model says done.
      if (decision.goal > 0.85 && (history.length > 0 || decision.action === "done" || /navigation/.test(hints.join()))) {
        console.log("   ✓ step complete"); return true;
      }
      if (decision.action === "done") {
        if (decision.goal >= 0.5) { console.log("   ✓ step complete"); return true; }
        // Model says "done" but does not believe the goal is met: usually a wall (login, consent, loading).
        if (await this.handleWall(snap)) { history.push({ n: n + 1, action: "waited for user (login/consent wall)", outcome: "ok" }); continue; }
        if (history.length > 0) { console.log("   ✖ model gave up (goal " + decision.goal.toFixed(2) + ")"); return false; }
      }
      if (!this.mac && isLoginWall(snap) && !/sign in|log ?in|password|email/i.test(step)) {
        if (await this.handleWall(snap)) { history.push({ n: n + 1, action: "waited for user login", outcome: "ok" }); continue; }
      }
      if (decision.stuck > 0.85 && history.length >= 2) { console.log("   ✖ stuck"); return false; }

      await d.setCaption(step, `→ ${describe()}`);
      let outcome = "ok";
      try {
        switch (decision.action) {
          case "click": await d.click(decision.target); break;
          case "type": await d.type(decision.target, decision.text, { submit: decision.submit }); break;
          case "goto": case "gotourl": await d.goto(decision.url); break;
          case "open_app": await d.openApp(decision.appName); break;
          case "hotkey": await d.hotkey(decision.combo); break;
          case "scroll_down": await d.scroll("down"); break;
          case "scroll_up": await d.scroll("up"); break;
          case "back": await d.back(); break;
          case "press_enter": await d.pressEnter(); break;
          case "wait": await d.page.waitForTimeout(1500); break;
          case "done": return true;
          default: outcome = "unknown action";
        }
      } catch (e) { outcome = `failed: ${e.message.split("\n")[0].slice(0, 120)}`; }

      const after = await d.snapshot(1, []);
      const changed = `${after.url}|${after.text.slice(0, 200)}` !== `${snap.url}|${snap.text.slice(0, 200)}`;
      if (!changed && decision.action !== "wait") noopCount++; else noopCount = 0;
      history.push({ n: n + 1, action: describe(), outcome, page_changed: changed, url_after: after.url });
      if (outcome !== "ok") console.log(`   ⚠ ${outcome}`);
      if (noopCount >= 3) { console.log("   ✖ no visible progress after 3 actions"); return false; }
      lastSig = sig;
    }
    console.log("   ⚠ max steps reached");
    return false;
  }

  // Login / consent walls: pause so the human can sign in inside the Chrome
  // window, then resume. The persistent profile remembers the session afterwards.
  async handleWall(snap) {
    if (!isLoginWall(snap)) return false;
    const d = this.driver;
    console.log("   🔐 Login page detected. Sign in inside the Chrome window; I'll continue when it moves on (up to 3 min).");
    await d.setCaption("Please sign in…", "waiting for you");
    const startUrl = snap.url;
    try {
      await d.page.waitForURL((u) => !isLoginUrl(u.toString()) && u.toString() !== startUrl, { timeout: 180000 });
    } catch { console.log("   ⚠ still on the login page"); return false; }
    await d.settle(1500);
    return true;
  }
}

const COMMON_APPS = ["Notes", "Safari", "Google Chrome", "Finder", "Mail", "Messages", "Calendar", "Reminders", "TextEdit", "Terminal", "System Settings", "Music", "Photos", "Preview", "Slack", "Zoom", "Spotify", "Notion", "Cursor", "Visual Studio Code"];
function isLoginUrl(u) { return /accounts\.google\.com|\/signin|\/login|\/sign_in|\/oauth|auth0|okta|\/sso\b|microsoftonline\.com/i.test(u); }
function isLoginWall(snap) {
  if (isLoginUrl(snap.url)) return true;
  const pw = snap.elements.some((e) => e.kind === "password field");
  return pw && /sign in|log in|password/i.test(snap.text);
}
