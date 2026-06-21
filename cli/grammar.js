// Voice / command grammar for the CLI — a faithful port of public/app.js parseVoice
// (same vocabulary + agent-name mishearing aliases). Pure & testable: parse() turns a
// transcript or typed line into a routed action. The web app and CLI stay in lockstep.

const AGENT_TYPE_ALIASES = {
  claude: ['claude', 'claud', 'cloud', 'clawed', 'clawd', 'claudes', 'clode', 'klaud', 'chlaude', 'cloud9'],
  codex:  ['codex', 'codec', 'codecs', 'codeex', 'kodex', 'codux', 'codecks', 'codaks', 'codx'],
  hermes: ['hermes', 'hermies', 'hermez', 'herms', 'harmes', 'hermie'],
};
const AGENT_ALIAS_TO_TYPE = {};
for (const [t, ws] of Object.entries(AGENT_TYPE_ALIASES)) for (const w of ws) AGENT_ALIAS_TO_TYPE[w] = t;

const SPAWN_VERBS = new Set(['new', 'add', 'create', 'spawn', 'launch', 'open', 'start', 'another', 'make']);
const SPAWN_NOUNS = new Set(['terminal', 'terminals', 'agent', 'agents', 'cli', 'window', 'windows',
  'bot', 'instance', 'session', 'tab', 'console', 'shell', 'shells', 'bash', 'zsh',
  ...Object.keys(AGENT_ALIAS_TO_TYPE)]);
const CODEX_SPACED_RE = /code\s?-?x/;

const BROADCAST = new Set(['everyone', 'all', 'team', 'fleet', 'everybody', 'guys']);
const FILLER = new Set(['hey', 'ok', 'okay', 'yo', 'hi', 'hello', 'please', 'now', 'so', 'um', 'uh']);
const CONTROL = {
  interrupt: ['stop', 'stopit', 'stopthat', 'stopnow', 'stopplease', 'halt', 'cancel', 'cancelthat', 'abort', 'interrupt', 'nevermind', 'pause', 'wait', 'holdon'],
  escape: ['escape', 'dismiss', 'goback'],
  enter: ['enter', 'submit', 'send', 'sendit', 'go', 'run', 'runit', 'doit', 'confirm', 'yes', 'proceed'],
  clear: ['clear', 'clearit', 'clearthat', 'clearinput', 'cleartext', 'cleartheinput', 'clearthetext', 'clearthecommand', 'erase', 'erasethat', 'erasethis', 'wipe', 'wipethat', 'wipeit', 'scratchthat', 'discard', 'discardthat', 'deletethat'],
};
const TTS_ECHO_RE = /^\s*[a-z][a-z0-9-]*\s*,?\s+says\b/i;

export const clean = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Returns one of:
//   {kind:'echo'} | {kind:'spawn', agentType, prompt} | {kind:'error', transcript}
//   {kind:'select', target} | {kind:'control', target, action} | {kind:'command', target, text}
// or null for empty input.
export function parse(transcript, { activeNames = [], promptAliases = {} } = {}) {
  if (TTS_ECHO_RE.test(transcript)) return { kind: 'echo' };

  let tokens = String(transcript).trim().split(/\s+/).filter(Boolean);
  while (tokens.length && FILLER.has(clean(tokens[0]))) tokens.shift();
  if (!tokens.length) return null;

  const phrase = tokens.join(' ').toLowerCase();
  const ct = tokens.map(clean);

  const hasSpawnNoun = ct.some((t) => SPAWN_NOUNS.has(t)) || CODEX_SPACED_RE.test(phrase);
  if (SPAWN_VERBS.has(ct[0]) && hasSpawnNoun) {
    let agentType = 'shell';
    for (const t of ct) { if (AGENT_ALIAS_TO_TYPE[t]) { agentType = AGENT_ALIAS_TO_TYPE[t]; break; } }
    if (agentType === 'shell' && CODEX_SPACED_RE.test(phrase)) agentType = 'codex';
    let prompt;
    for (const tok of tokens) { const id = promptAliases[clean(tok)]; if (id) { prompt = id; break; } }
    return { kind: 'spawn', agentType, prompt };
  }

  const head = clean(tokens[0]);
  let target;
  if (BROADCAST.has(head)) target = 'all';
  else if (activeNames.includes(head)) target = head;
  else return { kind: 'error', transcript };

  const body = tokens.slice(1).join(' ').trim();
  if (!body) return { kind: 'select', target };
  const c = clean(body);
  for (const action in CONTROL) if (CONTROL[action].includes(c)) return { kind: 'control', target, action };
  return { kind: 'command', target, text: body };
}
