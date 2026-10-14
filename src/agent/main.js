// jev-guide --agent: a Mac-wide voice assistant.
//   Voice (default, JEV_VOICE=live): hold right Option, speak, release → Gemini Live hears it,
//     acknowledges, and calls the planner as a background tool → speaks the result.
//   Classic (JEV_VOICE=classic): speech-to-text → planner → Gemini TTS reply.
//   Either way the planner (ADK, Gemini) drives chrome_* / mac_* tools and Jev picks each click.
// Also accepts typed requests in the terminal and the 🎤 button in jev-guide's Chrome.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { launchMac } from "../mac.js";
import { launchBrowser, HOME_URL } from "../browser.js";
import { createBrain } from "../brain.js";
import { loadSites } from "../sites.js";
import { Runner } from "../cli.js";
import { transcribeFile } from "../stt.js";
import { synthesize } from "../tts.js";
import { createOrchestrator } from "./orchestrator.js";
import { createLive } from "./live.js";
import { createScheduler } from "./scheduler.js";
import { createChat } from "./chat.js";

// Key codes: 61 right Option (default), 54 right Command, 62 right Control, 63 fn.
const PTT_KEYS = { right_option: 61, right_command: 54, right_control: 62, fn: 63 };
const PTT_NAMES = { 61: "right ⌥ Option", 54: "right ⌘ Command", 62: "right ⌃ Control", 63: "fn" };

