/* cnos front-end: a grid of live terminals (shells + agents) + voice control. */

const FleetEl   = document.getElementById('fleet');
const EmptyEl   = document.getElementById('empty');
const TargetEl  = document.getElementById('target');
const HeardEl   = document.getElementById('heard');
const CardTpl   = document.getElementById('card-tpl');
const PromptSel = document.getElementById('promptSel'); // role-prompt picker for new agents

// Active terminal palette + font, driven by the theme engine (see "Theme" below).
// Seeded with the default so terminals created before applyTheme() still render.
let currentTermTheme = {
  background: '#141821', foreground: '#e6e9ef', cursor: '#7c9cff',
  selectionBackground: '#33405e',
  black: '#1b212d', red: '#ff6b6b', green: '#58d6a6', yellow: '#e6c07b',
  blue: '#7c9cff', magenta: '#c792ea', cyan: '#56b6c2', white: '#e6e9ef',
  brightBlack: '#5a6477', brightRed: '#ff8585', brightGreen: '#74e8bd',
  brightYellow: '#f1d49b', brightBlue: '#9db4ff', brightMagenta: '#d7a9f5',
  brightCyan: '#7fd3dd', brightWhite: '#ffffff',
};
let currentFontStack = '"SFMono-Regular", "SF Mono", ui-monospace, Menlo, monospace';
let currentFontSize = 12;

/** id -> { id, name, cwd, exited, term, fit, ro, el } */
const agents = new Map();
let ws = null;
let pendingSpawnAnnounce = false; // set when a spawn was requested by voice
let promptAliases = {};           // spoken alias -> role-prompt id (from the server's hello)
let fleetLayoutFrame = 0;

function queueFleetLayout() {
  if (fleetLayoutFrame) return;
  fleetLayoutFrame = requestAnimationFrame(() => {
    fleetLayoutFrame = 0;
    layoutFleetCards();
  });
}

// A grid row keeps its normal height so a tall card does not push terminals in
// neighboring columns downward. The last card in each visual column can then
// safely use any otherwise-empty space beneath it.
function layoutFleetCards() {
  const cards = [...FleetEl.querySelectorAll('.card')];
  for (const card of cards) {
    card.classList.remove('fills-column');
    card.style.removeProperty('--available-height');
  }
  if (!cards.length) return;

  const firstTop = cards[0].offsetTop;
  let columns = 0;
  while (columns < cards.length && Math.abs(cards[columns].offsetTop - firstTop) < 2) columns++;

  const fleetRect = FleetEl.getBoundingClientRect();
  const paddingBottom = parseFloat(getComputedStyle(FleetEl).paddingBottom) || 0;
  const contentTops = cards.map((card) => card.getBoundingClientRect().top - fleetRect.top + FleetEl.scrollTop);

  cards.forEach((card, index) => {
    if (index + columns < cards.length) return;
    const available = Math.max(0, FleetEl.clientHeight - contentTops[index] - paddingBottom);
    card.style.setProperty('--available-height', `${Math.floor(available)}px`);
    card.classList.add('fills-column');
  });
}

new ResizeObserver(queueFleetLayout).observe(FleetEl);

// ---- On-page voice diagnostics (so we never need DevTools) ------------------
const diagStatic = {
  api: (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) ? 'mic+recorder ✓' : 'MISSING ✗',
  engine: 'whisper (local)',
  secure: window.isSecureContext ? 'yes ✓' : 'NO ✗',
  perm: '?',
  device: document.documentElement.classList.contains('mobile') ? 'mobile ✓' : 'desktop',
};
const diagLines = [];
const diagEl = document.createElement('div');
diagEl.id = 'diag';
diagEl.hidden = true; // hidden by default; toggled from the 🔎 button in the top bar
diagEl.innerHTML = '<div class="diag-head">🔎 voice diagnostics <span id="diag-min">✕</span></div>'
  + '<div id="diag-body"></div>'
  + '<div class="diag-foot"><span class="diag-lab">level</span><div class="diag-meter"><div id="diag-level"></div></div><span id="diag-leveltxt">—</span></div>';
