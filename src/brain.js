// Decision layer. One Jev call per step: pick the next action from the page's
// real elements, and score "goal met" / "stuck" in parallel (jev-browser pattern).
// Jev never generates text: URLs come from the site catalog / transcript and
// typed text comes from candidates extracted from what you said.
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const NAV_ACTIONS = {
  scroll_down: "Scroll the page down to reveal more content",
  scroll_up: "Scroll the page up",
  back: "Go back to the previous page",
  wait: "Do nothing this step; the page is still loading or an action just completed and needs time",
  done: "The step is already complete on the current page; nothing else needs to happen",
};

// Auth: TYPESAFE_API_KEY (direct) or OPENROUTER_API_KEY (Jev via OpenRouter).
export function makeClient() {
  if (process.env.TYPESAFE_API_KEY) return new TypeSafeClient({ timeout: 15000 });
  if (process.env.OPENROUTER_API_KEY) {
    return new TypeSafeClient({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api",
      defaultModel: process.env.JEV_MODEL || "jev-latest",
      timeout: 15000,
      defaultHeaders: { "HTTP-Referer": "https://github.com/jev-guide", "X-Title": "jev-guide" },
    });
  }
  throw new Error("No API key. Set TYPESAFE_API_KEY (console.typesafe.ai) or OPENROUTER_API_KEY in .env, or run with --lexical for an offline smoke test.");
}

export function createBrain({ provider = "jev", sites, log = () => {} }) {
  const client = provider === "jev" ? makeClient() : null;

  async function ask(state, questions) {
    if (client) {
      const t0 = Date.now();
      const res = await client.systemOne({ state, questions });
      log(`jev ${res.model} ${Date.now() - t0}ms · ${res.usage.input_tokens} tok`);
      return res.answers;
    }
    return lexicalAnswers(state, questions);
  }

  return {
    /**
     * Decide the next action for a step.
     * @returns {{action:string, target?:string, text?:string, submit?:boolean, goal:number, stuck:number, confidence:number, probabilities:object}}
     */
    async decide({ step, allSteps, stepIndex, snapshot, history, textCandidates, urls, hints, apps = [], menus = [], hotkeys = {} }) {
      const criteria = {};
      const BUDGET = 250; // Jev accepts at most 255 choices per question
      for (const a of apps) criteria["open_app_" + a.replace(/[^A-Za-z0-9]+/g, "_")] = `Open / switch to the macOS app "${a}"${a === snapshot.app ? " (already in front)" : ""}`;
      for (const m of menus) criteria["click_" + m.id] = `Choose menu item ${m.label}${m.shortcut ? " (⌘" + m.shortcut + ")" : ""}`;
      for (const [k, h] of Object.entries(hotkeys)) criteria["hotkey_" + k] = h.description;
      if (textCandidates.length && snapshot.app) criteria.type_focused = "Type into whatever control currently has keyboard focus (use when no text field is listed or after opening a new note/document)";
      for (const [k, s] of Object.entries(sites)) criteria["goto_" + k] = `Navigate the browser to ${s.description} (${s.url})`;
      urls.forEach((u, i) => (criteria["gotourl_" + i] = `Navigate the browser to the URL mentioned in the instruction: ${u}`));
      if (textCandidates.length) criteria.press_enter = "Press Enter to submit what was just typed";
      Object.assign(criteria, NAV_ACTIONS);
      for (const e of snapshot.elements) {
        if (Object.keys(criteria).length >= BUDGET - 1) break;
        const desc = `${e.kind}: "${e.label}"${e.extra ? " (" + e.extra + ")" : ""}${e.inViewport ? "" : " [off-screen]"}`;
        if (["text field", "search box", "password field", "text area", "combo box"].includes(e.kind)) {
          if (textCandidates.length) criteria["type_" + e.id] = "Type into " + desc;
          criteria["click_" + e.id] = "Click/focus " + desc;
        } else {
          criteria["click_" + e.id] = "Click " + desc;
        }
      }

      const state = {
        current_step_instruction: step,
        full_instruction_sequence: allSteps.map((s, i) => `${i + 1}. ${s}${i === stepIndex ? "   <-- current step" : ""}`),
        step_hints: hints,
        current_page: snapshot.app ? { frontmost_app: snapshot.app, window: snapshot.title } : { url: snapshot.url, title: snapshot.title },
        page_text_excerpt: snapshot.text,
        history_of_actions_taken_for_this_step: history.length ? history : "none yet",
        text_that_could_be_typed: textCandidates.length ? textCandidates : "none",
        note: "Prefer acting on the current page when the requested control is present. Use a goto_* action only when the instruction asks to open/go to a site and the page is not already there. Choose done only when the step is already satisfied.",
      };

      const questions = {
        action: choice("Which single action best advances the current step instruction on the current page?", criteria),
        goal_met: noul("Is the current step instruction already fully satisfied by what is on the current page (no further action needed)?"),
        stuck: noul("Do the previous actions for this step show no progress (repeating, looping, or the page not responding)?"),
      };
      if (textCandidates.length > 1) {
        const tc = {}; textCandidates.forEach((t, i) => (tc["t" + i] = t));
        questions.text = choice("Which text should be typed for this step?", tc);
      }
      if (textCandidates.length) {
        questions.submit = noul("After typing, should Enter be pressed to submit (e.g. a search or a form)?");
      }

      const a = await ask(state, questions);
      const act = a.action.choice;
      const out = {
        action: act, goal: a.goal_met.noul, stuck: a.stuck.noul,
        confidence: a.action.confidence, probabilities: a.action.probabilities,
      };
      const m = act.match(/^(click|type|goto|gotourl|open_app|hotkey)_(.+)$/);
      if (m) {
        out.action = m[1];
        out.target = m[2];
        if (m[1] === "open_app") out.appName = apps.find((a) => a.replace(/[^A-Za-z0-9]+/g, "_") === m[2]);
        if (m[1] === "hotkey") out.combo = hotkeys[m[2]]?.combo;
        if (m[1] === "type" && m[2] === "focused") out.target = null;
        if (m[1] === "goto") out.url = sites[m[2]]?.url;
        if (m[1] === "gotourl") out.url = urls[Number(m[2])];
        if (m[1] === "type") {
          out.text = textCandidates.length > 1 ? textCandidates[Number(a.text.choice.slice(1))] : textCandidates[0];
          out.submit = a.submit ? a.submit.noul > 0.5 : false;
        }
      }
      return out;
    },
  };
}

