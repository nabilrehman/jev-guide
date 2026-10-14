// The planner: an ADK agent (Gemini on Vertex/AI Studio, or Claude via OpenRouter) that turns one spoken request
// into a sequence of tool calls across Chrome and the Mac. Jev does the clicks
// inside each chrome_do / mac_do step.
import { LlmAgent, InMemoryRunner } from "@google/adk";
import { OpenRouterLlm } from "./openrouter_llm.js";
import { GeminiLlm } from "./gemini_llm.js";
import { buildTools } from "./tools.js";
import { TIME_ZONE } from "./scheduler.js";
import { createRouter, TIERS } from "./router.js";
import { createTaskStore } from "./tasks.js";

// Limits for one long task in total, across all its rounds. A task that hits one pauses and can be resumed.
const LONG_MAX_USD = Number(process.env.JEV_LONG_MAX_USD) || 5;
const LONG_MAX_MS = (Number(process.env.JEV_LONG_MAX_HOURS) || 8) * 3_600_000;
const LONG_MAX_IDLE = 3; // rounds in a row without save_progress before giving up

// Hard cap on planner calls per request, so a task that goes in circles can't drain credits.
// With the router, each tier has its own cap (router.js); this env var overrides all of them.
const MAX_LLM_CALLS = Number(process.env.JEV_AGENT_MAX_CALLS) || 0;

const INSTRUCTION = `You are Jev Guide, a voice assistant that operates the user's Mac for them.
The user speaks a request; it arrives as transcribed text (it may contain transcription slips, e.g. "Claw.i" for "claude.ai").

You have two sets of hands:
- chrome_* tools drive jev-guide's own Chrome window. It has its own profile, where the user logs in to sites once and stays logged in. Use it for anything on the web.
- mac_* tools drive whatever app is in front on the Mac (Notes, System Settings, Finder, the user's own Chrome, ...), through Accessibility.

How to work:
1. If the request refers to something on screen ("this file", "this page", "here"), look first: mac_read_screen shows what the user is looking at right now (including links with href=...). chrome_read_page shows the jev-guide Chrome page.
2. Plan the whole task, then carry it out step by step. Prefer direct tools over clicking: chrome_open_url instead of navigating by clicks, chrome_download with a URL instead of clicking a download link, chrome_attach_file instead of the Mac file picker, mac_open_app instead of hunting through the Dock.
3. chrome_do / mac_do take ONE simple, concrete step each ("click New Note", "click the message box"). You write any text that has to be typed (a question, a note, a search query) and pass it in \`text\`; Jev cannot write text itself.
4. After an important step, check the result (read the page or screen) before going on. If a step fails, try a different phrasing or approach once or twice, then stop and say what blocked you.
5. Signing in: when a site needs a login, sign in with the user's saved credentials. Click Sign in / Log in, click the username or email field, and pick the saved login the browser or macOS Passwords/Keychain offers (an autofill suggestion, a key icon, or a "Use password for…" prompt), then submit. Never type, read out, or guess a password yourself. If no saved login is offered, or a verification code, 2-step prompt, or CAPTCHA appears, stop and ask the user to finish that part, then continue when they say so.
6. Be economical: don't re-read the screen or page unless something changed, and stop after about 25 tool calls (a long task gives its own budget per round).
7. Never buy, pay, send money, delete data, or send messages/emails on the user's behalf unless they clearly asked for exactly that.
8. Timers and videos: when a page makes you wait (a countdown, a locked Next button, a video that has to finish), use chrome_wait instead of reading the page again and again. If a countdown shows the time left, wait that long; if a video is paused, start it first.
9. Quizzes and exercises: read the question and every option (chrome_read_page lists the choices and which one is selected), work out the answer, select it, submit, and read the feedback before going on. If it was wrong, use the explanation and try again.
10. A course or exam that certifies the user personally (for a court, a license or an official credential), or asks identity-verification questions, must be taken by the user: don't answer it for them; stop and hand it back.

When done, reply in one or two short spoken-style sentences: what you did, or the answer they asked for. Your reply is read aloud, so no markdown, lists or URLs.`;