function mountDiag() { if (!diagEl.isConnected && document.body) document.body.appendChild(diagEl); renderDiag(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountDiag); else mountDiag();
function renderDiag() {
  const body = diagEl.querySelector('#diag-body');
  if (!body) return;
  body.innerHTML =
    `<div class="diag-stat">API: <b>${diagStatic.api}</b> · engine: <b>${diagStatic.engine}</b><br>secure: <b>${diagStatic.secure}</b> · device: <b>${diagStatic.device}</b> · mic: <b>${diagStatic.perm}</b> · ws: <b>${ws && ws.readyState === 1 ? 'open ✓' : '…'}</b></div>` +
    diagLines.map((l) => `<div class="diag-line">${escapeHtml(l)}</div>`).join('');
}
function diagLog(msg) {
  const t = (performance.now() / 1000).toFixed(1);
  diagLines.push(`${t}s  ${msg}`);
  while (diagLines.length > 16) diagLines.shift();
  console.log('[voice]', msg);
  srvLog(msg);
  renderDiag();
}
function srvLog(msg) { try { send({ type: 'clientlog', msg: String(msg) }); } catch {} }
diagEl.addEventListener('click', (e) => {
  if (e.target.id === 'diag-min') diagEl.hidden = true;
});
document.getElementById('diagToggle').onclick = () => { diagEl.hidden = !diagEl.hidden; renderDiag(); };

// Mic picker: getUserMedia({audio:true}) uses Chrome's DEFAULT mic, which may be
// a silent/wrong device. Let the user choose, and capture from that deviceId.
let selectedMicId = null;
const micSelectEl = () => document.getElementById('micSelect');
async function populateMics() {
  try {
    const ds = await navigator.mediaDevices.enumerateDevices();
    const mics = ds.filter((d) => d.kind === 'audioinput');
    const sel = micSelectEl();
    if (sel) {
      sel.innerHTML = '<option value="">🎤 default mic</option>';
      mics.forEach((m) => sel.add(new Option('🎤 ' + (m.label || ('mic ' + m.deviceId.slice(0, 6))), m.deviceId)));
      if (selectedMicId) sel.value = selectedMicId;
    }
    srvLog('mics: ' + mics.map((m) => m.label || '(no label)').join(' | '));
  } catch (e) { diagLog('enumerate failed: ' + e.message); }
}
micSelectEl()?.addEventListener('change', (e) => {
  selectedMicId = e.target.value || null;
  diagLog('mic switched → ' + (e.target.selectedOptions[0] ? e.target.selectedOptions[0].textContent : 'default'));
  if (listening) { stopListening(); setTimeout(startListening, 250); }
});

const VIRTUAL_MIC = /blackhole|virtual|aggregate|loopback|soundflower|cable|vb-audio/i;
// If Chrome's default capture device is a silent virtual device, switch to a real one.
async function autoPickRealMic(currentLabel) {
  if (selectedMicId || !VIRTUAL_MIC.test(currentLabel)) return;
  const ds = await navigator.mediaDevices.enumerateDevices();
  const mics = ds.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default');
  const real = mics.find((m) => /built-in|macbook|internal/i.test(m.label) && !VIRTUAL_MIC.test(m.label))
            || mics.find((m) => !VIRTUAL_MIC.test(m.label));
  if (!real) return;
  selectedMicId = real.deviceId;
  diagLog('default mic is virtual/silent → auto-switching to: ' + real.label);
  const sel = micSelectEl(); if (sel) sel.value = real.deviceId;
  if (listening) { stopListening(); setTimeout(startListening, 250); }
}

// ---- WebSocket plumbing -----------------------------------------------------
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => { diagLog('websocket connected'); renderDiag(); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    dispatch(msg);
  };
  ws.onclose = () => {
    note('connection lost — reconnecting…', 'warn');
    setTimeout(connect, 1500);
  };
}

function dispatch(msg) {
  switch (msg.type) {
    case 'hello':                                        // fresh connection
      serverHome = msg.home || serverHome;
      serverDefaultWorkdir = msg.workdir || serverDefaultWorkdir;
      if (!currentWorkdir) currentWorkdir = serverDefaultWorkdir;
      renderCwdLabel();
      populatePrompts(msg.prompts || []);
      resetFleet();
      break;
    case 'list':    syncList(msg.terminals); break;
    case 'spawned':
      ensureCard(msg);
      setTimeout(() => refreshUsage(true), 8000); // a fresh agent run refreshes its token/snapshot
      if (pendingSpawnAnnounce) {
        pendingSpawnAnnounce = false;
        const r = msg.promptLabel ? ` <span class="mut">(${escapeHtml(msg.promptLabel)})</span>` : '';
        note(`new ${escapeHtml(msg.agentType || 'agent')} <b>${escapeHtml(msg.name)}</b>${r} ready — say “<b>${escapeHtml(msg.name)}</b>, …”`);
      }
      break;
    case 'output':  agents.get(msg.id)?.term.write(msg.data); break;
    case 'exit':    markExited(msg.id); break;
    case 'routed':  flashRouted(msg); break;
    case 'spawn-error': note(escapeHtml(msg.message), 'warn'); break;
    case 'speaking':   setSpeaking(msg.on, msg.name); break;
  }
}

function resetFleet() {
  for (const a of agents.values()) destroyCard(a, true);
  agents.clear();
  refreshTargets();
  updateEmpty();
}

function syncList(list) {
  const keep = new Set(list.map((t) => t.id));
  for (const id of [...agents.keys()]) if (!keep.has(id)) markExited(id);
  for (const t of list) ensureCard(t);
}

