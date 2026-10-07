#!/usr/bin/env node
// aigate-spend — per-host usage collector. Tails Claude Code transcripts and Codex rollouts with a
// per-file byte-offset cursor, turns every billed API call into a content-free usage event and POSTs
// batches to aigate (/api/spend/events). Reads ONLY usage fields; no message text is ever read into
// an event, stored or sent. Node >= 24, builtins only. See the spend design for the wire format.
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

const VERSION = '1.0.0';
const DAY_MS = 86_400_000;
const CHUNK = 1 << 20;
const RING = 64;
const MAX_BODY = 900_000;
const MAX_INT = 2 ** 31 - 1;
const SIDECAR_TRUNCATE_BYTES = 20 * 1024 * 1024;
const SOURCES = ['claude_code', 'codex'];
const IN_PROMPT = 'cache_tokens_in_prompt'; // wire flag: true when cached tokens are a subset of input (OpenAI shape)

// The only keys an event may carry. Anything else is a bug here and fatal before it leaves the box.
const EVENT_KEYS = new Set([
  'source_event_id', 'ts', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'cache_write_1h_tokens', 'cache_tokens_in_prompt', 'status', 'project',
  'session_id', 'session_started_at', 'scope',
]);

const HELP = `aigate-spend ${VERSION} — ship local Claude Code / Codex token usage to aigate

usage: aigate-spend [options]

  --backfill           read every transcript from byte 0 regardless of the cursor (server dedupes; safe to repeat)
  --dry-run            parse and print counts; post nothing, advance nothing
  --since <days>       first-run window in days (default 7); with --backfill, only files modified within <days>
  --source <name>      claude_code | codex   (default: both)
  --json               print the summary as JSON instead of one line
  --state <file>       cursor file (default ~/.claude/aigate/spend-cursor.json)
  --help               this text

env: AIGATE_URL, AIGATE_TOKEN (else read from ~/.claude/aigate/env)
     AIGATE_SPEND_CLAUDE_ROOT   default ~/.claude/projects
     AIGATE_SPEND_CODEX_HOMES   colon list, default ~/.codex
     AIGATE_SPEND_BATCH         events per POST, default 500
     AIGATE_SPEND_HOST          host label, default short hostname
     AIGATE_SPEND_RETRY_MS      wait before the one transport retry, default 5000

exit: 0 ok · 2 aigate unreachable / rejected the batch (cursor not advanced) · 1 fatal (bad args, bad state)
`;

class Fatal extends Error {}
class PostFailed extends Error {}

const stats = {
  files: 0, changed: 0, scanned: 0, claude: 0, codex: 0, posted: 0, accepted: 0, duplicate: 0,
  rejected: 0, unpriced: 0, unattributed: 0, sessions: 0, errors: 0,
};

// ── args ────────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { backfill: false, dryRun: false, since: null, source: null, json: false, state: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Fatal(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--backfill') o.backfill = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--since') {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) throw new Fatal('--since needs a positive number of days');
      o.since = n;
    } else if (a === '--source') {
      o.source = val();
      if (!SOURCES.includes(o.source)) throw new Fatal(`--source must be one of ${SOURCES.join(', ')}`);
    } else if (a === '--state') o.state = val();
    else throw new Fatal(`unknown argument: ${a}`);
  }
  return o;
}

