// cnos — per-provider API usage (rate-limit utilization) for the dashboard meter.
//
// Read-only by design: we read whatever credentials/logs each CLI already wrote
// and NEVER write them back. Providers return rate-limit utilization, a credit
// balance, or an honest "unavailable" with a reason.
//
//   Claude  — live  : GET https://api.anthropic.com/api/oauth/usage (OAuth token)
//   Codex   — cached: newest ~/.codex/sessions rollout's rate_limits snapshot
//   DeepSeek — live  : GET https://api.deepseek.com/user/balance (API key)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const HOME = os.homedir();

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

function readEnvValue(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim() || null;
  }
  return value.replace(/\s+#.*$/, '').trim() || null;
}

// ---- shared shaping helpers -------------------------------------------------

// Accept a utilization as either a 0–1 fraction or a 0–100 percentage.
function asPercent(v) {
  if (v == null || v === '' || Number.isNaN(Number(v))) return null;
  let n = Number(v);
  if (n > 0 && n <= 1) n *= 100; // looked like a fraction
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

// Normalize a reset marker (ISO string, epoch seconds, or epoch ms) to ISO.
function asResetIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Build one window from a provider's raw object, tolerant of field-name drift.
function toWindow(raw, key, label) {
  if (!raw || typeof raw !== 'object') return null;
  const used = asPercent(
    raw.used_percentage ?? raw.utilization ?? raw.used_percent ??
    (raw.used != null && raw.limit ? (raw.used / raw.limit) * 100 : null)
  );
  if (used == null) return null;
  return {
    key,
    label,
    usedPercent: used,
    resetsAt: asResetIso(raw.resets_at ?? raw.resetsAt ?? raw.reset_at ?? raw.resets ?? null),
  };
}

// A window_minutes value → a short human label (300 → "5h", 10080 → "Weekly").
function windowLabel(minutes, fallback) {
  if (!minutes) return fallback;
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return fallback;
}

// ---- Claude (live) ----------------------------------------------------------

// Where Claude Code keeps its OAuth credentials differs by OS. On macOS the CLI
// stores (and refreshes) them in the login Keychain under "Claude Code-credentials";
// the legacy ~/.claude/.credentials.json copy is frequently stale/expired there.
// So on darwin read the Keychain first and only fall back to the file. Both hold
// the same { claudeAiOauth: {...} } shape. The Keychain read can raise a one-time
// macOS "allow access" prompt for the node process — choose "Always Allow".
function readClaudeOauth() {
  if (process.platform === 'darwin') {
    try {
      const raw = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const o = JSON.parse(raw)?.claudeAiOauth;
      if (o?.accessToken) return o;
    } catch { /* not present or access denied — fall back to the file below */ }
  }
  return readJson(path.join(HOME, '.claude/.credentials.json'))?.claudeAiOauth || null;
}

// The usage endpoint is rate-limited PER ACCOUNT, and every Claude Code process
// signed in with this token polls it too — so a fleet of spawned agents plus this
// meter can collectively trip a 429. When that happens the API returns a
// Retry-After; honor it (don't touch the endpoint again until it passes) and keep
// serving the last good reading as stale rather than blanking the meter to an error.
let claudeLastGood = null; // { asOf, planType, windows } from the newest success
let claudeRetryUntil = 0;  // epoch ms — skip the endpoint until we pass this

// Retry-After is delta-seconds or an HTTP-date. Return an epoch-ms deadline,
// clamped to [1s, 10m] so a bogus header can't wedge the meter open or shut.
function retryAfterDeadline(header) {
  const now = Date.now();
  const clamp = (ms) => Math.min(Math.max(ms, now + 1000), now + 600_000);
  if (!header) return now + 60_000; // no hint → a sane default backoff
  const secs = Number(header);
  if (Number.isFinite(secs)) return clamp(now + secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? now + 60_000 : clamp(at);
}

// Reshape the last good reading into a (stale) provider payload, or an honest
// "unavailable" when we have nothing good to fall back on yet.
function claudeStale(base, reason) {
  if (!claudeLastGood) return { ...base, available: false, reason };
  return {
    ...base, available: true, live: false, stale: true, reason,
    asOf: claudeLastGood.asOf, planType: claudeLastGood.planType, windows: claudeLastGood.windows,
  };
}

async function claudeUsage() {
  const base = { id: 'claude', label: 'Claude' };
  const o = readClaudeOauth();
  if (!o?.accessToken) return { ...base, available: false, reason: 'not signed in to Claude' };
  if (o.expiresAt && o.expiresAt < Date.now()) {
    return { ...base, available: false, reason: 'token expired — run a Claude agent to refresh it' };
  }
  // Still inside a prior 429's Retry-After window — don't hit the endpoint at all.
  if (Date.now() < claudeRetryUntil) {
    return claudeStale(base, `rate-limited — retrying in ${Math.ceil((claudeRetryUntil - Date.now()) / 1000)}s`);
  }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${o.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) {
      claudeRetryUntil = retryAfterDeadline(res.headers.get('retry-after'));
      return claudeStale(base, `rate-limited — retrying in ${Math.ceil((claudeRetryUntil - Date.now()) / 1000)}s`);
    }
    if (res.status === 401) return { ...base, available: false, reason: 'token rejected — run a Claude agent to refresh it' };
    if (!res.ok) return claudeStale(base, `usage API returned ${res.status}`);
    const data = await res.json();
    const windows = [
      toWindow(data.five_hour, '5h', '5-hour'),
      toWindow(data.seven_day, '7d', 'Weekly'),
      toWindow(data.seven_day_opus, '7d_opus', 'Weekly · Opus'),
    ].filter(Boolean);
    if (!windows.length) return { ...base, available: false, reason: 'no rate-limit data (subscription plan only)' };
    claudeLastGood = { asOf: new Date().toISOString(), planType: data.plan_type || null, windows };
    return { ...base, available: true, live: true, planType: data.plan_type || null, windows };
  } catch (e) {
    return claudeStale(base, 'could not reach usage API: ' + (e.message || e.name));
  }
}

// ---- Codex (cached snapshot from newest session rollout) --------------------

// Extract the balanced {...} that follows the LAST occurrence of "key": in text.
function lastBalancedObject(text, key) {
  const needle = `"${key}":`;
  const at = text.lastIndexOf(needle);
  if (at === -1) return null;
  let i = text.indexOf('{', at);
  if (i === -1) return null;
  let depth = 0;
  for (let end = i; end < text.length; end++) {
    const c = text[end];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(i, end + 1)); } catch { return null; }
    }
  }
  return null;
}