// ---- Cards / terminals ------------------------------------------------------
function ensureCard({ id, name, agentType, promptLabel, cwd }) {
  let a = agents.get(id);
  if (a) { a.name = name; a.cwd = cwd; if (agentType) a.agentType = agentType; if (promptLabel !== undefined) a.promptLabel = promptLabel; paintHeader(a); refreshTargets(); return a; }

  const el = CardTpl.content.firstElementChild.cloneNode(true);
  const termEl = el.querySelector('.term');

  const term = new Terminal({
    fontFamily: currentFontStack,
    fontSize: currentFontSize, cursorBlink: true, scrollback: 8000,
    theme: currentTermTheme, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  // keystrokes typed directly into a focused terminal go to its PTY
  term.onData((data) => send({ type: 'input', id, data }));

  const doFit = () => {
    try { fit.fit(); send({ type: 'resize', id, cols: term.cols, rows: term.rows }); } catch {}
  };
  const ro = new ResizeObserver(() => requestAnimationFrame(doFit));
  ro.observe(termEl);

  a = { id, name, agentType: agentType || 'shell', promptLabel: promptLabel || '', cwd, exited: false, term, fit, ro, el };
  agents.set(id, a);

  el.querySelector('.interrupt').onclick = () => send({ type: 'control', target: name, action: 'interrupt' });
  el.querySelector('.clear').onclick     = () => send({ type: 'control', target: name, action: 'clear' });
  el.querySelector('.enter').onclick     = () => send({ type: 'control', target: name, action: 'enter' });
  el.querySelector('.kill').onclick      = () => send({ type: 'kill', id });

  FleetEl.appendChild(el);
  queueFleetLayout();
  paintHeader(a);
  requestAnimationFrame(doFit);
  refreshTargets();
  updateEmpty();
  return a;
}

function paintHeader(a) {
  a.el.querySelector('.name').textContent = a.name;
  const typeEl = a.el.querySelector('.type');
  if (typeEl) { typeEl.textContent = a.agentType || ''; typeEl.dataset.type = a.agentType || ''; }
  const roleEl = a.el.querySelector('.role');
  if (roleEl) { roleEl.textContent = a.promptLabel || ''; roleEl.hidden = !a.promptLabel; } // role-prompt badge
  a.el.classList.toggle('roled', !!a.promptLabel);
  const cwd = a.el.querySelector('.cwd');
  cwd.textContent = a.cwd.replace(/^.*\//, '…/') || a.cwd;
  cwd.title = a.cwd;
  a.el.classList.toggle('exited', a.exited);
}

function markExited(id) {
  const a = agents.get(id);
  if (!a || a.exited) return;
  a.exited = true;
  a.term.write('\r\n\x1b[2m── agent exited ──\x1b[0m\r\n');
  paintHeader(a);
  refreshTargets();
  // leave the card up briefly so the user sees the exit, then remove
  setTimeout(() => { if (agents.get(id)?.exited) { destroyCard(a); agents.delete(id); updateEmpty(); refreshTargets(); } }, 4000);
}

function destroyCard(a, immediate) {
  try { a.ro.disconnect(); } catch {}
  try { a.term.dispose(); } catch {}
  a.el.remove();
  queueFleetLayout();
}

function updateEmpty() { EmptyEl.hidden = agents.size > 0; }

function flashRouted({ target }) {
  const names = target === 'all' ? activeNames() : [String(target).toLowerCase()];
  for (const a of agents.values()) {
    if (names.includes(a.name)) {
      a.el.classList.add('routed');
      setTimeout(() => a.el.classList.remove('routed'), 700);
    }
  }
}

// ---- Targets / command bar --------------------------------------------------
function activeNames() {
  return [...agents.values()].filter((a) => !a.exited).map((a) => a.name);
}

function refreshTargets() {
  const prev = TargetEl.value;
  const names = activeNames();
  TargetEl.innerHTML = '';
  const all = new Option('▶ everyone', 'all');
  TargetEl.add(all);
  for (const n of names) TargetEl.add(new Option(n, n));
  TargetEl.value = names.includes(prev) || prev === 'all' ? prev : (names[0] || 'all');
}

document.getElementById('cmdForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('cmdInput');
  const text = input.value.trim();
  if (!text) return;
  send({ type: 'command', target: TargetEl.value, text });
  input.value = '';
});

document.getElementById('addBtn').onclick = () => send({
  type: 'spawn',
  agentType: document.getElementById('agentType').value,
  cwd: currentWorkdir || undefined,
  prompt: PromptSel.value || undefined,
});

// Fill the role-prompt picker from the server and build the voice alias map.
function populatePrompts(list) {
  promptAliases = {};
  if (PromptSel) {
    const prev = PromptSel.value;
    PromptSel.innerHTML = '<option value="">— none —</option>';
    for (const p of list) PromptSel.add(new Option(p.label, p.id));
    if ([...PromptSel.options].some((o) => o.value === prev)) PromptSel.value = prev;
  }
  for (const p of list) for (const a of (p.aliases || [])) promptAliases[a] = p.id;
}

// Clear the typed-but-unsent input for whoever's selected in the target bar
// (the default "▶ everyone" → all agents). Mirrors saying "everyone, clear".
document.getElementById('clearBtn').onclick = () => send({ type: 'control', target: TargetEl.value, action: 'clear' });


// ---- Voice control ----------------------------------------------------------
const BROADCAST = new Set(['everyone', 'all', 'team', 'fleet', 'everybody', 'guys']);
const FILLER    = new Set(['hey', 'ok', 'okay', 'yo', 'hi', 'hello', 'please', 'now', 'so', 'um', 'uh']);
const CONTROL = {
  interrupt: ['stop', 'stopit', 'stopthat', 'stopnow', 'stopplease', 'halt', 'cancel', 'cancelthat', 'abort', 'interrupt', 'nevermind', 'pause', 'wait', 'holdon'],
  escape:    ['escape', 'dismiss', 'goback'],
  enter:     ['enter', 'submit', 'send', 'sendit', 'go', 'run', 'runit', 'doit', 'confirm', 'yes', 'proceed'],
  clear:     ['clear', 'clearit', 'clearthat', 'clearinput', 'cleartext', 'cleartheinput', 'clearthetext', 'clearthecommand', 'erase', 'erasethat', 'erasethis', 'wipe', 'wipethat', 'wipeit', 'scratchthat', 'discard', 'discardthat', 'deletethat'],
};
// "new terminal" / "add an agent" / "spawn a cli" → launch a new agent (no target needed)
const SPAWN_VERB = /^(new|add|create|spawn|launch|open|start|another)\b/;
const SPAWN_NOUN = /\b(terminal|terminals|agent|agents|cli|claude|codex|hermes|window|windows|bot|instance|session)\b/;
const AGENT_TYPE_RE = /\b(claude|codex|hermes)\b/;
const clean = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// The TTS hook (tts-notify.py) prefixes every spoken line with "<Callsign> says, ".
// This matches that lead-in so we can discard the fleet's own voice if the mic
// catches it — the one signature no real spoken command ever has.
const TTS_ECHO_RE = /^\s*[a-z][a-z0-9-]*\s*,?\s+says\b/i;

function parseVoice(transcript) {
  // Drop the fleet's own TTS heard back through the mic. The speak hook announces
  // output as "<Callsign> says, <text>"; if the half-duplex mute has any gap (TTS
  // startup lag, a dropped /api/speaking ping, overlapping notifications), Whisper
  // catches it and we'd route the "<text>" right back to the agent — a self-feeding
  // loop. No genuine command has "says" as its second word, so treat it as echo.
  if (TTS_ECHO_RE.test(transcript)) return { echo: transcript };

  let tokens = transcript.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && FILLER.has(clean(tokens[0]))) tokens.shift();
  if (!tokens.length) return null;

  const phrase = tokens.join(' ').toLowerCase();
  if (SPAWN_VERB.test(phrase) && SPAWN_NOUN.test(phrase)) {
    const m = phrase.match(AGENT_TYPE_RE);
    // a role name anywhere in the phrase preloads that prompt, e.g. "new claude terminal, programmer"
    let prompt;
    for (const tok of tokens) { const id = promptAliases[clean(tok)]; if (id) { prompt = id; break; } }
    // "new terminal" → a blank shell; an agent type must be named explicitly.
    return { global: 'spawn', agentType: m ? m[1] : 'shell', prompt };
  }

  const head = clean(tokens[0]);
  let target;
  if (BROADCAST.has(head)) target = 'all';
  else if (activeNames().includes(head)) target = head;
  else return { error: transcript };           // must name an agent, "everyone", or "new terminal"

  const body = tokens.slice(1).join(' ').trim();
  if (!body) return { target, select: true };   // named an agent only → make it active
  const c = clean(body);
  for (const action in CONTROL) if (CONTROL[action].includes(c)) return { target, control: action };
  return { target, text: body };
}

function routeVoice(parsed, transcript) {
  if (!parsed) return;
  if (parsed.echo) {                 // the agent's own TTS came back through the mic
    diagLog('🔇 ignored TTS echo: "' + parsed.echo + '"');
    note('<span class="mut">🔇 ignored agent speech</span>');
    return;
  }
  if (parsed.global === 'spawn') {
    pendingSpawnAnnounce = true;
    send({ type: 'spawn', agentType: parsed.agentType, cwd: currentWorkdir || undefined, prompt: parsed.prompt });
    const role = parsed.prompt ? ` as <b>${escapeHtml(parsed.prompt)}</b>` : '';
    note(`heard <b>${escapeHtml(transcript)}</b> → <span class="route">launching a new ${parsed.agentType} terminal${role}…</span>`);
    return;
  }
  if (parsed.error) {
    note(`heard “${escapeHtml(transcript)}” — start with an agent name (“<b>jack</b>, …”), “<b>everyone</b>, …”, or “<b>new terminal</b>”`, 'warn');
    return;
  }
  TargetEl.value = parsed.target;              // reflect target in the bar
  if (parsed.select) { note(`heard <b>${escapeHtml(transcript)}</b> → ${routeLabel(parsed.target)} is now the target`); return; }
  if (parsed.control) {
    send({ type: 'control', target: parsed.target, action: parsed.control });
    const VERB = { interrupt: 'stop', clear: 'clear input' };
    const ICON = { clear: '🧹' };
    const verb = VERB[parsed.control] || parsed.control;
    note(`heard <b>${escapeHtml(transcript)}</b> → <span class="route">${ICON[parsed.control] || '⏹'} ${routeLabel(parsed.target)} ${verb}</span>`);
    return;
  }
  send({ type: 'command', target: parsed.target, text: parsed.text });
  note(`heard <b>${escapeHtml(transcript)}</b> → <span class="route">${routeLabel(parsed.target)}</span>`);
}

const routeLabel = (t) => (t === 'all' ? 'everyone' : t);

function note(html, kind) {
  HeardEl.hidden = false;
  HeardEl.innerHTML = html;
  HeardEl.style.color = kind === 'warn' ? 'var(--danger)' : '';
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

// ---- Voice: getUserMedia + VAD + MediaRecorder + local Whisper --------------
const micBtn = document.getElementById('micBtn');
const micLabel = micBtn.querySelector('.label');

function setMic(state, text) {
  micBtn.classList.toggle('on', state === 'on');
  micBtn.classList.toggle('err', state === 'err');
  micLabel.textContent = text;
}

// Voice-activity-detection / segmenting tuning
const SPEECH_THRESH = 14;   // input level (0–100) that counts as speech
const SILENCE_MS    = 850;  // trailing silence that ends an utterance
const MAX_IDLE_MS   = 6000; // recycle the recorder if no speech (keeps clips tiny)
const MIN_UTTER_MS  = 250;  // ignore sub-quarter-second blips

let listening = false;
let mediaStream = null, audioCtx = null, analyser = null, vadBuf = null, vadRAF = null;
let recorder = null, recMime = '', chunks = [];
let hadSpeech = false, lastSpeechAt = 0, segStartAt = 0;

// Half-duplex: while an agent is speaking (TTS), ignore the mic so we never
// transcribe our own voice back as a command. cnos's TTS hook pings the server,
// which relays a {speaking} message here. echoCancellation can't catch `say`
// (it plays outside the browser's audio graph), so we gate capture instead.
let speakingCount = 0, micSuppressUntil = 0, wasSuppressed = false;
const SPEAK_TAIL_MS = 500; // stay muted briefly after speech to swallow room echo
function micSuppressed() { return speakingCount > 0 || performance.now() < micSuppressUntil; }
function setSpeaking(on, name) {
  if (on) speakingCount++;
  else if (speakingCount > 0 && --speakingCount === 0) micSuppressUntil = performance.now() + SPEAK_TAIL_MS;
  if (listening) setMic('on', micSuppressed() ? '🔇 muted' : 'Listening');
  diagLog((on ? '🔇 ' : '🔈 ') + (name || 'agent') + (on ? ' speaking → mic muted' : ' done speaking'));
}
function dropCurrentSegment() {
  hadSpeech = false; // discard the in-flight clip instead of transcribing it
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
  else if (listening) startSegment();
}

const supported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
diagLog(supported ? 'voice ready: getUserMedia + MediaRecorder + Whisper' : 'getUserMedia/MediaRecorder MISSING');

if (!supported) {
  micBtn.disabled = true;
  setMic('err', 'No voice');
  note('this browser lacks getUserMedia/MediaRecorder — use a recent Chrome', 'warn');
} else {
  micBtn.onclick = () => (listening ? stopListening() : startListening());
  setTimeout(autoStart, 500);
}

// Resume a suspended AudioContext on the first user interaction (autoplay policy
// starts it suspended when voice auto-starts without a click).
['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().then(() => diagLog('audioctx resumed by gesture')).catch(() => {});
  }, true));

