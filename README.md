# cnos

Your own command a fleet of AI coding agents with your voice.

cnos launches a grid of real agent terminals — **claude, codex, gemini, hermes** —
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

1. Pick a type in the top bar and click **+ Add** — or say *“new claude terminal”*,
   *“new gemini terminal”*, *“new hermes terminal”*… Each agent gets a call sign.
2. Voice **auto-starts** — allow the mic once. Pick your input from the **🎤 selector**
   in the top bar (toggle the **🔎** panel for a live level meter + log). Then talk:
   - *“jack, build a todo app in react”* → routed to **jack**
   - *“everyone, commit your work”* → broadcast to **all** agents
   - *“new gemini terminal”* → spawns a Gemini agent
   - *“jack, stop”* → interrupts jack (Ctrl-C)
3. Or use the command bar at the top, or just click a terminal and type.

## Agent types

| Type     | Launches                              | Auto mode                |
| -------- | ------------------------------------- | ------------------------ |
| `claude` | `claude --permission-mode auto --effort max` | auto-accept edits |
| `codex`  | `codex --full-auto`                   | full-auto                |
| `gemini` | `gemini --approval-mode auto_edit`    | auto-approve edits       |
| `hermes` | `hermes`                              | —                        |

Only the CLIs you have installed will launch; others report a clear "not installed"
message. Override any type with `CNOS_<TYPE>_BIN` and `CNOS_<TYPE>_ARGS`.

## Voice grammar

```
[hey] <agent|everyone> <command…>
[hey] <agent|everyone> stop|cancel              → interrupt (Ctrl-C)
[hey] <agent|everyone> enter|go|submit           → just press Enter
new|add|spawn <claude|codex|gemini|hermes> …     → launch that agent type
```

The first word is the target. `everyone`, `all`, `team`, `fleet` broadcast.
Voice is hands-free: it auto-detects when you start and stop talking (VAD),
records the clip, and transcribes it with Whisper.

## Configuration

| Env var               | Default                                   | Meaning                              |
| --------------------- | ----------------------------------------- | ------------------------------------ |
| `PORT`                | `4173`                                    | HTTP/WebSocket port                  |
| `CNOS_WORKDIR`        | your home dir                             | default working dir for agents       |
| `CNOS_<TYPE>_BIN`     | the CLI name (`claude`, `gemini`, …)      | path to that agent's CLI             |
| `CNOS_<TYPE>_ARGS`    | per-type auto-mode flags (see table)      | flags that agent type launches with  |
| `CNOS_WHISPER_BIN`    | auto (`whisper-cli`)                      | path to the whisper.cpp binary       |
| `CNOS_WHISPER_MODEL`  | `models/ggml-base.en.bin`                 | Whisper model file                   |

Examples: `CNOS_WORKDIR=~/dev/myrepo npm start` ·
`CNOS_CLAUDE_ARGS="--permission-mode acceptEdits --effort high" npm start`

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
                                          claude / codex / gemini / hermes  (×N)
```

The Node server owns the PTYs and transcription; the browser captures audio and
renders terminals. Spoken commands are recorded locally, transcribed by Whisper,
parsed (`<agent> <command>`), and typed into that agent's terminal. Claude's
first-run "trust this folder" prompt is auto-accepted. Multiple browser windows
stay in sync (output is broadcast; scrollback is replayed on connect).

## ⚠️ Security

Agents run in **auto mode** (auto-accept edits), not full bypass — but they can
still make changes without prompting. Run cnos on a workdir you trust, ideally a
sandbox. The server binds to localhost. Voice audio is transcribed **locally** by
whisper.cpp and never leaves your machine.
