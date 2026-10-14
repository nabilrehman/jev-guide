// In-page overlay: an animated fake cursor, a highlight ring, and a caption bar
// (like a training video). Injected via addInitScript so it survives navigation.
export const OVERLAY_INIT = `
(() => {
  if (window.__jev) return;
  const J = (window.__jev = { caption: "", status: "" });
  const css = \`
    #__jev_cursor{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;
      transition:transform .55s cubic-bezier(.2,.8,.2,1);transform:translate(-100px,-100px);filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}
    #__jev_ring{position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #ff3b30;border-radius:8px;
      box-shadow:0 0 0 4px rgba(255,59,48,.25);opacity:0;transition:opacity .2s}
    #__jev_cap{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;
      max-width:80vw;background:rgba(0,0,0,.78);color:#fff;font:600 22px/1.35 -apple-system,Helvetica,Arial,sans-serif;
      padding:10px 18px;border-radius:10px;text-align:center;opacity:0;transition:opacity .25s;white-space:pre-wrap}
    #__jev_cap small{display:block;font:500 14px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#9be7a4;margin-top:4px}
    #__jev_click{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;border-radius:50%;
      border:3px solid #ffcc00;transform:translate(-50%,-50%) scale(1);opacity:0}
    #__jev_mic{position:fixed;right:24px;bottom:28px;z-index:2147483647;width:60px;height:60px;border-radius:50%;border:0;
      background:#1a73e8;box-shadow:0 4px 14px rgba(0,0,0,.35);cursor:pointer;display:flex;align-items:center;justify-content:center;
      pointer-events:auto;padding:0;transition:background .2s,transform .15s}
    #__jev_mic:hover{transform:scale(1.06)}
    #__jev_mic.listening{background:#ff3b30;animation:__jev_breathe 1.2s ease-in-out infinite}
    #__jev_mic.busy{background:#5f6368}
    @keyframes __jev_breathe{0%,100%{box-shadow:0 0 0 0 rgba(255,59,48,.55)}50%{box-shadow:0 0 0 14px rgba(255,59,48,0)}}
    @keyframes __jev_pulse{0%{transform:translate(-50%,-50%) scale(.6);opacity:1}100%{transform:translate(-50%,-50%) scale(3.2);opacity:0}}
  \`;
  function ensure() {
    if (document.getElementById("__jev_cursor")) return;
    const root = document.documentElement;
    const style = document.createElement("style"); style.textContent = css; root.appendChild(style);
    const cur = document.createElement("div"); cur.id = "__jev_cursor";
    cur.appendChild(svg("0 0 24 24", 26, [["path", { d: "M4 2l16 9.5-7 1.6L9 20z", fill: "#fff", stroke: "#000", "stroke-width": "1.5", "stroke-linejoin": "round" }]]));
    root.appendChild(cur);
    const ring = document.createElement("div"); ring.id = "__jev_ring"; root.appendChild(ring);
    const cap = document.createElement("div"); cap.id = "__jev_cap"; root.appendChild(cap);
    const clk = document.createElement("div"); clk.id = "__jev_click"; root.appendChild(clk);
    const mic = document.createElement("button"); mic.id = "__jev_mic"; mic.type = "button";
    mic.title = "Click and say what to do (shortcut: Option+Space). Click again to send.";
    mic.appendChild(svg("0 0 24 24", 26, [
      ["rect", { x: "9", y: "3", width: "6", height: "11", rx: "3", fill: "#fff" }],
      ["path", { d: "M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21", fill: "none", stroke: "#fff", "stroke-width": "2", "stroke-linecap": "round" }],
    ]));
    mic.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); J.toggleMic(); });
    root.appendChild(mic);
    J.render();
  }
  function svg(viewBox, size, children) {
    const NS = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(NS, "svg");
    el.setAttribute("viewBox", viewBox); el.setAttribute("width", size); el.setAttribute("height", size);
    for (const [tag, attrs] of children) {
      const c = document.createElementNS(NS, tag);
      for (const k in attrs) c.setAttribute(k, attrs[k]);
      el.appendChild(c);
    }
    return el;
  }
  J.render = () => {
    const cap = document.getElementById("__jev_cap"); if (!cap) return;
    if (!J.caption && !J.status) { cap.style.opacity = "0"; return; }
    cap.textContent = J.caption;
    if (J.status) { const s = document.createElement("small"); s.textContent = J.status; cap.appendChild(s); }
    cap.style.opacity = "1";
  };
  J.setCaption = (t, s) => { ensure(); J.caption = t || ""; J.status = s || ""; J.render(); };
  J.moveTo = (x, y) => { ensure(); const c = document.getElementById("__jev_cursor"); c.style.transform = \`translate(\${x - 3}px,\${y - 2}px)\`; };
  J.highlight = (r) => { ensure(); const g = document.getElementById("__jev_ring");
    if (!r) { g.style.opacity = "0"; return; }
    g.style.left = (r.x - 4) + "px"; g.style.top = (r.y - 4) + "px"; g.style.width = (r.width + 8) + "px"; g.style.height = (r.height + 8) + "px"; g.style.opacity = "1"; };
  J.clickFx = (x, y) => { ensure(); const k = document.getElementById("__jev_click"); k.style.left = x + "px"; k.style.top = y + "px";
    k.style.animation = "none"; void k.offsetWidth; k.style.animation = "__jev_pulse .5s ease-out"; };

  // ---------- voice: Chrome's built-in speech recognition ----------
  // Click (or Option+Space) to start; click again, or just stop talking, to send.
  // While a command is running the button turns grey; clicking it then asks to stop.
  J.busy = false;
  J.setBusy = (b) => { ensure(); J.busy = !!b; micClass(); };
  function micClass() {
    const m = document.getElementById("__jev_mic"); if (!m) return;
    m.classList.toggle("listening", !!J.rec);
    m.classList.toggle("busy", J.busy && !J.rec);
    m.title = J.rec ? "Listening… click to send" : J.busy ? "Working… click to stop" : "Click and say what to do (shortcut: Option+Space)";
  }
  J.toggleMic = () => {
    if (J.rec) { J.rec.stop(); return; }
    if (J.busy) { window.__jevVoiceStop?.(); J.setCaption("Stopping…", ""); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { J.setCaption("Speech recognition isn't available in this browser", ""); return; }
    const rec = new SR();
    rec.lang = navigator.language || "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = "", interim = "", failed = false;
    rec.onresult = (ev) => {
      interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      J.setCaption((finalText + interim).trim() || "…", "🎤 listening — click the mic to send");
    };
    rec.onerror = (ev) => {
      if (ev.error === "no-speech" || ev.error === "aborted") return;
      failed = true;
      const why = { "not-allowed": "microphone access was blocked (check Chrome + macOS mic permissions)",
        "audio-capture": "no microphone found", network: "Chrome's speech service is unreachable" }[ev.error] || ev.error;
      J.setCaption("Voice error: " + why, "");
    };
    rec.onend = () => {
      J.rec = null; micClass();
      const text = (finalText + " " + interim).replace(/\s+/g, " ").trim();
      if (failed) return;
      if (!text) { J.setCaption("", ""); return; }
      J.setCaption(text, "sending…");
      window.__jevVoiceSubmit?.(text);
    };
    J.rec = rec; micClass();
    J.setCaption("Listening…", "🎤 say what to do — click the mic to send");
    try { rec.start(); } catch (e) { J.rec = null; micClass(); J.setCaption("Voice error: " + e.message, ""); }
  };
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "Space" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); J.toggleMic(); }
  }, true);

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ensure, { once: true }); else ensure();
})();
`;