async function autoStart() {
  // Voice needs a secure context (HTTPS or localhost). Phones usually reach cnos
  // over plain http://<laptop-ip>, where getUserMedia is blocked — fail soft and
  // point the user at the command bar instead of flashing a scary "mic blocked".
  if (!window.isSecureContext) {
    setMic('off', 'Voice ⚠');
    note('🎙 voice needs HTTPS or localhost — on this connection, type commands in the bar above', 'warn');
    return;
  }
  try {
    const st = await navigator.permissions.query({ name: 'microphone' });
    diagStatic.perm = st.state + (st.state === 'granted' ? ' ✓' : '');
    diagLog('mic permission = ' + st.state);
    if (st.state === 'granted') return startListening();
    if (st.state === 'denied') {
      setMic('err', 'Mic blocked');
      note('🎙 microphone is blocked — click the camera/mic icon in the address bar, set “Allow”, then reload', 'warn');
      return;
    }
    setMic('off', 'Listen');
    note('🎙 click <b>Listen</b> (top-right) once to enable voice — Chrome will ask to use your mic');
    st.onchange = () => { diagStatic.perm = st.state; diagLog('mic permission → ' + st.state); if (st.state === 'granted' && !listening) startListening(); };
  } catch {
    startListening();
  }
}

async function startListening() {
  if (listening) return;
  setMic('on', 'Starting…');
  note('🎙 enabling microphone — click “Allow” if asked…');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: selectedMicId ? { exact: selectedMicId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    });
  } catch (err) {
    setMic('err', 'Mic blocked');
    diagStatic.perm = 'denied ✗'; diagLog('mic DENIED: ' + err.name);
    note('🎙 microphone permission denied — allow it via the camera/mic icon in the address bar, then click Listen', 'warn');
    return;
  }
  diagStatic.perm = 'granted ✓'; diagLog('mic GRANTED — listening (local Whisper)');
  const trackLabel = mediaStream.getAudioTracks()[0]?.label || '';
  diagLog('capturing from: ' + (trackLabel || '(unknown device)'));
  populateMics();
  autoPickRealMic(trackLabel);
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  diagLog('audioctx created state=' + audioCtx.state);
  try { await audioCtx.resume(); } catch {}
  diagLog('audioctx after resume=' + audioCtx.state);
  if (audioCtx.state === 'suspended') note('🎙 click anywhere on the page once to activate the mic (the browser requires one click)', 'warn');
  const src = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  vadBuf = new Uint8Array(analyser.fftSize);
  recMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  listening = true;
  setMic('on', 'Listening');
  note('🎙 listening — say “<b>jack</b>, build a login page”, “<b>everyone</b>, run the tests”, or “<b>new terminal</b>”');
  startSegment();
  vadLoop();
}

