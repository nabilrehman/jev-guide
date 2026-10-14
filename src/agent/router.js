// Router: one cheap Flash-Lite call sizes each request (small / complex / large) before the
// planner runs, so quick jobs stay fast and cheap and only hard ones pay for a stronger model.
// Any failure falls back to the middle tier.
import { GoogleGenAI } from "@google/genai";

const ROUTER_MODEL = process.env.JEV_ROUTER_MODEL || "gemini-3.5-flash-lite";
const PRICE = [0.30, 2.50]; // USD per million tokens [input, output], gemini-3.5-flash-lite

// tier -> planner model, thinking level, planner-call cap. Override with e.g.
// JEV_TIER_COMPLEX="gemini-3.8-flash:HIGH:40".
const DEFAULT_TIERS = {
  small: "gemini-3.8-flash:LOW:15",
  complex: "gemini-3.1-pro-preview:LOW:30",
  large: "gemini-3.1-pro-preview:HIGH:60",
  // Per round: a long task runs as many rounds as it needs (orchestrator.js), so the cap is per round.
  long: "gemini-3.8-flash:LOW:40",
};
export const TIERS = Object.fromEntries(Object.entries(DEFAULT_TIERS).map(([tier, def]) => {
  const [model, thinking, calls] = (process.env[`JEV_TIER_${tier.toUpperCase()}`] || def).split(":");
  return [tier, { model, thinking: thinking || "LOW", maxCalls: Number(calls) || 30 }];
}));

const PROMPT = `You size requests for an assistant that operates a computer (apps, websites, files) for the user.
Pick the tier by how much work and judgment carrying out the request will take, not by how long the sentence is:
- small: one or two obvious actions in one place, or a simple question. Opening something, a single click or shortcut, reading what is on screen, saving a task for later.
- complex: several dependent steps in one app or site that need choices along the way: searching, filling a form, signing in, booking or buying something, finding and downloading a file.
- large: many steps across several apps or sites, research or comparison, multi-part requests, or work likely to need more than about 25 actions.
- long: open-ended work that goes on for a long time, unit after unit, likely hundreds of actions or more than about 20 minutes: working through a whole course or unit lesson by lesson, every item in a long list or queue, watching a series of videos.
Request:
`;

export function createRouter({ log = () => {} } = {}) {
  const project = process.env.JEV_AGENT_GCP_PROJECT;
  const ai = project
    ? new GoogleGenAI({ vertexai: true, project, location: process.env.JEV_AGENT_GCP_LOCATION || "global" })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let spent = 0;

  return {
    model: ROUTER_MODEL,
    get spent() { return spent; },
    /** @returns {Promise<{tier: string, reason: string, ms: number, cost: number}>} */
    async route(text) {
      const t0 = Date.now();
      try {
        const res = await ai.models.generateContent({
          model: ROUTER_MODEL,
          contents: PROMPT + text,
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: { tier: { type: "string", enum: Object.keys(TIERS) }, reason: { type: "string" } },
              required: ["tier", "reason"],
            },
            thinkingConfig: { thinkingLevel: "MINIMAL" },
            httpOptions: { timeout: 5000 },
          },
        });
        const u = res.usageMetadata || {};
        const cost = ((u.promptTokenCount || 0) * PRICE[0] + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE[1]) / 1e6;
        spent += cost;
        const out = JSON.parse(res.text);
        if (!TIERS[out.tier]) throw new Error(`unknown tier ${out.tier}`);
        return { tier: out.tier, reason: out.reason || "", ms: Date.now() - t0, cost };
      } catch (e) {
        log(`router failed (${e.message.split("\n")[0].slice(0, 100)}); using complex`);
        return { tier: "complex", reason: "router unavailable", ms: Date.now() - t0, cost: 0 };
      }
    },
  };
}
