// Hands-free voice for the CLI (macOS): capture the mic with ffmpeg (avfoundation)
// as 16 kHz mono PCM, run the same kind of energy VAD the web client uses to slice
// out each utterance, wrap it as a WAV, and POST it to the server's /transcribe
// (local Whisper). Emits the recognized text — the caller routes it via grammar.js.
//
// Audio capture can't be tested in this sandbox; it's written defensively (graceful
// onState('error', …) if ffmpeg/the mic is unavailable). The mic is auto-picked to
// avoid virtual devices (BlackHole etc., the web's #1 voice gotcha); override with
// `--mic <index>` / CNOS_MIC, and list devices with `cnos mics`.

import { spawn } from 'child_process';
import http from 'http';

const SPEECH_THRESH = Number(process.env.CNOS_VAD_THRESH) || 12;  // level 0..100
const SILENCE_MS = 800;     // trailing silence that ends an utterance
const MIN_UTTER_MS = 250;   // ignore sub-quarter-second blips
const MAX_UTTER_MS = 15000; // hard cap on one utterance
const PREROLL_MS = 250;     // keep a little audio before speech so starts aren't clipped
const SR = 16000;           // sample rate (mono, s16le)
const VIRTUAL = /blackhole|virtual|aggregate|loopback|soundflower|cable|vb-audio/i;

// Build a 16 kHz mono 16-bit WAV around raw PCM bytes.
export function buildWav(pcm) {
  const header = Buffer.alloc(44);
  const dataLen = pcm.length, byteRate = SR * 2;
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataLen, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

function levelOf(buf) {
  const n = buf.length >> 1; if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(i << 1) / 32768; sum += s * s; }
  return Math.min(100, Math.round(Math.sqrt(sum / n) * 300));
}

// Enumerate avfoundation audio input devices → [{ index, name }].
export function enumerateMics() {
  return new Promise((resolve) => {
    let err = '';
    let p;
    try { p = spawn('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { return resolve([]); }
    p.on('error', () => resolve([]));
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', () => {
      const list = []; let inAudio = false;
      for (const l of err.split('\n')) {
        if (/AVFoundation audio devices/i.test(l)) { inAudio = true; continue; }
        if (/AVFoundation video devices/i.test(l)) { inAudio = false; continue; }
        const m = l.match(/\[(\d+)\]\s+(.+?)\s*$/);
        if (inAudio && m) list.push({ index: Number(m[1]), name: m[2] });
      }
      resolve(list);
    });
  });
}

export async function listMics() {
  const a = await enumerateMics();
  if (!a.length) return 'no audio devices found (is ffmpeg installed? `brew install ffmpeg`)';
  return 'Audio input devices (use --mic <n> or CNOS_MIC):\n' + a.map((d) => `  [${d.index}] ${d.name}${VIRTUAL.test(d.name) ? '  (virtual — skipped by default)' : ''}`).join('\n');
}

function transcribe(httpUrl, wav) {
  return new Promise((resolve, reject) => {
    const u = new URL('/transcribe', httpUrl);
    const req = http.request(u, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'Content-Length': wav.length } }, (res) => {
      let body = ''; res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('transcribe timeout')));
    req.end(wav);
  });
}

// Pick a real mic: explicit override wins; else first built-in/non-virtual device.
async function resolveDevice(mic) {
  if (mic) return String(mic).startsWith(':') ? mic : ':' + mic;
  if (process.env.CNOS_MIC) return ':' + String(process.env.CNOS_MIC).replace(/^:/, '');
  const list = await enumerateMics();
  const real = list.find((d) => /built-in|macbook|internal/i.test(d.name) && !VIRTUAL.test(d.name))
    || list.find((d) => !VIRTUAL.test(d.name)) || list[0];
  return real ? ':' + real.index : ':default';
}

// onText(text) · onState(state, detail) — state: listening|off|speaking|thinking|error
export function createVoice({ httpUrl, mic, onText = () => {}, onState = () => {}, onLevel = () => {} }) {
  let proc = null, listening = false;
  let speaking = false, segStart = 0, lastVoice = 0, seg = [], preRoll = [], preRollBytes = 0;
  const preRollCap = Math.floor((PREROLL_MS / 1000) * SR) * 2;
  const reset = () => { speaking = false; seg = []; preRoll = []; preRollBytes = 0; };

  async function emit() {
    const pcm = Buffer.concat(seg); reset();
    if (pcm.length < (MIN_UTTER_MS / 1000) * SR * 2) return;
    onState('thinking');
    try { const r = await transcribe(httpUrl, buildWav(pcm)); const text = (r.text || '').trim(); if (text && /[a-z0-9]/i.test(text)) onText(text); }
    catch (e) { onState('error', e.message); }
    if (listening) onState('listening');
  }

  function onChunk(buf) {
    onLevel(levelOf(buf));
    const lvl = levelOf(buf), now = Date.now();
    if (lvl > SPEECH_THRESH) {
      if (!speaking) { speaking = true; segStart = now; seg = preRoll.slice(); onState('speaking'); }
      lastVoice = now; seg.push(buf);
    } else if (speaking) {
      seg.push(buf);
      if (now - lastVoice > SILENCE_MS || now - segStart > MAX_UTTER_MS) emit();
    } else {
      preRoll.push(buf); preRollBytes += buf.length;
      while (preRollBytes > preRollCap && preRoll.length) preRollBytes -= preRoll.shift().length;
    }
  }

  async function start() {
    if (listening) return;
    listening = true; reset();
    const device = await resolveDevice(mic);
    if (!listening) return; // stopped while resolving
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation', '-i', device, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'];
    try { proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { listening = false; onState('error', 'ffmpeg: ' + e.message); return; }
    let errBuf = '';
    proc.stdout.on('data', onChunk);
    proc.stderr.on('data', (d) => { errBuf = (errBuf + d).slice(-400); });
    proc.on('error', (e) => { listening = false; onState('error', e.code === 'ENOENT' ? 'ffmpeg not installed (brew install ffmpeg)' : e.message); });
    proc.on('exit', (code) => { const was = listening; listening = false; if (was && code) onState('error', `mic ${device} failed — try \`cnos mics\` then --mic <n>${errBuf ? ': ' + errBuf.trim() : ''}`); else onState('off'); });
    onState('listening', device);
  }
  function stop() { listening = false; if (proc) { try { proc.kill('SIGTERM'); } catch {} proc = null; } onState('off'); }
  function toggle() { if (listening) stop(); else start(); }

  return { start, stop, toggle, get listening() { return listening; } };
}
