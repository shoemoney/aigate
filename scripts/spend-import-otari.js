#!/usr/bin/env node
// spend-import-otari — one-shot history importer. Copies Claude Code / Codex usage events out of
// otari's SQLite DB (opened read-only) into aigate's spend ledger via POST /api/spend/events.
// otari holds the same source_event_ids the collector emits, so the server dedupes: re-running is
// safe. Content-free by construction (otari stores no content; event keys are allow-listed anyway).
// Node >= 24, builtins only.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 'otari-import';
const DEFAULT_DB = '/Users/shoemoney/Projects/otari/otari.db';
const SOURCES = ['claude_code', 'codex'];
const MAX_INT = 2 ** 31 - 1;
const MIN_TS = Date.parse('2020-01-01T00:00:00Z');
const ID_RE = /^[A-Za-z0-9._:/-]+$/;

const EVENT_KEYS = new Set([
  'source_event_id', 'ts', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'cache_write_1h_tokens', 'cache_tokens_in_prompt', 'status', 'project',
  'session_id', 'session_started_at', 'scope',
]);

const HELP = `spend-import-otari — copy otari usage history into aigate's spend ledger

usage: node scripts/spend-import-otari.js [options]

  --db <path>          otari SQLite file, opened read-only (default ${DEFAULT_DB})
  --source <name>      claude_code | codex | all   (default all)
  --before <ISO>       only rows with timestamp < this instant
  --since <ISO>        only rows with timestamp >= this instant
  --dry-run            count and print what would be posted; post nothing
  --batch <N>          events per POST, 1..1000 (default 500)
  --help               this text

env: AIGATE_URL, AIGATE_TOKEN (else read from ~/.claude/aigate/env)
exit: 0 ok · 2 a post failed (safe to re-run, the server dedupes) · 1 bad args / config
`;

class Fatal extends Error {}
class PostFailed extends Error {}

function parseArgs(argv) {
  const o = { db: DEFAULT_DB, source: 'all', before: null, since: null, dryRun: false, batch: 500, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Fatal(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--db') o.db = val();
    else if (a === '--source') {
      o.source = val();
      if (o.source !== 'all' && !SOURCES.includes(o.source)) throw new Fatal('--source must be claude_code, codex or all');
    } else if (a === '--before' || a === '--since') {
      const t = Date.parse(val());
      if (!Number.isFinite(t)) throw new Fatal(`${a} needs an ISO-8601 timestamp`);
      o[a.slice(2)] = t;
    } else if (a === '--batch') {
      const n = Number(val());
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Fatal('--batch must be an integer 1..1000');
      o.batch = n;
    } else throw new Fatal(`unknown argument: ${a}`);
  }
  return o;
}

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

function loadConfig() {
  const file = readEnvFile(join(homedir(), '.claude', 'aigate', 'env'));
  const pick = (k) => process.env[k] || file[k] || '';
  return { url: pick('AIGATE_URL').replace(/\/+$/, ''), token: pick('AIGATE_TOKEN') };
}

// ── normalisation (mirrors clients/aigate-spend.js) ────────────────────────────────────────────
const ident = (s, max) => String(s ?? '').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, max);
const nat = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.min(Math.floor(Number(n)), MAX_INT) : 0);

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

// otari stores naive UTC text 'YYYY-MM-DD HH:MM:SS.ffffff'
function isoFromOtari(v) {
  const s = String(v ?? '').trim().replace(' ', 'T');
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) && t >= MIN_TS ? new Date(t).toISOString() : null;
}

const otariBound = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '000');

function splitLabel(label) {
  const s = String(label ?? '');
  const i = s.indexOf(':');
  const host = ident(i === -1 ? s : s.slice(0, i), 128).toLowerCase() || 'otari';
  const project = i === -1 ? '' : ident(s.slice(i + 1), 200);
  return { host, project };
}

// Returns { host, event } or null when the row cannot become a valid event.
export function mapRow(r) {
  const id = String(r.source_event_id ?? '');
  if (!id || id.length > 256 || !ID_RE.test(id)) return null;
  const ts = isoFromOtari(r.timestamp);
  if (!ts) return null;
  const model = cleanModel(r.model);
  const fromModel = providerFor(model);
  const provider = r.source === 'codex'
    ? (ident(r.provider, 128) || fromModel)
    : (fromModel !== 'unknown' ? fromModel : (ident(r.provider, 128) || 'unknown'));
  const cw = nat(r.cache_write_tokens);
  const { host, project } = splitLabel(r.source_label);
  const event = {
    source_event_id: id,
    ts,
    provider,
    model,
    input_tokens: nat(r.prompt_tokens),
    output_tokens: nat(r.completion_tokens),
    cache_read_tokens: nat(r.cache_read_tokens),
    cache_write_tokens: cw,
    cache_write_1h_tokens: Math.min(nat(r.cache_write_1h_tokens), cw),
    cache_tokens_in_prompt: Boolean(r.cache_tokens_in_prompt),
    status: r.status === 'success' ? 'success' : 'error',
    project,
    session_id: null,
    session_started_at: null,
    scope: '',
  };
  for (const k of Object.keys(event)) if (!EVENT_KEYS.has(k)) throw new Fatal(`refusing to send unexpected event field "${k}"`);
  return { host, event };
}

