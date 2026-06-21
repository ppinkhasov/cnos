# cnos

Command a fleet of terminals — blank shells and AI coding agents — with your voice.

cnos launches a grid of real terminals — a **blank shell** by default, or a coding
agent (**claude, codex, hermes**) — each with its own call sign (`jack`, `zulu`,
`echo`, …), driven by voice or text. Agents can be preloaded with a specialist
**role** prompt and start in **auto mode** with **max effort**:

```
claude --permission-mode auto --effort max
```

Voice runs through **local Whisper** (whisper.cpp) — hands-free, private, offline.
No cloud speech API, no keys; audio never leaves your machine.

A native **iOS/iPadOS client** (SwiftUI + SwiftTerm) lives in [`ios/`](ios/README.md) —
the same fleet, terminals, and voice, connecting to your cnos server.

## Quick start

```bash
# one-time: install the voice engine + a model
brew install whisper-cpp ffmpeg
mkdir -p models
curl -L -o models/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin

npm install      # builds node-pty (needs Xcode CLT — already present on most Macs)
npm start
```

Then open **http://localhost:4173 in Chrome**.

1. Click **+ Add** for a **blank shell** (the default), or pick an agent type first —
   or say *“new terminal”* (shell), *“new claude terminal”*, *“new codex terminal”*…
   Each terminal gets a call sign.
2. Voice **auto-starts** — allow the mic once. Pick your input from the **🎤 selector**
   in the top bar (toggle the **🔎** panel for a live level meter + log). Then talk:
   - *“jack, build a todo app in react”* → routed to **jack**
   - *“everyone, commit your work”* → broadcast to **all** agents
   - *“new codex terminal”* → spawns a Codex agent
   - *“jack, stop”* → interrupts jack (Ctrl-C)
3. Or use the command bar at the top, or just click a terminal and type.

The UI is **mobile-responsive** — on a phone the top bar stacks, the usage meter
wraps, and agents render one per row. To open it from your phone, browse to
**`http://<your-mac-LAN-IP>:<PORT>`** on the same Wi-Fi (e.g.
`http://192.168.1.20:4173`). Voice needs a secure context (HTTPS or `localhost`),
so over plain LAN http you drive agents by **typing** in the command bar — voice
still works when you open cnos on the host machine itself.

## Agent types

| Type     | Launches                              | Auto mode                |
| -------- | ------------------------------------- | ------------------------ |
| `shell` *(default)* | your `$SHELL` (e.g. `/bin/zsh`) — a plain blank terminal, no agent | — |
| `claude` | `claude --permission-mode auto --effort max` | auto-accept edits |
| `codex`  | `codex --sandbox workspace-write --ask-for-approval on-request` | auto (workspace-write) |
| `hermes` | `hermes`                              | —                        |

**`shell` is the default** — *“new terminal”* / **+ Add** opens a blank shell; name a
type (*“new claude terminal”*, or the top-bar selector) to launch a coding agent. Role
prompts apply to agents only, not blank shells. Only the CLIs you have installed will
launch; others report a clear "not installed" message. Override any type with
`CNOS_<TYPE>_BIN` and `CNOS_<TYPE>_ARGS` (`CNOS_SHELL_BIN` for the shell).

## Working directory

The **📁 folder button** in the top bar picks the directory new agents spawn into —
click it to browse (or paste a path / `~/dev/app`, then **Use this folder**). It
applies to every new agent (manual **+ Add** and voice *"new terminal"*). The
choice is remembered across reloads; the default is `CNOS_WORKDIR` (your home dir).
Each agent card shows the directory it's running in.

## Themes & display

Click **🎨** in the top bar to restyle everything — applied instantly and remembered
across reloads:

- **16 color schemes** — cnos Dark/Light, Solarized (dark & light), Dracula, Nord,
  Tokyo Night, Catppuccin Mocha, Gruvbox, One Dark, Monokai Pro, GitHub Dark,
  **Ubuntu**, High Contrast, **Matrix**, and **Synthwave '84**. Each recolors the
  whole UI *and* the terminal palette (all 16 ANSI colors).
- **Font** — choose a monospace family (JetBrains Mono, Fira Code, IBM Plex Mono,
  Ubuntu Mono, Hack, Cascadia Code, Source Code Pro, Geist Mono, …) or leave it on
  the theme's recommended font. These fonts are **bundled** (`public/fonts/` +
  `public/fonts.css`), so they work offline regardless of what's installed.
- **Text size** — scale the terminal text from Extra Small to Extra Large.

Click **⛶** (or press F11) to toggle **fullscreen**. Themes are data in
`public/themes.js` (`CNOS_THEMES` — add your own there); the engine lives in
`public/app.js`. Terminal title bars are compact and the UI uses restrained
font-weights for a clean, low-chrome look.

## Voice grammar

```
[hey] <agent|everyone> <command…>
[hey] <agent|everyone> stop|cancel|pause         → stop the current task (Esc)
[hey] <agent|everyone> clear|erase|scratch that  → wipe typed-but-unsent input
[hey] <agent|everyone> enter|go|submit           → just press Enter
new terminal                                     → blank shell (the default)
new <claude|codex|hermes> terminal [role]        → launch that agent (optionally in a role)
new claude terminal, programmer                  → claude preloaded with the “programmer” role
```

