// Chat window: type requests to the agent instead of speaking them, and watch what it does
// (router choice, tool calls, Jev's clicks) under each message. A tiny local web server
// (127.0.0.1 only) serves the page and streams events to it; the window is Chrome in --app mode.
import http from "node:http";
import fs from "node:fs";
import { spawn } from "node:child_process";

const PORT = Number(process.env.JEV_CHAT_PORT) || 47823;

/**
 * @param {object} o
 * @param {(text: string) => void} o.onSend
 * @param {() => void} o.onStop
 */
export function createChat({ onSend, onStop }) {
  const clients = new Set();
  const history = []; // replayed to a window opened later
  const broadcast = (ev) => {
    if (ev.type !== "busy") { history.push(ev); if (history.length > 400) history.shift(); }
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(line);
  };
  let busy = false;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      for (const ev of history) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "busy", busy })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && (req.url === "/send" || req.url === "/stop")) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(204).end();
        if (req.url === "/stop") return onStop();
        try { const { text } = JSON.parse(body); if (text?.trim()) onSend(text.trim()); } catch {}
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.on("error", (e) => console.log(`⚠ chat window unavailable: ${e.message}`));
  server.listen(PORT, "127.0.0.1");

  const url = `http://127.0.0.1:${PORT}/`;
  return {
    url,
    /** user | reply | activity | error */
    post(type, text) { broadcast({ type, text, at: Date.now() }); },
    setBusy(b) { busy = b; broadcast({ type: "busy", busy: b }); },
    // Chrome's --app mode: a plain window with no tabs or address bar.
    open() {
      const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => fs.existsSync(p));
      if (!chrome) return spawn("open", [url], { stdio: "ignore", detached: true }).unref();
      spawn("open", ["-na", "Google Chrome", "--args", `--app=${url}`, "--window-size=440,680"], { stdio: "ignore", detached: true }).unref();
    },
    close() { server.close(); },
  };
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Guide</title>
<style>
  :root {
    --bg: #0b0b0c; --panel: #151517; --line: #26262a; --text: #f2f2f3; --muted: #8b8b93;
    --me: #f2f2f3; --me-text: #0b0b0c; --accent: #ffffff; --danger: #e5484d; --ok: #46a758;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg: #fafafa; --panel: #ffffff; --line: #e6e6e8; --text: #111113; --muted: #6f6f77; --me: #111113; --me-text: #ffffff; --accent: #111113; }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--text); font: 14.5px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid var(--line); -webkit-app-region: drag; }
  .logo { width: 30px; height: 26px; background: #000; border-radius: 15px 15px 4px 4px; display: grid; place-items: center; border: 1px solid #2a2a2e; }
  .logo i { display: flex; gap: 2px; align-items: center; height: 12px; }
  .logo b { width: 2px; background: #fff; border-radius: 2px; }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: .1px; }
  header .status { margin-left: auto; font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
  body.busy .dot { background: #f5a524; animation: pulse 1s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  main { flex: 1; overflow-y: auto; padding: 18px 16px 8px; scroll-behavior: smooth; }
  .empty { color: var(--muted); text-align: center; margin-top: 22vh; font-size: 13.5px; }
  .empty strong { display: block; color: var(--text); font-size: 16px; font-weight: 600; margin-bottom: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 16px; }
  .chip { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 999px; padding: 6px 11px; font: inherit; font-size: 12.5px; cursor: pointer; }
  .chip:hover { border-color: var(--muted); }
  .msg { display: flex; margin: 10px 0; }
  .msg.user { justify-content: flex-end; }
  .bubble { max-width: 84%; padding: 9px 13px; border-radius: 16px; white-space: pre-wrap; word-wrap: break-word; }
  .user .bubble { background: var(--me); color: var(--me-text); border-bottom-right-radius: 5px; }
  .reply .bubble { background: var(--panel); border: 1px solid var(--line); border-bottom-left-radius: 5px; }
  .error .bubble { background: transparent; border: 1px solid var(--danger); color: var(--danger); }
  details.trail { margin: 2px 0 6px; max-width: 92%; }
  details.trail summary { list-style: none; cursor: pointer; color: var(--muted); font-size: 12px; display: inline-flex; align-items: center; gap: 6px; user-select: none; }
  details.trail summary::-webkit-details-marker { display: none; }
  details.trail summary::before { content: "›"; display: inline-block; transition: transform .15s; font-size: 14px; }
  details.trail[open] summary::before { transform: rotate(90deg); }
  .trail ol { list-style: none; margin: 6px 0 0; padding: 0 0 0 10px; border-left: 1px solid var(--line); }
  .trail li { font: 11.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; color: var(--muted); padding: 1px 0 1px 8px; white-space: pre-wrap; word-break: break-word; }
  .trail li.route { color: var(--text); }
  .typing { display: inline-flex; gap: 4px; padding: 12px 14px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: bounce 1.2s infinite; }
  .typing span:nth-child(2) { animation-delay: .15s; } .typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
  footer { padding: 10px 12px 14px; }
  form { display: flex; align-items: flex-end; gap: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 22px; padding: 6px 6px 6px 14px; }
  form:focus-within { border-color: var(--muted); }
  textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; max-height: 140px; padding: 7px 0; }
  button.send, button.stop { width: 34px; height: 34px; border-radius: 50%; border: 0; cursor: pointer; display: grid; place-items: center; flex: none; }
  button.send { background: var(--accent); color: var(--bg); }
  button.send:disabled { opacity: .3; cursor: default; }
  button.stop { background: var(--danger); color: #fff; display: none; }
  body.busy button.stop { display: grid; }
  .hint { color: var(--muted); font-size: 11px; text-align: center; margin-top: 7px; }
</style></head>
<body>
<header>
  <div class="logo"><i><b style="height:5px"></b><b style="height:9px"></b><b style="height:12px"></b><b style="height:9px"></b><b style="height:5px"></b></i></div>
  <h1>Jev Guide</h1>
  <div class="status"><span class="dot"></span><span id="status">Ready</span></div>
</header>
<main id="log">
  <div class="empty" id="empty"><strong>What should I do?</strong>Type a request. I'll plan it and Jev clicks it on your Mac.
    <div class="chips">
      <button class="chip">What app is in front?</button>
      <button class="chip">What's scheduled?</button>
      <button class="chip">Open Notes and make a note that says hello</button>
    </div>
  </div>
</main>
<footer>
  <form id="f">
    <textarea id="t" rows="1" placeholder="Ask Jev to do something…" autofocus></textarea>
    <button type="button" class="stop" id="stop" title="Stop">
      <svg width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12" rx="2" fill="currentColor"/></svg></button>
    <button class="send" id="send" disabled title="Send (Enter)">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </form>
  <div class="hint">Enter to send · Shift+Enter for a new line</div>
</footer>
<script>
  const log = document.getElementById("log"), t = document.getElementById("t"), send = document.getElementById("send");
  let trail = null, typing = null;
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const scroll = (force) => { if (force || atBottom()) log.scrollTop = log.scrollHeight; };
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function bubble(kind, text) {
    document.getElementById("empty")?.remove();
    const m = el("div", "msg " + kind); m.append(el("div", "bubble", text)); log.append(m); return m;
  }
  function showTyping(on) {
    if (on && !typing) { typing = el("div", "msg reply"); const b = el("div", "bubble typing"); b.innerHTML = "<span></span><span></span><span></span>"; typing.append(b); log.append(typing); }
    else if (on) log.append(typing); // keep it last
    else if (!on && typing) { typing.remove(); typing = null; }
  }
  function addActivity(text) {
    if (!trail) {
      const d = el("details", "trail"); d.append(el("summary", null, "Working…")); d.append(el("ol"));
      log.append(d); trail = d;
    }
    const li = el("li", text.startsWith("🧭") ? "route" : "", text);
    trail.querySelector("ol").append(li);
    const n = trail.querySelectorAll("li").length;
    trail.querySelector("summary").textContent = n + (n === 1 ? " step" : " steps");
    if (typing) log.append(typing);
  }
  const es = new EventSource("/events");
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data), wasBottom = atBottom();
    if (ev.type === "busy") {
      document.body.classList.toggle("busy", ev.busy);
      document.getElementById("status").textContent = ev.busy ? "Working" : "Ready";
      showTyping(ev.busy);
    }
    else if (ev.type === "user") { bubble("user", ev.text); trail = null; }
    else if (ev.type === "activity") addActivity(ev.text);
    else if (ev.type === "reply" || ev.type === "error") { showTyping(false); bubble(ev.type, ev.text); trail = null; }
    scroll(wasBottom || ev.type === "user");
  };
  function submit(text) {
    text = (text ?? t.value).trim(); if (!text) return;
    fetch("/send", { method: "POST", body: JSON.stringify({ text }) });
    t.value = ""; grow(); t.focus();
  }
  function grow() { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 140) + "px"; send.disabled = !t.value.trim(); }
  t.addEventListener("input", grow);
  t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
  document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
  document.getElementById("stop").addEventListener("click", () => fetch("/stop", { method: "POST" }));
  document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => submit(c.textContent)));
</script>
</body></html>`;
