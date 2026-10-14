// Push-to-talk voice input: ffmpeg (avfoundation) records the mic until you
// press Enter, whisper.cpp transcribes locally. Nothing leaves the machine but
// the transcript (which goes to Jev).
//   brew install whisper-cpp ffmpeg
// The base.en model is downloaded on first use to ~/.jev-guide/.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const HOME = path.join(os.homedir(), ".jev-guide");

function which(bin) {
  try { return execFileSync("which", [bin], { encoding: "utf8" }).trim(); } catch { return null; }
}

export function voiceAvailable() {
  const whisper = which("whisper-cli") || which("whisper-cpp") || which("main");
  const ffmpeg = which("ffmpeg");
  return { ok: !!(whisper && ffmpeg), whisper, ffmpeg };
}

export async function ensureModel() {
  fs.mkdirSync(HOME, { recursive: true });
  const model = process.env.WHISPER_MODEL || path.join(HOME, "ggml-base.en.bin");
  if (fs.existsSync(model)) return model;
  console.log(`[voice] downloading whisper model (~148 MB) to ${model} ...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  fs.writeFileSync(model, Buffer.from(await res.arrayBuffer()));
  return model;
}

export function listMics() {
  try { execFileSync("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], { stdio: ["ignore", "ignore", "inherit"] }); } catch {}
}

/** Records until `stopSignal` resolves, returns transcript text. */
export async function recordAndTranscribe(stopSignal, { mic = process.env.JEV_MIC || ":0" } = {}) {
  const { whisper, ffmpeg } = voiceAvailable();
  const model = await ensureModel();
  const wav = path.join(os.tmpdir(), `jev-voice-${Date.now()}.wav`);
  const rec = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "avfoundation", "-i", mic, "-ac", "1", "-ar", "16000", "-t", "60", wav], { stdio: ["pipe", "ignore", "inherit"] });
  await stopSignal;
  rec.stdin.write("q"); // graceful stop so the WAV header is finalized
  await new Promise((r) => rec.on("exit", r));
  const out = execFileSync(whisper, ["-m", model, "-f", wav, "-nt", "-np"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  fs.rmSync(wav, { force: true });
  return out.replace(/\[.*?\]/g, "").replace(/\s+/g, " ").trim();
}
