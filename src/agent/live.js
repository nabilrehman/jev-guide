// Voice front end: a Gemini Live session (speech in, speech out) with the planner behind it as a
// background tool. Live hears the user, says a short acknowledgment, calls run_task, and speaks the
// result when it comes back. Push-to-talk: the app marks the start and end of each utterance.
//
// Vertex AI (ADC, JEV_LIVE_GCP_LOCATION, default us-central1) when a Cloud project is set,
// otherwise the AI Studio key.
import { GoogleGenAI, Modality, Behavior, FunctionResponseScheduling } from "@google/genai";

const MODEL = process.env.JEV_LIVE_MODEL || "gemini-3.8-live";

const INSTRUCTION = `You are Jev Guide, a voice assistant that operates the user's Mac and web browser for them.
You speak with the user; a separate agent does the actual work on the computer through the run_task tool.

- For ANY request to do something on the computer or the web (open, click, find, read, write, send, check...):
  FIRST say a very short acknowledgment out loud (3 to 6 words, like: On it, opening Notes), THEN call run_task.
  Never wait silently.
- Pass the request to run_task faithfully in the user's own words. Keep any text to type, names, and numbers
  exactly as the user said them; resolve "it" / "that" from the conversation, but don't add or change details.
- When a task result arrives, tell the user the outcome in one or two short, natural sentences.
- If the user asks to stop or cancel, call stop_task.
- If a task is still running and the user asks for something else, tell them it will start after the current one.
- For plain questions or chit-chat that need nothing from the computer, just answer briefly.
- Keep everything short and spoken: no lists, markdown, or URLs read out.`;

const TOOLS = [{
  functionDeclarations: [
    {
      name: "run_task",
      description: "Carry out a task on the user's Mac or in the web browser, and return what happened (or the answer found). "
        + "It can also schedule tasks to run automatically at a later time or on a repeating schedule, and list or cancel scheduled tasks. "
        + "Long tasks (working through a whole course, lesson after lesson) run for as long as they need and can be paused with stop_task and resumed later.",
      behavior: Behavior.NON_BLOCKING,
      parameters: { type: "object", properties: { request: { type: "string", description: "The full task, in the user's words" } }, required: ["request"] },
    },
    { name: "stop_task", description: "Stop the task that is currently running.", behavior: Behavior.NON_BLOCKING },
  ],
}];

/**
 * @param {object} o
 * @param {(request: string) => Promise<string>} o.runTask  runs a task, resolves with its outcome text
 * @param {() => void} o.stopTask
 * @param {(b64: string) => void} o.play   queue 24 kHz PCM audio
 * @param {() => void} o.stopAudio
 * @param {(event: object) => void} o.onEvent  {heard}, {said}, {turnDone}
 * @param {(msg: string) => void} o.log
 */
export function createLive({ runTask, stopTask, play, stopAudio, onEvent = () => {}, log = () => {} }) {
  const project = process.env.JEV_AGENT_GCP_PROJECT;
  const ai = project
    ? new GoogleGenAI({ vertexai: true, project, location: process.env.JEV_LIVE_GCP_LOCATION || "us-central1" })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const backend = project ? `Vertex ${project}` : "AI Studio";

  let session = null;
  let connecting = null;
  let resumeHandle = null; // lets a reconnect continue the same conversation
  let heard = "", said = "";

  function connect() {
    if (session) return Promise.resolve(session);
    if (connecting) return connecting;
    connecting = (async () => {
      const s = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: INSTRUCTION,
          tools: TOOLS,
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } }, // push-to-talk marks turns
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.JEV_LIVE_VOICE || "Kore" } } },
          contextWindowCompression: { slidingWindow: {} }, // sessions can run past the audio-length limit
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
        },
        callbacks: {
          onmessage: (m) => handle(m),
          onerror: (e) => log(`live error: ${e.message || e}`),
          onclose: (e) => {
            if (session === s) session = null;
            if (e?.code && e.code !== 1000) log(`live closed (${e.code}${e.reason ? ` ${e.reason.slice(0, 120)}` : ""}); will reconnect on next use`);
          },
        },
      });
      session = s;
      return s;
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function handle(m) {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) resumeHandle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) { log("live: server asked to reconnect"); session?.close(); session = null; }
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) heard += sc.inputTranscription.text;
      // The transcript can carry markers like <no speech> or {pause}; they aren't words.
      if (sc.outputTranscription?.text) { said += sc.outputTranscription.text.replace(/<[^>]*>|\{[^}]*\}/g, ""); onEvent({ saying: said.trim() }); }
      for (const p of sc.modelTurn?.parts || []) if (p.inlineData?.data) play(p.inlineData.data);
      if (sc.interrupted) stopAudio();
      if (sc.turnComplete || sc.interrupted) {
        if (heard.trim()) onEvent({ heard: heard.trim() });
        if (said.trim()) onEvent({ said: said.trim() });
        heard = ""; said = "";
        onEvent({ turnDone: true });
      }
    }
    for (const fc of m.toolCall?.functionCalls || []) onToolCall(fc);
  }

  async function onToolCall(fc) {
    if (fc.name === "stop_task") {
      stopTask();
      respond(fc, { result: "Stopped." }, FunctionResponseScheduling.SILENT);
      return;
    }
    if (fc.name !== "run_task") return respond(fc, { error: `unknown tool ${fc.name}` });
    const request = String(fc.args?.request || "").trim();
    let result;
    try { result = (await runTask(request)) || "Done."; } catch (e) { result = `It failed: ${e.message}`; }
    respond(fc, { result }, FunctionResponseScheduling.WHEN_IDLE);
  }

  async function respond(fc, response, scheduling) {
    try {
      const s = await connect();
      s.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { ...response, ...(scheduling ? { scheduling } : {}) } }] });
    } catch (e) { log(`live: could not send the task result: ${e.message}`); }
  }

  // Mic chunks of a push-to-talk turn are held until the hold is long enough to be a real
  // utterance (a short tap means "stop", not speech).
  let turn = null;
  return {
    model: MODEL,
    backend,
    connect,
    beginTurn() {
      stopAudio();
      turn = { chunks: [], started: false };
      connect().catch((e) => log(`live: could not connect: ${e.message}`));
    },
    async audio(b64) {
      if (!turn) return;
      if (!turn.started) {
        turn.chunks.push(b64);
        if (turn.chunks.length < 4) return; // ~400 ms
        const s = await connect();
        if (!turn || turn.started) return;
        turn.started = true;
        s.sendRealtimeInput({ activityStart: {} });
        for (const c of turn.chunks.splice(0)) s.sendRealtimeInput({ audio: { data: c, mimeType: "audio/pcm;rate=16000" } });
        return;
      }
      session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
    },
    async endTurn() {
      const t = turn; turn = null;
      if (!t) return;
      const s = await connect();
      if (!t.started) {
        if (t.chunks.length < 3) return; // too short to be speech
        s.sendRealtimeInput({ activityStart: {} });
        for (const c of t.chunks) s.sendRealtimeInput({ audio: { data: c, mimeType: "audio/pcm;rate=16000" } });
      }
      s.sendRealtimeInput({ activityEnd: {} });
    },
    cancelTurn() { turn = null; },
    async sendText(text) {
      const s = await connect();
      s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    },
    close() { session?.close(); session = null; },
  };
}