// ── config ──────────────────────────────────────────────────────────────────────────────────────
function readEnvFile(file) {
  const out = {};
  let txt;
  try { txt = readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of txt.split('\n')) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadConfig(opts) {
  const dir = join(homedir(), '.claude', 'aigate');
  const file = readEnvFile(join(dir, 'env'));
  const pick = (k) => process.env[k] || file[k] || '';
  const batch = Number(process.env.AIGATE_SPEND_BATCH);
  const retry = Number(process.env.AIGATE_SPEND_RETRY_MS);
  return {
    url: pick('AIGATE_URL').replace(/\/+$/, ''),
    token: pick('AIGATE_TOKEN'),
    host: (process.env.AIGATE_SPEND_HOST || hostname().split('.')[0] || 'unknown').toLowerCase(),
    claudeRoot: process.env.AIGATE_SPEND_CLAUDE_ROOT || join(homedir(), '.claude', 'projects'),
    codexHomes: (process.env.AIGATE_SPEND_CODEX_HOMES || join(homedir(), '.codex')).split(':').filter(Boolean),
    batch: Number.isInteger(batch) && batch > 0 ? Math.min(batch, 1000) : 500,
    retryMs: Number.isFinite(retry) && retry >= 0 ? retry : 5000,
    stateFile: opts.state || join(dir, 'spend-cursor.json'),
    sidecar: join(dir, 'spend-sessions.jsonl'),
  };
}

// ── cursor state ────────────────────────────────────────────────────────────────────────────────
function loadState(file) {
  if (!existsSync(file)) return { state: { version: 1, sessions_sidecar_offset: 0, files: {} }, fresh: true };
  let st;
  try { st = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Fatal(`state file ${file} is not valid JSON: ${e.message}`); }
  if (!st || st.version !== 1 || typeof st.files !== 'object' || st.files === null) {
    throw new Fatal(`state file ${file} has an unknown shape; move it aside to start over`);
  }
  if (!Number.isInteger(st.sessions_sidecar_offset)) st.sessions_sidecar_offset = 0;
  return { state: st, fresh: false };
}

function saveState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, file);
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
const ident = (s, max) => String(s ?? '').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, max);
const nat = (n) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_INT) : 0);
const num = (v) => (typeof v === 'number' ? v : 0);

function isoTs(v) {
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function cleanModel(m) {
  const s = String(m ?? '').replace(/\[[^\]]*\]/g, '').replace(/-contributor$/, '');
  return ident(s, 256) || 'unknown';
}

function providerFor(model) {
  const m = model.toLowerCase();
  if (m.startsWith('claude')) return 'anthropic';
  if (/^(gpt|o[1-9]|codex|chatgpt)/.test(m)) return 'openai';
  if (m.startsWith('muse')) return 'meta';
  if (/^(kimi|k3|moonshot)/.test(m)) return 'moonshot';
  if (m.startsWith('qwen')) return 'qwencloud';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.includes('/')) return 'openrouter';
  return 'unknown';
}

function walk(dir, accept, out = []) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, accept, out);
    else if (e.isFile() && accept(e.name)) out.push(p);
  }
  return out;
}

// Reads complete lines from `start`. Returns the byte offset just past the last line handed to
// `onLine`; a trailing partial line is left for the next run (unless it already parses as JSON).
function readLines(path, start, onLine) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = Buffer.alloc(0);
    let offset = start;
    let pos = start;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const nl = data.lastIndexOf(0x0a);
      if (nl === -1) { carry = data; continue; }
      for (const line of data.subarray(0, nl).toString('utf8').split('\n')) if (line) onLine(line);
      offset += nl + 1;
      carry = data.subarray(nl + 1);
    }
    if (carry.length) {
      const tail = carry.toString('utf8');
      let whole = false;
      try { JSON.parse(tail); whole = true; } catch { /* half-written line, wait for the newline */ }
      if (whole) { onLine(tail); offset += carry.length; }
    }
    return offset;
  } finally {
    closeSync(fd);
  }
}

function ringPush(ring, id) {
  ring.push(id);
  if (ring.length > RING) ring.shift();
}

