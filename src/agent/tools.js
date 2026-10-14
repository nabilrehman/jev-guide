// Tools the planner can call. Two sets of hands, both driven by Jev click-by-click:
//   chrome_* : jev-guide's own Chrome window (Playwright, persistent logged-in profile)
//   mac_*    : whatever app is in front on the Mac (Accessibility)
// Anything that needs writing (URLs, questions, note text) is written by the planner
// and handed to Jev as exact text; Jev only picks where to click and type.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { FunctionTool } from "@google/adk";
import { z } from "zod";

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + " …" : s);
// Claude Code runs headless (claude -p) inside one folder. dontAsk mode refuses anything not listed
// here (rm, installs, git push, network...) without prompting. Override with JEV_CLAUDE_TOOLS.
const CLAUDE_BIN = process.env.JEV_CLAUDE_BIN || [path.join(os.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"].find((p) => fs.existsSync(p)) || "claude";
const CLAUDE_TOOLS = (process.env.JEV_CLAUDE_TOOLS || "Read,Glob,Grep,Edit,Write,Bash(ls:*),Bash(mkdir:*),Bash(mv:*),Bash(cp:*),Bash(cat:*),Bash(head:*),Bash(wc:*),Bash(file:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(npm test:*)").split(",");
const CLAUDE_BUDGET = process.env.JEV_CLAUDE_BUDGET_USD || "2";
const CLAUDE_TIMEOUT_MS = (Number(process.env.JEV_CLAUDE_TIMEOUT_MIN) || 10) * 60_000;

const expandHome = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

export function buildTools(hands) {
  const safe = (fn) => async (args) => {
    if (hands.stopped) return { ok: false, error: "stopped by the user; do nothing else" };
    try { return await fn(args || {}); } catch (e) { return { ok: false, error: e.message.split("\n")[0].slice(0, 300) }; }
  };

  return [
    // ---------- Chrome ----------
    new FunctionTool({
      name: "chrome_open_url",
      description: "Open a URL in the jev-guide Chrome window (its own profile, where the user is logged in to the sites they use with it). Fastest way to get to a site.",
      parameters: z.object({ url: z.string().describe("Full URL, e.g. https://claude.ai/new") }),
      execute: safe(async ({ url }) => {
        const b = await hands.browser();
        await b.page.bringToFront().catch(() => {});
        await b.goto(url);
        return { ok: true, url: b.page.url(), title: await b.page.title().catch(() => "") };
      }),
    }),
    new FunctionTool({
      name: "chrome_read_page",
      description: "Read the current page in the jev-guide Chrome window: URL, title, visible text, and links with their real hrefs. Use it to find a file's URL or to read an answer on the page.",
      parameters: z.object({}),
      execute: safe(async () => {
        const b = await hands.browser();
        const p = await b.readPage();
        return { ok: true, ...p, text: clip(p.text, 6000) };
      }),
    }),
    new FunctionTool({
      name: "chrome_do",
      description: "Do ONE concrete UI step in the jev-guide Chrome window, e.g. 'click the Billing link', 'type into the message box and press Enter', 'open the account menu'. Jev picks the clicks. Keep it to one simple step; call again for the next one. If the step types something, put the exact words in `text`.",
      parameters: z.object({
        instruction: z.string().describe("One concrete step, phrased as an instruction"),
        text: z.string().optional().describe("Exact text to type, if this step types anything"),
      }),
      execute: safe(async ({ instruction, text }) => {
        const b = await hands.browser();
        await b.page.bringToFront().catch(() => {});
        const ok = await hands.chromeRunner.runOne(instruction, { text });
        return { ok, url: b.page.url(), title: await b.page.title().catch(() => "") };
      }),
    }),
    new FunctionTool({
      name: "chrome_wait",
      description: "Wait in the jev-guide Chrome window instead of re-reading the page over and over: for a page timer, a video, or something loading. "
        + "Give seconds (the most to wait, up to 900) and optionally a condition to stop early: until_text appears, until_gone disappears (e.g. a countdown), "
        + "until_enabled names a button or link that must become clickable (e.g. 'Next'), or until_media_ended for videos/audio on the page. "
        + "With only seconds it simply waits that long, e.g. the time a countdown on screen shows. Start a paused video first; waiting does not play it.",
      parameters: z.object({
        seconds: z.number().describe("Longest wait in seconds (max 900)"),
        until_text: z.string().optional(),
        until_gone: z.string().optional(),
        until_enabled: z.string().optional().describe("Label of a button/link that must become enabled"),
        until_media_ended: z.boolean().optional(),
      }),
      execute: safe(async ({ seconds, until_text, until_gone, until_enabled, until_media_ended }) => {
        const b = await hands.browser();
        await hands.caption(`Waiting${until_enabled ? ` for ${until_enabled}` : until_media_ended ? " for the video" : ""} (up to ${Math.round(seconds)}s)`, "⏳");
        const r = await b.waitFor({ seconds, text: until_text, gone: until_gone, enabled: until_enabled, media_ended: until_media_ended }, () => hands.stopped);
        const media = await b.mediaState();
        return { ok: !r.stopped, ...r, ...(media.length ? { media } : {}) };
      }),
    }),
    new FunctionTool({
      name: "chrome_download",
      description: "Download a file by URL (using the jev-guide Chrome window's cookies) into ~/Downloads. Returns the saved path. Get the URL from chrome_read_page or mac_read_screen first.",
      parameters: z.object({ url: z.string() }),
      execute: safe(async ({ url }) => {
        const b = await hands.browser();
        await hands.caption(`Downloading ${clip(url, 80)}`, "⬇");
        return { ok: true, ...(await b.downloadUrl(url)) };
      }),
    }),
    new FunctionTool({
      name: "chrome_attach_file",
      description: "Attach/upload a local file on the current page of the jev-guide Chrome window (e.g. a chat's attach button). Hands the file over directly, so the Mac file picker never opens.",
      parameters: z.object({
        path: z.string().describe("Absolute path, or ~/..."),
        attach_button: z.string().optional().describe("Only if the page has no file input: which button opens the upload, e.g. 'the paperclip / attach files button'"),
      }),
      execute: safe(async ({ path: p, attach_button }) => {
        const b = await hands.browser();
        const file = expandHome(p);
        const r = await b.attachFile(file, async () => {
          const ok = await hands.chromeRunner.runOne(`click ${attach_button || "the attach / upload file button"}`);
          if (!ok) throw new Error("could not find the attach button");
        });
        return { ok: true, attached: path.basename(file), ...r };
      }),
    }),

    // ---------- Mac ----------
    new FunctionTool({
      name: "mac_read_screen",
      description: "Read the app in front on the Mac (the one the user is looking at): app name, window title, visible text, and controls (links include href=...). Use first when the user says 'this' / 'here' about something on screen.",
      parameters: z.object({}),
      execute: safe(async () => {
        const snap = await hands.mac.snapshot(120, []);
        return {
          ok: true, app: snap.app, window: snap.title, text: clip(snap.text, 3000),
          controls: snap.elements.slice(0, 120).map((e) => `${e.kind}: ${e.label}${e.extra ? " (" + e.extra + ")" : ""}`),
        };
      }),
    }),
    new FunctionTool({
      name: "mac_open_app",
      description: "Open or switch to a Mac app by name, e.g. 'Notes', 'System Settings', 'Google Chrome', 'Finder'.",
      parameters: z.object({ name: z.string() }),
      execute: safe(async ({ name }) => {
        const match = hands.installedApps.find((a) => a.toLowerCase() === name.toLowerCase()) || name;
        await hands.caption(`Opening ${match}`, "");
        await hands.mac.openApp(match);
        return { ok: true, app: match };
      }),
    }),
    new FunctionTool({
      name: "mac_do",
      description: "Do ONE concrete UI step in the app in front on the Mac, e.g. 'click New Note', 'click Displays in the sidebar', 'choose File > Export as PDF'. Jev picks the clicks, menu items and hotkeys. If the step types something, put the exact words in `text`.",
      parameters: z.object({
        instruction: z.string(),
        text: z.string().optional().describe("Exact text to type, if this step types anything"),
      }),
      execute: safe(async ({ instruction, text }) => {
        const ok = await hands.macRunner.runOne(instruction, { text });
        const a = await hands.mac.apps();
        return { ok, frontmost_app: a.frontmost };
      }),
    }),
    new FunctionTool({
      name: "mac_type",
      description: "Type text into whatever has keyboard focus in the front Mac app (e.g. the body of a new note). Use after the right field is focused.",
      parameters: z.object({ text: z.string(), press_enter: z.boolean().optional() }),
      execute: safe(async ({ text, press_enter }) => {
        await hands.caption(`Typing: ${clip(text, 80)}`, "");
        await hands.mac.ensureTarget();
        await hands.mac.type(null, text, { submit: !!press_enter });
        return { ok: true };
      }),
    }),
    new FunctionTool({
      name: "mac_hotkey",
      description: "Press a keyboard shortcut in the front Mac app, e.g. 'cmd+n', 'cmd+shift+d', 'return', 'escape'.",
      parameters: z.object({ combo: z.string() }),
      execute: safe(async ({ combo }) => { await hands.mac.ensureTarget(); await hands.mac.hotkey(combo); return { ok: true }; }),
    }),

    // ---------- scheduling ----------
    new FunctionTool({
      name: "schedule_task",
      description: "Save a task to run automatically later: once at a date and time, every N minutes, or on a cron schedule. "
        + "Use it when the user asks for something to happen at a later time or repeatedly (\"tomorrow at 7 book...\", \"every morning...\"), instead of doing it now. "
        + "Give exactly one of: at (local date-time like 2026-10-03T07:00:00), every_minutes, or cron (5 fields, local time, e.g. \"0 9 * * 1-5\"). "
        + "task is the full request to carry out at that time, in the user's words, without the timing part.",
      parameters: z.object({ task: z.string(), at: z.string().optional(), every_minutes: z.number().optional(), cron: z.string().optional() }),
      execute: safe(async (args) => {
        const job = hands.scheduler.add(args);
        return { ok: true, id: job.id, next_run: new Date(job.next).toLocaleString() };
      }),
    }),
    new FunctionTool({
      name: "list_scheduled_tasks",
      description: "List the saved scheduled tasks with their ids and next run times.",
      parameters: z.object({}),
      execute: safe(async () => ({ ok: true, tasks: hands.scheduler.list() })),
    }),
    new FunctionTool({
      name: "cancel_scheduled_task",
      description: "Delete a scheduled task by id (get ids from list_scheduled_tasks).",
      parameters: z.object({ id: z.string() }),
      execute: safe(async ({ id }) => ({ ok: hands.scheduler.remove(id) })),
    }),

    // ---------- long tasks ----------
    new FunctionTool({
      name: "save_progress",
      description: "Only while working on a long task: record where you are so the next round (or a resume after a stop) carries on from here. "
        + "Call it after each unit of work you finish (a lesson, page, item) and before your steps for this round run out. "
        + "progress replaces the previous notes, so include everything the next round needs: what is done, where you are now (page/URL), and what comes next. "
        + "Set finished=true when the whole goal is done; set needs_user to a short question when you are blocked on the user (sign-in, verification, a decision).",
      parameters: z.object({ progress: z.string(), finished: z.boolean().optional(), needs_user: z.string().optional() }),
      execute: safe(async ({ progress, finished, needs_user }) => {
        const t = hands.longTask;
        if (!t) return { ok: false, error: "no long task is running; just carry on" };
        hands.tasks.update(t, { progress, status: finished ? "done" : needs_user ? "needs_user" : "running", question: needs_user || "" });
        t.saved = true;
        return { ok: true, note: finished || needs_user ? "saved; stop now and reply with a short summary" : "saved; keep going" };
      }),
    }),
    new FunctionTool({
      name: "list_long_tasks",
      description: "List the user's long tasks (running in rounds, e.g. working through a course) with their status, progress notes, ids, time and cost so far.",
      parameters: z.object({}),
      execute: safe(async () => ({ ok: true, tasks: hands.tasks.list() })),
    }),
    new FunctionTool({
      name: "resume_long_task",
      description: "Continue a paused or waiting long task (get ids from list_long_tasks). It starts right after your reply, so just say it is resuming. "
        + "note passes on anything the user just told you, e.g. that they finished signing in.",
      parameters: z.object({ id: z.string(), note: z.string().optional() }),
      execute: safe(async ({ id, note }) => {
        const t = hands.tasks.get(id);
        if (!t) return { ok: false, error: `no long task ${id}` };
        if (t.status === "done") return { ok: false, error: "that task is already finished" };
        hands.resumeTask = { id, note: note || "" };
        return { ok: true, goal: t.goal, progress: t.progress };
      }),
    }),

    // ---------- Claude Code ----------
    new FunctionTool({
      name: "claude_code",
      description: "Hand a code or file job to Claude Code, a coding agent that reads, writes and reorganizes files in one folder and runs safe commands there. "
        + "Use it for programming (explain, fix, change or write code in a project), scripts, and bulk file work (sort, rename, move, summarize documents). "
        + "It works only inside `folder` (a folder in the user's home, e.g. ~/Downloads or a project folder). It cannot delete files, install software, use the network, or push to git. "
        + "Give the full task in plain words. Takes from seconds to several minutes; returns Claude Code's report.",
      parameters: z.object({ task: z.string(), folder: z.string() }),
      execute: safe(async ({ task, folder }) => {
        const dir = path.resolve(expandHome(folder));
        const rel = path.relative(os.homedir(), dir);
        if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep)[0].startsWith(".") || rel.split(path.sep)[0] === "Library")
          return { ok: false, error: `folder must be inside the home folder (not the home folder itself, Library, or hidden folders): ${dir}` };
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: `no such folder: ${dir}` };
        const args = ["-p", task, "--output-format", "json", "--permission-mode", "dontAsk", "--strict-mcp-config", "--no-session-persistence",
          "--max-budget-usd", CLAUDE_BUDGET, "--allowedTools", ...CLAUDE_TOOLS,
          // Chained commands (a && b, loops, pipes) don't match the allowed list and get refused whole.
          "--append-system-prompt", "Permissions are fixed and nobody can approve more. Run one simple command per Bash call: no &&, ;, pipes or loops. Deleting files is not allowed."];
        const out = await new Promise((resolve, reject) => {
          const child = spawn(CLAUDE_BIN, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
          hands.claudeChild = child;
          let stdout = "", stderr = "";
          child.stdout.on("data", (d) => (stdout += d));
          child.stderr.on("data", (d) => (stderr += d));
          const timer = setTimeout(() => child.kill("SIGTERM"), CLAUDE_TIMEOUT_MS);
          child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not start Claude Code (${CLAUDE_BIN}): ${e.message}`)); });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (hands.claudeChild === child) hands.claudeChild = null;
            if (hands.stopped) return reject(new Error("stopped by the user"));
            if (signal) return reject(new Error(`Claude Code was stopped after ${CLAUDE_TIMEOUT_MS / 60_000} minutes`));
            try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Claude Code exited ${code}: ${(stderr || stdout).trim().slice(-300)}`)); }
          });
        });
        const refused = (out.permission_denials || []).map((d) => d.tool_input?.command || d.tool_name);
        // total_cost_usd is the API-price equivalent; with a Claude subscription login it is covered by the plan.
        console.log(`   · claude code ${(out.duration_ms / 1000).toFixed(1)}s · ${out.num_turns} turns · ~$${(out.total_cost_usd || 0).toFixed(3)} API-equivalent${refused.length ? ` · refused: ${refused.join("; ").slice(0, 160)}` : ""}`);
        return { ok: !out.is_error, report: clip(out.result || "", 2000), ...(refused.length ? { refused } : {}) };
      }),
    }),

    // ---------- files ----------
    new FunctionTool({
      name: "list_recent_files",
      description: "List the most recently modified files in a folder (default ~/Downloads), newest first. At most 50; also returns the total count.",
      parameters: z.object({ folder: z.string().optional(), limit: z.number().optional() }),
      execute: safe(async ({ folder, limit }) => {
        const dir = expandHome(folder || "~/Downloads");
        const all = fs.readdirSync(dir).filter((f) => !f.startsWith("."))
          .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, modified: st.mtime.toISOString().slice(0, 16), kb: Math.round(st.size / 1024), ...(st.isDirectory() ? { dir: true } : {}) }; })
          .sort((a, b) => b.modified.localeCompare(a.modified));
        return { ok: true, folder: dir, total: all.length, files: all.slice(0, Math.min(limit || 10, 50)) };
      }),
    }),
  ];
}