// ── posting ────────────────────────────────────────────────────────────────────────────────────
async function postBatch(cfg, source, host, events) {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify({ source, host, collector_version: VERSION, events }),
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(`${cfg.url}/api/spend/events`, { ...init, signal: AbortSignal.timeout(60_000) }); break; } catch (e) {
      if (attempt === 1) throw new PostFailed(`${source}/${host}: ${e.cause?.code || e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const text = await res.text();
  if (!res.ok) throw new PostFailed(`${source}/${host}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

const blank = () => ({ read: 0, skipped: 0, posted: 0, accepted: 0, duplicate: 0, rejected: 0 });
export const newStats = () => ({ claude_code: blank(), codex: blank() });

// Mutates `stats` as it goes so a failure part-way still reports how far it got.
export async function run(opts, cfg, stats, out = process.stdout) {
  const db = new DatabaseSync(`file:${opts.db}?immutable=1`, { readOnly: true });
  try {
    const wanted = opts.source === 'all' ? SOURCES : [opts.source];
    const where = [`source IN (${wanted.map(() => '?').join(',')})`];
    const params = [...wanted];
    if (opts.before != null) { where.push('timestamp < ?'); params.push(otariBound(opts.before)); }
    if (opts.since != null) { where.push('timestamp >= ?'); params.push(otariBound(opts.since)); }
    const stmt = db.prepare(`SELECT source, source_event_id, timestamp, provider, model, status, source_label, prompt_tokens,
      completion_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cache_tokens_in_prompt
      FROM usage_logs WHERE ${where.join(' AND ')} ORDER BY timestamp`);

    const buffers = new Map();   // `${source}\0${host}` -> events
    const dry = new Map();       // same key -> count, dry-run only
    let sample = null;

    const flush = async (source, host, events) => {
      const s = stats[source];
      const r = await postBatch(cfg, source, host, events);
      s.posted += events.length;
      s.accepted += nat(r.accepted);
      s.duplicate += nat(r.duplicate);
      s.rejected += nat(r.rejected);
    };

    for (const row of stmt.iterate(...params)) {
      const s = stats[row.source];
      s.read++;
      const m = row.source_event_id ? mapRow(row) : null;
      if (!m) { s.skipped++; continue; }
      const key = `${row.source}\0${m.host}`;
      if (opts.dryRun) {
        dry.set(key, (dry.get(key) || 0) + 1);
        s.posted++;
        sample ??= { source: row.source, host: m.host, event: m.event };
        continue;
      }
      let buf = buffers.get(key);
      if (!buf) { buf = []; buffers.set(key, buf); }
      buf.push(m.event);
      if (buf.length >= opts.batch) { buffers.set(key, []); await flush(row.source, m.host, buf); }
    }
    for (const [key, buf] of buffers) {
      if (!buf.length) continue;
      const [source, host] = key.split('\0');
      await flush(source, host, buf);
    }

    if (opts.dryRun) {
      for (const [key, n] of [...dry].sort()) {
        const [source, host] = key.split('\0');
        out.write(`would post ${n} ${source} events for host=${host}\n`);
      }
      if (sample) out.write(`sample ${JSON.stringify(sample)}\n`);
    }
  } finally {
    db.close();
  }
}

export function summaryLine(stats, opts) {
  const parts = SOURCES.map((s) => {
    const x = stats[s];
    return `${s}[read=${x.read} skipped=${x.skipped} posted=${x.posted} accepted=${x.accepted} duplicate=${x.duplicate} rejected=${x.rejected}]`;
  });
  const t = blank();
  for (const s of SOURCES) for (const k of Object.keys(t)) t[k] += stats[s][k];
  return `spend-import-otari${opts.dryRun ? ' (dry-run)' : ''}: rows read=${t.read} skipped=${t.skipped} posted=${t.posted} `
    + `accepted=${t.accepted} duplicate=${t.duplicate} rejected=${t.rejected} ${parts.join(' ')}`;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`spend-import-otari: ${e.message}\n\n${HELP}`);
    return 1;
  }
  if (opts.help) { process.stdout.write(HELP); return 0; }
  const cfg = loadConfig();
  if (!opts.dryRun && (!cfg.url || !cfg.token)) {
    process.stderr.write('spend-import-otari: AIGATE_URL and AIGATE_TOKEN are required (env or ~/.claude/aigate/env)\n');
    return 1;
  }
  const stats = newStats();
  let code = 0;
  try {
    await run(opts, cfg, stats);
  } catch (e) {
    process.stderr.write(`spend-import-otari: ${e.message}\n`);
    code = e instanceof PostFailed ? 2 : 1;
  }
  process.stdout.write(`${summaryLine(stats, opts)}\n`);
  return code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main());
