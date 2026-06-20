/* cnos front-end: a grid of live Claude terminals + voice orchestration. */

const FleetEl   = document.getElementById('fleet');
const EmptyEl   = document.getElementById('empty');
const TargetEl  = document.getElementById('target');
const HeardEl   = document.getElementById('heard');
const CardTpl   = document.getElementById('card-tpl');

const TERM_THEME = {
  background: '#141821', foreground: '#e6e9ef', cursor: '#7c9cff',
  selectionBackground: '#33405e',
  black: '#1b212d', red: '#ff6b6b', green: '#58d6a6', yellow: '#e6c07b',
  blue: '#7c9cff', magenta: '#c792ea', cyan: '#56b6c2', white: '#e6e9ef',
  brightBlack: '#5a6477', brightRed: '#ff8585', brightGreen: '#74e8bd',
  brightYellow: '#f1d49b', brightBlue: '#9db4ff', brightMagenta: '#d7a9f5',
  brightCyan: '#7fd3dd', brightWhite: '#ffffff',
};

/** id -> { id, name, cwd, exited, term, fit, ro, el } */
const agents = new Map();
let ws = null;
let pendingSpawnAnnounce = false; // set when a spawn was requested by voice
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
    case 'hello':   resetFleet(); break;                 // fresh connection
    case 'list':    syncList(msg.terminals); break;
    case 'spawned':
      ensureCard(msg);
      setTimeout(() => refreshUsage(true), 8000); // a fresh agent run refreshes its token/snapshot
      if (pendingSpawnAnnounce) {
        pendingSpawnAnnounce = false;
        note(`new ${escapeHtml(msg.agentType || 'agent')} <b>${escapeHtml(msg.name)}</b> ready — say “<b>${escapeHtml(msg.name)}</b>, …”`);
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
function ensureCard({ id, name, agentType, cwd }) {
  let a = agents.get(id);
  if (a) { a.name = name; a.cwd = cwd; if (agentType) a.agentType = agentType; paintHeader(a); refreshTargets(); return a; }

  const el = CardTpl.content.firstElementChild.cloneNode(true);
  const termEl = el.querySelector('.term');

  const term = new Terminal({
    fontFamily: 'SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12, cursorBlink: true, scrollback: 8000,
    theme: TERM_THEME, allowProposedApi: true,
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

  a = { id, name, agentType: agentType || 'claude', cwd, exited: false, term, fit, ro, el };
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

document.getElementById('addBtn').onclick = () => send({ type: 'spawn', agentType: document.getElementById('agentType').value });

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
    return { global: 'spawn', agentType: m ? m[1] : 'claude' };
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
    send({ type: 'spawn', agentType: parsed.agentType });
    note(`heard <b>${escapeHtml(transcript)}</b> → <span class="route">launching a new ${parsed.agentType} agent…</span>`);
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

connect();
