// ADK's built-in Gemini model, plus the same per-call log line and
// running cost as the OpenRouter connector. Gemini caches repeated prompt prefixes on its
// own (implicit caching), so the growing history of a long task is billed cheaper.
import { Gemini } from "@google/adk";

// USD per million tokens [input, output]. Output includes thinking tokens.
const PRICES = {
  "gemini-3.8-flash": [0.75, 3.75], // introductory rate until 2026-12-31, then 1.50 / 7.50
  "gemini-3.1-pro-preview": [2.0, 12.0],
};

export class GeminiLlm extends Gemini {
  constructor({ model = process.env.JEV_AGENT_MODEL || "gemini-3.8-flash", thinking = process.env.JEV_AGENT_THINKING || "LOW", log = () => {} } = {}) {
    // Vertex AI with Application Default Credentials when a Cloud project is set,
    // otherwise a Google AI Studio key.
    const project = process.env.JEV_AGENT_GCP_PROJECT;
    super(project
      ? { model, vertexai: true, project, location: process.env.JEV_AGENT_GCP_LOCATION || "global" }
      : { model, apiKey: process.env.GEMINI_API_KEY });
    this.backend = project ? `Vertex ${project}` : "AI Studio";
    this.log = log;
    this.thinking = thinking;
    this.spent = 0;
    this.calls = 0; // planner calls and time, for the per-request timing summary
    this.ms = 0;
  }

  // Default thinking made calls take 4-36s with occasional hangs; LOW is usually 2-6s and
  // plenty for choosing the next tool (MINIMAL is rejected by 3.8 Flash). Any call that still stalls gets 30s and one retry.
  async *generateContentAsync(llmRequest, stream = false, abortSignal) {
    for (let attempt = 1; ; attempt++) {
      llmRequest.config = {
        ...llmRequest.config,
        thinkingConfig: { thinkingLevel: this.thinking },
        httpOptions: { ...llmRequest.config?.httpOptions, timeout: 30000 },
      };
      try {
        yield* this.#call(llmRequest, stream, abortSignal);
        return;
      } catch (e) {
        if (attempt >= 2 || abortSignal?.aborted) throw e;
        this.log(`planner call failed (${e.message.split("\n")[0].slice(0, 120)}), retrying`);
      }
    }
  }

  async *#call(llmRequest, stream, abortSignal) {
    const t0 = Date.now();
    for await (const res of super.generateContentAsync(llmRequest, stream, abortSignal)) {
      const u = res.usageMetadata;
      if (u) {
        const [pin, pout] = PRICES[this.model] || [0, 0];
        const cached = u.cachedContentTokenCount || 0;
        // Cached input is billed at 10% of the input rate.
        const cost = ((u.promptTokenCount - cached + cached * 0.1) * pin + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * pout) / 1e6;
        const ms = Date.now() - t0;
        this.spent += cost; this.calls++; this.ms += ms;
        this.log(`planner ${this.model} (${this.backend}) ${ms}ms · ${u.promptTokenCount} tok in${cached ? ` (${cached} cached)` : ""} · ${u.candidatesTokenCount || 0} out + ${u.thoughtsTokenCount || 0} thinking · $${cost.toFixed(4)}${ms > 8000 ? "  ⚠ slow" : ""}`);
      }
      yield res;
    }
  }
}