function startSegment() {
  if (!listening || !mediaStream) return;
  chunks = []; hadSpeech = false; segStartAt = performance.now(); lastSpeechAt = 0;
  try {
    recorder = recMime ? new MediaRecorder(mediaStream, { mimeType: recMime }) : new MediaRecorder(mediaStream);
  } catch { recorder = new MediaRecorder(mediaStream); }
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onSegmentStop;
  try { recorder.start(); } catch (err) { diagLog('recorder start failed: ' + err.message); }
}

function endSegment() {
  if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch {} }
}

function onSegmentStop() {
  const speech = hadSpeech;
  const dur = performance.now() - segStartAt;
  const blob = chunks.length ? new Blob(chunks, { type: recMime || 'audio/webm' }) : null;
  if (listening) startSegment();             // immediately re-arm for the next utterance
  if (speech && blob && dur > MIN_UTTER_MS) queueTranscribe(blob);
}

function vadLoop() {
  if (!listening || !analyser) return;
  analyser.getByteTimeDomainData(vadBuf);
  let sum = 0;
  for (let i = 0; i < vadBuf.length; i++) { const v = (vadBuf[i] - 128) / 128; sum += v * v; }
  const level = Math.min(100, Math.round(Math.sqrt(sum / vadBuf.length) * 300));
  const now = performance.now();

  const bar = diagEl.querySelector('#diag-level'); if (bar) bar.style.width = level + '%';
  const txt = diagEl.querySelector('#diag-leveltxt'); if (txt) txt.textContent = String(level);

  if (micSuppressed()) {
    // An agent is speaking (or just finished): never count this as speech, and
    // hold the segment open so the TTS audio is dropped, not sent to Whisper.
    hadSpeech = false; lastSpeechAt = 0; segStartAt = now; wasSuppressed = true;
    vadRAF = requestAnimationFrame(vadLoop);
    return;
  }
  if (wasSuppressed) {            // just un-muted → discard the TTS tail, start clean
    wasSuppressed = false;
    dropCurrentSegment();
    if (listening) setMic('on', 'Listening');
    vadRAF = requestAnimationFrame(vadLoop);
    return;
  }

  if (level > SPEECH_THRESH) { hadSpeech = true; lastSpeechAt = now; }
  if (hadSpeech && lastSpeechAt && now - lastSpeechAt > SILENCE_MS) endSegment();
  else if (!hadSpeech && now - segStartAt > MAX_IDLE_MS) endSegment(); // recycle idle recorder
  vadRAF = requestAnimationFrame(vadLoop);
}