// Offline fallback so the pipeline can be exercised without an API key.
// Naive keyword overlap; it is NOT smart. Use --lexical only for smoke tests.
function lexicalAnswers(state, questions) {
  const instr = String(state.current_step_instruction).toLowerCase();
  const words = instr.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      let p = 0.05;
      if (name === "submit") p = /search|look up|enter/.test(instr) ? 0.9 : 0.2;
      if (name === "goal_met") {
        const url = String(state.current_page.url).toLowerCase();
        const hist = Array.isArray(state.history_of_actions_taken_for_this_step) ? state.history_of_actions_taken_for_this_step : [];
        if (hist.length > 0) p = 0.9;
        else if (/go to|open|navigate/.test(instr) && words.some((w) => url.includes(w))) p = 0.9;
      }
      if (name === "stuck") p = (Array.isArray(state.history_of_actions_taken_for_this_step) ? state.history_of_actions_taken_for_this_step.length : 0) >= 5 ? 0.9 : 0.05;
      answers[name] = { type: "noul", noul: p };
      continue;
    }
    const scores = {};
    for (const [label, desc] of Object.entries(q.criteria)) {
      const d = String(desc).toLowerCase();
      let s = 0;
      for (const w of words) if (d.includes(w)) s += 1 + w.length / 10;
      if (label.startsWith("goto_") && /go to|open|navigate|visit/.test(instr)) s += 0.5;
      if (label.startsWith("open_app_") && /open|launch|switch to/.test(instr)) s += 1;
      if (label.startsWith("hotkey_") && /save|undo|copy|paste|quit|close/.test(instr)) s += 1;
      if (label.startsWith("click_") && /click|press|tap|select|choose/.test(instr)) s += 0.5;
      if (label.startsWith("type_") && /type|enter|search|write|fill/.test(instr)) s += 1.5;
      if (["scroll_down", "scroll_up"].includes(label) && /scroll/.test(instr)) s += 5;
      if (label === "back" && /\bback\b/.test(instr)) s += 5;
      if (label === "done" || label === "wait") s -= 1;
      scores[label] = s;
    }
    const total = Object.values(scores).reduce((a, b) => a + Math.max(b, 0.001), 0);
    const probabilities = Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Math.max(v, 0.001) / total]));
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
    answers[name] = { type: "choice", choice: best, confidence: probabilities[best], probabilities };
  }
  return answers;
}
const STOP = new Set(["the", "and", "then", "click", "open", "goto", "into", "onto", "please", "that", "this", "for", "with", "page", "button", "link", "tab", "menu", "console", "site", "website"]);
