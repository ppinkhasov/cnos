#!/usr/bin/env node
// cnos CLI — drive the cnos fleet from inside any terminal (Terminal.app, iTerm,
// bash, tmux, …). It connects to the cnos server over the SAME WebSocket protocol
// the web and iOS clients use, so all three share one live fleet — spawn here, see
// it in the browser, and vice-versa. Starts the server automatically if it isn't up.
//
// Usage:
//   cnos                         attach — full-screen TUI (switch agents, spawn, route)
//   cnos new [type] [opts]       spawn a terminal (type: shell|claude|codex|hermes; default shell)
//                                  opts: --prompt <id> --cwd <dir> --name <call-sign>
//   cnos ls                      list terminals
//   cnos send <target> <text…>   type a command into <target> (a call-sign or "all")
//   cnos stop|clear|enter <tgt>  send a control key to <target>
//   cnos kill <name>             kill a terminal
//   cnos usage                   print per-provider API usage
//   cnos serve                   run the cnos server in the foreground
//   cnos help                    this help
//
// Global options: --port <n> (default $PORT or 4173) · --server <ws://host:port>

import { WebSocket } from 'ws';
import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'true'; opts[k] = v; }
  else positional.push(a);
}
const cmd = positional.shift() || 'attach';
const PORT = Number(opts.port || process.env.PORT || 4173);
const HOST = opts.host || 'localhost';
const REMOTE = opts.server || null;                 // ws://host:port — skip auto-start
const WS_URL = REMOTE || `ws://${HOST}:${PORT}`;
const HTTP_URL = REMOTE ? REMOTE.replace(/^ws/, 'http') : `http://${HOST}:${PORT}`;

const AGENT_TYPES = new Set(['shell', 'claude', 'codex', 'hermes']);

// ---- server bootstrap -------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function serverUp() { const r = await httpGet(HTTP_URL + '/'); return !!(r && r.status); }
async function ensureServer() {
  if (REMOTE) return;                               // user pointed us at an existing server
  if (await serverUp()) return;
  process.stderr.write(`· starting cnos server on :${PORT} …\n`);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, detached: true, stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 40; i++) { if (await serverUp()) return; await new Promise((r) => setTimeout(r, 250)); }
  fail(`could not start the cnos server on :${PORT} (try: cnos serve)`);
}
function fail(msg) { process.stderr.write(`cnos: ${msg}\n`); process.exit(1); }

// ---- a thin connection that resolves once the initial list has arrived ------
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const api = { ws, hello: null, agents: [], send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close() };
    let ready = false;
    ws.on('open', () => {});
    ws.on('error', (e) => { if (!ready) reject(e); });
    ws.on('close', () => { if (!ready) reject(new Error('connection closed')); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') api.hello = m;
      else if (m.type === 'list') { api.agents = m.terminals; if (!ready) { ready = true; resolve(api); } }
      if (api._on) api._on(m);
    });
  });
}

// ---- one-shot subcommands ---------------------------------------------------
function findAgent(api, name) {
  const n = String(name || '').toLowerCase();
  return api.agents.find((a) => a.name === n);
}

async function cmdLs() {
  await ensureServer();
  const api = await connect();
  if (!api.agents.length) console.log('(no terminals — spawn one with `cnos new` or `cnos`)');
  else {
    const w = Math.max(...api.agents.map((a) => a.name.length), 4);
    console.log('NAME'.padEnd(w) + '  TYPE     ROLE        DIR');
    for (const a of api.agents) {
      console.log(a.name.padEnd(w) + '  ' + (a.agentType || '').padEnd(8) + ' ' +
        (a.promptLabel || '-').padEnd(11) + ' ' + (a.cwd || ''));
    }
  }
  api.close(); process.exit(0);
}

async function cmdNew() {
  const type = positional[0] && AGENT_TYPES.has(positional[0]) ? positional.shift() : 'shell';
  await ensureServer();
  const api = await connect();
  api._on = (m) => {
    if (m.type === 'spawned') { console.log(`${m.agentType} ${m.name}${m.promptLabel ? ' (' + m.promptLabel + ')' : ''} — say “${m.name}, …” or attach with \`cnos\``); api.close(); process.exit(0); }
    if (m.type === 'spawn-error') fail(m.message);
  };
  api.send({ type: 'spawn', agentType: type, prompt: opts.prompt || undefined, cwd: opts.cwd || undefined, name: opts.name || undefined });
  setTimeout(() => fail('timed out waiting for spawn'), 15000);
}

