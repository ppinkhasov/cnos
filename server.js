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
import { getUsage } from './usage.js';

const execFileP = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Configuration (override via env) --------------------------------------
const PORT = Number(process.env.PORT) || 4173;
const WORKDIR = process.env.CNOS_WORKDIR || os.homedir();
// Agent types — each spawns a different CLI. Defaults run in "auto" mode
// (auto-accept edits), NOT bypass/dangerous. Override per type with
// CNOS_<TYPE>_BIN and CNOS_<TYPE>_ARGS (e.g. CNOS_CLAUDE_ARGS="--effort high").
const AGENT_DEFAULTS = {
  claude: { bin: 'claude', args: ['--permission-mode', 'auto', '--effort', 'max'] },
  // codex 0.140+ removed `--full-auto`; its modern equivalent is an explicit
  // sandbox + approval policy. workspace-write + on-request = edit/run inside the
  // workdir without prompting, only escalate when the model asks — "auto", NOT
  // full bypass (parity with claude's `--permission-mode auto`). For unattended
  // runs override with CNOS_CODEX_ARGS="--sandbox danger-full-access --ask-for-approval never".
  codex:  { bin: 'codex',  args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
  hermes: { bin: 'hermes', args: [] },
};
const DEFAULT_AGENT = 'claude';

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
// Resolve each agent type to an absolute bin + args (both env-overridable).
const AGENT_TYPES = {};
for (const [type, def] of Object.entries(AGENT_DEFAULTS)) {
  const U = type.toUpperCase();
  const argsEnv = process.env[`CNOS_${U}_ARGS`];
  AGENT_TYPES[type] = {
    bin: resolveBin(process.env[`CNOS_${U}_BIN`] || def.bin),
    args: argsEnv !== undefined ? argsEnv.split(' ').filter(Boolean) : def.args,
  };
}

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
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[=>()][AB0-2]?/g;
// The trust prompt positions words with cursor moves, so the ANSI-stripped text
// has NO spaces between words. Match the flattened (space-removed) form so the
// auto-accept is reliable regardless of how Claude draws the screen.
const TRUST_RE = /trustthisfolder|isthisaprojectyou(created|trust)/i;
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

function spawnTerminal({ type, name, cwd } = {}) {
  const agentType = AGENT_TYPES[type] ? type : DEFAULT_AGENT;
  const spec = AGENT_TYPES[agentType];
  if (!spec.bin.includes('/')) { // resolveBin couldn't find it on PATH
    console.error(`  ! ${agentType} not installed ("${spec.bin}" not on PATH)`);
    broadcast({ type: 'spawn-error', message: `${agentType} is not installed — "${spec.bin}" not found on PATH` });
    return null;
  }
  const id = String(nextId++);
  const agentName = pickName(name);
  let workdir = cwd ? cwd.replace(/^~/, os.homedir()) : WORKDIR;
  if (!fs.existsSync(workdir)) workdir = WORKDIR;

  let proc;
  try {
    proc = pty.spawn(spec.bin, spec.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workdir,
      env: { ...process.env, PATH: SPAWN_PATH, TERM: 'xterm-256color', CNOS_AGENT: agentName, CNOS_PORT: String(PORT) },
    });
  } catch (err) {
    console.error(`  ! failed to spawn ${agentType} "${agentName}": ${err.message}`);
    broadcast({ type: 'spawn-error', message: `Could not launch ${agentType} (${spec.bin}): ${err.message}` });
    return null;
  }

  // Only Claude shows the "trust this folder" dialog; pre-mark others as handled.
  const term = { id, name: agentName, type: agentType, cwd: workdir, pty: proc, history: '', trustHandled: agentType !== 'claude' };
  terminals.set(id, term);

  // Stop watching for the trust prompt once the boot window passes.
  const trustTimer = setTimeout(() => { term.trustHandled = true; }, BOOT_WINDOW_MS);

  proc.onData((data) => {
    term.history += data;
    if (term.history.length > MAX_HISTORY) term.history = term.history.slice(-MAX_HISTORY);

    if (!term.trustHandled && TRUST_RE.test(term.history.slice(-2000).replace(ANSI_RE, '').replace(/\s+/g, ''))) {
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

  console.log(`  + spawned ${agentType} "${agentName}" (id ${id}) in ${workdir}`);
  broadcast({ type: 'spawned', id, name: agentName, agentType, cwd: workdir });
  return term;
}

function listPayload() {
  return {
    type: 'list',
    terminals: [...terminals.values()].map((t) => ({ id: t.id, name: t.name, agentType: t.type, cwd: t.cwd })),
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

// "stop"/interrupt sends Esc — the key agent TUIs use to interrupt the current
// task. Ctrl-C tends to quit the program instead.
// "clear" wipes the typed-but-unsubmitted input line: Ctrl-E (jump to end of
// line) then Ctrl-U (kill to line start), so the whole line goes regardless of
// where the cursor sits. Ctrl-C is avoided here too (it would quit the agent).
const CONTROL_SEQ = { interrupt: '\x1b', escape: '\x1b', enter: '\r', clear: '\x05\x15' };

function handle(ws, msg) {
  switch (msg.type) {
    case 'spawn':
      spawnTerminal({ type: msg.agentType, name: msg.name, cwd: msg.cwd });
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

    case 'control': { // interrupt / escape / enter / clear, routed
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

// Per-provider API usage (rate-limit utilization) for the top-bar meter.
// Read-only: reads each CLI's existing creds/logs, never writes them. Cached.
app.get('/api/usage', async (req, res) => {
  try {
    res.json(await getUsage({ force: req.query.force === '1' }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Half-duplex voice: the TTS hook POSTs here right before/after an agent speaks
// so the browser can mute the mic and not transcribe the agent's own speech as
// a command (the echo/feedback loop). Fire-and-forget broadcast to all clients.
app.post('/api/speaking', (req, res) => {
  broadcast({ type: 'speaking', on: !!(req.body && req.body.on), name: req.body && req.body.name });
  res.json({ ok: true });
});

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
    agentTypes: Object.keys(AGENT_TYPES),
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
  console.log('\n  ┌─ cnos ── multi-agent fleet orchestrator ──────────────');
  console.log(`  │  open    http://localhost:${PORT}   (use Chrome for voice)`);
  console.log(`  │  workdir ${WORKDIR}`);
  for (const [type, spec] of Object.entries(AGENT_TYPES)) {
    console.log(`  │  ${type.padEnd(7)}${spec.bin} ${spec.args.join(' ')}`.trimEnd());
  }
  console.log(`  │  voice   ${WHISPER_BIN ? WHISPER_BIN + ' + ' + path.basename(WHISPER_MODEL) : 'whisper NOT found'}`);
  console.log('  └────────────────────────────────────────────────────────\n');
});
