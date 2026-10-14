import fs from "node:fs";
import { loadEnv } from "./src/env.js"; loadEnv();
import { GoogleGenAI, Modality, Behavior, FunctionResponseScheduling } from "@google/genai";
const which = process.argv[2], model = process.argv[3];
const ai = which === "vertex"
  ? new GoogleGenAI({ vertexai: true, project: process.env.JEV_AGENT_GCP_PROJECT, location: process.argv[4] || "global" })
  : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(2) + "s";
let audioBytes = 0, firstAudio = null, outText = "", inText = "";
let session;
const done = new Promise((resolve) => setTimeout(resolve, 45000));
let finish;
const ended = new Promise((r) => (finish = r));
session = await ai.live.connect({
  model,
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: "You are Jev Guide, a voice assistant that operates the user's Mac. For ANY request to do something on the computer or web: FIRST say a very short acknowledgment out loud (3-6 words, like: On it, opening Notes), THEN call run_task with the full request. Never wait silently. When the task result arrives, tell the user the result in one short sentence.",
    tools: [{ functionDeclarations: [{ name: "run_task", description: "Carry out a task on the user's Mac/web and return the outcome.", behavior: Behavior.NON_BLOCKING,
      parameters: { type: "object", properties: { request: { type: "string" } }, required: ["request"] } }] }],
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    inputAudioTranscription: {}, outputAudioTranscription: {},
    ...(process.env.TL ? { thinkingConfig: { thinkingLevel: process.env.TL } } : {}),
  },
  callbacks: {
    onopen: () => console.log(ts(), "open"),
    onmessage: (m) => {
      const sc = m.serverContent;
      if (sc?.inputTranscription?.text) inText += sc.inputTranscription.text;
      if (sc?.outputTranscription?.text) outText += sc.outputTranscription.text;
      for (const p of sc?.modelTurn?.parts || []) if (p.inlineData) { audioBytes += Buffer.from(p.inlineData.data, "base64").length; if (!firstAudio) { firstAudio = ts(); console.log(ts(), "first audio", p.inlineData.mimeType); } }
      if (sc?.turnComplete) { console.log(ts(), "turnComplete | heard:", JSON.stringify(inText), "| said:", JSON.stringify(outText)); outText = ""; }
      if (m.toolCall) for (const fc of m.toolCall.functionCalls) {
        console.log(ts(), "TOOL CALL", fc.name, JSON.stringify(fc.args));
        setTimeout(() => { console.log(ts(), "sending tool result");
          session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: "Opened Notes and created a note that says testing Jev.", scheduling: FunctionResponseScheduling.WHEN_IDLE } }] });
          setTimeout(finish, 12000); }, 5000);
      }
    },
    onerror: (e) => console.log(ts(), "ERROR", e.message),
    onclose: (e) => { console.log(ts(), "closed", e.code, e.reason); finish(); },
  },
});
// speak the request from a wav file: 16 kHz mono PCM, sent in 100 ms chunks
const say = fs.readFileSync("/private/tmp/claude-501/-Users-nabilrehman-Downloads-screen-capture-jev/0407c82b-8777-4228-b648-49ef78d2150e/scratchpad/req.wav"); const pcm = say.subarray(say.indexOf("data") + 8);
session.sendRealtimeInput({ activityStart: {} });
for (let i = 0; i < pcm.length; i += 3200) { session.sendRealtimeInput({ audio: { data: pcm.subarray(i, i + 3200).toString("base64"), mimeType: "audio/pcm;rate=16000" } }); await new Promise((r) => setTimeout(r, 20)); }
session.sendRealtimeInput({ activityEnd: {} });
console.log(ts(), "audio sent");
await Promise.race([ended, done]);
console.log("total audio out:", (audioBytes / 48000).toFixed(1) + "s");
session.close(); process.exit(0);
