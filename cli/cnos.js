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
// Messages received before a handler is attached are queued, so `api.attach(fn)`
// replays them — important for the grid, which needs the initial scrollback bytes.
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const queue = [];
    const api = {
      ws, hello: null, agents: [], _on: null,
      send: (o) => ws.send(JSON.stringify(o)), close: () => ws.close(),
      attach(fn) { api._on = fn; for (const m of queue) fn(m); queue.length = 0; },
    };
    let ready = false;
    ws.on('error', (e) => { if (!ready) reject(e); });
    ws.on('close', () => { if (!ready) reject(new Error('connection closed')); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'hello') api.hello = m;
      else if (m.type === 'list') { api.agents = m.terminals; if (!ready) { ready = true; resolve(api); } }
      if (api._on) api._on(m); else queue.push(m);
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

// ---- attach: live GRID TUI (terminal multiplexer) ---------------------------
// Every agent gets a live pane, all tiled and visible at once — the cnos web grid,
// in your terminal. Each agent's bytes feed a headless xterm sized to its pane, and
// the compositor (render.js) paints them all each frame. Ctrl-A is the prefix key.
const PREFIX = 0x01;     // Ctrl-A
const out = (s) => process.stdout.write(s);
const termW = () => process.stdout.columns || 80;
const termH = () => process.stdout.rows || 24;

async function runAttach() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('attach needs an interactive terminal (try `cnos ls` / `cnos send`)');
  const { computeLayout, renderFrame, makeTerm } = await import('./render.js');
  await ensureServer();
  const api = await connect().catch((e) => fail('connect failed: ' + e.message));

  const byId = new Map();          // id -> { id, name, type, promptLabel, term (headless) }
  let order = [];                  // ids, in pane order
  let focusIdx = 0;
  let layout = computeLayout(0, termW(), termH());
  let mode = 'attach';             // attach | cmdkey | line | help
  let line = '', lineKind = null, linePrompt = '';
  let pendingFocus = false;        // focus the next spawned terminal
  let cwd = opts.cwd || '';
  let dirty = false;

  const inOrder = () => order.map((id) => byId.get(id));
  const focused = () => byId.get(order[focusIdx]);

  // Re-tile to the current terminal size; size every agent's headless term + PTY to
  // its pane so each pane is a 1:1 view of that agent's screen.
  function relayout() {
    layout = computeLayout(order.length, termW(), termH());
    layout.panes.forEach((p, i) => {
      const a = byId.get(order[i]); if (!a) return;
      try { a.term.resize(p.innerCols, p.innerRows); } catch {}
      api.send({ type: 'resize', id: a.id, cols: p.innerCols, rows: p.innerRows });
    });
    if (focusIdx >= order.length) focusIdx = Math.max(0, order.length - 1);
    draw(true);
  }
  function draw(force) {
    if (mode !== 'attach') return;            // overlays (line/help/cmdkey) own the screen
    if (!order.length) { out('\x1b[2J\x1b[H\x1b[2m  cnos — no terminals.  Ctrl-A then s/c/x/h to spawn · ? help · d detach\x1b[0m'); return; }
    out(renderFrame(inOrder(), layout, focusIdx, { accent: '36' }));
    void force;
  }
  const scheduleDraw = () => { dirty = true; };
  const ticker = setInterval(() => { if (dirty && mode === 'attach') { dirty = false; draw(); } }, 36); // ~28fps, only when changed

  api.attach((m) => {
    switch (m.type) {
      case 'list': {
        order = m.terminals.map((t) => t.id);
        for (const t of m.terminals) {
          let a = byId.get(t.id);
          if (!a) { a = { id: t.id, term: makeTerm(40, 10) }; byId.set(t.id, a); }
          a.name = t.name; a.type = t.agentType || 'shell'; a.promptLabel = t.promptLabel || '';
        }
        for (const id of [...byId.keys()]) if (!order.includes(id)) { try { byId.get(id).term.dispose(); } catch {} byId.delete(id); }
        relayout();
        break;
      }
      case 'spawned': {
        if (!byId.has(m.id)) byId.set(m.id, { id: m.id, name: m.name, type: m.agentType || 'shell', promptLabel: m.promptLabel || '', term: makeTerm(40, 10) });
        if (!order.includes(m.id)) order.push(m.id);
        if (pendingFocus) { pendingFocus = false; focusIdx = order.indexOf(m.id); }
        relayout();
        break;
      }
      case 'output': { const a = byId.get(m.id); if (a) { a.term.write(m.data); scheduleDraw(); } break; }
      case 'exit': {
        const a = byId.get(m.id); if (a) { try { a.term.dispose(); } catch {} byId.delete(m.id); }
        order = order.filter((x) => x !== m.id);
        relayout();
        break;
      }
      case 'spawn-error': overlay('error: ' + m.message); break;
    }
  });

  out('\x1b[?1049h');                          // alternate screen (restored on detach)
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', relayout);
  api.ws.on('close', () => { teardown(); process.stderr.write('cnos: connection closed\n'); process.exit(1); });
  draw(true);

  function spawnType(t) { pendingFocus = true; api.send({ type: 'spawn', agentType: t, cwd: cwd || undefined }); }
  function setFocus(i) { if (i >= 0 && i < order.length) { focusIdx = i; draw(true); } }
  function cycle(d) { if (order.length) { focusIdx = (focusIdx + d + order.length) % order.length; draw(true); } }
  function detach() { teardown(); process.stdout.write('detached — fleet still running (reopen with `cnos`)\n'); process.exit(0); }
  function overlay(text) { out(`\x1b7\x1b[${termH()};1H\x1b[2K\x1b[7m ${text} \x1b[0m\x1b8`); }

  function onKey(data) {
    if (mode === 'help') { mode = 'attach'; draw(true); return; }
    if (mode === 'line') return onLineKey(data);
    if (mode === 'cmdkey') { mode = 'attach'; return onCmd(data); }
    if (data.length === 1 && data[0] === PREFIX) {
      mode = 'cmdkey';
      overlay('cnos: s/c/x/h spawn · 1-9 focus · n/p · : cmd · ! all · k kill · w cwd · ? help · d detach');
      return;
    }
    const a = focused(); if (a) api.send({ type: 'input', id: a.id, data: data.toString('utf8') });
  }

  function onCmd(data) {
    if (data.length === 1 && data[0] === PREFIX) { const a = focused(); if (a) api.send({ type: 'input', id: a.id, data: '\x01' }); return; }
    const k = data.toString('utf8');
    if (k === 's' || k === 'c' || k === 'x' || k === 'h') return spawnType({ s: 'shell', c: 'claude', x: 'codex', h: 'hermes' }[k]);
    if (k >= '1' && k <= '9') return setFocus(+k - 1);
    if (k === 'n') return cycle(1);
    if (k === 'p') return cycle(-1);
    if (k === 'k') { const a = focused(); if (a) api.send({ type: 'kill', id: a.id }); return; }
    if (k === 'd' || k === 'q') return detach();
    if (k === ':') return startLine('cmd', ':');
    if (k === '!') return startLine('all', '!all> ');
    if (k === 'w') return startLine('cwd', 'cwd> ');
    if (k === '?') return showHelp();
    draw(true); // unknown — repaint over the hint line
  }

  function startLine(kind, prompt) { mode = 'line'; lineKind = kind; line = ''; linePrompt = prompt; drawLine(); }
  function drawLine() { out(`\x1b[${termH()};1H\x1b[2K\x1b[?25h\x1b[1m${linePrompt}\x1b[0m${line}`); }
  function onLineKey(data) {
    if (data[0] === 0x0d || data[0] === 0x0a) { const v = line; mode = 'attach'; runLine(lineKind, v); draw(true); return; }
    if (data[0] === 0x1b) { mode = 'attach'; draw(true); return; }                 // Esc cancels
    if (data[0] === 0x7f || data[0] === 0x08) { line = line.slice(0, -1); drawLine(); return; }
    const s = data.toString('utf8').replace(/[\x00-\x1f]/g, ''); if (s) { line += s; drawLine(); }
  }
  function runLine(kind, v) {
    if (kind === 'cwd') { cwd = v.trim(); overlay(`new terminals spawn in: ${cwd || '(server default)'}`); return; }
    if (!v) return;
    const a = focused();
    if (kind === 'cmd' && a) api.send({ type: 'command', target: a.name, text: v });
    else if (kind === 'all') api.send({ type: 'command', target: 'all', text: v });
  }

  function showHelp() {
    mode = 'help'; out('\x1b[2J\x1b[H\x1b[?25l');
    out([
      '\x1b[1m cnos — live grid in your terminal (Ctrl-A is the prefix)\x1b[0m', '',
      '   Every agent is a live pane, all visible at once — like the web grid.', '',
      '   Ctrl-A s / c / x / h    new shell / claude / codex / hermes',
      '   Ctrl-A 1-9              focus pane N        Ctrl-A n / p   next / previous',
      '   Ctrl-A :                command → focused pane',
      '   Ctrl-A !                command → ALL panes',
      '   Ctrl-A k                kill focused        Ctrl-A w   set working dir',
      '   Ctrl-A d                detach (the fleet keeps running)',
      '   Ctrl-A Ctrl-A           send a literal Ctrl-A to the pane',
      '', '   Typing goes to the focused pane. Same fleet as the browser + iOS app.',
      '', '\x1b[2m   press any key to return\x1b[0m',
    ].join('\r\n'));
  }

  function teardown() { try { process.stdin.setRawMode(false); } catch {} clearInterval(ticker); out('\x1b[?25h\x1b[0m\x1b[?1049l'); }
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