// ── Claude Code reader ──────────────────────────────────────────────────────────────────────────
function claudeLine(line, st, out, path) {
  stats.scanned++;
  if (!line.includes('"usage"')) return;
  let d;
  try { d = JSON.parse(line); } catch { stats.errors++; return; }
  const m = d && d.message;
  if (!m || typeof m.id !== 'string' || !m.id || !m.usage || typeof m.usage !== 'object' || !d.timestamp) return;
  if (m.model === '<synthetic>') return;
  if (st.recentIds.includes(m.id)) return;
  const ts = isoTs(d.timestamp);
  if (!ts) { stats.errors++; return; }
  ringPush(st.recentIds, m.id);
  const u = m.usage;
  const model = cleanModel(m.model);
  const cw = nat(num(u.cache_creation_input_tokens));
  const projDir = path.includes('/subagents/') ? basename(dirname(dirname(dirname(path)))) : basename(dirname(path));
  const project = ident(d.cwd ? basename(String(d.cwd)) : projDir.split('-').pop(), 200);
  out.push({
    source_event_id: ident(m.id, 256),
    ts,
    provider: providerFor(model),
    model,
    input_tokens: nat(num(u.input_tokens)),
    output_tokens: nat(num(u.output_tokens)),
    cache_read_tokens: nat(num(u.cache_read_input_tokens)),
    cache_write_tokens: cw,
    cache_write_1h_tokens: Math.min(nat(num(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens)), cw),
    [IN_PROMPT]: false,
    status: d.isApiErrorMessage ? 'error' : 'success',
    project,
    session_id: ident(d.sessionId || basename(path, '.jsonl'), 256),
    session_started_at: null,
    scope: '',
  });
}

// ── Codex reader ────────────────────────────────────────────────────────────────────────────────
const TOKEN_KEYS = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens'];
const ZERO_TOTAL = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0 };
const CODEX_MARKERS = ['session_meta', 'turn_context', 'token_count', 'token_usage_record'];

function codexMeta(d, st) {
  const p = d.payload || {};
  if (d.type === 'session_meta') {
    st.provider = ident(p.model_provider || 'openai', 128) || 'openai';
    if (p.cwd) st.project = ident(basename(String(p.cwd)), 200);
    st.startedAt = isoTs(p.timestamp || d.timestamp);
    const model = p.model || (p.base_instructions && p.base_instructions.model);
    if (typeof model === 'string' && model) st.model = cleanModel(model);
  } else if (d.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) st.model = cleanModel(p.model);
  }
}

function codexLine(line, st, pass) {
  stats.scanned++;
  if (!CODEX_MARKERS.some((k) => line.includes(k))) return;
  let d;
  try { d = JSON.parse(line); } catch { stats.errors++; return; }
  if (!d || typeof d !== 'object') return;
  codexMeta(d, st);
  const p = d.payload || {};
  if (p.type === 'token_count' && p.info && p.info.total_token_usage && st.mode !== 'tur') {
    pass.tc.push({ ts: isoTs(d.timestamp), model: st.model, total: p.info.total_token_usage });
  } else if ((d.type === 'token_usage_record' || p.type === 'token_usage_record') && p.usage && st.mode !== 'tc') {
    const rid = typeof p.response_id === 'string' && p.response_id ? p.response_id : `${p.turn_id || 'turn'}:${d.ordinal ?? pass.tur.length}`;
    pass.tur.push({ ts: isoTs(d.timestamp), model: st.model, usage: p.usage, rid });
  }
}

function codexEvent(st, scope, ts, model, usage, id) {
  return {
    source_event_id: ident(id, 256),
    ts,
    provider: st.provider || 'openai',
    model: model || 'unknown',
    input_tokens: nat(num(usage.input_tokens)),
    output_tokens: nat(num(usage.output_tokens)),
    cache_read_tokens: nat(num(usage.cached_input_tokens)),
    cache_write_tokens: nat(num(usage.cache_write_input_tokens)),
    cache_write_1h_tokens: 0,
    [IN_PROMPT]: true,
    status: 'success',
    project: st.project || '',
    session_id: st.threadId,
    session_started_at: st.startedAt || null,
    scope,
  };
}