// Screen/page reads are the bulk of the prompt and every one is re-sent on each later call.
// Once there's a newer read of the same kind, swap the old result for a short stub.
// New objects are built so the session history itself stays intact.
const READ_TOOLS = ["mac_read_screen", "chrome_read_page", "list_recent_files"];
function dropOldReads(request) {
  const contents = request.contents || [];
  const seen = new Set();
  for (let i = contents.length - 1; i >= 0; i--) {
    const parts = contents[i].parts || [];
    if (!parts.some((p) => READ_TOOLS.includes(p.functionResponse?.name))) continue;
    contents[i] = {
      ...contents[i],
      parts: parts.map((p) => {
        const name = p.functionResponse?.name;
        if (!READ_TOOLS.includes(name)) return p;
        if (!seen.has(name)) { seen.add(name); return p; }
        return { ...p, functionResponse: { ...p.functionResponse, response: { ok: true, note: "older result, superseded by a later call of the same tool" } } };
      }),
    };
  }
}

// One line per request showing where the time went: planner calls vs each tool.
function timingSummary(totalMs, calls, plannerMs, tools, cost, spent) {
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const pct = (ms) => `${Math.round((100 * ms) / Math.max(totalMs, 1))}%`;
  const toolMs = Object.values(tools).reduce((a, t) => a + t.ms, 0);
  const byTool = Object.entries(tools).sort((a, b) => b[1].ms - a[1].ms)
    .map(([name, t]) => `${name} ${t.n}× ${s(t.ms)}`).join(", ");
  const other = totalMs - plannerMs - toolMs;
  return `   ⏱ ${s(totalMs)} total · planner ${calls}× ${s(plannerMs)} (${pct(plannerMs)}) · tools ${s(toolMs)} (${pct(toolMs)})${byTool ? `: ${byTool}` : ""}`
    + `${other > 500 ? ` · other ${s(other)}` : ""} · $${cost.toFixed(3)} (run total $${spent.toFixed(3)})`;
}

