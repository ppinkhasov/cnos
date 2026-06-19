// cnos — Voice-orchestrated fleet of Claude CLI agents.
//
// Spawns real `claude --dangerously-skip-permissions --effort max` processes,
// one per named agent, inside pseudo-terminals (PTYs). Streams their I/O to the
// browser over a WebSocket so a grid of live xterm.js terminals can render them
// and a voice layer can route spoken commands to a named agent (or all of them).

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Configuration (override via env) --------------------------------------
const PORT = Number(process.env.PORT) || 4173;
const WORKDIR = process.env.CNOS_WORKDIR || os.homedir();
const CLAUDE_BIN = process.env.CNOS_CLAUDE_BIN || 'claude';
// The two flags the user asked for: auto mode + max effort.
const CLAUDE_ARGS = (process.env.CNOS_CLAUDE_ARGS
  ? process.env.CNOS_CLAUDE_ARGS.split(' ')
  : ['--dangerously-skip-permissions', '--effort', 'max']
).filter(Boolean);

// Make sure common install locations for `claude` are on PATH for spawned PTYs.
const EXTRA_PATHS = [
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
const SPAWN_PATH = [...EXTRA_PATHS, process.env.PATH || ''].join(path.delimiter);

// Resolve `claude` to an absolute path so PTY spawning never depends on how
// posix_spawnp searches PATH.
function resolveBin(bin) {
  if (bin.includes('/')) return bin;
  for (const dir of SPAWN_PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
  }
  return bin; // let the spawn surface a clear error if truly missing
}
const CLAUDE_PATH = resolveBin(CLAUDE_BIN);

// Voice transcription: local whisper.cpp (no API key, runs offline on-device).
function resolveWhisper() {
  if (process.env.CNOS_WHISPER_BIN) return process.env.CNOS_WHISPER_BIN;
  for (const n of ['whisper-cli', 'whisper-cpp']) {
    const p = resolveBin(n);
    if (p.includes('/')) return p;
  }
  return null;
}
const WHISPER_BIN = resolveWhisper();
const WHISPER_MODEL = process.env.CNOS_WHISPER_MODEL || path.join(__dirname, 'models', 'ggml-base.en.bin');

// Distinct, voice-friendly call signs. Easy to say, hard to confuse on a mic.
const NAME_POOL = [
  'jack', 'zulu', 'echo', 'nova', 'ruby', 'leo', 'mango', 'sierra',
  'romeo', 'kilo', 'tango', 'victor', 'juno', 'atlas', 'remy', 'indie',
];

// ---- Terminal fleet ---------------------------------------------------------
const terminals = new Map(); // id -> { id, name, cwd, pty, history }
const clients = new Set();   // connected browser sockets
let nextId = 1;

const MAX_HISTORY = 200_000; // bytes of scrollback retained per agent for replay

// On first launch in a directory, Claude shows a "Is this a project you trust?"
// prompt that must be accepted before it's ready. We auto-accept it (the default
// option is "Yes, I trust this folder") so the user's first command isn't eaten
// by the dialog. Self-contained — no edits to the user's global Claude config.
const TRUST_RE = /trust this folder|Is this a project you (created|trust)/i;
const BOOT_WINDOW_MS = 30_000;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

function pickName(requested) {
  if (requested) return String(requested).toLowerCase().replace(/[^a-z0-9-]/g, '');
  const used = new Set([...terminals.values()].map((t) => t.name));
  return NAME_POOL.find((n) => !used.has(n)) || `agent-${nextId}`;
}

function spawnTerminal({ name, cwd } = {}) {
  const id = String(nextId++);
  const agentName = pickName(name);
  let workdir = cwd ? cwd.replace(/^~/, os.homedir()) : WORKDIR;
  if (!fs.existsSync(workdir)) workdir = WORKDIR;

  let proc;
  try {
    proc = pty.spawn(CLAUDE_PATH, CLAUDE_ARGS, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workdir,
      env: { ...process.env, PATH: SPAWN_PATH, TERM: 'xterm-256color', CNOS_AGENT: agentName },
    });
  } catch (err) {
    console.error(`  ! failed to spawn "${agentName}": ${err.message}`);
    broadcast({ type: 'spawn-error', message: `Could not launch ${CLAUDE_PATH}: ${err.message}` });
    return null;
  }

  const term = { id, name: agentName, cwd: workdir, pty: proc, history: '', trustHandled: false };
  terminals.set(id, term);

  // Stop watching for the trust prompt once the boot window passes.
  const trustTimer = setTimeout(() => { term.trustHandled = true; }, BOOT_WINDOW_MS);

  proc.onData((data) => {
    term.history += data;
    if (term.history.length > MAX_HISTORY) term.history = term.history.slice(-MAX_HISTORY);

    if (!term.trustHandled && TRUST_RE.test(term.history.slice(-800))) {
      term.trustHandled = true;
      clearTimeout(trustTimer);
      // brief delay so the dialog is fully rendered before we confirm it
      setTimeout(() => { try { proc.write('\r'); } catch { /* gone */ } }, 200);
    }

    broadcast({ type: 'output', id, data });
  });

  proc.onExit(({ exitCode }) => {
    clearTimeout(trustTimer);
    broadcast({ type: 'exit', id, code: exitCode });
    terminals.delete(id);
  });

  console.log(`  + spawned "${agentName}" (id ${id}) in ${workdir}`);
  broadcast({ type: 'spawned', id, name: agentName, cwd: workdir });
  return term;
}

