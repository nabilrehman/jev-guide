// Speech-to-text, picked by length:
//   up to 55 s  → Google Cloud Speech-to-Text V2, Chirp 3 (~0.9 s). ADC + the planner's Cloud project.
//   longer      → Gemini 3.5 Transcribe (AI Studio key), up to 1 hour in one request.
//                 If that fails, Chirp 3 again, split at pauses into pieces under its 60 s limit.
// OpenRouter is only for Jev.
import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const MAX_CHUNK_S = 55; // Chirp's sync limit is 60 s
const SEARCH_S = 10; // look for the quietest moment in the last 10 s before the cut
const LONG_MODEL = process.env.JEV_STT_LONG_MODEL || "gemini-3.5-transcribe";

export async function transcribeFile(file, { log = () => {} } = {}) {
  const buf = fs.readFileSync(file);
  const wav = parseWav(buf);
  if (!wav || wav.seconds <= MAX_CHUNK_S) return recognize(buf);
  log(`long recording (${Math.round(wav.seconds)}s) → ${LONG_MODEL}`);
  if (process.env.GEMINI_API_KEY && buf.length < 18e6) {
    try { return await transcribeLong(buf); } catch (e) { log(`${e.message}; falling back to Chirp 3 in pieces`); }
  }
  const parts = await Promise.all(splitAtPauses(wav).map((pcm) => recognize(buildWav(pcm, wav.fmt))));
  return parts.filter(Boolean).join(" ");
}

// Gemini 3.5 Transcribe takes inline audio up to the 20 MB request limit (~10 min of 16 kHz mono).
async function transcribeLong(audio) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${LONG_MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: audio.toString("base64") } }] }] }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${LONG_MODEL}: ${res.status} ${body.error?.message || ""}`.trim());
  return (body.candidates?.[0]?.content?.parts || []).map((p) => p.audioTranscription?.text || p.text || "").join(" ").replace(/\s+/g, " ").trim();
}

async function recognize(audio) {
  const project = process.env.JEV_AGENT_GCP_PROJECT;
  if (!project) throw new Error("JEV_AGENT_GCP_PROJECT is needed for speech-to-text");
  const location = process.env.JEV_STT_LOCATION || "us";
  const model = process.env.JEV_STT_MODEL || "chirp_3";
  const host = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  const token = await auth.getAccessToken();
  const res = await fetch(`https://${host}/v2/projects/${project}/locations/${location}/recognizers/_:recognize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-goog-user-project": project, "Content-Type": "application/json" },
    body: JSON.stringify({
      config: { autoDecodingConfig: {}, languageCodes: ["en-US"], model },
      content: audio.toString("base64"),
    }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Speech-to-Text ${model}: ${res.status} ${body.error?.message || ""}`.trim());
  return (body.results || []).map((r) => r.alternatives?.[0]?.transcript || "").join(" ").replace(/\s+/g, " ").trim();
}

// Find the fmt and data chunks (Apple's recorder adds an FLLR padding chunk, so the
// header isn't always 44 bytes). Only 16-bit PCM is split; anything else is sent whole.
function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let fmt = null;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = buf.subarray(off + 8, off + 8 + size);
    if (id === "data" && fmt) {
      const channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
      if (fmt.readUInt16LE(0) !== 1 || bits !== 16) return null;
      const data = buf.subarray(off + 8, Math.min(off + 8 + size, buf.length));
      const frame = channels * 2;
      return { fmt, data, frame, rate, seconds: data.length / frame / rate };
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

// Cut before each MAX_CHUNK_S mark, at the quietest 100 ms window in the SEARCH_S before it.
function splitAtPauses({ data, frame, rate }) {
  const bytesPerS = frame * rate;
  const win = Math.floor(bytesPerS / 10 / frame) * frame;
  const pieces = [];
  let start = 0;
  while (data.length - start > MAX_CHUNK_S * bytesPerS) {
    const hi = start + MAX_CHUNK_S * bytesPerS;
    let best = hi, bestEnergy = Infinity;
    for (let w = hi - SEARCH_S * bytesPerS; w + win <= hi; w += win) {
      let e = 0;
      for (let i = w; i < w + win; i += 2) e += Math.abs(data.readInt16LE(i));
      if (e < bestEnergy) { bestEnergy = e; best = w + win / 2 - ((win / 2) % frame); }
    }
    pieces.push(data.subarray(start, best));
    start = best;
  }
  pieces.push(data.subarray(start));
  return pieces;
}

function buildWav(pcm, fmt) {
  const header = Buffer.alloc(12 + 8 + fmt.length + 8);
  header.write("RIFF", 0); header.writeUInt32LE(header.length - 8 + pcm.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(fmt.length, 16); fmt.copy(header, 20);
  const d = 20 + fmt.length;
  header.write("data", d); header.writeUInt32LE(pcm.length, d + 4);
  return Buffer.concat([header, pcm]);
}
