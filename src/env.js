// Minimal .env loader (project dir, then ~/.jev-guide/.env). Never overrides real env.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export function loadEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const files = [path.join(process.cwd(), ".env"), path.join(here, "..", ".env"), path.join(os.homedir(), ".jev-guide", ".env")];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  }
}
