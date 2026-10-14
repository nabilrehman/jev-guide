# jev-guide

Say (or type) what you want done in the browser. Chrome opens and does it **live**, with an
on-screen cursor, a highlight ring around every control it's about to click, and a caption bar
showing the current instruction. Optionally records the session to a video.

Decisions are made by **Jev** (TypeSafe AI's System One model): per step it picks one action
from the page's real DOM elements in ~200–400 ms. Jev never generates text, so URLs come from a
site catalog and typed text comes from what you said.

```
🎤 > go to google cloud console, then click on billing, then click on budgets and alerts
📋 3 steps: (1) go to google cloud console  (2) click on billing  (3) click on budgets and alerts
▶ Step 1/3: go to google cloud console
   1. go to https://console.cloud.google.com/   [p=1.00 goal=0.01]
   2. done                                       [p=0.98 goal=0.94]
▶ Step 2/3: click on billing
   1. click link "Billing"                        [p=0.96 goal=0.04]
   ...
```

## Agent mode: a voice assistant for the whole Mac (`--agent`)

```sh
npm run agent          # or: jev-guide --agent
```

Hold **right ⌥ Option** anywhere on the Mac, say what you want, and let go. Tap it while
it's working to stop. You can also type requests in the terminal.

```
🗣  "Download this file, then put it in claude.ai and ask what the main risks are"
🔧 mac_read_screen                      ← what are you looking at? finds the PDF link
🔧 chrome_download url="https://…/contract.pdf"
🔧 chrome_open_url url="https://claude.ai/new"
🔧 chrome_attach_file path="~/Downloads/contract.pdf"
🔧 chrome_do instruction="type into the message box and press Enter" text="What are the main risks in this contract?"
💬 "I attached the contract on claude.ai and asked about its main risks."
```

How it fits together, all on the one `OPENROUTER_API_KEY`:

| Part | What | Where |
|---|---|---|
| Voice | **Gemini Live** (`gemini-3.8-live`, Vertex us-central1): hold-to-talk mic streamed from `mac/axhelper`; Live acknowledges, calls the planner as a background `run_task` tool, and speaks the result. `JEV_VOICE=classic` switches back to the row below | `src/agent/live.js` |
| Ears (classic) | Hold-to-talk recorder in `mac/axhelper` → Chirp 3 (Google Cloud, ADC) for recordings up to 55 s; Gemini 3.5 Transcribe (AI Studio key) for longer ones, falling back to Chirp 3 in pieces | `src/stt.js` |
| Brain | Google ADK (TypeScript) agent, planning with Gemini 3.8 Flash on Vertex AI (Claude via OpenRouter still possible) | `src/agent/orchestrator.js`, `src/agent/gemini_llm.js` |
| Hands | Tools: `chrome_open_url/read_page/do/download/attach_file`, `mac_read_screen/open_app/do/type/hotkey`, `list_recent_files` | `src/agent/tools.js` |
| Clicks | Jev (via OpenRouter, the only thing that uses it) picks each click inside every `chrome_do` / `mac_do` step | `src/cli.js` `Runner.runOne` |

The planner writes any text (questions, notes, search terms) and hands it to Jev as exact
text; Jev never has to write anything. Replies are read aloud with Gemini 3.8 Flash TTS (`--quiet` to turn that off).
Each request starts fresh, with a short note of the last few requests, so "now summarize it into a note" works. `/reset` clears it.

Settings (`.env`):
- `OPENROUTER_API_KEY`: Jev only.
- `JEV_AGENT_GCP_PROJECT`, `JEV_AGENT_GCP_LOCATION` (`global`): Google Cloud
  project for the planner and speech-to-text, using Application Default Credentials
  (`gcloud auth application-default login`). Without it, `GEMINI_API_KEY` (AI Studio) is used for the planner.
- `JEV_AGENT_MODEL` (default `gemini-3.8-flash`; an `anthropic/...` id switches back to Claude via OpenRouter),
  `JEV_AGENT_THINKING` (default `LOW`), `JEV_AGENT_MAX_CALLS` (default 30).
- `JEV_STT_MODEL` (default `chirp_3`), `JEV_STT_LOCATION` (default `us`) for short recordings;
  `JEV_STT_LONG_MODEL` (default `gemini-3.5-transcribe`, needs `GEMINI_API_KEY`) for ones over 55 s.
- `JEV_VOICE` (`live` default, or `classic`), `JEV_LIVE_MODEL` (default `gemini-3.8-live`), `JEV_LIVE_GCP_LOCATION`
  (default `us-central1`; Live isn't in `global`), `JEV_LIVE_VOICE` (default `Kore`).
- `JEV_TTS_MODEL` (required for spoken replies), `JEV_TTS_VOICE` (default `Kore`). Replies fall back to macOS `say` if TTS fails.
- `JEV_PTT_KEY` (`right_option` default, `right_command`, `right_control`, `fn`).

### Long tasks

Requests the router sizes as **long** ("work through this Khan Academy unit, lesson by lesson")
run as a series of **rounds**. Each round is a fresh planner session (Gemini 3.8 Flash, ≤40 calls)
that starts from the goal plus the planner's own notes, which it saves with `save_progress` after
each unit. Notes persist in `~/.jev-guide/tasks.json`, so a stop, crash or restart doesn't lose them.

- `chrome_wait` waits for page timers, videos and locked buttons instead of re-reading the page:
  a set number of seconds (e.g. the countdown on screen), or until text appears or disappears, a
  button like Next becomes clickable, or the video ends. `chrome_read_page` now lists buttons and
  quiz choices with `disabled` / `selected`, and video position and duration (embedded players included).
- Stop (tap the hotkey) pauses the task; say "resume the course" to carry on (`resume_long_task`).
  On sign-in, verification or CAPTCHA it pauses and asks you, then resumes when you say so.
- A task pauses at `JEV_LONG_MAX_USD` (default 5) or `JEV_LONG_MAX_HOURS` (default 8) in total, or
  after 3 rounds in a row without saved progress. `JEV_TIER_LONG` sets the per-round model,
  thinking and call cap (default `gemini-3.8-flash:LOW:40`).
- Other requests wait behind a running long task; stop it first to do something else.
- Quizzes: it reads the question and choices, answers, and reads the feedback. Courses or exams
  that certify you personally (court, license, official credential) or ask identity questions are
  handed back to you.

The Chrome tools use jev-guide's own Chrome window (profile `~/.jev-guide/chrome-profile`).
Sign in to the sites you want it to use there once, e.g. claude.ai. The Mac tools drive any app,
including your normal Chrome. Permissions: Accessibility + Microphone for your terminal (or for
**Jev Guide** when you use the app from `npm run install-app`, which now starts agent mode in
the menu bar).

## Two modes

| | Browser mode (default) | Mac mode (`--mac`) |
|---|---|---|
| Eyes | Chrome DOM via Playwright | macOS Accessibility tree of the front app |
| Hands | Playwright clicks/typing | Real cursor + synthetic clicks, keystrokes, hotkeys, menu items, `open -a` |
| Overlay | In-page cursor, ring, caption | Floating caption bar + red ring windows over any app |
| Recording | Page video (.webm/.mp4) | Whole screen (`screencapture`, .mov) |
| Login | Persistent Chrome profile | You're already logged in everywhere |

```
jev-guide --mac
🎤 > open notes, then create a new note, then type "Groceries: milk, eggs"
🎤 > open system settings, then click on displays, then click on night shift
🎤 > open chrome, then go to google cloud billing
```

## Setup

```sh
npm install
cp .env.example .env        # add OPENROUTER_API_KEY=sk-or-...  (or TYPESAFE_API_KEY)
npm start                    # interactive prompt
```

**Install as a Mac app** (no terminal needed afterwards):

```sh
npm run install-app          # creates /Applications/Jev Guide.app
```

Then open **Jev Guide** from Spotlight (⌘Space), Launchpad, or the Dock. Chrome opens with the
🎤 button. Close the Chrome window to quit. Logs go to `~/.jev-guide/app.log`. The app runs this
folder's code, so edits apply on the next launch. Re-run the install if you move the folder.

Uses your installed Google Chrome via Playwright. If Chrome is missing: `npx playwright install chrome`.

**Login once.** Chrome runs with a persistent profile at `~/.jev-guide/chrome-profile`.
The first time you hit Google Cloud you'll see a sign-in page; jev-guide pauses, you sign in
in that window, and it continues. Later sessions stay signed in.

## Usage

```sh
jev-guide                                   # interactive: type or dictate instructions
jev-guide "go to github, then click pricing" # one-shot
jev-guide --record                          # save ./recordings/*.mp4 (needs ffmpeg for mp4; else .webm)
jev-guide --voice                           # push-to-talk with local whisper.cpp
jev-guide --start https://console.cloud.google.com
jev-guide --lexical "..."                   # offline keyword matcher (no API key, dumb; smoke tests only)
```

Interactive commands: `/quit`, `/url`, `/steps off`.

### Mac mode

```sh
jev-guide --mac              # first run compiles mac/axhelper (needs Xcode Command Line Tools)
jev-guide --mac --record     # whole-screen .mov into ./recordings/
```

Permissions (System Settings → Privacy & Security), granted to **your terminal app**
(Terminal, iTerm, Cursor, …), since that is what launches the helper:

- **Accessibility** — required. macOS prompts on first run.
- **Screen Recording** — only for `--record`.
- **Microphone** — only for `--voice`.

What Jev can choose from on each step in Mac mode: every visible control of the front app
(buttons, rows, tabs, fields, links inside Chrome/Electron too), the app's menu bar items,
common hotkeys (⌘S, ⌘N, ⌘W, ⌘Z, …), installed/running apps to open, and the site catalog.
It never drives your terminal; if the terminal is in front it targets the last app it used.

### Voice

Three options:

0. **Mic button in Chrome (easiest, browser mode):** run `npm start`, then in the Chrome window
   click the blue 🎤 button (bottom-right, on every page) or press **⌥ Option+Space** and speak.
   Click again, or just stop talking, to send. The mic turns grey while a command runs. Click it
   then to stop the command. It uses Chrome's built-in speech recognition, so ffmpeg and whisper
   aren't needed. Spoken and typed commands share one queue.
1. **Zero install:** in the interactive prompt press **Fn Fn** (macOS Dictation) and speak.
   The transcript lands in the prompt; press Enter.
2. **`--voice` (push-to-talk, fully local):**
   ```sh
   brew install whisper-cpp ffmpeg
   jev-guide --voice
   ```
   Press Enter to start talking, Enter to stop. The base.en model (~148 MB) downloads on first
   use to `~/.jev-guide/`. Set `JEV_MIC=":1"` if your mic isn't device 0 (`jev-guide --list-mics`).

### How instructions are interpreted

- `then`, `after that`, `next`, `, and` split one utterance into sequential steps.
- Each step loops: snapshot visible elements → Jev picks `click_<el>` / `type_<el>` /
  `goto_<site>` / scroll / back / done, and scores *goal met* and *stuck* in the same call.
- Typing: text comes from quotes (`type "hello"`) or verbs (`search for weather in SF`).
- Sites: built-in catalog (Google Cloud console/billing/IAM/BigQuery/…, Gmail, GitHub, AWS, …).
  Add your own in `~/.jev-guide/sites.json`:
  ```json
  { "my_dashboard": { "url": "https://…", "description": "Internal admin dashboard" } }
  ```
  Explicit URLs in speech also work: "go to example dot com slash pricing".

## Layout

```
bin/jev-guide.js      entrypoint
src/mac.js            Mac driver (talks JSON-lines to mac/axhelper)
mac/axhelper.swift    Accessibility tree dump, press/type/hotkey/scroll, cursor glide, overlays
src/cli.js            REPL, step runner, stop conditions, login-wall pause
src/brain.js          Jev call: action Choice + goal/stuck Nouls (+ text choice, submit)
src/browser.js        Playwright/Chrome, DOM element harvest (pierces shadow DOM), animated cursor
src/overlay.js        in-page cursor / highlight / caption CSS+JS
src/instructions.js   step splitting, text-candidate extraction
src/sites.js          site catalog + URL extraction
src/voice.js          ffmpeg + whisper.cpp push-to-talk
src/stt.js            speech-to-text: Chirp 3 (short) / Gemini 3.5 Transcribe (long)
src/tts.js            Gemini 3.8 Flash TTS for spoken replies
src/agent/main.js     --agent: hold-to-talk loop, queue, menu bar, spoken replies
src/agent/orchestrator.js  ADK LlmAgent + system instruction
src/agent/live.js       Gemini Live voice front end (run_task / stop_task tools)
src/agent/gemini_llm.js      ADK Gemini planner (Vertex/AI Studio) with cost log, low thinking, retry
src/agent/openrouter_llm.js  ADK BaseLlm connector for OpenRouter (optional Claude planner)
src/agent/tools.js    chrome_* / mac_* / file / long-task tools the planner calls
src/agent/router.js   Flash-Lite sizes each request: small / complex / large / long
src/agent/tasks.js    long tasks: goal + progress notes in ~/.jev-guide/tasks.json
```

## Notes / limits

- Mac mode sees only what apps expose to Accessibility. Native and Electron apps are fine;
  games, canvas-only UIs, and unlabeled icon buttons are invisible to Jev.

- Jev sees text, not pixels: canvas-only UIs or icon buttons without labels are invisible to it.
- Pages with >240 controls are trimmed (in-viewport + instruction-keyword overlap first).
- Google occasionally refuses sign-in in automated browsers. If that happens, sign in to Google
  in that same Chrome window through a regular site (e.g. gmail.com) first.
- Recording captures the page viewport (cursor + captions included), not the whole screen.