// Newest .jsonl under ~/.codex/sessions. Rollout names are ISO-stamped, so a
// lexicographic sort of full paths is chronological — newest is the max path.
function newestCodexRollouts(root, limit = 12) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out.sort().reverse().slice(0, limit);
}

function codexUsage() {
  const base = { id: 'codex', label: 'Codex' };
  if (!exists(path.join(HOME, '.codex/auth.json'))) return { ...base, available: false, reason: 'not configured' };
  const sessions = path.join(HOME, '.codex/sessions');
  if (!exists(sessions)) return { ...base, available: false, reason: 'no Codex sessions yet' };

  for (const file of newestCodexRollouts(sessions)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes('"rate_limits"')) continue;
    const rl = lastBalancedObject(text, 'rate_limits');
    if (!rl) continue;
    const windows = [
      toWindow(rl.primary, '5h', windowLabel(rl.primary?.window_minutes, '5-hour')),
      toWindow(rl.secondary, '7d', windowLabel(rl.secondary?.window_minutes, 'Weekly')),
    ].filter(Boolean);
    if (!windows.length) continue;
    // The snapshot is from the last Codex API call, not live — surface that.
    let mtime = null;
    try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* ignore */ }
    return { ...base, available: true, live: false, asOf: mtime, planType: rl.plan_type || null, windows };
  }
  return { ...base, available: false, reason: 'no usage snapshot yet — run a Codex task (limits arrive on live calls)' };
}

// ---- DeepSeek (live account credit balance) ---------------------------------

async function deepseekUsage() {
  const base = { id: 'deepseek', label: 'DeepSeek' };
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    || readEnvValue(path.join(HOME, '.hermes/.env'), 'DEEPSEEK_API_KEY');
  if (!apiKey) return { ...base, available: false, reason: 'DEEPSEEK_API_KEY is not configured' };

  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) return { ...base, available: false, reason: 'API key rejected' };
    if (!res.ok) return { ...base, available: false, reason: `balance API returned ${res.status}` };

    const data = await res.json();
    const balances = Array.isArray(data.balance_infos)
      ? data.balance_infos.map((b) => ({
          currency: String(b.currency || '').toUpperCase(),
          total: String(b.total_balance ?? ''),
        })).filter((b) => b.currency && b.total && Number.isFinite(Number(b.total)))
      : [];
    if (!balances.length) return { ...base, available: false, reason: 'balance API returned no totals' };
    return { ...base, available: true, live: true, creditAvailable: data.is_available !== false, balances };
  } catch (e) {
    return { ...base, available: false, reason: 'could not reach balance API: ' + (e.message || e.name) };
  }
}

// ---- aggregate (with a short cache so polling can't hammer the API) ---------

const PROVIDERS = [claudeUsage, codexUsage, deepseekUsage];
let cache = null; // { at, payload }
const CACHE_MS = 30_000;

export async function getUsage({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.payload;
  const providers = await Promise.all(PROVIDERS.map(async (fn) => {
    try { return await fn(); } catch (e) { return { id: fn.name, label: fn.name, available: false, reason: 'error: ' + e.message }; }
  }));
  const payload = { asOf: new Date().toISOString(), providers };
  cache = { at: Date.now(), payload };
  return payload;
}