export async function createOrchestrator(hands, { log = console.log } = {}) {
  // Gemini when a Cloud project or AI Studio key is set (JEV_AGENT_MODEL=anthropic/... forces OpenRouter).
  const useGemini = (process.env.JEV_AGENT_GCP_PROJECT || process.env.GEMINI_API_KEY) && !/\//.test(process.env.JEV_AGENT_MODEL || "");
  const appName = "jev_guide";
  const userId = "me";
  const makePlanner = (model) => {
    const agent = new LlmAgent({
      name: "jev_guide",
      description: "Operates the user's Mac and Chrome by voice.",
      model,
      instruction: INSTRUCTION,
      tools: buildTools(hands),
      beforeModelCallback: ({ request }) => { dropOldReads(request); },
    });
    return { model, runner: new InMemoryRunner({ agent, appName }) };
  };
  // Gemini: a Flash-Lite router sizes each request and picks the planner model for it.
  // OpenRouter: one fixed planner.
  const router = useGemini ? createRouter({ log: (m) => log(`   · ${m}`) }) : null;
  const planners = {}; // "model:thinking" -> planner, built on first use
  const fixed = useGemini ? null : makePlanner(new OpenRouterLlm({ log: (m) => log(`   · ${m}`) }));
  const totalSpent = () => (router?.spent || 0) + Object.values(planners).concat(fixed || []).reduce((a, p) => a + p.model.spent, 0);
  async function plannerFor(text) {
    if (!router) return { ...fixed, maxCalls: MAX_LLM_CALLS || 30, routeCost: 0 };
    const r = await router.route(text);
    const t = TIERS[r.tier];
    const key = `${t.model}:${t.thinking}`;
    planners[key] ||= makePlanner(new GeminiLlm({ model: t.model, thinking: t.thinking, log: (m) => log(`   · ${m}`) }));
    const maxCalls = MAX_LLM_CALLS || t.maxCalls;
    log(`🧭 ${r.tier} → ${t.model} · thinking ${t.thinking} · ≤${maxCalls} calls  (router ${r.ms}ms: ${r.reason})`);
    return { ...planners[key], tier: r.tier, maxCalls, routeCost: r.cost };
  }
  let abort = null;
  const recent = [];
  const tasks = createTaskStore();
  hands.tasks = tasks;
  const longPlanner = async () => {
    if (!router) return { ...fixed, maxCalls: MAX_LLM_CALLS || 30, routeCost: 0 };
    const t = TIERS.long;
    const key = `${t.model}:${t.thinking}`;
    planners[key] ||= makePlanner(new GeminiLlm({ model: t.model, thinking: t.thinking, log: (m) => log(`   · ${m}`) }));
    return { ...planners[key], tier: "long", maxCalls: MAX_LLM_CALLS || t.maxCalls, routeCost: 0 };
  };
  const waiting = tasks.unfinished();
  if (waiting.length) log(`📚 ${waiting.length} unfinished long task(s); say "resume" to continue: ${waiting.map((t) => `${t.id} "${t.goal.slice(0, 60)}"`).join(", ")}`);

  // One planner session, start to finish. Returns its final reply text. With `roundEnd`, hitting
  // the call cap ends the session quietly instead of throwing (a long task's round is just over).
  async function runSession({ model, runner, maxCalls, routeCost = 0 }, prompt, { roundEnd = false } = {}) {
    abort = new AbortController();
    let reply = "";
    const t0 = Date.now();
    const before = { calls: model.calls, ms: model.ms, spent: model.spent };
    const started = new Map(); // functionCall id -> start time
    const tools = {}; // tool name -> { n, ms }
    const session = await runner.sessionService.createSession({ appName, userId });
    try {
      for await (const ev of runner.runAsync({
        userId, sessionId: session.id, abortSignal: abort.signal,
        runConfig: { maxLlmCalls: maxCalls },
        newMessage: { role: "user", parts: [{ text: prompt }] },
      })) {
        if (ev.errorMessage) throw new Error(ev.errorMessage);
        for (const p of ev.content?.parts || []) {
          if (p.functionCall) {
            const args = Object.entries(p.functionCall.args || {}).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 90)}`).join(" ");
            log(`🔧 ${p.functionCall.name} ${args}`);
            started.set(p.functionCall.id, Date.now());
            await hands.caption(`${p.functionCall.name.replace(/_/g, " ")}: ${Object.values(p.functionCall.args || {})[0] ?? ""}`.slice(0, 140), "working…");
          } else if (p.functionResponse) {
            const r = p.functionResponse.response || {};
            const ms = Date.now() - (started.get(p.functionResponse.id) ?? Date.now());
            const t = (tools[p.functionResponse.name] ||= { n: 0, ms: 0 });
            t.n++; t.ms += ms;
            log(`   ↳ ${p.functionResponse.name} ${(ms / 1000).toFixed(2)}s${r.ok === false ? ` ⚠ ${r.error || "step failed"}` : ""}`);
          } else if (p.text && ev.author === "jev_guide") {
            reply = p.text.trim();
          }
        }
        if (abort.signal.aborted) break;
      }
    } catch (e) {
      if (!(roundEnd && /Max number of llm calls/i.test(e.message))) throw e;
      log(`   · round used all ${maxCalls} planner calls`);
    } finally {
      abort = null;
      log(timingSummary(Date.now() - t0, model.calls - before.calls, model.ms - before.ms, tools, model.spent - before.spent + routeCost, totalSpent()));
    }
    return reply;
  }

  // A long task runs as a series of rounds, each a fresh planner session (so the prompt stays small)
  // that starts from the goal plus the planner's own saved progress notes. It ends when the planner
  // marks it finished or needs the user, or pauses on a stop, the time/cost limits, or rounds that
  // make no progress. Paused tasks keep their notes and can be resumed later.
  async function runLong(task, note = "") {
    const plan = await longPlanner();
    log(`📚 long task ${task.id} · ${plan.model.model} · ≤${plan.maxCalls} calls per round · limits $${LONG_MAX_USD}, ${LONG_MAX_MS / 3_600_000}h`);
    tasks.update(task, { status: "running", question: "", reason: "" });
    hands.longTask = task;
    let idle = 0;
    const pause = (reason) => { tasks.update(task, { status: "paused", reason }); return reason; };
    try {
      for (;;) {
        if (hands.stopped) return pause("Paused. Say resume when you want me to carry on.");
        if (task.spent >= LONG_MAX_USD) return pause(`Paused: this task has used its $${LONG_MAX_USD} limit. Say resume to give it more.`);
        if (task.ms >= LONG_MAX_MS) return pause(`Paused after ${Math.round(task.ms / 3_600_000)} hours. Say resume to keep going.`);
        task.saved = false;
        const spent0 = plan.model.spent, t0 = Date.now();
        const prompt = `Current local time: ${new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${TIME_ZONE}).

You are working on a long task in rounds. This is round ${task.rounds + 1}; you have up to ${plan.maxCalls} model calls in it, then a fresh round continues from your saved notes.
Goal: ${task.goal}
${task.progress ? `Your progress notes so far:\n${task.progress}` : "Nothing done yet: start from the beginning."}${note ? `\nThe user says: ${note}` : ""}

Look at where things stand now (the browser may still be on the page you left), then keep working toward the goal. Call save_progress after each unit you finish and before this round's calls run out. When the whole goal is done, call save_progress with finished=true; if you are blocked on the user, call it with needs_user. Then reply in one or two short sentences.`;
        note = "";
        let reply = "";
        try { reply = await runSession(plan, prompt, { roundEnd: true }); }
        catch (e) {
          if (hands.stopped || e.name === "AbortError") return pause("Paused. Say resume when you want me to carry on.");
          log(`   · round failed: ${e.message.split("\n")[0].slice(0, 160)}`);
        }
        tasks.update(task, { rounds: task.rounds + 1, spent: task.spent + plan.model.spent - spent0, ms: task.ms + Date.now() - t0 });
        if (task.status === "done") return reply || "All done.";
        if (task.status === "needs_user") return `I need you for this: ${task.question} Tell me when to resume.`;
        idle = task.saved ? 0 : idle + 1;
        log(`📚 round ${task.rounds} done · ${Math.round(task.ms / 60_000)} min · $${task.spent.toFixed(2)} · ${task.saved ? task.progress.split("\n")[0].slice(0, 140) : `no progress saved (${idle}/${LONG_MAX_IDLE})`}`);
        if (idle >= LONG_MAX_IDLE) return pause(`Paused: ${LONG_MAX_IDLE} rounds in a row made no progress.${reply ? ` Last: ${reply}` : ""}`);
      }
    } finally {
      hands.longTask = null;
    }
  }

  return {
    model: router ? `routed (${router.model} → ${Object.entries(TIERS).map(([k, t]) => `${k}: ${t.model}`).join(", ")})` : fixed.model.model,

    // Run one request to completion. Returns the agent's final reply text.
    // Each request gets a fresh session (screen dumps from old tasks would otherwise be
    // re-sent on every call and cost grows fast); a short note of recent requests keeps
    // follow-ups like "now put it in a note" working. Long requests run as rounds (runLong).
    async handle(text, { scheduled = false } = {}) {
      hands.stopped = false;
      hands.resumeTask = null;
      const plan = await plannerFor(text);
      let reply;
      if (plan.tier === "long") {
        reply = await runLong(tasks.create(text));
      } else {
        // The current time, so "tomorrow at 7" can be scheduled; no context for a scheduled run itself.
        const now = `Current local time: ${new Date().toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} (${TIME_ZONE}).\n\n`;
        const note = recent.length && !scheduled ? `Earlier requests in this conversation (for context only):\n${recent.map((r) => `- User: ${r.text}\n  You: ${r.reply}`).join("\n")}\n\nNew request: ` : "";
        reply = await runSession(plan, now + note + text);
        // resume_long_task was called: the task runs now, after the planner's reply.
        const resume = hands.resumeTask;
        hands.resumeTask = null;
        const task = resume && !hands.stopped && tasks.get(resume.id);
        if (task) reply = await runLong(task, resume.note);
      }
      recent.push({ text, reply: reply.slice(0, 300) || "(no reply)" });
      if (recent.length > 4) recent.shift();
      return reply;
    },

    stop() {
      hands.stopped = true;
      abort?.abort();
      hands.chromeRunner?.stop();
      hands.macRunner?.stop();
      hands.claudeChild?.kill("SIGTERM");
    },

    async reset() { recent.length = 0; },
  };
}