// Transcribe queued clips one at a time (preserves command order, no drops).
let tQueue = [], tBusy = false;
function queueTranscribe(blob) { tQueue.push(blob); pumpTranscribe(); }
async function pumpTranscribe() {
  if (tBusy || !tQueue.length) return;
  tBusy = true;
  const blob = tQueue.shift();
  note('<span class="mut">🎙 transcribing…</span>');
  diagLog('↑ ' + Math.round(blob.size / 1024) + 'KB → Whisper');
  try {
    const r = await fetch('/transcribe', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
    const j = await r.json();
    const text = (j.text || '').trim();
    if (text && /[a-z0-9]/i.test(text)) { diagLog('🎙 HEARD: "' + text + '"'); routeVoice(parseVoice(text), text); }
    else diagLog('Whisper: (no words)' + (j.error ? ' — ' + j.error : ''));
  } catch (err) {
    diagLog('transcribe error: ' + err.message);
    note('🎙 transcription failed: ' + escapeHtml(err.message), 'warn');
  } finally {
    tBusy = false;
    pumpTranscribe();
  }
}

function stopListening() {
  listening = false;
  if (vadRAF) cancelAnimationFrame(vadRAF);
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  mediaStream = audioCtx = analyser = recorder = null;
  const bar = diagEl.querySelector('#diag-level'); if (bar) bar.style.width = '0%';
  setMic('off', 'Listen');
  note('voice off — click Listen to resume');
}

// ---- Working-directory picker -----------------------------------------------
// A 📁 button in the top bar opens a small folder browser (backed by /api/dirs).
// The chosen directory is where every NEW agent — manual “+ Add” and voice
// “new terminal” — gets spawned. Persisted in localStorage so it survives reloads.
const CwdBtn   = document.getElementById('cwdBtn');
const CwdLabel = CwdBtn.querySelector('.cwd-label');
const CwdPop   = document.getElementById('cwdPop');
const CwdPath  = document.getElementById('cwdPath');
const CwdGo    = document.getElementById('cwdGo');
const CwdList  = document.getElementById('cwdList');
const CwdUse   = document.getElementById('cwdUse');
const CwdMsg   = document.getElementById('cwdMsg');

let serverHome = '';
let serverDefaultWorkdir = '';
let currentWorkdir = localStorage.getItem('cnos.cwd') || '';
let browsePath = '';

function cwdShort(p) {
  if (!p) return '~';
  if (serverHome && p === serverHome) return '~';
  const base = String(p).replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  return base || p;
}
function renderCwdLabel() {
  CwdLabel.textContent = cwdShort(currentWorkdir);
  CwdBtn.title = 'New agents spawn in: ' + (currentWorkdir || '(server default)') + ' — click to change';
}

function cwdRow(label, fullPath, isUp) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'cwd-row' + (isUp ? ' up' : '');
  el.textContent = (isUp ? '↑  ' : '') + label;
  el.onclick = () => loadDirs(fullPath);
  return el;
}

async function loadDirs(p, isRetry) {
  CwdMsg.textContent = 'loading…';
  try {
    const r = await fetch('/api/dirs?path=' + encodeURIComponent(p || ''));
    const j = await r.json();
    if (!r.ok) {
      // a stale/typo path shouldn't dead-end the browser — fall back to the default
      if (!isRetry && p) { CwdMsg.textContent = (j.error || 'cannot open') + ' — showing default'; return loadDirs('', true); }
      CwdMsg.textContent = j.error || 'cannot open folder'; return;
    }
    serverHome = j.home || serverHome;
    browsePath = j.path;
    CwdPath.value = j.path;
    CwdList.innerHTML = '';
    if (j.parent) CwdList.appendChild(cwdRow('..', j.parent, true));
    for (const name of j.dirs) CwdList.appendChild(cwdRow(name, j.path.replace(/[/\\]+$/, '') + '/' + name, false));
    CwdMsg.textContent = j.dirs.length ? '' : '(no subfolders here)';
  } catch (e) { CwdMsg.textContent = 'error: ' + e.message; }
}

function openCwd() {
  const r = CwdBtn.getBoundingClientRect();
  CwdPop.style.top = (r.bottom + 6) + 'px';
  CwdPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 348)) + 'px';
  CwdPop.hidden = false;
  loadDirs(currentWorkdir || '');
}
function closeCwd() { CwdPop.hidden = true; }

CwdBtn.onclick = (e) => { e.stopPropagation(); if (CwdPop.hidden) openCwd(); else closeCwd(); };
CwdGo.onclick = () => loadDirs(CwdPath.value.trim());
CwdPath.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); loadDirs(CwdPath.value.trim()); } });
CwdUse.onclick = () => {
  currentWorkdir = browsePath || CwdPath.value.trim();
  if (currentWorkdir) localStorage.setItem('cnos.cwd', currentWorkdir); else localStorage.removeItem('cnos.cwd');
  renderCwdLabel();
  closeCwd();
  note(`📁 new agents will spawn in <b>${escapeHtml(currentWorkdir || 'the server default')}</b>`);
};
// dismiss on outside click / Escape
document.addEventListener('click', (e) => { if (!CwdPop.hidden && !CwdPop.contains(e.target) && !CwdBtn.contains(e.target)) closeCwd(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !CwdPop.hidden) closeCwd(); });

renderCwdLabel();

