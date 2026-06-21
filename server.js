// cnos — Voice-controlled fleet of terminals (plain shells + AI coding agents).
//
// Spawns real PTYs — a blank shell by default, or a coding-agent CLI (claude /
// codex / hermes), optionally preloaded with a "role" prompt. Streams their I/O to
// the browser over a WebSocket so a grid of live xterm.js terminals can render
// them and a voice layer can route spoken commands to a named terminal (or all).

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
// Terminal types. "shell" is a plain interactive shell (the default — "new
// terminal"); the others spawn a coding-agent CLI in "auto" mode (auto-accept
// edits), NOT bypass/dangerous. Override per type with CNOS_<TYPE>_BIN and
// CNOS_<TYPE>_ARGS (e.g. CNOS_CLAUDE_ARGS="--effort high").
const AGENT_DEFAULTS = {
  // A blank terminal: just the user's interactive shell, no agent.
  shell:  { bin: process.env.SHELL || '/bin/zsh', args: [] },
  claude: { bin: 'claude', args: ['--permission-mode', 'auto', '--effort', 'max'] },
  // codex 0.140+ removed `--full-auto`; its modern equivalent is an explicit
  // sandbox + approval policy. workspace-write + on-request = edit/run inside the
  // workdir without prompting, only escalate when the model asks — "auto", NOT
  // full bypass (parity with claude's `--permission-mode auto`). For unattended
  // runs override with CNOS_CODEX_ARGS="--sandbox danger-full-access --ask-for-approval never".
  codex:  { bin: 'codex',  args: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] },
  hermes: { bin: 'hermes', args: [] },
};
const DEFAULT_AGENT = 'shell';   // "new terminal" → a blank shell

// Make sure common install locations for the CLIs are on PATH for spawned PTYs.
const EXTRA_PATHS = [
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];
const SPAWN_PATH = [...EXTRA_PATHS, process.env.PATH || ''].join(path.delimiter);

// Resolve a bin to an absolute path so PTY spawning never depends on how
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

// Resolve a user-supplied directory (expand a leading ~, make absolute). Returns
// `fallback` when the path is empty, missing, or not a directory.
function resolveDir(p, fallback) {
  if (!p) return fallback;
  let r = String(p).replace(/^~(?=$|[/\\])/, os.homedir());
  try { r = path.resolve(r); return fs.statSync(r).isDirectory() ? r : fallback; }
  catch { return fallback; }
}
// Resolve each type to an absolute bin + args (both env-overridable).
const AGENT_TYPES = {};
for (const [type, def] of Object.entries(AGENT_DEFAULTS)) {
  const U = type.toUpperCase();
  const argsEnv = process.env[`CNOS_${U}_ARGS`];
  AGENT_TYPES[type] = {
    bin: resolveBin(process.env[`CNOS_${U}_BIN`] || def.bin),
    args: argsEnv !== undefined ? argsEnv.split(' ').filter(Boolean) : def.args,
  };
}

// ---- Role prompts -----------------------------------------------------------
// Launch a coding agent preloaded with a prompt (the generic Loop prompt, an
// Orchestrator that delegates to its own subagents, or a mitsuhiko poc-engineering
// role). The prompt text is passed as the agent's first/positional prompt, so it
// boots straight into that mode. Files live in prompts/. Not applied to shells.
const PROMPT_SPECS = [
  { id: 'loop',       file: 'loop_agent.md',                label: 'Loop',           aliases: ['loop', 'looping', 'iterate', 'iterating', 'continuous', 'auto', 'nonstop', 'keepgoing'] },
  { id: 'orchestrator', file: 'orchestrator_agent.md',      label: 'Orchestrator',   aliases: ['orchestrator', 'orchestrate', 'orchestration', 'manager'] },
  { id: 'programmer', file: 'implementation_agent.md',      label: 'Programmer',     aliases: ['programmer', 'implementer', 'implementation', 'coder', 'engineer'] },
  { id: 'architect',  file: 'software_architect_agent.md',  label: 'Architect',      aliases: ['architect'] },
  { id: 'designer',   file: 'architecture_design_agent.md', label: 'Architecture',   aliases: ['designer', 'design', 'architecture'] },
  { id: 'analyst',    file: 'problem_analysis_agent.md',    label: 'Analyst',        aliases: ['analyst', 'analysis', 'analyze'] },
  { id: 'planner',    file: 'detailed_planning_agent.md',   label: 'Planner',        aliases: ['planner', 'planning', 'plan'] },
  { id: 'breakdown',  file: 'task_breakdown_agent.md',      label: 'Task breakdown', aliases: ['breakdown', 'tasks', 'tasking'] },
  { id: 'lead',       file: 'programming_lead_agent.md',    label: 'Research lead',  aliases: ['lead', 'researchlead', 'research'] },
];
const PROMPTS = {}; // id -> { id, label, aliases, content }
for (const spec of PROMPT_SPECS) {
  try {
    const content = fs.readFileSync(path.join(__dirname, 'prompts', spec.file), 'utf8').trim();
    if (content) PROMPTS[spec.id] = { ...spec, content };
  } catch { /* prompt file missing — skip it */ }
}
// What the client needs (NOT the full text — that stays server-side).
const promptList = () => Object.values(PROMPTS).map((p) => ({ id: p.id, label: p.label, aliases: p.aliases }));

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
const terminals = new Map(); // id -> { id, name, type, cwd, pty, history, promptId, promptLabel }
const clients = new Set();   // connected browser sockets
let nextId = 1;