export async function runAgent(opts) {
  const sites = loadSites();
  const recordingsDir = path.join(process.cwd(), "recordings");
  const brain = createBrain({ provider: "jev", sites, log: (m) => opts.verbose && console.log(`   · ${m}`) });
  const mac = await launchMac({ record: opts.record, recordingsDir });
  const installedApps = await mac.installedApps();
  const macRunner = new Runner({ driver: mac, brain, sites, maxSteps: opts.maxSteps, showSteps: true, mac: true });
  macRunner.installedApps = installedApps;

  let busy = false;
  let queue = Promise.resolve();
  let pending = 0;

  const hands = {
    mac, macRunner, installedApps,
    chromeRunner: null,
    _browser: null,
    async browser() {
      if (this._browser) return this._browser;
      const b = await launchBrowser({ record: opts.record, recordingsDir });
      if (b.page.url() === "about:blank") await b.goto(HOME_URL);
      this.chromeRunner = new Runner({ driver: b, brain, sites, maxSteps: opts.maxSteps, showSteps: true });
      b.onVoice = (text) => { console.log(`\n🗣  "${text}" (Chrome mic)`); request(text); };
      b.onVoiceStop = () => stop();
      b.closed.then(() => { if (this._browser === b) { this._browser = null; this.chromeRunner = null; } });
      this._browser = b;
      return b;
    },
    async caption(text, status = "") { await mac.setCaption(text, status); },
  };

  // Scheduled tasks run through the same queue as spoken ones (after whatever is running now).
  hands.scheduler = createScheduler({
    log: (m) => console.log(m),
    run: (job) => enqueue(`This is a scheduled task and its time has come, so do it now: ${job.task}`, { scheduled: true, label: `⏰ ${job.task}` }),
  });

  // Chat window: typed requests go straight to the planner (no voice reply); every request,
  // reply and step (voice ones too) shows up there.
  const chat = createChat({ onSend: (text) => enqueue(text, { speakReply: false }), onStop: () => stop() });
  const ACTIVITY = /^\s*(🧭|🔧|↳|⏰|· claude code|\d+\. )/;
  const consoleLog = console.log;
  console.log = (...a) => {
    consoleLog(...a);
    const line = a.join(" ").replace(/\x1b\[[0-9;]*m/g, "");
    if (ACTIVITY.test(line)) chat.post("activity", line.trim());
  };

  const agent = await createOrchestrator(hands);

  // Replies are voiced by Gemini TTS, falling back to macOS `say` if it fails. A newer reply
  // (or a stop) replaces one still being generated.
  let speaker = null;
  let speakSeq = 0;
  const speak = async (text) => {
    if (opts.quiet || !text) return;
    speaker?.kill();
    const seq = ++speakSeq;
    let file = null;
    try { file = await synthesize(text); } catch (e) { if (opts.verbose) console.log(`   · ${e.message}`); }
    if (seq !== speakSeq) return;
    speaker = file
      ? spawn("afplay", [file], { stdio: "ignore" }).on("exit", () => fs.rm(file, () => {}))
      : spawn("say", ["-r", "210", text], { stdio: "ignore" });
  };
  const hush = () => { speakSeq++; speaker?.kill(); };

  // Stop controls: floating button + menu bar item (helper), and the Chrome mic button.
  const showBusy = async (b) => { chat.setBusy(b); await mac.setBusy(b); await hands._browser?.setBusy(b); };

  const stop = () => {
    if (!busy) return;
    console.log("\n⏹  stop requested");
    agent.stop();
    hands.caption("Stopping…", "⏹");
  };

  // Runs one request through the planner, one at a time. Resolves with the outcome text.
  const enqueue = (text, { speakReply = true, scheduled = false, label = text } = {}) => {
    pending++;
    const run = queue.then(async () => {
      busy = true;
      await showBusy(true);
      hush();
      await mac.setStatus("⏳");
      // Start from whatever the user is looking at now, not the last app we drove.
      mac.targetApp = null;
      await mac.cmd({ op: "target", app: "" });
      await hands.caption(label, scheduled ? "scheduled task" : "thinking…");
      console.log(`\n🧠 ${text}`);
      chat.post("user", label);
      if (scheduled) speak(`Running your scheduled task: ${label.replace(/^⏰ /, "")}`);
      try {
        let reply = await agent.handle(text, { scheduled });
        if (hands.stopped) reply = "Stopped.";
        console.log(`${live ? "📋" : "💬"} ${reply || "(no reply)"}`);
        await hands.caption(reply || "Done", "✓");
        chat.post("reply", reply || "Done.");
        if (speakReply) speak(reply);
        return reply;
      } catch (e) {
        const msg = e.name === "AbortError" ? "Stopped."
          : /credits/i.test(e.message) ? "Your OpenRouter credits have run out. Add credits at openrouter.ai, then try again."
          : /spending cap|billing/i.test(e.message) ? "The Google AI Studio key has hit its spending cap. Raise it at ai.studio/billing, then try again."
          : /deadline|aborted|timed? ?out/i.test(e.message) ? "The planner took too long to answer. Please try again."
          : `Something went wrong: ${e.message}`;
        console.log(`✖ ${msg}`);
        chat.post("error", msg);
        await hands.caption(msg, "");
        if (speakReply) speak(msg);
        return msg;
      } finally {
        busy = false; pending--;
        await showBusy(pending > 0);
        await mac.setStatus(pending ? "⏳" : "🎤");
        setTimeout(() => { if (!busy) mac.setCaption("", ""); }, 6000);
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  // ---------- Gemini Live voice ----------
  let live = null;
  if ((process.env.JEV_VOICE || "live") !== "classic") {
    live = createLive({
      runTask: (request) => enqueue(request, { speakReply: false }),
      stopTask: () => stop(),
      play: (b64) => { mac.play(b64); },
      stopAudio: () => { mac.stopPlayback(); },
      onEvent: (ev) => {
        if (ev.heard) console.log(`\n🗣  "${ev.heard}"`);
        if (ev.said) console.log(`🔊 ${ev.said}`);
        if (ev.saying && !busy) mac.setCaption(ev.saying, "🔊");
      },
      log: (m) => console.log(`   · ${m}`),
    });
    try { await live.connect(); } catch (e) {
      console.log(`⚠ Gemini Live unavailable (${e.message}); using classic speech-to-text instead`);
      live = null;
    }
  }

  // ---------- push-to-talk ----------
  const key = PTT_KEYS[process.env.JEV_PTT_KEY] ?? (Number(process.env.JEV_PTT_KEY) || 61);
  mac.onEvent = async (ev) => {
    switch (ev.event) {
      case "mic": live?.audio(ev.data); break;
      case "ptt_start":
        hush();
        live?.beginTurn();
        await mac.setStatus("🔴");
        await mac.setCaption("Listening…", "release to send");
        break;
      case "ptt_tap":
        live?.cancelTurn();
        await mac.setStatus(busy ? "⏳" : "🎤");
        if (busy) stop(); else await mac.setCaption("", "");
        break;
      case "ptt_cancel":
        live?.cancelTurn();
        await mac.setStatus(busy ? "⏳" : "🎤");
        if (!busy) await mac.setCaption("", "");
        break;
      case "ptt_stop": {
        await mac.setStatus(busy ? "⏳" : "🎤");
        if (live) {
          if (!busy) await mac.setCaption("…", "");
          live.endTurn().catch((e) => console.log(`✖ Gemini Live: ${e.message}`));
          break;
        }
        await mac.setCaption("Transcribing…", "");
        let text = "";
        try {
          const t0 = Date.now();
          text = await transcribeFile(ev.file, { log: (m) => console.log(`   · ${m}`) });
          console.log(`\n🗣  "${text}"  (${Date.now() - t0}ms, ${(ev.ms / 1000).toFixed(1)}s audio)`);
        } catch (e) {
          console.log(`✖ speech-to-text: ${e.message}`);
          await mac.setCaption("Couldn't transcribe that", e.message.slice(0, 100));
        } finally { fs.rm(ev.file, () => {}); }
        // Saying "stop" / "cancel" stops the current task instead of queueing behind it.
        if (text && busy && /^\W*(?:(?:ok(?:ay)?|hey|please|no)[\s,]+)*(?:stop|cancel|halt|abort|never ?mind)\b/i.test(text)) stop();
        else if (text) enqueue(text);
        else if (!busy) setTimeout(() => mac.setCaption("", ""), 2500);
        break;
      }
      case "ptt_error": console.log(`✖ ${ev.error}`); await mac.setCaption(ev.error, ""); break;
      case "mic_permission": console.log(ev.granted ? "🎙  microphone allowed" : "✖ microphone permission denied: System Settings → Privacy & Security → Microphone"); break;
      case "stop": stop(); break;
      case "play_idle": if (!busy) setTimeout(() => { if (!busy) mac.setCaption("", ""); }, 4000); break;
      case "quit": await shutdown(); break;
      case "open_chat": chat.open(); break;
    }
  };
  const ptt = await mac.enablePushToTalk(key, { stream: !!live });
  await mac.setStatus("🎤");

  // If the helper ever dies, bring it back (hotkey, menu bar item) instead of hanging.
  let restarts = 0;
  mac.onExit = async () => {
    if (++restarts > 20) { console.log("✖ mac helper keeps exiting; giving up"); return; }
    agent.stop();
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await mac.start();
      await mac.enablePushToTalk(key, { stream: !!live });
      await mac.setStatus(busy ? "⏳" : "🎤");
      await mac.setBusy(busy);
      console.log("↻ mac helper restarted");
    } catch (e) { console.log(`✖ could not restart mac helper: ${e.message}`); }
  };

  // Typed and Chrome-mic requests: through Live when it's on (it answers out loud), else straight in.
  function request(text) {
    if (live) return live.sendText(text).catch((e) => console.log(`✖ Gemini Live: ${e.message}`));
    return enqueue(text);
  }

  async function shutdown() {
    hands.scheduler.stop();
    chat.close();
    agent.stop();
    hush();
    live?.close();
    await hands._browser?.close().catch(() => {});
    await mac.close().catch(() => {});
    process.exit(0);
  }
  process.on("SIGINT", shutdown);

  console.log(`\n🤖 Jev Guide agent · voice ${live ? `Gemini Live ${live.model} (${live.backend})` : "classic"} · planner ${agent.model} · clicks by Jev`);
  console.log(`🎙  Hold ${PTT_NAMES[key] ?? `key ${key}`} anywhere, speak, let go. Tap it while working to stop.${ptt.mic === "denied" ? "  ⚠ microphone access denied (System Settings → Privacy & Security → Microphone)" : ""}`);

  if (opts.instruction) {
    await enqueue(opts.instruction);
    return shutdown();
  }
  console.log(`💬 Chat window: click the tab at the bottom of the screen, or open ${chat.url}`);
  if (opts.app) return new Promise(() => {}); // menu bar "Quit Jev Guide" exits

  console.log("⌨️  Or type a request here. /reset forgets the conversation, /quit exits.\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "🎤 > " });
  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (text === "/quit" || text === "/exit") return shutdown();
    if (text === "/reset") { await agent.reset(); console.log("↺ new conversation"); rl.prompt(); return; }
    if (text) await request(text);
    rl.prompt();
  });
  rl.on("close", shutdown);
  return new Promise(() => {});
}
