# cnos

Your own [cnvs.dev](https://cnvs.dev): command a fleet of Claude CLI agents with your voice.

cnos launches a grid of real `claude` terminals — each with its own call sign
(`jack`, `zulu`, `echo`, …) — and lets you orchestrate them by voice or text.
Every agent starts in **auto mode** with **max effort**:

```
claude --dangerously-skip-permissions --effort max
```

Voice runs through **local Whisper** (whisper.cpp) — hands-free, private, and
offline. No cloud speech API, no keys, audio never leaves your machine.

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

1. Click **+ Add agent** (or say *“new terminal”*) to spawn a Claude terminal.
2. Voice **auto-starts** — allow the mic once. The diagnostics panel (bottom-left)
   shows a live input-level meter so you can see it hearing you. Then talk:
   - *“jack, build a todo app in react”* → routed to **jack**
   - *“zulu, fix the failing tests”* → routed to **zulu**
   - *“everyone, commit your work”* → broadcast to **all** agents
   - *“new terminal”* → spawns another agent
   - *“jack, stop”* → interrupts jack (Ctrl-C)
3. Or use the command bar at the top, or just click a terminal and type.

## Voice grammar

```
[hey] <agent|everyone> <command…>
[hey] <agent|everyone> stop|cancel         → interrupt (Ctrl-C)
[hey] <agent|everyone> enter|go|submit      → just press Enter
new|add|spawn <terminal|agent|cli>          → launch a new agent
```

The first word is the target. `everyone`, `all`, `team`, `fleet` broadcast.
Voice is hands-free: it auto-detects when you start and stop talking (VAD),
records the clip, and transcribes it with Whisper.

## Configuration

| Env var              | Default                                        | Meaning                          |
| -------------------- | ---------------------------------------------- | -------------------------------- |
| `PORT`               | `4173`                                         | HTTP/WebSocket port              |
| `CNOS_WORKDIR`       | your home dir                                  | default working dir for agents   |
| `CNOS_CLAUDE_BIN`    | `claude`                                       | path to the Claude CLI           |
| `CNOS_CLAUDE_ARGS`   | `--dangerously-skip-permissions --effort max` | flags every agent launches with  |
| `CNOS_WHISPER_BIN`   | auto (`whisper-cli`)                           | path to the whisper.cpp binary   |
| `CNOS_WHISPER_MODEL` | `models/ggml-base.en.bin`                      | Whisper model file               |

Example: `CNOS_WORKDIR=~/dev/myrepo PORT=5000 npm start`

Want faster (less accurate) or more accurate voice? Swap the model:
`ggml-tiny.en.bin` (fastest) · `ggml-base.en.bin` (default) · `ggml-small.en.bin` (most accurate).

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
                                       claude --dangerously-skip-permissions --effort max  (×N)
```

The Node server owns the PTYs and transcription; the browser captures audio and
renders terminals. Spoken commands are recorded locally, sent to the server,
transcribed by Whisper, parsed (`<agent> <command>`), and typed into that
agent's terminal. Multiple browser windows stay in sync (output is broadcast;
scrollback is replayed on connect).

## ⚠️ Security

`--dangerously-skip-permissions` lets each agent run any command **without
asking**. Run cnos only on a machine/workdir where you trust that, ideally a
sandbox. The server binds to localhost. Voice audio is transcribed **locally**
by whisper.cpp and never leaves your machine.