// Turns one pass worth of candidates into events and advances the file's counters. The mode is
// fixed per file: token_count's cumulative counter when present, else per-response usage records.
function codexFinish(st, pass, scope, out) {
  if (!st.mode) {
    if (pass.tc.length) st.mode = 'tc';
    else if (pass.tur.length) st.mode = 'tur';
  }
  if (st.mode === 'tc') {
    for (const c of pass.tc) {
      if (!c.ts) { stats.errors++; continue; }
      const cur = {};
      for (const k of TOKEN_KEYS) cur[k] = nat(num(c.total[k]));
      if (!st.tcLast && st.baseline) {
        st.tcLast = cur; // joined mid-file: the counter's history is not ours to bill
        continue;
      }
      const prev = st.tcLast || ZERO_TOTAL;
      const restarted = cur.input_tokens + cur.output_tokens < prev.input_tokens + prev.output_tokens;
      const delta = {};
      let any = false;
      for (const k of TOKEN_KEYS) {
        delta[k] = restarted ? cur[k] : Math.max(cur[k] - prev[k], 0);
        if (delta[k]) any = true;
      }
      st.tcLast = cur;
      if (!any) continue;
      out.push(codexEvent(st, scope, c.ts, c.model, delta, `${st.threadId}:tc:${++st.tcIndex}`));
    }
  } else if (st.mode === 'tur') {
    for (const c of pass.tur) {
      if (!c.ts) { stats.errors++; continue; }
      if (st.recentIds.includes(c.rid)) continue;
      ringPush(st.recentIds, c.rid);
      out.push(codexEvent(st, scope, c.ts, c.model, c.usage, `${st.threadId}:${c.rid}`));
    }
  }
}

// ── discovery ───────────────────────────────────────────────────────────────────────────────────
function discover(cfg, only) {
  const files = [];
  if (!only || only === 'claude_code') {
    for (const p of walk(cfg.claudeRoot, (n) => n.endsWith('.jsonl'))) files.push({ source: 'claude_code', path: p, scope: '' });
  }
  if (!only || only === 'codex') {
    const seen = new Set();
    for (const home of cfg.codexHomes) {
      let scope;
      try { scope = realpathSync(home); } catch { continue; }
      for (const sub of ['sessions', 'archived_sessions']) {
        for (const p of walk(join(scope, sub), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))) {
          let real = p;
          try { real = realpathSync(p); } catch { /* keep as is */ }
          if (seen.has(real)) continue;
          seen.add(real);
          files.push({ source: 'codex', path: p, scope });
        }
      }
    }
  }
  return files;
}

const freshEntry = (source, size, mtimeMs, offset) => ({
  source, size, mtimeMs, offset, mode: null, tcIndex: 0, tcLast: null, baseline: false,
  model: '', provider: '', project: '', threadId: '', startedAt: null, sessionId: '', recentIds: [],
});

function threadIdOf(path) {
  const m = basename(path, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1].toLowerCase() : basename(path, '.jsonl');
}

// Codex metadata lives in the first line only; a file skipped on first run still needs it.
function primeCodexMeta(path, st) {
  let line = null;
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      const n = readSync(fd, buf, 0, CHUNK, 0);
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl > 0) line = buf.subarray(0, nl).toString('utf8');
    } finally { closeSync(fd); }
  } catch { return; }
  if (!line || !line.includes('session_meta')) return;
  try { codexMeta(JSON.parse(line), st); } catch { /* metadata is best effort */ }
}

// Decides where reading starts. Returns { entry, skip }.
function planFile(f, stat, state, ctx) {
  const prior = state.files[f.path];
  const mtimeAge = Date.now() - stat.mtimeMs;
  if (ctx.opts.backfill) {
    if (ctx.opts.since && mtimeAge > ctx.opts.since * DAY_MS) return { skip: true };
    return { entry: freshEntry(f.source, stat.size, stat.mtimeMs, 0) };
  }
  if (prior && stat.size >= prior.offset) {
    if (prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) return { skip: true };
    return { entry: structuredClone(prior) };
  }
  if (prior) return { entry: freshEntry(f.source, stat.size, stat.mtimeMs, 0) }; // truncated or replaced
  if (ctx.fresh && mtimeAge > (ctx.opts.since || 7) * DAY_MS) {
    const e = freshEntry(f.source, stat.size, stat.mtimeMs, stat.size);
    if (f.source === 'codex') {
      e.threadId = threadIdOf(f.path);
      e.baseline = true;
      primeCodexMeta(f.path, e);
    }
    return { entry: e, skipRead: true };
  }
  return { entry: freshEntry(f.source, stat.size, stat.mtimeMs, 0) };
}