async function cmdSend() {
  const target = positional.shift();
  const text = positional.join(' ');
  if (!target || !text) fail('usage: cnos send <target> <text…>');
  await ensureServer();
  const api = await connect();
  api.send({ type: 'command', target, text });
  setTimeout(() => { console.log(`→ ${target}: ${text}`); api.close(); process.exit(0); }, 300);
}

async function cmdControl(action) {
  const target = positional.shift();
  if (!target) fail(`usage: cnos ${action} <target>`);
  await ensureServer();
  const api = await connect();
  api.send({ type: 'control', target, action });
  setTimeout(() => { console.log(`→ ${target}: [${action}]`); api.close(); process.exit(0); }, 250);
}

async function cmdKill() {
  const name = positional.shift();
  if (!name) fail('usage: cnos kill <name>');
  await ensureServer();
  const api = await connect();
  const a = findAgent(api, name);
  if (!a) fail(`no terminal named "${name}" (see \`cnos ls\`)`);
  api.send({ type: 'kill', id: a.id });
  setTimeout(() => { console.log(`killed ${name}`); api.close(); process.exit(0); }, 250);
}

async function cmdUsage() {
  await ensureServer();
  const r = await httpGet(HTTP_URL + '/api/usage');
  if (!r || !r.status) fail('usage unavailable');
  let data; try { data = JSON.parse(r.body); } catch { fail('bad usage response'); }
  for (const p of (data.providers || [])) {
    if (!p.available) { console.log(`${p.label.padEnd(10)} ${p.reason || 'unavailable'}`); continue; }
    if (p.balances && p.balances.length) console.log(`${p.label.padEnd(10)} ${p.balances.map((b) => `${b.total} ${b.currency}`).join(', ')}`);
    else if (p.windows && p.windows.length) console.log(`${p.label.padEnd(10)} ${p.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join('  ')}`);
  }
  process.exit(0);
}

function cmdServe() {
  // Run the server in the foreground (inherit stdio) — `cnos serve`.
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code || 0));
}

function cmdHelp() {
  process.stdout.write(`cnos — voice-and-text fleet of terminals, in your terminal

  cnos                         attach (full-screen TUI)
  cnos new [type] [opts]       spawn shell|claude|codex|hermes (default shell)
                                 --prompt <id>  --cwd <dir>  --name <call-sign>
  cnos ls                      list terminals
  cnos send <target> <text…>   type a command into a call-sign (or "all")
  cnos stop|clear|enter <tgt>  send a control key
  cnos kill <name>             kill a terminal
  cnos usage                   per-provider API usage
  cnos serve                   run the server in the foreground

  --port <n> (default ${PORT})   --server ws://host:port (attach to a remote cnos)

In attach mode the prefix key is Ctrl-A:
  Ctrl-A s/c/x/h  new shell/claude/codex/hermes      Ctrl-A 1-9  switch to terminal N
  Ctrl-A n/p      next / previous terminal           Ctrl-A k    kill current
  Ctrl-A :        type a command into current         Ctrl-A !    broadcast to all
  Ctrl-A w        set working dir for new terminals   Ctrl-A d    detach (leave fleet running)
  Ctrl-A ?        help                                Ctrl-A Ctrl-A  send a literal Ctrl-A
`);
  process.exit(0);
}

// ---- attach: full-screen TUI ------------------------------------------------
const PREFIX = 0x01;     // Ctrl-A
const MAX_HIST = 200_000;
const out = (s) => process.stdout.write(s);
const rows = () => process.stdout.rows || 24;
const cols = () => process.stdout.columns || 80;
const clearScreen = () => out('\x1b[2J\x1b[3J\x1b[H');

