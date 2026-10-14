// ADK model connector for OpenRouter (OpenAI-compatible chat completions), so the
// ADK agent can plan with Claude using the same OPENROUTER_API_KEY as Jev.
// Converts ADK/Gemini-style contents + function declarations to chat messages +
// tools, and the reply's tool_calls back to functionCall parts.
import { BaseLlm } from "@google/adk";

export class OpenRouterLlm extends BaseLlm {
  constructor({ model = process.env.JEV_AGENT_MODEL || "anthropic/claude-sonnet-5.5", log = () => {} } = {}) {
    super({ model });
    this.log = log;
    this.spent = 0;
    this.calls = 0;
    this.ms = 0;
  }

  async *generateContentAsync(llmRequest, _stream = false, abortSignal) {
    const body = {
      model: this.model,
      messages: toMessages(llmRequest),
      max_tokens: 2048,
      usage: { include: true },
    };
    const tools = toTools(llmRequest);
    if (tools.length) body.tools = tools;

    const t0 = Date.now();
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/jev-guide",
        "X-Title": "jev-guide",
      },
      body: JSON.stringify(body),
      signal: abortSignal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.choices?.length) {
      yield { errorCode: String(res.status), errorMessage: data.error?.message || `OpenRouter error ${res.status}`, turnComplete: true };
      return;
    }
    this.spent += Number(data.usage?.cost) || 0;
    this.calls++; this.ms += Date.now() - t0;
    this.log(`planner ${this.model} ${Date.now() - t0}ms · ${data.usage?.prompt_tokens ?? "?"} tok${data.usage?.cost != null ? ` · $${Number(data.usage.cost).toFixed(4)}` : ""}`);

    const msg = data.choices[0].message;
    const parts = [];
    if (msg.content) parts.push({ text: msg.content });
    for (const tc of msg.tool_calls || []) {
      let args = {};
      try { args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}; } catch {}
      parts.push({ functionCall: { id: tc.id, name: tc.function.name, args } });
    }
    if (!parts.length) parts.push({ text: "" });
    yield {
      content: { role: "model", parts },
      turnComplete: true,
      usageMetadata: data.usage ? { promptTokenCount: data.usage.prompt_tokens, candidatesTokenCount: data.usage.completion_tokens, totalTokenCount: data.usage.total_tokens } : undefined,
    };
  }

  async connect() { throw new Error("Live mode is not supported by the OpenRouter connector"); }
}

function toMessages(req) {
  const messages = [];
  const sys = req.config?.systemInstruction;
  const sysText = typeof sys === "string" ? sys : sys?.parts?.map((p) => p.text || "").join("\n") || "";
  if (sysText) messages.push({ role: "system", content: sysText });

  for (const c of req.contents || []) {
    const parts = c.parts || [];
    if (c.role === "model") {
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
      const calls = parts.filter((p) => p.functionCall).map((p) => ({
        id: p.functionCall.id, type: "function",
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
      }));
      if (!text && !calls.length) continue;
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: function responses become tool messages, the rest is user text.
    for (const p of parts) {
      if (p.functionResponse) {
        messages.push({ role: "tool", tool_call_id: p.functionResponse.id, content: JSON.stringify(p.functionResponse.response ?? {}) });
      }
    }
    const text = parts.filter((p) => p.text).map((p) => p.text).join("\n");
    if (text) messages.push({ role: "user", content: text });
  }
  return messages;
}

function toTools(req) {
  const out = [];
  for (const t of req.config?.tools || []) {
    for (const fd of t.functionDeclarations || []) {
      out.push({
        type: "function",
        function: {
          name: fd.name,
          description: fd.description || "",
          parameters: fd.parametersJsonSchema || toJsonSchema(fd.parameters) || { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

// Gemini Schema ({type:"OBJECT", ...}) -> JSON Schema ({type:"object", ...}).
function toJsonSchema(s) {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(toJsonSchema);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === "nullable") continue;
    else out[k] = typeof v === "object" ? toJsonSchema(v) : v;
  }
  return out;
}
