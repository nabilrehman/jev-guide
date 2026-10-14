// Split one spoken instruction into sequential steps and extract text
// candidates Jev can choose from (Jev never generates text, it only picks).

const SEQ_SPLIT = /\s*(?:[,;.]\s*)?(?:\band then\b|\bthen\b|\bafter that\b|\bnext,?\b|\bfinally\b|\bafterwards\b)\s*/i;

export function splitSteps(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) return [];
  let parts = cleaned.split(SEQ_SPLIT).map((s) => s.trim()).filter(Boolean);
  // Also split ", and " (comma-and) which almost always separates steps in speech.
  parts = parts.flatMap((p) => p.split(/,\s+and\s+/i).map((s) => s.trim()).filter(Boolean));
  parts = parts.map((p) => p.replace(/^(?:and|please|can you|could you|now)\s+/i, "").replace(/[.?!]+$/, "").trim());
  return parts.filter((p) => p.length >= 3);
}

// Candidate strings the model may choose to type. Order = priority.
export function extractTextCandidates(step) {
  const c = new Set();
  for (const m of step.matchAll(/["“”']([^"“”']{1,120})["“”']/g)) c.add(m[1].trim());
  const verbs = /\b(?:type|enter|write|search(?: for)?|look up|fill(?: in)?|put|paste|name it|call it|input)\s+(?:in\s+)?(?:the\s+)?(.+)$/i;
  const m = step.match(verbs);
  if (m) {
    let v = m[1].trim();
    // strip trailing target phrases: "search for foo in the search bar"
    v = v.replace(/\s+(?:in|into|on|at)\s+(?:the\s+)?[\w\s-]*?(?:box|bar|field|input|search|form)\s*$/i, "").trim();
    v = v.replace(/^(?:the\s+)?(?:text|words?|query)\s+/i, "").trim();
    if (v) c.add(v);
  }
  return [...c].filter((s) => s.length > 0).slice(0, 20);
}

// Heuristic hints for the state (what kind of step this looks like).
export function classifyStepHint(step) {
  const s = step.toLowerCase();
  const hints = [];
  if (/\b(go to|open|navigate|visit|launch|bring up)\b/.test(s)) hints.push("navigation");
  if (/\b(click|press|tap|select|choose|hit|toggle|check|expand|open the .* (menu|tab|dropdown))\b/.test(s)) hints.push("click");
  if (/\b(type|enter|write|search|fill|input|paste)\b/.test(s)) hints.push("typing");
  if (/\b(scroll)\b/.test(s)) hints.push("scroll");
  if (/\b(back)\b/.test(s)) hints.push("back");
  if (/\b(save|submit|confirm|apply|create|delete|continue)\b/.test(s)) hints.push("commit-action");
  return hints;
}
