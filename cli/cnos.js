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

async function cmdMics() {
  const { listMics } = await import('./voice.js');
  console.log(await listMics());
  process.exit(0);
}

function cmdHelp() {
  process.stdout.write(`cnos — voice-and-text fleet of terminals, in your terminal

  cnos                         the live grid + command bar (type or speak)
  cnos new [type] [opts]       spawn shell|claude|codex|hermes (default shell)
                                 --prompt <id>  --cwd <dir>  --name <call-sign>
  cnos ls                      list terminals
  cnos send <target> <text…>   type a command into a call-sign (or "all")
  cnos stop|clear|enter <tgt>  send a control key
  cnos kill <name>             kill a terminal
  cnos usage                   per-provider API usage
  cnos mics                    list microphones (for --mic)
  cnos serve                   run the server in the foreground

  --port <n> (default ${PORT})   --server ws://host:port   --mic <index>   --no-voice

The grid opens listening — just talk. Spoken or typed, commands route like the web:
  "new claude terminal"   "jack, build a login page"   "everyone, stop"   "kill zulu"
  spoken too: "mute" / "listen"   "zoom" / "zoom out"   "detach"
  Tab        cycle command target (all / each agent)
  ← →        focus a pane (also sets the target)
  Ctrl-V     toggle hands-free voice          Ctrl-Z  zoom into the focused pane
  Ctrl-K     kill focused pane                Ctrl-D  detach (fleet keeps running)
`);
  process.exit(0);
}

// ---- attach: web-style command bar + live agent grid ------------------------
// The web app, in your terminal: a grid of live agent panes (top) + a persistent
// command bar (bottom) where you TYPE or SPEAK commands — "new claude terminal",
// "jack build a login page", "everyone stop" — routed through the same grammar as
// the web. Hands-free voice (mic → /transcribe) is ON from launch — a live mic
// meter + pulse show it hearing you; Ctrl-V (or say "mute") toggles it.
const out = (s) => process.stdout.write(s);
const termW = () => process.stdout.columns || 80;
const termH = () => process.stdout.rows || 24;