// ---- Usage meter (top bar) --------------------------------------------------
// Polls /api/usage and renders a per-provider utilization strip. Read-only:
// the server reads each CLI's existing creds/logs and never modifies them.
const UsageEl = document.getElementById('usage');
const USAGE_PROVIDER_IDS = new Set(['claude', 'codex', 'deepseek']);
const WIN_LABEL = { '5h': '5h', '7d': '7d', '7d_opus': 'opus' };

const lvlClass = (p) => (p >= 80 ? 'lvl-hot' : p >= 50 ? 'lvl-warn' : 'lvl-ok');

function fmtReset(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'window has since reset';
  const h = Math.floor(ms / 3.6e6), m = Math.round((ms % 3.6e6) / 6e4);
  return h >= 1 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}
function fmtAsOf(iso) {
  const t = Date.parse(iso); if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function fmtCurrency(value, currency) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return `${value} ${currency}`;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
}

function renderUsage(data) {
  const providers = Array.isArray(data?.providers)
    ? data.providers.filter((p) => USAGE_PROVIDER_IDS.has(p.id))
    : [];
  UsageEl.innerHTML = providers.map((p) => {
    const cls = ['usage-chip'];
    if (!p.available || p.creditAvailable === false) cls.push('off');
    else if (!p.live) cls.push('stale');

    let inner = `<span class="usage-name">${escapeHtml(p.label)}</span>`;
    if (p.available && p.balances?.length) {
      inner += p.balances.map((b) =>
        `<span class="usage-balance" title="Total available balance">${escapeHtml(fmtCurrency(b.total, b.currency))}</span>`
      ).join('');
    } else if (p.available && p.windows?.length) {
      inner += p.windows.map((w) => {
        const pct = Math.round(w.usedPercent);
        const L = lvlClass(pct);
        const tip = `${w.label}${w.resetsAt ? ' · ' + fmtReset(w.resetsAt) : ''}`;
        return `<span class="usage-win" title="${escapeHtml(tip)}">`
          + `<span class="lab">${escapeHtml(WIN_LABEL[w.key] || w.key)}</span>`
          + `<span class="usage-bar ${L}"><i style="width:${pct}%"></i></span>`
          + `<span class="usage-pct ${L}">${pct}%</span></span>`;
      }).join('');
      inner += p.live
        ? `<span class="usage-live" title="live from the usage API">● live</span>`
        : (p.asOf
            ? `<span class="usage-meta" title="${escapeHtml(p.reason || 'cached snapshot')}">as of ${escapeHtml(fmtAsOf(p.asOf))}</span>`
            : (p.reason ? `<span class="usage-meta" title="${escapeHtml(p.reason)}">${escapeHtml(p.reason)}</span>` : ''));
    } else {
      inner += `<span class="usage-na">${escapeHtml(p.reason || 'unavailable')}</span>`;
    }
    const chipTip = p.planType ? `${p.label} · ${p.planType} plan` : p.label;
    return `<div class="${cls.join(' ')}" data-provider="${escapeHtml(p.id)}" title="${escapeHtml(chipTip)}">${inner}</div>`;
  }).join('');
}

async function refreshUsage(force) {
  try {
    const r = await fetch('/api/usage' + (force ? '?force=1' : ''));
    if (r.ok) renderUsage(await r.json());
  } catch { /* keep last render */ }
}

UsageEl.addEventListener('click', () => {
  UsageEl.style.opacity = '0.5';
  refreshUsage(true).finally(() => { UsageEl.style.opacity = ''; });
});
refreshUsage();
setInterval(() => refreshUsage(), 60_000);

// ---- Theme engine (color scheme + font + text size) + fullscreen ------------
// Themes/fonts/sizes are defined in themes.js (loaded first). Applying a theme
// sets the CSS custom properties on :root, swaps the xterm palette/font/size on
// every open terminal, and persists the choice in localStorage. Fully local.
const _THEMES_SRC = (typeof CNOS_THEMES !== 'undefined') ? CNOS_THEMES : [];
const _FONTS_SRC  = (typeof CNOS_FONTS  !== 'undefined') ? CNOS_FONTS  : [];
const _SIZES_SRC  = (typeof CNOS_SIZES  !== 'undefined') ? CNOS_SIZES  : [{ id: 'normal', label: 'Normal', scale: 1 }];
const THEMES = Object.fromEntries(_THEMES_SRC.map((t) => [t.id, t]));
const FONTS  = Object.fromEntries(_FONTS_SRC.map((f) => [f.id, f]));
const DEFAULT_THEME = THEMES['cnos-dark'] ? 'cnos-dark' : (_THEMES_SRC[0] ? _THEMES_SRC[0].id : 'cnos-dark');
const UI_VARS = { bg: '--bg', panel: '--panel', panel2: '--panel-2', line: '--line', text: '--text', muted: '--muted', accent: '--accent', accent2: '--accent-2', danger: '--danger', live: '--live' };

let themeId = localStorage.getItem('cnos.theme') || DEFAULT_THEME;
let fontId  = localStorage.getItem('cnos.font')  || '';        // '' → follow the theme's recommended font
let sizeId  = localStorage.getItem('cnos.size')  || 'normal';
if (!THEMES[themeId]) themeId = DEFAULT_THEME;

const activeTheme = () => THEMES[themeId] || THEMES[DEFAULT_THEME] || _THEMES_SRC[0];
function activeFontStack() {
  const t = activeTheme();
  const fid = fontId || (t && t.font);
  return (FONTS[fid] || FONTS.sf || { stack: '"SFMono-Regular", ui-monospace, Menlo, monospace' }).stack;
}
const activeScale = () => (_SIZES_SRC.find((s) => s.id === sizeId) || { scale: 1 }).scale;

