// Scheduled tasks ("tomorrow at 7 book the gym class", "every weekday at 9 check my calendar").
// Like OpenClaw's cron: jobs persist on disk, run inside this process (Jev Guide must be running
// and the Mac awake), and each run is a fresh planner request. Three kinds of schedule:
//   at    : one time, ISO date-time (deleted after it runs)
//   every : every N minutes
//   cron  : a 5-field cron expression in the local time zone
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Cron } from "croner";

const FILE = path.join(os.homedir(), ".jev-guide", "schedule.json");
const TICK_MS = 15_000;
// A one-time job whose time passed while Jev Guide was closed (or the Mac asleep) still runs if it
// is at most this late; older ones are dropped and reported instead.
const GRACE_MS = 15 * 60_000;
export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function nextRun(schedule, after = new Date()) {
  if (schedule.kind === "at") return new Date(schedule.at);
  if (schedule.kind === "every") return new Date(after.getTime() + schedule.minutes * 60_000);
  return new Cron(schedule.cron, { paused: true, timezone: TIME_ZONE }).nextRun(after);
}

export function describeSchedule(s) {
  if (s.kind === "at") return `once at ${new Date(s.at).toLocaleString()}`;
  if (s.kind === "every") return `every ${s.minutes} minutes`;
  return `cron "${s.cron}" (${TIME_ZONE})`;
}

/**
 * @param {object} o
 * @param {(job: object) => Promise<void>} o.run  runs a due job's task
 * @param {(msg: string) => void} [o.log]
 */
export function createScheduler({ run, log = console.log }) {
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  const save = () => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(jobs, null, 2));
  };

  function tick() {
    const now = Date.now();
    for (const job of [...jobs]) {
      if (new Date(job.next).getTime() > now) continue;
      const late = now - new Date(job.next).getTime();
      if (job.schedule.kind === "at") {
        jobs = jobs.filter((j) => j !== job);
        if (late > GRACE_MS) { log(`⏰ missed (Jev Guide was closed or the Mac asleep): "${job.task}" ${describeSchedule(job.schedule)}`); continue; }
      } else {
        job.next = nextRun(job.schedule, new Date(now)).toISOString();
        if (late > GRACE_MS) { log(`⏰ skipped a missed run of "${job.task}"; next ${new Date(job.next).toLocaleString()}`); continue; }
      }
      job.lastRun = new Date(now).toISOString();
      log(`⏰ running scheduled task: "${job.task}"`);
      run(job).catch((e) => log(`✖ scheduled task failed: ${e.message}`));
    }
    save();
  }
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  setTimeout(tick, 1000);

  return {
    /** @returns {object} the saved job, or throws on a bad schedule */
    add({ task, at, every_minutes, cron }) {
      const schedule = at ? { kind: "at", at: new Date(at).toISOString() }
        : every_minutes ? { kind: "every", minutes: Math.max(1, Number(every_minutes)) }
        : cron ? { kind: "cron", cron: cron.trim() }
        : null;
      if (!schedule) throw new Error("give one of: at, every_minutes, cron");
      if (schedule.kind === "at" && Number.isNaN(new Date(at).getTime())) throw new Error(`can't read the time "${at}"`);
      const next = nextRun(schedule);
      if (!next) throw new Error("that schedule never runs");
      if (schedule.kind === "at" && next.getTime() < Date.now() - 60_000) throw new Error(`${next.toLocaleString()} is in the past`);
      const job = { id: Math.random().toString(36).slice(2, 8), task, schedule, next: next.toISOString(), created: new Date().toISOString() };
      jobs.push(job);
      save();
      log(`⏰ scheduled "${task}" ${describeSchedule(schedule)} (next ${next.toLocaleString()})`);
      return job;
    },
    list() { return jobs.map((j) => ({ id: j.id, task: j.task, when: describeSchedule(j.schedule), next: new Date(j.next).toLocaleString() })); },
    remove(id) {
      const n = jobs.length;
      jobs = jobs.filter((j) => j.id !== id);
      save();
      return jobs.length < n;
    },
    stop() { clearInterval(timer); },
  };
}