async function runAttach() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('attach needs an interactive terminal (try `cnos ls` / `cnos send`)');
  const { computeLayout, renderFrame, makeTerm, cup } = await import('./render.js');
  const { parse, clean } = await import('./grammar.js');
  const { createVoice } = await import('./voice.js');
  await ensureServer();
  const api = await connect().catch((e) => fail('connect failed: ' + e.message));

  const byId = new Map();          // id -> { id, name, type, promptLabel, term }
  let order = [];                  // ids in pane order
  let focusIdx = 0;
  let target = 'all';              // command target: 'all' or an agent name
  let cwd = opts.cwd || '';
  let line = '';                   // command-bar input
  let zoom = false;                // raw passthrough to the focused pane
  let pendingFocus = false;        // focus the next spawned terminal
  let dirty = false, flashMsg = '', flashAt = 0;
  let vState = 'off', vLevel = 0, tick = 0;
  const ACCENT = '36';                                    // cyan — neutral across host themes
  const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const FLASH_MS = 4200;
  const voiceLive = () => vState === 'listening' || vState === 'speaking' || vState === 'thinking';

  const inOrder = () => order.map((id) => byId.get(id));
  const focused = () => byId.get(order[focusIdx]);
  const names = () => inOrder().map((a) => a.name);
  const promptAliases = () => { const m = {}; for (const p of (api.hello && api.hello.prompts) || []) for (const al of (p.aliases || [])) m[al] = p.id; return m; };
  const flash = (m) => { flashMsg = m; flashAt = Date.now(); dirty = true; };

  const voice = createVoice({
    httpUrl: HTTP_URL, mic: opts.mic,
    onText: (t) => routeLine(t, { voice: true }),
    onState: (st, d) => { vState = st; if (st === 'error') flash('voice unavailable — ' + (d || 'press ^V to retry')); dirty = true; },
    onLevel: (lvl) => { vLevel = Math.max(vLevel, Math.min(100, lvl * 1.7)); },   // fast attack; ticker eases the release
  });

  const layoutFor = () => computeLayout(zoom ? 1 : order.length, termW(), termH() - 3);
  let layout = layoutFor();

  function relayout() {
    layout = layoutFor();
    const targets = zoom ? (focused() ? [focused()] : []) : inOrder();
    targets.forEach((a, i) => { const p = layout.panes[i]; if (!a || !p) return; try { a.term.resize(p.innerCols, p.innerRows); } catch {} api.send({ type: 'resize', id: a.id, cols: p.innerCols, rows: p.innerRows }); });
    if (focusIdx >= order.length) focusIdx = Math.max(0, order.length - 1);
    draw();
  }

  // Lay out a list of colored {c: SGR, t: text} segments into <= W visible cells.
  function paintSegs(segs, W) {
    let out = '', used = 0;
    for (const s of segs) {
      if (used >= W) break;
      const ch = [...String(s.t)];
      const take = Math.min(ch.length, W - used);
      if (take <= 0) continue;
      out += (s.c ? `\x1b[${s.c}m` : '\x1b[0m') + ch.slice(0, take).join('') + '\x1b[0m';
      used += take;
    }
    return out + '\x1b[0m\x1b[K';
  }

  // The voice indicator: a breathing dot while idle-listening, a solid dot while it
  // hears you, a braille spinner while transcribing, calm when off.
  function voiceSeg() {
    if (vState === 'thinking') return { c: ACCENT, g: SPINNER[tick % SPINNER.length], t: 'transcribing' };
    if (vState === 'speaking') return { c: '1;' + ACCENT, g: '◉', t: 'hearing you' };
    if (vState === 'listening') { const on = (tick % 16) < 9; return { c: on ? ACCENT : '2;' + ACCENT, g: on ? '◉' : '◯', t: 'listening' }; }
    if (vState === 'error') return { c: '1;31', g: '⚠', t: 'voice off' };
    return { c: '2', g: '◯', t: 'voice off' };
  }

  // A small VU meter — bright bar on a dim track, eased so it falls smoothly.
  function meterSegs(mW) {
    const f = (Math.max(0, Math.min(100, vLevel)) / 100) * mW;
    const filled = Math.min(mW, Math.floor(f));
    const frac = f - Math.floor(f);
    const parts = '▏▎▍▌▋▊▉█';
    const partial = filled < mW && frac > 0.05 ? parts[Math.max(0, Math.min(7, Math.round(frac * 8) - 1))] : '';
    const track = mW - filled - (partial ? 1 : 0);
    const segs = [{ c: (vState === 'speaking' ? '1;' : '') + ACCENT, t: '█'.repeat(filled) + partial }];
    if (track > 0) segs.push({ c: '2', t: '·'.repeat(track) });
    return segs;
  }

  function statusSegs() {
    const v = voiceSeg();
    const segs = [{ c: '', t: ' ' }, { c: v.c, t: v.g + ' ' + v.t.padEnd(11) }, { c: '', t: ' ' }, ...meterSegs(14)];
    if (flashMsg && Date.now() - flashAt < FLASH_MS) segs.push({ c: '', t: '   ' }, { c: '1;' + ACCENT, t: flashMsg });
    else segs.push({ c: '2', t: '   target ' }, { c: ACCENT, t: target }, { c: '2', t: `   ${order.length} live` }, { c: '2', t: zoom ? '   zoom' : '   ^V mute · ^Z zoom · ^D quit' });
    return segs;
  }

  function inputSegs() {
    if (zoom) return [{ c: '2', t: '  typing goes to the zoomed pane — Esc (or say “zoom out”) to return' }];
    const lit = vState === 'listening' || vState === 'speaking';
    const prompt = { c: lit ? '1;' + ACCENT : '1', t: ' ❯ ' };
    if (line) { const room = Math.max(1, termW() - 3); const shown = line.length > room ? line.slice(line.length - room) : line; return [prompt, { c: '', t: shown }]; }
    return [prompt, { c: '2', t: vState === 'off' || vState === 'error' ? 'type a command…' : 'speak a command — or just type' }];
  }
  const inputCursorCol = (W) => line ? Math.min(W - 1, 3 + Math.min(line.length, Math.max(1, W - 3))) : 3;

  // The bottom command panel: a hairline rule, the voice/status line, the input line.
  function panelStr(W, H) {
    return cup(H - 3, 0) + '\x1b[2m' + '─'.repeat(W) + '\x1b[0m\x1b[K' +
      cup(H - 2, 0) + paintSegs(statusSegs(), W) +
      cup(H - 1, 0) + paintSegs(inputSegs(), W);
  }

  function welcomeStr(W, H) {
    const live = vState === 'listening' || vState === 'speaking';
    const lines = [
      ['1;' + ACCENT, 'cnos'],
      ['2', 'a fleet of terminals you drive by voice'],
      ['', ''],
      [live ? ACCENT : '2', (live ? '◉ listening — say ' : '◯ starting voice — ') + '“new claude terminal”'],
      ['2', 'or “new terminal” · “jack, build a login page” · “everyone, stop”'],
    ];
    const top = Math.max(0, Math.floor((H - 3 - lines.length) / 2));
    let s = '';
    lines.forEach(([c, t], i) => { const col = Math.max(0, Math.floor((W - [...t].length) / 2)); s += cup(top + i, col) + (c ? `\x1b[${c}m` : '') + t + '\x1b[0m'; });
    return s;
  }

  function draw() {
    const W = termW(), H = termH();
    let s = '\x1b[?2026h\x1b[?25l\x1b[H';
    let cursor = null;
    if (!order.length) {
      s += '\x1b[2J' + welcomeStr(W, H);
    } else if (zoom) {
      const r = renderFrame([focused()], layout, 0, { accent: ACCENT }); s += r.paint; cursor = r.cursor;
    } else {
      s += renderFrame(inOrder(), layout, focusIdx, { accent: ACCENT }).paint;
    }
    s += panelStr(W, H) + '\x1b[?2026l';
    if (zoom && cursor) s += '\x1b[?25h' + cup(cursor[0], cursor[1]);
    else s += '\x1b[?25h' + cup(H - 1, inputCursorCol(W));
    out(s);
  }
  // Repaint only the bottom panel — used for voice animation so the live meter and
  // pulse stay smooth without redrawing every agent pane each frame.
  function drawPanel() {
    const W = termW(), H = termH();
    out('\x1b[?2026h\x1b[?25l' + panelStr(W, H) + '\x1b[?2026l\x1b[?25h' + cup(H - 1, inputCursorCol(W)));
  }
  const scheduleDraw = () => { dirty = true; };
  const ticker = setInterval(() => {
    tick++;
    vLevel = vLevel > 0.6 ? vLevel * 0.8 : 0;             // ease the meter back down
    const animating = voiceLive() || (flashMsg && Date.now() - flashAt < FLASH_MS);
    if (dirty) { dirty = false; draw(); }
    else if (animating && !zoom) { order.length ? drawPanel() : draw(); }
  }, 36);

  api.attach((m) => {
    switch (m.type) {
      case 'list': {
        order = m.terminals.map((t) => t.id);
        for (const t of m.terminals) { let a = byId.get(t.id); if (!a) { a = { id: t.id, term: makeTerm(40, 10) }; byId.set(t.id, a); } a.name = t.name; a.type = t.agentType || 'shell'; a.promptLabel = t.promptLabel || ''; }
        for (const id of [...byId.keys()]) if (!order.includes(id)) { try { byId.get(id).term.dispose(); } catch {} byId.delete(id); }
        if (target !== 'all' && !names().includes(target)) target = 'all';
        relayout(); break;
      }
      case 'spawned': {
        if (!byId.has(m.id)) byId.set(m.id, { id: m.id, name: m.name, type: m.agentType || 'shell', promptLabel: m.promptLabel || '', term: makeTerm(40, 10) });
        if (!order.includes(m.id)) order.push(m.id);
        if (pendingFocus) { pendingFocus = false; focusIdx = order.indexOf(m.id); target = m.name; }
        flash(`+ ${m.agentType || 'agent'} ${m.name}`); relayout(); break;
      }
      case 'output': { const a = byId.get(m.id); if (a) { a.term.write(m.data); scheduleDraw(); } break; }
      case 'exit': { const a = byId.get(m.id); if (a) { try { a.term.dispose(); } catch {} byId.delete(m.id); } order = order.filter((x) => x !== m.id); if (zoom && !focused()) zoom = false; relayout(); break; }
      case 'spawn-error': flash('error: ' + m.message); break;
    }
  });

  out('\x1b[?1049h');                          // alternate screen
  process.stdin.setRawMode(true); process.stdin.resume();
  process.stdin.on('data', onKey);
  process.stdout.on('resize', relayout);
  api.ws.on('close', () => { teardown(); process.stderr.write('cnos: connection closed\n'); process.exit(1); });
  draw();

  // Hands-free by default: start listening the moment the grid opens, so you can
  // drive the fleet entirely by voice. Opt out with --no-voice / CNOS_NO_VOICE=1.
  if (opts['no-voice'] !== 'true' && process.env.CNOS_NO_VOICE !== '1') { flash('starting voice — speak a command'); voice.start(); }

  function spawnType(t, prompt) { pendingFocus = true; api.send({ type: 'spawn', agentType: t, cwd: cwd || undefined, prompt: prompt || undefined }); }
  function setFocus(i) { if (i >= 0 && i < order.length) { focusIdx = i; target = focused().name; draw(); } }
  function cycleFocus(d) { if (order.length) setFocus((focusIdx + d + order.length) % order.length); }
  function cycleTarget() { const list = ['all', ...names()]; const i = list.indexOf(target); target = list[(i + 1) % list.length]; if (target !== 'all') focusIdx = Math.max(0, names().indexOf(target)); draw(); }
  function detach() { teardown(); process.stdout.write('detached — fleet still running (reopen with `cnos`)\n'); process.exit(0); }

  // CLI-only spoken meta-commands (kept OUT of grammar.js so it stays in lockstep
  // with the web app). These let a hands-free user mute, zoom, and detach by voice.
  const LOCAL = {
    mute: new Set(['mute', 'muteit', 'mutevoice', 'stoplistening', 'stoplisteningplease', 'stopvoice', 'voiceoff', 'bequiet', 'quiet', 'silence', 'muteyourself']),
    unmute: new Set(['unmute', 'listen', 'startlistening', 'voiceon', 'listenup', 'wakeup', 'wakeupcnos']),
    zoom: new Set(['zoom', 'zoomin', 'maximize', 'focusmode', 'fullscreen', 'blowup']),
    unzoom: new Set(['unzoom', 'zoomout', 'minimize', 'restore', 'exitzoom', 'zoomback']),
    detach: new Set(['detach', 'quitcnos', 'exitcnos', 'closecnos', 'detachcnos', 'leavecnos']),
  };
  function localCommand(cp) {
    if (LOCAL.mute.has(cp)) { if (voice.listening) { voice.stop(); flash('muted — press ^V (or say nothing) to talk'); } return true; }
    if (LOCAL.unmute.has(cp)) { if (!voice.listening) { flash('listening'); voice.start(); } return true; }
    if (LOCAL.zoom.has(cp)) { if (order.length && !zoom) { zoom = true; relayout(); flash('zoomed — say “zoom out” to return'); } return true; }
    if (LOCAL.unzoom.has(cp)) { if (zoom) { zoom = false; relayout(); } return true; }
    if (LOCAL.detach.has(cp)) { detach(); return true; }
    return false;
  }

  function voiceFlash(r, t) {
    if (r.kind === 'spawn') return `“${t}” → new ${r.agentType || 'shell'}${r.prompt ? ' · ' + r.prompt : ''}`;
    if (r.kind === 'select') return `“${t}” → focus ${r.target}`;
    if (r.kind === 'control') return `“${t}” → ${r.target}: ${r.action}`;
    if (r.kind === 'command') return `♪ ${r.target} ◂ ${r.text}`;
    return '♪ ' + t;
  }

  // Route a typed line OR a voice transcript through the shared grammar.
  function routeLine(text, { voice: viaVoice = false } = {}) {
    const t = String(text).trim(); if (!t) return;
    if (localCommand(clean(t))) return;
    const r = parse(t, { activeNames: names(), promptAliases: promptAliases() });
    if (!r || r.kind === 'echo') { if (viaVoice) flash('· ignored “' + t + '”'); return; }
    if (r.kind === 'error') {
      if (viaVoice) { flash('· didn’t catch a target — “' + t + '”'); return; }
      return api.send({ type: 'command', target, text: t });   // typed → raw command to the current target
    }
    if (viaVoice) flash(voiceFlash(r, t));
    if (r.kind === 'spawn') return spawnType(r.agentType, r.prompt);
    if (r.kind === 'select') { const i = names().indexOf(r.target); if (i >= 0) setFocus(i); else { target = r.target; draw(); } return; }
    if (r.kind === 'control') return api.send({ type: 'control', target: r.target, action: r.action });
    if (r.kind === 'command') return api.send({ type: 'command', target: r.target, text: r.text });
  }

  function onKey(data) {
    if (zoom) {
      if (data.length === 1 && (data[0] === 0x1b || data[0] === 0x1a)) { zoom = false; relayout(); return; } // Esc / Ctrl-Z
      const a = focused(); if (a) api.send({ type: 'input', id: a.id, data: data.toString('utf8') });
      return;
    }
    if (data[0] === 0x1b && data.length > 1) {            // arrow escape sequences
      const seq = data.toString('latin1');
      if (seq === '\x1b[C') cycleFocus(1); else if (seq === '\x1b[D') cycleFocus(-1);
      return;
    }
    if (data.length === 1) {
      const b = data[0];
      if (b === 0x0d || b === 0x0a) { const v = line; line = ''; routeLine(v); draw(); return; } // Enter
      if (b === 0x1b) { line = ''; draw(); return; }                                             // Esc clears
      if (b === 0x7f || b === 0x08) { line = line.slice(0, -1); draw(); return; }                 // Backspace
      if (b === 0x09) return cycleTarget();                                                       // Tab
      if (b === 0x16) { voice.toggle(); return; }                                                 // Ctrl-V
      if (b === 0x1a) { if (order.length) { zoom = true; relayout(); } return; }                  // Ctrl-Z zoom
      if (b === 0x0b) { const a = focused(); if (a) api.send({ type: 'kill', id: a.id }); return; } // Ctrl-K
      if (b === 0x04) return detach();                                                            // Ctrl-D
      if (b === 0x03) { line = ''; draw(); return; }                                              // Ctrl-C clears
    }
    // Printable text — possibly a coalesced paste or fast-typed run of bytes. Submit
    // on any embedded newline so a pasted/merged command line still runs (single-key
    // Enter is already handled above for the normal char-at-a-time case).
    const raw = data.toString('utf8');
    if (/[\r\n]/.test(raw)) {
      const parts = raw.split(/\r\n|[\r\n]/);
      for (let i = 0; i < parts.length; i++) {
        line += parts[i].replace(/[\x00-\x1f\x7f]/g, '');
        if (i < parts.length - 1) { const v = line; line = ''; routeLine(v); }
      }
      draw(); return;
    }
    const s = raw.replace(/[\x00-\x1f\x7f]/g, '');
    if (s) { line += s; draw(); }
  }

  function teardown() { try { voice.stop(); } catch {} try { process.stdin.setRawMode(false); } catch {} clearInterval(ticker); out('\x1b[?25h\x1b[0m\x1b[?1049l'); }
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
      case 'mics': case 'mic': await cmdMics(); break;
      case 'serve': cmdServe(); break;
      case 'help': case '--help': case '-h': cmdHelp(); break;
      default: fail(`unknown command "${cmd}" — try \`cnos help\``);
    }
  } catch (e) { fail(e.message); }
})();