const MAX_HISTORY = 200_000; // bytes of scrollback retained per terminal for replay

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

// Spawn a terminal. `type` defaults to a blank shell. `prompt` (a role-prompt id)
// rides in as the agent's positional first prompt — agents only, ignored for shells.
function spawnTerminal({ type, name, cwd, prompt } = {}) {
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
  // Role prompts apply to agents only, never to a blank shell.
  const role = (prompt && PROMPTS[prompt] && agentType !== 'shell') ? PROMPTS[prompt] : null;
  const args = role ? [...spec.args, role.content] : spec.args;

  let proc;
  try {
    proc = pty.spawn(spec.bin, args, {
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

  // Only Claude shows the "trust this folder" dialog; pre-mark everything else handled.
  const term = {
    id, name: agentName, type: agentType, cwd: workdir, pty: proc, history: '',
    trustHandled: agentType !== 'claude',
    promptId: role ? role.id : null,
    promptLabel: role ? role.label : '',
  };
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

  console.log(`  + spawned ${agentType} "${agentName}" (id ${id})${role ? ` [${role.label}]` : ''} in ${workdir}`);
  broadcast({ type: 'spawned', id, name: agentName, agentType, promptId: term.promptId, promptLabel: term.promptLabel, cwd: workdir });
  return term;
}

function listPayload() {
  return {
    type: 'list',
    terminals: [...terminals.values()].map((t) => ({
      id: t.id, name: t.name, agentType: t.type, promptId: t.promptId, promptLabel: t.promptLabel, cwd: t.cwd,
    })),
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

// Type text into a terminal, then submit with a SEPARATE Enter keystroke a beat
// later — bundling "text\r" in one write can be treated as a paste whose newline
// won't submit.
function sendCommand(term, text) {
  if (!term) return;
  write(term, text);
  setTimeout(() => write(term, '\r'), 120);
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
      spawnTerminal({ type: msg.agentType, name: msg.name, cwd: msg.cwd, prompt: msg.prompt });
      break;

    case 'input': // raw keystrokes from a focused terminal
      write(terminals.get(msg.id), msg.data);
      break;

    case 'command': { // type the text, then press Enter as a SEPARATE keystroke
      const list = resolveTargets(msg.target);
      for (const t of list) sendCommand(t, msg.text);
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
// no-cache (revalidate every load) so front-end edits always reach the browser
// without a hard refresh — cheap 304s when files are unchanged, thanks to etag.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true, lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));
// Serve the xterm.js library straight out of node_modules (no bundler needed).
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, 'node_modules/@xterm/xterm/css')));
app.use('/vendor/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib')));

// Per-provider API usage (Claude + Codex) for the top-bar meter — powered by the
// local `ai-usage` CLI (`ai-usage --once --json`). Read-only: ai-usage reads your
// own caches/credentials and never modifies them. Cached ~25s; serves stale on error.
const AI_USAGE_BIN = resolveBin(process.env.CNOS_AIUSAGE_BIN || path.join(os.homedir(), '.local/bin/ai-usage'));
let usageCache = { at: 0, data: null };
app.get('/api/usage', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && usageCache.data && Date.now() - usageCache.at < 25_000) return res.json(usageCache.data);
  try {
    const { stdout } = await execFileP(AI_USAGE_BIN, ['--once', '--json'], {
      timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: SPAWN_PATH, NO_COLOR: '1' },
    });
    const data = JSON.parse(stdout);
    usageCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    if (usageCache.data) return res.json(usageCache.data);   // serve last good snapshot on failure
    res.status(500).json({ error: 'ai-usage unavailable: ' + e.message });
  }
});

// List the subdirectories of a path — powers the working-directory picker. Expands
// a leading ~. Read-only; this is a localhost tool that already spawns CLIs with
// full filesystem access, so listing directories adds no new exposure.
app.get('/api/dirs', (req, res) => {
  try {
    let dir = String(req.query.path || '').trim();
    dir = dir ? dir.replace(/^~(?=$|[/\\])/, os.homedir()) : WORKDIR;
    dir = path.resolve(dir);
    let st;
    try { st = fs.statSync(dir); } catch { return res.status(404).json({ error: 'no such directory' }); }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a directory' });
    let dirs = [];
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.')) // hide dotfolders (still reachable by typing the path)
        .filter((d) => { try { return fs.statSync(path.join(dir, d.name)).isDirectory(); } catch { return false; } })
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch { /* unreadable directory → just return an empty list */ }
    const parent = path.dirname(dir);
    res.json({ path: dir, parent: parent === dir ? null : parent, home: os.homedir(), dirs });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
    home: os.homedir(),
    agentTypes: Object.keys(AGENT_TYPES),
    prompts: promptList(),
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
  console.log('\n  ┌─ cnos ── voice-controlled terminal fleet ─────────────');
  console.log(`  │  open    http://localhost:${PORT}   (use Chrome for voice)`);
  console.log(`  │  workdir ${WORKDIR}`);
  for (const [type, spec] of Object.entries(AGENT_TYPES)) {
    console.log(`  │  ${type.padEnd(7)}${spec.bin} ${spec.args.join(' ')}`.trimEnd());
  }
  console.log(`  │  prompts ${Object.keys(PROMPTS).join(', ') || '(none found in prompts/)'}`);
  console.log(`  │  voice   ${WHISPER_BIN ? WHISPER_BIN + ' + ' + path.basename(WHISPER_MODEL) : 'whisper NOT found'}`);
  console.log('  └────────────────────────────────────────────────────────\n');
});