function listPayload() {
  return {
    type: 'list',
    terminals: [...terminals.values()].map((t) => ({ id: t.id, name: t.name, cwd: t.cwd })),
  };
}

// Resolve a routing target to a list of terminals. 'all' (or empty) -> everyone.
function resolveTargets(target) {
  if (!target || target === 'all') return [...terminals.values()];
  const wanted = String(target).toLowerCase();
  const t = [...terminals.values()].find((x) => x.name === wanted);
  return t ? [t] : [];
}

function write(term, data) {
  if (term?.pty) {
    try { term.pty.write(data); } catch { /* process gone */ }
  }
}

const CONTROL_SEQ = { interrupt: '\x03', escape: '\x1b', enter: '\r' };

function handle(ws, msg) {
  switch (msg.type) {
    case 'spawn':
      spawnTerminal({ name: msg.name, cwd: msg.cwd });
      break;

    case 'input': // raw keystrokes from a focused terminal
      write(terminals.get(msg.id), msg.data);
      break;

    case 'command': { // type the text, then press Enter as a SEPARATE keystroke
      const list = resolveTargets(msg.target);
      for (const t of list) {
        write(t, msg.text);
        // A standalone Enter a beat later submits reliably; bundling "text\r" in
        // one write can get treated as a paste and the newline won't submit.
        setTimeout(() => write(t, '\r'), 120);
      }
      broadcast({ type: 'routed', target: msg.target, text: msg.text, count: list.length });
      break;
    }

    case 'control': { // interrupt / escape / enter, routed
      const seq = CONTROL_SEQ[msg.action];
      if (!seq) break;
      const list = resolveTargets(msg.target);
      for (const t of list) write(t, seq);
      broadcast({ type: 'routed', target: msg.target, text: `[${msg.action}]`, count: list.length });
      break;
    }

    case 'resize': {
      const t = terminals.get(msg.id);
      if (t) { try { t.pty.resize(Math.max(2, msg.cols | 0), Math.max(2, msg.rows | 0)); } catch { /* */ } }
      break;
    }

    case 'kill': {
      const t = terminals.get(msg.id);
      if (t) { try { t.pty.kill(); } catch { /* */ } }
      break;
    }

    case 'rename': {
      const t = terminals.get(msg.id);
      if (t && msg.name) {
        t.name = String(msg.name).toLowerCase().replace(/[^a-z0-9-]/g, '');
        broadcast(listPayload());
      }
      break;
    }

    case 'clientlog': // browser streams its voice diagnostics here so we can see them
      console.log('  [client]', String(msg.msg).slice(0, 400));
      break;

    case 'list':
      ws.send(JSON.stringify(listPayload()));
      break;
  }
}

// ---- HTTP + static assets ---------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve the xterm.js library straight out of node_modules (no bundler needed).
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/css')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib')));

// Transcribe a short audio clip with local whisper.cpp. The browser records the
// utterance (getUserMedia + MediaRecorder) and POSTs it here as raw audio bytes.
app.post('/transcribe', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }), async (req, res) => {
  if (!WHISPER_BIN) return res.status(503).json({ error: 'whisper not installed — run: brew install whisper-cpp' });
  if (!fs.existsSync(WHISPER_MODEL)) return res.status(503).json({ error: 'whisper model missing at ' + WHISPER_MODEL });
  if (!req.body || !req.body.length) return res.json({ text: '' });

  const stamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const inPath = path.join(os.tmpdir(), `cnos-${stamp}.webm`);
  const wavPath = path.join(os.tmpdir(), `cnos-${stamp}.wav`);
  try {
    fs.writeFileSync(inPath, req.body);
    // whisper.cpp wants 16 kHz mono PCM wav
    await execFileP('ffmpeg', ['-y', '-i', inPath, '-ar', '16000', '-ac', '1', '-f', 'wav', wavPath], { timeout: 20000 });
    const { stdout } = await execFileP(WHISPER_BIN, ['-m', WHISPER_MODEL, '-f', wavPath, '-nt'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    const text = stdout.replace(/\[[0-9:.\s>\-]+\]/g, '').replace(/\s+/g, ' ').trim();
    res.json({ text });
  } catch (err) {
    console.error('  ! transcribe failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(wavPath).catch(() => {});
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'hello',
    workdir: WORKDIR,
    launch: `${CLAUDE_BIN} ${CLAUDE_ARGS.join(' ')}`,
    names: NAME_POOL,
  }));
  ws.send(JSON.stringify(listPayload()));
  // Replay scrollback so a fresh/reconnecting window renders current state.
  for (const t of terminals.values()) {
    if (t.history) ws.send(JSON.stringify({ type: 'output', id: t.id, data: t.history }));
  }
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, msg);
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log('\n  ┌─ cnos ── Claude agent fleet orchestrator ─────────────');
  console.log(`  │  open    http://localhost:${PORT}   (use Chrome for voice)`);
  console.log(`  │  workdir ${WORKDIR}`);
  console.log(`  │  launch  ${CLAUDE_PATH} ${CLAUDE_ARGS.join(' ')}`);
  console.log(`  │  voice   ${WHISPER_BIN ? WHISPER_BIN + ' + ' + path.basename(WHISPER_MODEL) : 'whisper NOT found'}`);
  console.log('  └────────────────────────────────────────────────────────\n');
});
