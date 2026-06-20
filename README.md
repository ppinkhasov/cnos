# cnos

Your own command a fleet of AI coding agents with your voice.

cnos launches a grid of real agent terminals — **claude, codex, hermes** —
each with its own call sign (`jack`, `zulu`, `echo`, …) — and lets you orchestrate
them by voice or text. Claude starts in **auto mode** with **max effort**:

```
claude --permission-mode auto --effort max
```

Voice runs through **local Whisper** (whisper.cpp) — hands-free, private, offline.
No cloud speech API, no keys; audio never leaves your machine.

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

1. Pick a type in the top bar and click **+ Add** — or say *“new claude terminal”*
   or *“new hermes terminal”*… Each agent gets a call sign.
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
| `claude` | `claude --permission-mode auto --effort max` | auto-accept edits |
| `codex`  | `codex --sandbox workspace-write --ask-for-approval on-request` | auto (workspace-write) |
| `hermes` | `hermes`                              | —                        |

Only the CLIs you have installed will launch; others report a clear "not installed"
message. Override any type with `CNOS_<TYPE>_BIN` and `CNOS_<TYPE>_ARGS`.

## Working directory

The **📁 folder button** in the top bar picks the directory new agents spawn into —
click it to browse (or paste a path / `~/dev/app`, then **Use this folder**). It
applies to every new agent: manual **+ Add**, voice *"new terminal"*, and the whole
orchestrator fleet (lead + workers). The choice is remembered across reloads; the
default is `CNOS_WORKDIR` (your home dir). Each agent card shows the directory it's
running in.

## Voice grammar

```
[hey] <agent|everyone> <command…>
[hey] <agent|everyone> stop|cancel|pause         → stop the current task (Esc)
[hey] <agent|everyone> clear|erase|scratch that  → wipe typed-but-unsent input
[hey] <agent|everyone> enter|go|submit           → just press Enter
new|add|spawn <claude|codex|hermes> …            → launch that agent type
```

The first word is the target. `everyone`, `all`, `team`, `fleet` broadcast.
Voice is hands-free: it auto-detects when you start and stop talking (VAD),
records the clip, and transcribes it with Whisper.

## Orchestrate (goal → fleet)

Flip **Orchestrate** on, type a **goal**, and press **Start**. cnos spawns a
**lead** agent plus a few **workers** and runs an autonomous
*perceive → reason → act → observe* loop until the goal is met:

- The **lead** (a Claude agent) breaks the goal into subtasks and delegates them,
  emitting `@@CNOS` directives the server reads from its terminal.
- The server **dispatches** each task to an idle worker, **watches** for it to go
  quiet (done), and **reports** the result back to the lead.
- When every worker is busy and work remains, cnos **auto-spawns** another worker
  (up to the **Max** cap). It stops when the lead declares the goal complete.

You set the **goal**, the worker **type**, how many **workers** to start with
(default 3), and the **Max** agent cap (default 8). A live panel shows each
agent's state and an activity feed of the lead's decisions; **Stop** halts the
loop and leaves the agents running. The lead is always a `claude` agent (it needs
the directive protocol); override its model/flags with `CNOS_LEAD_ARGS`.

## Configuration

| Env var               | Default                                   | Meaning                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| `PORT`                | `4173`                                    | HTTP/WebSocket port                  |
| `CNOS_WORKDIR`        | your home dir                             | default working dir for agents       |
| `CNOS_<TYPE>_BIN`     | the CLI name (`claude`, `codex`, …)       | path to that agent's CLI             |
| `CNOS_<TYPE>_ARGS`    | per-type auto-mode flags (see table)      | flags that agent type launches with  |
| `CNOS_LEAD_ARGS`      | (none)                                    | extra flags for the orchestrator lead (e.g. `--model sonnet`) |
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
                                                claude / codex / hermes  (×N)
```

The Node server owns the PTYs and transcription; the browser captures audio and
renders terminals. Spoken commands are recorded locally, transcribed by Whisper,
parsed (`<agent> <command>`), and typed into that agent's terminal. Claude's
first-run "trust this folder" prompt is auto-accepted. Multiple browser windows
stay in sync (output is broadcast; scrollback is replayed on connect).

## ⚠️ Security

Agents run in **auto mode** (auto-accept edits), not full bypass — but they can
still make changes without prompting. Run cnos on a workdir you trust, ideally a
sandbox. **The server listens on all network interfaces** — so other devices on
your LAN (like your phone) can reach it; only run it on a network you trust. Voice
audio is transcribed **locally** by whisper.cpp and never leaves your machine.