// ── posting ─────────────────────────────────────────────────────────────────────────────────────
async function httpJson(cfg, path, body) {
  const url = `${cfg.url}${path}`;
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(body),
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      break;
    } catch (e) {
      if (attempt === 1) throw new PostFailed(`${path}: ${e.cause?.code || e.message}`);
      await new Promise((r) => setTimeout(r, cfg.retryMs));
    }
  }
  const text = await res.text();
  if (!res.ok) throw new PostFailed(`${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function assertContentFree(events) {
  for (const ev of events) {
    for (const k of Object.keys(ev)) if (!EVENT_KEYS.has(k)) throw new Fatal(`refusing to send unexpected event field "${k}"`);
  }
}

async function postEvents(cfg, source, events, summary) {
  assertContentFree(events);
  const body = { source, host: cfg.host, collector_version: VERSION, summary, events };
  if (events.length > 1 && JSON.stringify(body).length > MAX_BODY) {
    const mid = events.length >> 1;
    await postEvents(cfg, source, events.slice(0, mid), summary);
    await postEvents(cfg, source, events.slice(mid), summary);
    return;
  }
  const r = await httpJson(cfg, '/api/spend/events', body);
  stats.posted += events.length;
  stats.accepted += nat(r.accepted);
  stats.duplicate += nat(r.duplicate);
  stats.rejected += nat(r.rejected);
  stats.unpriced += nat(r.unpriced);
  stats.unattributed += nat(r.unattributed);
}

async function replaySidecar(cfg, state) {
  let size;
  try { size = statSync(cfg.sidecar).size; } catch { return; }
  if (size < state.sessions_sidecar_offset) state.sessions_sidecar_offset = 0;
  if (size === state.sessions_sidecar_offset) return;
  const sessions = [];
  const end = readLines(cfg.sidecar, state.sessions_sidecar_offset, (line) => {
    try {
      const s = JSON.parse(line);
      if (s && typeof s === 'object' && !Array.isArray(s)) sessions.push(s);
    } catch { stats.errors++; }
  });
  for (let i = 0; i < sessions.length; i += 1000) {
    const chunk = sessions.slice(i, i + 1000);
    await httpJson(cfg, '/api/spend/sessions', { sessions: chunk });
    stats.sessions += chunk.length;
  }
  state.sessions_sidecar_offset = end;
  if (end >= size && size > SIDECAR_TRUNCATE_BYTES) {
    writeFileSync(cfg.sidecar, '', { mode: 0o600 });
    state.sessions_sidecar_offset = 0;
  }
}

// ── main run ────────────────────────────────────────────────────────────────────────────────────
async function run(opts, cfg) {
  const { state, fresh } = loadState(cfg.stateFile);
  const ctx = { opts, fresh };
  const queues = { claude_code: [], codex: [] };
  const live = !opts.dryRun;
  const fileCount = { claude_code: 0, codex: 0 };
  let lastSave = Date.now();

  if (live && (!cfg.url || !cfg.token)) throw new Fatal('AIGATE_URL and AIGATE_TOKEN are required (env or ~/.claude/aigate/env)');
  if (live) await replaySidecar(cfg, state);

  const commit = (t) => {
    state.files[t.path] = t.entry;
    if (Date.now() - lastSave > 5000) { saveState(cfg.stateFile, state); lastSave = Date.now(); }
  };

  const flush = async (source, items) => {
    const events = items.map((i) => i.ev);
    await postEvents(cfg, source, events, { files: fileCount[source], scanned: stats.scanned, errors: stats.errors });
    for (const { t } of items) if (--t.remaining === 0) commit(t);
  };

  const enqueue = async (source, events, t) => {
    if (!live) return;
    t.remaining = events.length;
    if (!events.length) { commit(t); return; }
    for (const ev of events) queues[source].push({ ev, t });
    while (queues[source].length >= cfg.batch) await flush(source, queues[source].splice(0, cfg.batch));
  };

  const files = discover(cfg, opts.source);
  stats.files = files.length;
  for (const f of files) fileCount[f.source]++;

  let failure = null;
  try {
    for (const f of files) {
      let stat;
      try { stat = statSync(f.path); } catch { continue; }
      const plan = planFile(f, stat, state, ctx);
      if (plan.skip) continue;
      const entry = plan.entry;
      entry.size = stat.size;
      entry.mtimeMs = stat.mtimeMs;
      const t = { path: f.path, entry, remaining: 0 };
      const out = [];
      if (plan.skipRead) {
        if (live) commit(t);
        continue;
      }
      const before = entry.offset;
      try {
        if (f.source === 'claude_code') {
          if (!entry.sessionId) entry.sessionId = basename(f.path, '.jsonl');
          entry.offset = readLines(f.path, entry.offset, (line) => claudeLine(line, entry, out, f.path));
        } else {
          entry.threadId = entry.threadId || threadIdOf(f.path);
          const pass = { tc: [], tur: [] };
          entry.offset = readLines(f.path, entry.offset, (line) => codexLine(line, entry, pass));
          codexFinish(entry, pass, f.scope, out);
        }
      } catch (e) {
        stats.errors++;
        process.stderr.write(`aigate-spend: cannot read ${f.path}: ${e.message}\n`);
        continue;
      }
      if (entry.offset > before) stats.changed++;
      stats[f.source === 'claude_code' ? 'claude' : 'codex'] += out.length;
      await enqueue(f.source, out, t);
    }
    for (const s of SOURCES) if (live && queues[s].length) await flush(s, queues[s].splice(0));
  } catch (e) {
    if (e instanceof Fatal) throw e;
    failure = e;
  }

  if (live) {
    for (const p of Object.keys(state.files)) if (!existsSync(p)) delete state.files[p];
    saveState(cfg.stateFile, state);
  }
  if (failure) throw failure;
}

// ── output ──────────────────────────────────────────────────────────────────────────────────────
const fmtN = (n) => n.toLocaleString('en-US');
const fmtScanned = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function summary(cfg, opts, took) {
  const s = { host: cfg.host, ...stats, took_s: Number((took / 1000).toFixed(1)) };
  if (opts.json) return JSON.stringify(s);
  return `aigate-spend: host=${s.host} files=${fmtN(s.files)} changed=${fmtN(s.changed)} scanned=${fmtScanned(s.scanned)} `
    + `claude=${fmtN(s.claude)} codex=${fmtN(s.codex)} posted=${fmtN(s.posted)} accepted=${fmtN(s.accepted)} `
    + `duplicate=${fmtN(s.duplicate)} rejected=${fmtN(s.rejected)} unpriced=${fmtN(s.unpriced)} `
    + `unattributed=${fmtN(s.unattributed)} sessions=${fmtN(s.sessions)} errors=${fmtN(s.errors)} took=${s.took_s}s`;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`aigate-spend: ${e.message}\n\n${HELP}`);
    return 1;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  const cfg = loadConfig(opts);
  const started = Date.now();
  let code = 0;
  try {
    await run(opts, cfg);
  } catch (e) {
    process.stderr.write(`aigate-spend: ${e.message}\n`);
    code = e instanceof Fatal ? 1 : 2;
    if (code === 2) stats.errors++;
  }
  process.stdout.write(`${summary(cfg, opts, Date.now() - started)}\n`);
  return code;
}

process.exit(await main());