function xtermThemeFrom(t) {
  const x = t.term;
  return {
    background: x.background, foreground: x.foreground, cursor: x.cursor, cursorAccent: x.background,
    selectionBackground: x.selection,
    black: x.black, red: x.red, green: x.green, yellow: x.yellow,
    blue: x.blue, magenta: x.magenta, cyan: x.cyan, white: x.white,
    brightBlack: x.brightBlack, brightRed: x.brightRed, brightGreen: x.brightGreen, brightYellow: x.brightYellow,
    brightBlue: x.brightBlue, brightMagenta: x.brightMagenta, brightCyan: x.brightCyan, brightWhite: x.brightWhite,
  };
}

function applyTheme() {
  const t = activeTheme();
  if (!t) return;
  const root = document.documentElement;
  for (const k in UI_VARS) root.style.setProperty(UI_VARS[k], t.ui[k]);
  root.style.setProperty('--on-accent', t.dark ? '#0b0f17' : '#ffffff');
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = t.ui.panel;

  currentFontStack = activeFontStack();
  currentFontSize = Math.max(8, Math.round(12 * activeScale()));
  currentTermTheme = xtermThemeFrom(t);
  root.style.setProperty('--font-mono', currentFontStack);

  // Live-apply to every open terminal, then force a repaint — xterm v5 doesn't
  // always re-render on a font-family swap that doesn't change cell metrics.
  for (const a of agents.values()) {
    try {
      a.term.options.theme = currentTermTheme;
      a.term.options.fontFamily = currentFontStack;
      a.term.options.fontSize = currentFontSize;
      a.term.clearTextureAtlas?.();           // canvas/webgl glyph cache (no-op on DOM renderer)
      a.fit.fit();
      a.term.refresh(0, a.term.rows - 1);      // redraw all visible rows with the new glyphs
      send({ type: 'resize', id: a.id, cols: a.term.cols, rows: a.term.rows });
    } catch {}
  }
  renderThemePicker();
}

// A bundled web font may arrive a frame after it's selected (font-display: swap);
// when any font finishes loading, repaint terminals so the swap shows immediately.
if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('loadingdone', () => {
    for (const a of agents.values()) {
      try { a.term.clearTextureAtlas?.(); a.term.refresh(0, a.term.rows - 1); } catch {}
    }
  });
}

function setTheme(id) { if (THEMES[id]) { themeId = id; localStorage.setItem('cnos.theme', id); applyTheme(); } }
function setFont(id)  { fontId = id; if (id) localStorage.setItem('cnos.font', id); else localStorage.removeItem('cnos.font'); applyTheme(); }
function setSize(id)  { sizeId = id; localStorage.setItem('cnos.size', id); applyTheme(); }

const ThemeBtn  = document.getElementById('themeBtn');
const ThemePop  = document.getElementById('themePop');
const ThemeGrid = document.getElementById('themeGrid');
const FontSel   = document.getElementById('fontSel');
const SizeSel   = document.getElementById('sizeSel');

function renderThemePicker() {
  if (ThemeGrid) {
    ThemeGrid.innerHTML = '';
    for (const t of _THEMES_SRC) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-swatch' + (t.id === themeId ? ' active' : '');
      b.title = t.name + (t.dark ? '' : ' (light)');
      b.onclick = () => setTheme(t.id);
      b.innerHTML =
        `<span class="sw-strip" style="background:${t.ui.bg}">`
        + `<i style="background:${t.ui.accent}"></i>`
        + `<i style="background:${t.ui.accent2}"></i>`
        + `<i style="background:${t.ui.danger}"></i>`
        + `<i style="background:${t.ui.text}"></i>`
        + `<i style="background:${t.ui.panel}"></i></span>`
        + `<span class="sw-name">${escapeHtml(t.name)}</span>`;
      ThemeGrid.appendChild(b);
    }
  }
  if (FontSel && FontSel.options.length <= 1) for (const f of _FONTS_SRC) FontSel.add(new Option(f.label, f.id));
  if (FontSel) FontSel.value = fontId;
  if (SizeSel && !SizeSel.options.length) for (const s of _SIZES_SRC) SizeSel.add(new Option(s.label, s.id));
  if (SizeSel) SizeSel.value = sizeId;
}

FontSel?.addEventListener('change', (e) => setFont(e.target.value));
SizeSel?.addEventListener('change', (e) => setSize(e.target.value));

function openTheme() {
  const r = ThemeBtn.getBoundingClientRect();
  ThemePop.style.top = (r.bottom + 6) + 'px';
  ThemePop.style.left = Math.max(8, Math.min(r.left - 130, window.innerWidth - 328)) + 'px';
  ThemePop.hidden = false;
  renderThemePicker();
}
function closeTheme() { ThemePop.hidden = true; }
if (ThemeBtn && ThemePop) {
  ThemeBtn.onclick = (e) => { e.stopPropagation(); if (ThemePop.hidden) openTheme(); else closeTheme(); };
  document.addEventListener('click', (e) => { if (!ThemePop.hidden && !ThemePop.contains(e.target) && !ThemeBtn.contains(e.target)) closeTheme(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ThemePop.hidden) closeTheme(); });
}

// Fullscreen toggle (Fullscreen API + WebKit fallback for older Safari).
const FsBtn = document.getElementById('fsBtn');
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
function toggleFs() {
  if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); }
  else {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const p = req && req.call(el);
    if (p && p.catch) p.catch(() => {});
  }
}
function paintFs() { if (FsBtn) { const on = !!fsEl(); FsBtn.classList.toggle('on', on); FsBtn.title = on ? 'Exit fullscreen' : 'Fullscreen (F11)'; } }
if (FsBtn) {
  FsBtn.onclick = toggleFs;
  document.addEventListener('fullscreenchange', paintFs);
  document.addEventListener('webkitfullscreenchange', paintFs);
  paintFs();
}

applyTheme();   // apply the saved/default theme on load (CSS vars + terminal palette/font/size)

connect();