The first word is the target. `everyone`, `all`, `team`, `fleet` broadcast.
Voice is hands-free: it auto-detects when you start and stop talking (VAD),
records the clip, and transcribes it with Whisper.

## Loop prompts

Launch any agent **preloaded with a prompt** so it boots straight into a mode or
role. Pick one in the top-bar **Loop Prompt** selector before **+ Add**, or say it —
e.g. *"new terminal, loop"* or *"new codex terminal, architect"*. The prompt is
passed as the agent's first/original prompt, and the agent card shows a badge. The
generic **loop** prompt is ours; the rest are the poc-engineering roles from
[mitsuhiko/agent-prompts](https://github.com/mitsuhiko/agent-prompts/tree/main/poc-engineering).

Bundled prompts (files live in `prompts/`):

| Say | Prompt | Prompt file |
| --- | ------ | ----------- |
| `loop` / `iterate` / `auto` | Loop | `loop_agent` — generic non-stop work loop |
| `orchestrator` / `manager` | Orchestrator | `orchestrator_agent` — delegates to managers → subagents, re-evaluates, repeats |
| `programmer` | Programmer | `implementation_agent` |
| `architect` | Architect | `software_architect_agent` |
| `designer` / `architecture` | Architecture | `architecture_design_agent` |
| `analyst` | Analyst | `problem_analysis_agent` |
| `planner` / `plan` | Planner | `detailed_planning_agent` |
| `breakdown` / `tasks` | Task breakdown | `task_breakdown_agent` |
| `lead` / `research` | Research lead | `programming_lead_agent` |

Add your own: drop a `.md` into `prompts/` and register it in `PROMPT_SPECS` (`server.js`).

For multi-agent work, launch agents with the **Orchestrator** loop prompt (it
delegates to its own subagents) — or just spawn several agents and direct them by
voice/text.

## Configuration

| Env var               | Default                                   | Meaning                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| `PORT`                | `4173`                                    | HTTP/WebSocket port                  |
| `CNOS_WORKDIR`        | your home dir                             | default working dir for agents       |
| `CNOS_<TYPE>_BIN`     | the CLI name (`claude`, `codex`, …)       | path to that agent's CLI             |
| `CNOS_<TYPE>_ARGS`    | per-type flags (see table; `shell` = none)| flags that terminal type launches with |
| `CNOS_SHELL_BIN`      | `$SHELL` (e.g. `/bin/zsh`)                | shell used for blank terminals       |
| `DEEPSEEK_API_KEY`    | `~/.hermes/.env` fallback                 | DeepSeek balance API credential      |
| `CNOS_WHISPER_BIN`    | auto (`whisper-cli`)                      | path to the whisper.cpp binary       |
| `CNOS_WHISPER_MODEL`  | `models/ggml-base.en.bin`                 | Whisper model file                   |

Examples: `CNOS_WORKDIR=~/dev/myrepo npm start` ·
`CNOS_CLAUDE_ARGS="--permission-mode acceptEdits --effort high" npm start`

## Usage meter

A strip under the top bar shows each subscription provider's rate-limit windows
and the total DeepSeek API credit balance available. It polls `GET /api/usage` every 60s;
click the strip to refresh now. Everything is **read-only**: the server reads
each CLI's existing credentials/logs and never modifies them.

| Provider | Source                                            | Freshness                                   |
| -------- | ------------------------------------------------- | ------------------------------------------- |
| `claude` | `GET /api/oauth/usage` (your Claude OAuth token)  | **live** while the token is valid           |
| `codex`  | newest `~/.codex/sessions` rollout snapshot       | last Codex API call (shown "as of …")       |
| `deepseek` | `GET /user/balance` (`DEEPSEEK_API_KEY`)       | **live** total available credit balance     |

The `claude` CLI refreshes its own OAuth token; if it has expired (no Claude
agent has run for a few hours) the meter says so and goes live again the next
time a Claude agent runs.

## How it works

```
Browser  ── xterm.js grid ──────────────── WebSocket (input/command/control) ──┐
         └─ getUserMedia → VAD → MediaRecorder ── POST /transcribe (audio) ──┐  │
                                                                             ▼  ▼
                                                       server.js (Node + Express)
                                                         │            │
                                              ffmpeg + whisper.cpp   node-pty
                                                  (transcribe)         │
                                                                       ▼
                                          shell / claude / codex / hermes  (×N)
```

The Node server owns the PTYs and transcription; the browser captures audio and
renders terminals. Spoken commands are recorded locally, transcribed by Whisper,
parsed (`<agent> <command>`), and typed into that agent's terminal. Claude's
first-run "trust this folder" prompt is auto-accepted. Multiple browser windows
stay in sync (output is broadcast; scrollback is replayed on connect). Front-end
assets in `public/` (incl. `themes.js`, `fonts.css`, and the bundled fonts) are
served with `Cache-Control: no-cache`, so edits reach the browser on a normal reload.

## ⚠️ Security

Agents run in **auto mode** (auto-accept edits), not full bypass — but they can
still make changes without prompting. Run cnos on a workdir you trust, ideally a
sandbox. **The server listens on all network interfaces** — so other devices on
your LAN (like your phone) can reach it; only run it on a network you trust. Voice
audio is transcribed **locally** by whisper.cpp and never leaves your machine.
