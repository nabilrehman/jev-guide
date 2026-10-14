// Long-running tasks ("work through this whole unit, lesson by lesson"). The goal and the planner's
// own progress notes persist in ~/.jev-guide/tasks.json, so a task survives a stop, a crash or a
// restart and can be resumed later. Status: running | paused | needs_user | done.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".jev-guide", "tasks.json");
const KEEP = 20; // most recent tasks kept on disk

export function createTaskStore() {
  let tasks = [];
  try { tasks = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  // Anything still "running" belongs to a process that has gone away.
  for (const t of tasks) if (t.status === "running") t.status = "paused";
  const save = () => {
    tasks = tasks.slice(-KEEP);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(tasks, null, 2));
  };

  return {
    create(goal) {
      const now = new Date().toISOString();
      const t = { id: Math.random().toString(36).slice(2, 8), goal, status: "running", progress: "", question: "", reason: "", rounds: 0, spent: 0, ms: 0, created: now, updated: now };
      tasks.push(t);
      save();
      return t;
    },
    get(id) { return tasks.find((t) => t.id === id); },
    update(t, patch) { Object.assign(t, patch, { updated: new Date().toISOString() }); save(); return t; },
    unfinished() { return tasks.filter((t) => t.status !== "done"); },
    list() {
      return tasks.map((t) => ({
        id: t.id, goal: t.goal, status: t.status, progress: t.progress.slice(0, 300),
        ...(t.question ? { waiting_for: t.question } : {}), ...(t.reason ? { paused_because: t.reason } : {}),
        rounds: t.rounds, minutes: Math.round(t.ms / 60_000), spent_usd: Number(t.spent.toFixed(2)), updated: new Date(t.updated).toLocaleString(),
      }));
    },
  };
}
