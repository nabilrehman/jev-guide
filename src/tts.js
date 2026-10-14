// Spoken replies with Gemini 3.8 Flash TTS on Vertex AI (same Cloud project and ADC as the
// planner and speech-to-text). Returns a WAV file to play; the caller falls back to `say`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export async function synthesize(text) {
  const project = process.env.JEV_AGENT_GCP_PROJECT;
  if (!project) throw new Error("JEV_AGENT_GCP_PROJECT is needed for text-to-speech");
  const model = process.env.JEV_TTS_MODEL;
  if (!model) throw new Error("JEV_TTS_MODEL is needed for text-to-speech");
  const voice = process.env.JEV_TTS_VOICE || "Kore";
  const token = await auth.getAccessToken();
  const res = await fetch(`https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  const audio = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!res.ok || !audio) throw new Error(`TTS ${model}: ${res.status} ${body.error?.message || "no audio"}`);
  const file = path.join(os.tmpdir(), `jev-reply-${Date.now()}.wav`);
  fs.writeFileSync(file, Buffer.from(audio.data, "base64"));
  return file;
}
