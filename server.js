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

// Resolve a user-supplied directory (expand a leading ~, make absolute). Returns
// `fallback` when the path is empty, missing, or not a directory.
function resolveDir(p, fallback) {
  if (!p) return fallback;
  let r = String(p).replace(/^~(?=$|[/\\])/, os.homedir());
  try { r = path.resolve(r); return fs.statSync(r).isDirectory() ? r : fallback; }
  catch { return fallback; }
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

// ---- Orchestrator (goal-driven, auto-scaling lead-agent loop) tuning --------
// One terminal becomes the "lead" (a claude agent) that decomposes the goal and
// delegates to worker agents. The lead issues machine-readable directives by
// APPENDING JSON lines to an orders file (path set per-run in orchStart) the server tails,
// and we feed it the goal + worker results by typing into its terminal. (A file —
// not screen scraping — because the TUI renders text with cursor moves that drop
// spaces and inject UI chrome mid-line, which shreds any scraped directive.)
const ORCH = {
  TICK_MS: 1200,            // loop cadence
  IDLE_MS: 3500,            // no PTY output for this long ⇒ agent is idle/done
  MIN_TASK_MS: 6000,        // floor before a just-assigned task can count as done
  LEAD_MIN_THINK_MS: 4000,  // floor before the lead's quiet counts as a finished reply
  SPAWN_COOLDOWN_MS: 8000,  // min gap between auto-scaling spawns
  REPORT_DEBOUNCE_MS: 1500, // batch near-simultaneous worker completions
  BOOT_MS: 3000,            // min wait before briefing a freshly-spawned lead
  MAX_ROUNDS: 24,           // safety ceiling on lead exchanges
};
const LEAD_EXTRA_ARGS = (process.env.CNOS_LEAD_ARGS || '').split(' ').filter(Boolean);

// The lead issues directives by APPENDING JSON lines to an orders file (which the
// server tails). A file is used — not terminal output — because Claude's TUI
// renders text with cursor moves that drop inter-word spaces and inject UI chrome
// mid-line, shredding any directive scraped from the screen. File bytes are exact.
// The path is per-run (under the chosen working directory) — see orchStart.

// The lead's role + protocol. Passed via --append-system-prompt (a CLI arg), so
// it is never echoed into the terminal. ordersPath is the run's directive file.
function leadProtocol(workerType, ordersPath) {
  return [
    'You are the LEAD orchestrator of "cnos", a fleet of autonomous CLI coding agents.',
    'You do NOT do the coding work yourself. Your job is to break the GOAL into subtasks, delegate',
    'them to worker agents, and decide when the goal is complete.',
    '',
    'You issue directives by APPENDING one compact JSON object per line to this exact file:',
    `  ${ordersPath}`,
    "Append, never overwrite — use the Bash tool, e.g.:  printf '%s\\n' '{\"action\":\"assign\",\"worker\":\"NAME\",\"task\":\"...\"}' >> " + ordersPath,
    'The cnos server tails that file and executes each line. Directive formats (valid JSON, one per line):',
    '  {"action":"assign","worker":"<name>","task":"<one concrete, self-contained instruction>"}',
    '  {"action":"spawn","reason":"<why another worker is needed>"}',
    '  {"action":"done","summary":"<one-line summary>"}',
    '  {"action":"note","text":"<status>"}',
    '',
    "You will receive plain-text messages in THIS terminal: the GOAL, your workers' names, and an",
    'update whenever a worker finishes (with the tail of its output) or a new worker becomes ready.',
    '',
    'Rules:',
    '- Immediately decompose the GOAL and append one "assign" line per available worker so they start',
    '  in parallel.',
    `- Each worker is a separate "${workerType}" coding agent in the working directory; keep each task to`,
    '  one line — the worker is capable and will expand it.',
    '- One active task per worker. After a worker finishes, the server tells you here; then append its',
    '  next "assign" line, or append a "done" line once the GOAL is fully achieved.',
    '- If all workers are busy and more parallel work remains, append a "spawn" line.',
    '- Do NOT create the project files yourself; the ONLY file you write to is the orders file above.',
    '  You may reason out loud in this terminal, but actions happen only via appended directive lines.',
  ].join('\n');
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

// ---- Orchestration: goal-driven, auto-scaling lead-agent loop ---------------
// off → cnos behaves exactly as today: you route commands to agents yourself.
// on  → you set a GOAL and press Start; cnos spawns a lead agent + workers and
//       runs a perceive→reason→act→observe loop (the lead delegates, the server
//       executes and reports results back) until the lead declares the goal done.
//       State lives here and is broadcast so every open tab stays in sync.
const orch = {
  enabled: false,
  running: false,
  status: 'idle',        // idle | briefing | running | done | stopped | stalled | error
  goal: '',
  workerType: DEFAULT_AGENT,
  workdir: WORKDIR,      // directory the lead + workers run in (chosen in the UI)
  startWorkers: 3,
  maxAgents: 8,
  leadId: null,
  round: 0,
  log: [],               // [{ t, kind, text }] — activity feed for the UI
  // transient runtime state (recomputed each run):
  pending: [],           // [{ name, task }] assignments awaiting a free worker
  finished: [],          // [{ name, task, tail }] completions awaiting report to the lead
  inbox: [],             // [string] plain notes queued for the lead (e.g. "worker ready")
  ordersOffset: 0,       // char offset consumed from the orders file (past last full object)
  ordersDir: '',         // <workdir>/.cnos        (set per-run in orchStart)
  ordersPath: '',        // <workdir>/.cnos/orders.jsonl
  briefed: false,
  nudged: false,
  leadSpawnAt: 0,
  lastFinishAt: 0,
  lastSpawnAt: 0,
  timer: null,
};

// Live per-agent status for the UI, derived from the PTY stream + task state.
function fleetSnapshot() {
  return [...terminals.values()].map((t) => {
    let state;
    if (t.role === 'lead') state = t.leadAwaiting ? 'thinking' : (isIdle(t) ? 'idle' : 'working');
    else if (t.orchTask) state = 'busy';
    else state = isIdle(t) ? 'idle' : 'working';
    return { id: t.id, name: t.name, role: t.role || 'worker', agentType: t.type, state, task: t.orchTask || '' };
  });
}

const orchestrationPayload = () => ({
  type: 'orchestration',
  enabled: orch.enabled,
  running: orch.running,
  // a stopped/stalled run can be resumed as long as its lead agent is still alive
  resumable: !orch.running && !!leadTerm() && (orch.status === 'stopped' || orch.status === 'stalled'),
  status: orch.status,
  goal: orch.goal,
  workerType: orch.workerType,
  workdir: orch.workdir,
  startWorkers: orch.startWorkers,
  maxAgents: orch.maxAgents,
  round: orch.round,
  agents: terminals.size,
  fleet: fleetSnapshot(),
  log: orch.log.slice(-40),
});

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

function spawnTerminal({ type, name, cwd, role, extraArgs } = {}) {
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
  const args = extraArgs && extraArgs.length ? [...spec.args, ...extraArgs] : spec.args;

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

  // Only Claude shows the "trust this folder" dialog; pre-mark others as handled.
  const term = {
    id, name: agentName, type: agentType, cwd: workdir, pty: proc, history: '',
    trustHandled: agentType !== 'claude',
    role: role === 'lead' ? 'lead' : 'worker',
    lastDataAt: Date.now(), // updated on every chunk; powers the idle/busy heuristic
    totalBytes: 0,          // monotonic byte count (survives history truncation)
    orchTask: null,         // task text the orchestrator assigned (workers only)
  };
  terminals.set(id, term);

  // Stop watching for the trust prompt once the boot window passes.
  const trustTimer = setTimeout(() => { term.trustHandled = true; }, BOOT_WINDOW_MS);

  proc.onData((data) => {
    term.history += data;
    if (term.history.length > MAX_HISTORY) term.history = term.history.slice(-MAX_HISTORY);
    term.lastDataAt = Date.now();
    term.totalBytes += data.length;

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
    // Keep the orchestrator coherent if an agent dies mid-run.
    if (orch.running) {
      if (term.id === orch.leadId) orchFinish('error', 'the lead agent exited');
      else if (term.orchTask) {
        orch.pending.unshift({ name: null, task: term.orchTask });
        orchLog('warn', `${term.name} exited mid-task — requeued`);
        broadcastOrch();
      }
    }
  });

  console.log(`  + spawned ${agentType} "${agentName}" (id ${id})${term.role === 'lead' ? ' [LEAD]' : ''} in ${workdir}`);
  broadcast({ type: 'spawned', id, name: agentName, agentType, role: term.role, cwd: workdir });
  return term;
}

function listPayload() {
  return {
    type: 'list',
    terminals: [...terminals.values()].map((t) => ({ id: t.id, name: t.name, agentType: t.type, role: t.role || 'worker', cwd: t.cwd })),
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

// Type text into an agent, then submit with a SEPARATE Enter keystroke a beat
// later — bundling "text\r" in one write can be treated as a paste whose newline
// won't submit. Used for both manual commands and orchestrator task dispatch.
function sendCommand(term, text) {
  if (!term) return;
  write(term, text);
  setTimeout(() => write(term, '\r'), 120);
}

// ---- Orchestrator engine (the loop: perceive → reason → act → observe) -------
// Idle/busy detection. A naive "no output for N ms" timer is unreliable: an IDLE
// Claude TUI still emits periodic bytes (cursor blink, footer/prompt redraws), so
// the timer keeps thinking a finished agent is busy — and the lead then hangs
// forever waiting on workers that are actually done. Instead we read Claude's
// footer, which shows "esc to interrupt" the whole time it is processing and never
// when idle at the prompt. We look only at output from the LAST tick (not the
// accumulated history, which still holds old spinner frames), with a few ticks of
// stickiness to ride out the gaps between spinner redraws.
const CLAUDE_BUSY_RE   = /esctointerrupt|esctocancel/;
const CLAUDE_FOOTER_RE = /esctointerrupt|esctocancel|shift\+?tabtocycle|\?forshortcuts|forshortcuts|automodeon|acceptedits|bypasspermissions|planmode/;
const BUSY_STICKY_TICKS = 3;

// Recompute each agent's busy/idle from the output it produced since the last tick.
function refreshActivity() {
  for (const t of terminals.values()) {
    const recent = deltaSince(t, t.viewMark || 0).replace(ANSI_RE, '').replace(/\s+/g, '').toLowerCase();
    t.viewMark = t.totalBytes;
    if (t.type !== 'claude') continue;                                                          // other TUIs → quiet-timer
    if (CLAUDE_BUSY_RE.test(recent)) { t.busyTicks = BUSY_STICKY_TICKS; t.claudeSeen = true; }  // actively working
    else if (CLAUDE_FOOTER_RE.test(recent)) { t.busyTicks = 0; t.claudeSeen = true; }           // idle at the prompt
    else if (t.busyTicks > 0) t.busyTicks--;                                                     // no footer this tick → decay
  }
}

function isIdle(term) {
  // Once Claude's footer has appeared, trust the interrupt-hint signal over timing.
  if (term.type === 'claude' && term.claudeSeen) return (term.busyTicks || 0) === 0;
  return Date.now() - (term.lastDataAt || 0) > ORCH.IDLE_MS; // non-Claude / pre-boot fallback
}
function broadcastOrch() { broadcast(orchestrationPayload()); }
function orchLog(kind, text) {
  orch.log.push({ t: Date.now(), kind, text });
  if (orch.log.length > 120) orch.log = orch.log.slice(-120);
  console.log(`  ~ orch[${kind}] ${text}`);
}

const cleanText = (s) => s.replace(ANSI_RE, '').replace(/\s+/g, ' ').trim();
// Output a terminal has produced since a saved byte-count mark, robust to the
// MAX_HISTORY truncation that would invalidate an absolute string index.
function deltaSince(term, baselineTotal) {
  const n = Math.min(term.history.length, Math.max(0, term.totalBytes - (baselineTotal || 0)));
  return term.history.slice(term.history.length - n);
}
const workers = () => [...terminals.values()].filter((t) => t.role !== 'lead');
const idleWorkers = () => workers().filter((t) => !t.orchTask && isIdle(t));
const leadTerm = () => (orch.leadId ? terminals.get(orch.leadId) : null);

function spawnWorker() {
  if (terminals.size >= orch.maxAgents) return null;
  const t = spawnTerminal({ type: orch.workerType, role: 'worker', cwd: orch.workdir });
  if (t) { orch.lastSpawnAt = Date.now(); orchLog('spawn', `added worker ${t.name} — ${terminals.size} agents`); }
  return t;
}

function assignWorker(term, task) {
  term.orchTask = task;
  term.taskStartedAt = Date.now();
  term.taskBaselineTotal = term.totalBytes; // so we can capture just this task's output
  sendCommand(term, task);
  broadcast({ type: 'routed', target: term.name, text: task, count: 1 });
  orchLog('assign', `${term.name} ← ${task.slice(0, 90)}`);
}

function completeWorker(term) {
  const task = term.orchTask;
  const tail = cleanText(deltaSince(term, term.taskBaselineTotal)).slice(-1000);
  orch.finished.push({ name: term.name, task, tail });
  orch.lastFinishAt = Date.now();
  term.orchTask = null;
  term.taskStartedAt = 0;
  orchLog('done', `${term.name} finished: ${(task || '').slice(0, 70)}`);
}

// Feed the lead the goal / worker results by typing into its terminal (its
// directives come back out-of-band via the orders file, not from this stream).
function sendToLead(text) {
  const lead = leadTerm();
  if (!lead) return;
  lead.leadSentAt = Date.now();
  lead.leadAwaiting = true;
  orch.round++; // every message to the lead is one exchange (bounded by MAX_ROUNDS)
  // Multi-line, so wrap in a bracketed paste so it lands as ONE input; \r submits.
  write(lead, '\x1b[200~' + text + '\x1b[201~');
  setTimeout(() => write(lead, '\r'), 140);
  orchLog('lead', '→ ' + text.split('\n')[0].slice(0, 80));
}

// Read new directives the lead has appended to the orders file. Extracts complete
// top-level {...} JSON objects by brace-matching (respecting strings/escapes), so
// it's robust to however the lead spaces them — one per line, several on a line,
// or pretty-printed across lines. A half-written trailing object waits for next tick.
function readOrders() {
  let txt;
  try { txt = fs.readFileSync(orch.ordersPath, 'utf8'); } catch { return []; }
  const fresh = txt.slice(orch.ordersOffset || 0);
  const out = [];
  let consumed = 0, depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0 && start >= 0) {
      const chunk = fresh.slice(start, i + 1);
      try { out.push(JSON.parse(chunk)); }
      catch { orchLog('warn', `ignored malformed order: ${chunk.slice(0, 80)}`); }
      consumed = i + 1; start = -1;
    }
  }
  orch.ordersOffset = (orch.ordersOffset || 0) + consumed; // keep any partial tail for next tick
  return out;
}

function handleDirective(d) {
  const action = String(d.action || '').toLowerCase();
  if (action === 'done') { orchFinish('done', String(d.summary || 'goal complete').slice(0, 200)); return; }
  if (action === 'note') { orchLog('note', String(d.text || '').slice(0, 140)); return; }
  if (action === 'spawn') {
    if (terminals.size < orch.maxAgents) {
      const t = spawnWorker();
      if (t) orch.inbox.push(`A new worker "${t.name}" is ready for a task.`);
    } else {
      orch.inbox.push(`Cannot add a worker — already at the ${orch.maxAgents}-agent cap.`);
    }
    return;
  }
  if (action === 'assign') {
    const name = String(d.worker || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    const task = String(d.task || '').trim();
    if (!name || !task) { orchLog('warn', `bad assign order: ${JSON.stringify(d).slice(0, 90)}`); return; }
    const w = workers().find((t) => t.name === name);
    if (w && !w.orchTask && isIdle(w)) assignWorker(w, task);
    else orch.pending.push({ name: w ? name : null, task }); // busy/booting/unknown → queue
    return;
  }
  orchLog('warn', `unknown order action: ${action || '(none)'}`);
}

// The message that reports finished workers (and any queued notes) back to the lead.
function buildLeadUpdate() {
  const lines = ['[cnos] Update:'];
  for (const r of orch.finished.splice(0)) {
    lines.push(`- Worker ${r.name} finished its task "${(r.task || '').slice(0, 100)}". Output tail:`);
    lines.push(r.tail ? r.tail.slice(-700) : '(no output captured)');
  }
  for (const n of orch.inbox.splice(0)) lines.push(`- ${n}`);
  const idle = idleWorkers().map((t) => t.name);
  const busy = workers().filter((t) => t.orchTask).map((t) => t.name);
  lines.push(`Idle workers ready for a task: ${idle.length ? idle.join(', ') : 'none'}. Busy: ${busy.length ? busy.join(', ') : 'none'}.`);
  lines.push('Assign the next task(s); request another worker if you need more capacity; or declare the goal done if it is fully complete.');
  return lines.join('\n');
}

function orchStart({ goal, workerType, workdir, startWorkers, maxAgents } = {}) {
  if (orch.running) return;
  // Retire a lead left over from a previous finished run so we don't end up with
  // two LEAD cards. (orch.running is false here, so its onExit is a no-op.) Old
  // workers are left alive as bonus capacity for the new run.
  const prevLead = orch.leadId && terminals.get(orch.leadId);
  orch.leadId = null;
  if (prevLead) { try { prevLead.pty.kill(); } catch { /* already gone */ } }
  if (typeof goal === 'string') orch.goal = goal.trim();
  if (workerType && AGENT_TYPES[workerType]) orch.workerType = workerType;
  if (workdir !== undefined) orch.workdir = resolveDir(workdir, WORKDIR);
  if (Number.isFinite(startWorkers)) orch.startWorkers = Math.max(1, Math.min(12, startWorkers | 0));
  if (Number.isFinite(maxAgents)) orch.maxAgents = Math.max(2, Math.min(16, maxAgents | 0));
  if (!orch.goal) { orch.status = 'error'; orchLog('error', 'no goal set'); broadcastOrch(); return; }

  // reset runtime
  orch.running = true; orch.status = 'briefing'; orch.round = 0; orch.log = [];
  orch.pending = []; orch.finished = []; orch.inbox = []; orch.ordersOffset = 0;
  orch.briefed = false; orch.nudged = false;
  orch.lastFinishAt = 0; orch.lastSpawnAt = Date.now();
  // Fresh orders file (the lead's directive channel) under the chosen workdir.
  orch.ordersDir = path.join(orch.workdir, '.cnos');
  orch.ordersPath = path.join(orch.ordersDir, 'orders.jsonl');
  try { fs.mkdirSync(orch.ordersDir, { recursive: true }); fs.writeFileSync(orch.ordersPath, ''); }
  catch (e) { orchFinish('error', `cannot create orders file (${orch.ordersPath}): ${e.message}`); return; }
  orchLog('start', `goal: ${orch.goal.slice(0, 110)}  ·  in ${orch.workdir}`);
  broadcastOrch();

  // Spawn the lead (claude + the protocol system prompt), then the initial workers.
  const lead = spawnTerminal({
    type: 'claude', role: 'lead', cwd: orch.workdir,
    extraArgs: ['--append-system-prompt', leadProtocol(orch.workerType, orch.ordersPath), ...LEAD_EXTRA_ARGS],
  });
  if (!lead) { orchFinish('error', 'could not spawn the lead (is claude installed?)'); return; }
  orch.leadId = lead.id;
  orch.leadSpawnAt = Date.now();

  const names = [];
  for (let i = 0; i < orch.startWorkers && terminals.size < orch.maxAgents; i++) {
    const w = spawnWorker();
    if (w) names.push(w.name);
  }
  if (!workers().length) { orchFinish('error', `could not spawn any ${orch.workerType} workers`); return; }
  orchLog('start', `lead ${lead.name} + ${names.length} workers: ${names.join(', ')}`);

  orch.timer = setInterval(orchTick, ORCH.TICK_MS);
  broadcastOrch();
}

function orchFinish(status, reason) {
  if (orch.timer) { clearInterval(orch.timer); orch.timer = null; }
  orch.running = false;
  orch.status = status;
  const lead = leadTerm();
  if (lead) lead.leadAwaiting = false;
  orchLog(status, reason || '');
  broadcastOrch();
}

// Resume a stopped/stalled run in place. Stop() only halts the loop — the lead and
// workers keep running and all state (goal, pending tasks, orders offset, log) is
// retained — so resuming just re-arms the tick. The next pass catches up on any
// work the agents finished while paused (OBSERVE) and on directives the lead wrote.
function orchResume() {
  if (orch.running) return;
  if (!orch.goal || !leadTerm()) { orchLog('warn', 'nothing to resume — start a new run'); broadcastOrch(); return; }
  // Re-baseline activity views so the first tick reads current screen state, not the
  // whole backlog accumulated during the pause (which still holds old spinner frames).
  for (const t of terminals.values()) t.viewMark = t.totalBytes;
  orch.running = true;
  orch.status = orch.briefed ? 'running' : 'briefing';
  orch.nudged = false; // give the lead a fresh chance before any stall check
  orchLog('resume', 'resumed — continuing where it left off');
  orch.timer = setInterval(orchTick, ORCH.TICK_MS);
  broadcastOrch();
}

// One pass of the loop. Runs every TICK_MS while a goal is in progress.
function orchTick() {
  if (!orch.running) return;
  refreshActivity();   // recompute every agent's busy/idle from the last tick's output
  const lead = leadTerm();
  if (!lead) { orchFinish('error', 'the lead agent is gone'); return; }

  // Brief the lead once it has finished booting (trust prompt + welcome screen).
  if (!orch.briefed) {
    if (Date.now() - orch.leadSpawnAt > ORCH.BOOT_MS && !lead.leadAwaiting && isIdle(lead)) {
      const names = workers().map((t) => t.name);
      orch.briefed = true;
      sendToLead([
        `GOAL: ${orch.goal}`, '',
        `Your worker agents (each a separate "${orch.workerType}" CLI agent in ${orch.workdir}): ${names.join(', ')}.`,
        '', 'Assign the first round of tasks now.',
      ].join('\n'));
    }
    broadcastOrch();
    return;
  }

  // (1) OBSERVE — a worker that has gone quiet after its minimum runtime is done.
  for (const w of workers()) {
    if (w.orchTask && Date.now() - (w.taskStartedAt || 0) > ORCH.MIN_TASK_MS && isIdle(w)) completeWorker(w);
  }

  // (2) REASON — consume any directive lines the lead appended to the orders file.
  for (const d of readOrders()) {
    if (orch.status === 'briefing') orch.status = 'running';
    orch.nudged = false;
    handleDirective(d);
    if (!orch.running) return;
  }
  // Once the lead settles after our last message, it's free to receive the next.
  if (lead.leadAwaiting && Date.now() - (lead.leadSentAt || 0) > ORCH.LEAD_MIN_THINK_MS && isIdle(lead)) {
    lead.leadAwaiting = false;
  }
  if (orch.round > ORCH.MAX_ROUNDS) { orchFinish('stalled', `hit the ${ORCH.MAX_ROUNDS}-round ceiling`); return; }

  // (3) ACT — dispatch queued assignments to any idle worker (prefer the named one).
  for (let i = 0; i < orch.pending.length; ) {
    const free = idleWorkers();
    if (!free.length) break;
    const p = orch.pending[i];
    const w = (p.name && free.find((t) => t.name === p.name)) || free[0];
    orch.pending.splice(i, 1);
    assignWorker(w, p.task);
  }

  // (4) SCALE — work still queued, everyone busy, under the cap ⇒ add a worker.
  if (orch.pending.length && !idleWorkers().length &&
      terminals.size < orch.maxAgents &&
      Date.now() - orch.lastSpawnAt > ORCH.SPAWN_COOLDOWN_MS) {
    spawnWorker();
  }

  // (5) REPORT / (6) STALL — when the lead is free, feed it results or stop.
  if (!lead.leadAwaiting && isIdle(lead)) {
    const haveReports = orch.finished.length && Date.now() - orch.lastFinishAt > ORCH.REPORT_DEBOUNCE_MS;
    if (haveReports || orch.inbox.length) {
      sendToLead(buildLeadUpdate());
    } else if (orch.status === 'running' && workers().length &&
               !orch.pending.length && !orch.finished.length &&
               !workers().some((w) => w.orchTask || !isIdle(w))) {
      // Everything has quiesced but the lead never declared done.
      if (!orch.nudged) {
        orch.nudged = true;
        sendToLead('[cnos] All workers are idle and no tasks are outstanding. If the GOAL is complete, declare it done with a one-line summary. Otherwise assign the next task(s).');
      } else {
        orchFinish('stalled', 'lead stopped issuing tasks without declaring the goal done');
      }
    }
  }

  broadcastOrch();
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

    case 'set-orchestration': {
      // The browser flipped the toggle or edited the goal/config. Config edits are
      // ignored mid-run; the enable toggle just shows/hides the panel everywhere.
      if (typeof msg.enabled === 'boolean') orch.enabled = msg.enabled;
      if (!orch.running && msg.config && typeof msg.config === 'object') {
        const c = msg.config;
        if (typeof c.goal === 'string') orch.goal = c.goal;
        if (c.workerType && AGENT_TYPES[c.workerType]) orch.workerType = c.workerType;
        if (Number.isFinite(c.startWorkers)) orch.startWorkers = Math.max(1, Math.min(12, c.startWorkers | 0));
        if (Number.isFinite(c.maxAgents)) orch.maxAgents = Math.max(2, Math.min(16, c.maxAgents | 0));
      }
      broadcastOrch();
      break;
    }

    case 'orchestrate-start':
      orchStart({ goal: msg.goal, workerType: msg.workerType, workdir: msg.workdir,
                  startWorkers: msg.startWorkers, maxAgents: msg.maxAgents });
      break;

    case 'orchestrate-stop':
      if (orch.running) orchFinish('stopped', 'stopped by user');
      break;

    case 'orchestrate-resume':
      orchResume();
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
    names: NAME_POOL,
  }));
  ws.send(JSON.stringify(listPayload()));
  ws.send(JSON.stringify(orchestrationPayload())); // current fleet-wide mode
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