async function runAttach() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('attach needs an interactive terminal (try `cnos ls` / `cnos send`)');
  await ensureServer();
  const api = await connect().catch((e) => fail('connect failed: ' + e.message));

  const agents = new Map();        // id -> { id, name, type, promptLabel, history, exited }
  let order = [];                  // ids, display order
  let focusId = null;
  let mode = 'attach';             // attach | cmdkey | line | help
  let line = '', lineKind = null, linePrompt = '';
  let pendingFocus = false;        // focus the next spawned terminal
  let cwd = opts.cwd || '';
  const types = () => (api.hello && api.hello.agentTypes) || ['shell', 'claude', 'codex', 'hermes'];

  const focused = () => (focusId ? agents.get(focusId) : null);
  function syncList(list) {
    order = list.map((t) => t.id);
    for (const t of list) {
      const a = agents.get(t.id) || { id: t.id, history: '', exited: false };
      a.name = t.name; a.type = t.agentType || 'shell'; a.promptLabel = t.promptLabel || '';
      agents.set(t.id, a);
    }
    for (const id of [...agents.keys()]) if (!order.includes(id)) agents.delete(id);
    if (!focusId && order.length) setFocus(order[0]);
    if (!order.length) drawEmpty();
  }
  function resizeFocused() { const a = focused(); if (a) api.send({ type: 'resize', id: a.id, cols: cols(), rows: rows() }); }
  function setFocus(id) {
    focusId = id; const a = agents.get(id);
    clearScreen();
    if (a) { resizeFocused(); out(a.history); } else drawEmpty();
  }
  function drawEmpty() {
    clearScreen();
    out('\x1b[2m  cnos — no terminals yet.\r\n  Ctrl-A then  s shell · c claude · x codex · h hermes · ? help · d detach\x1b[0m\r\n');
  }
  function status(text) { out(`\x1b7\x1b[${rows()};1H\x1b[2K\x1b[7m ${text} \x1b[0m\x1b8`); }
  function refresh() { const a = focused(); clearScreen(); if (a) out(a.history); else drawEmpty(); }

  api._on = (m) => {
    switch (m.type) {
      case 'list': syncList(m.terminals); break;
      case 'spawned':
        agents.set(m.id, { id: m.id, name: m.name, type: m.agentType || 'shell', promptLabel: m.promptLabel || '', history: '', exited: false });
        if (!order.includes(m.id)) order.push(m.id);
        if (pendingFocus || !focusId) { pendingFocus = false; setFocus(m.id); } else status(`+ ${m.agentType} ${m.name}  (Ctrl-A ${order.indexOf(m.id) + 1} to switch)`);
        break;
      case 'output': {
        const a = agents.get(m.id); if (!a) break;
        a.history += m.data; if (a.history.length > MAX_HIST) a.history = a.history.slice(-MAX_HIST);
        if (m.id === focusId && mode === 'attach') out(m.data);
        break;
      }
      case 'exit': {
        const a = agents.get(m.id); if (a) a.exited = true;
        order = order.filter((x) => x !== m.id); agents.delete(m.id);
        if (m.id === focusId) { focusId = null; if (order.length) setFocus(order[0]); else drawEmpty(); }
        break;
      }
      case 'spawn-error': status('error: ' + m.message); break;
    }
  };
  syncList(api.agents);

  // ---- input ----
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', () => { if (mode === 'attach') resizeFocused(); });
  api.ws.on('close', () => { teardown(); process.stderr.write('cnos: connection closed\n'); process.exit(1); });

  function spawnType(t) { pendingFocus = true; api.send({ type: 'spawn', agentType: t, cwd: cwd || undefined }); }
  function cycle(d) { if (!order.length) return; const i = order.indexOf(focusId); setFocus(order[(i + d + order.length) % order.length]); }
  function detach() { teardown(); process.stdout.write('detached — fleet still running (reopen with `cnos`)\n'); process.exit(0); }

  function onKey(data) {
    if (mode === 'help') { mode = 'attach'; refresh(); return; }
    if (mode === 'line') return onLineKey(data);
    if (mode === 'cmdkey') { mode = 'attach'; return onCmd(data); }
    if (data.length === 1 && data[0] === PREFIX) {
      mode = 'cmdkey';
      status('cnos:  s/c/x/h spawn · 1-9 switch · n/p · : cmd · ! all · k kill · w cwd · ? help · d detach');
      return;
    }
    const a = focused(); if (a) api.send({ type: 'input', id: a.id, data: data.toString('utf8') });
  }

  function onCmd(data) {
    if (data.length === 1 && data[0] === PREFIX) { const a = focused(); if (a) api.send({ type: 'input', id: a.id, data: '\x01' }); return; }
    const k = data.toString('utf8');
    if (k === 's' || k === 'c' || k === 'x' || k === 'h') { spawnType({ s: 'shell', c: 'claude', x: 'codex', h: 'hermes' }[k]); return; }
    if (k >= '1' && k <= '9') { const id = order[+k - 1]; if (id) setFocus(id); else refresh(); return; }
    if (k === 'n') return cycle(1);
    if (k === 'p') return cycle(-1);
    if (k === 'k') { const a = focused(); if (a) api.send({ type: 'kill', id: a.id }); return; }
    if (k === 'd' || k === 'q') return detach();
    if (k === ':') { startLine('cmd', ':'); return; }
    if (k === '!') { startLine('all', '!all> '); return; }
    if (k === 'w') { startLine('cwd', 'cwd> '); return; }
    if (k === '?') { showHelp(); return; }
    refresh(); // unknown — just clear the status line
  }

  function startLine(kind, prompt) { mode = 'line'; lineKind = kind; line = ''; linePrompt = prompt; drawLine(); }
  function drawLine() { out(`\x1b[${rows()};1H\x1b[2K\x1b[1m${linePrompt}\x1b[0m${line}`); }
  function onLineKey(data) {
    if (data[0] === 0x0d || data[0] === 0x0a) { const v = line; mode = 'attach'; runLine(lineKind, v); refresh(); return; }
    if (data[0] === 0x1b) { mode = 'attach'; refresh(); return; }                 // Esc cancels
    if (data[0] === 0x7f || data[0] === 0x08) { line = line.slice(0, -1); drawLine(); return; }
    const s = data.toString('utf8').replace(/[\x00-\x1f]/g, ''); if (s) { line += s; drawLine(); }
  }
  function runLine(kind, v) {
    if (!v && kind !== 'cwd') return;
    if (kind === 'cmd') { const a = focused(); if (a) api.send({ type: 'command', target: a.name, text: v }); }
    else if (kind === 'all') api.send({ type: 'command', target: 'all', text: v });
    else if (kind === 'cwd') { cwd = v.trim(); status(`new terminals will spawn in: ${cwd || '(server default)'}`); }
  }

  function showHelp() {
    mode = 'help'; clearScreen();
    out(`\x1b[1m cnos attach — Ctrl-A is the prefix\x1b[0m\r\n\r\n` +
      `  Ctrl-A s / c / x / h   new shell / claude / codex / hermes\r\n` +
      `  Ctrl-A 1-9             switch to terminal N\r\n` +
      `  Ctrl-A n / p           next / previous terminal\r\n` +
      `  Ctrl-A :               type a command into the current terminal\r\n` +
      `  Ctrl-A !               broadcast a command to ALL terminals\r\n` +
      `  Ctrl-A k               kill the current terminal\r\n` +
      `  Ctrl-A w               set working dir for new terminals\r\n` +
      `  Ctrl-A d               detach (leave the fleet running)\r\n` +
      `  Ctrl-A Ctrl-A          send a literal Ctrl-A to the terminal\r\n\r\n` +
      `  Typing goes straight to the focused terminal (full TUI fidelity).\r\n` +
      `  The same fleet is live in the browser (\`npm start\`) and the iOS app.\r\n\r\n` +
      `\x1b[2m  press any key to return\x1b[0m`);
  }

  function teardown() { try { process.stdin.setRawMode(false); } catch {} out('\x1b[?25h\x1b[0m'); }
  process.on('exit', teardown);
  process.on('SIGTERM', () => { teardown(); process.exit(0); });
}

// ---- dispatch ---------------------------------------------------------------
(async () => {
  try {
    switch (cmd) {
      case 'attach': case 'tui': await runAttach(); break;
      case 'ls': case 'list': await cmdLs(); break;
      case 'new': case 'spawn': await cmdNew(); break;
      case 'send': case 'cmd': await cmdSend(); break;
      case 'stop': case 'interrupt': await cmdControl('interrupt'); break;
      case 'clear': await cmdControl('clear'); break;
      case 'enter': await cmdControl('enter'); break;
      case 'kill': await cmdKill(); break;
      case 'usage': await cmdUsage(); break;
      case 'serve': cmdServe(); break;
      case 'help': case '--help': case '-h': cmdHelp(); break;
      default: fail(`unknown command "${cmd}" — try \`cnos help\``);
    }
  } catch (e) { fail(e.message); }
})();
