/**
 * aigate/spend — usage-event store, attribution map, price table and the /api/spend routes.
 * Collectors POST content-free usage events; this module dedupes, attributes (spend_sessions),
 * prices at ingest (spend-pricing.js) and serves the read model. request_log is never touched.
 * server.js keeps a four-line hook: ensureSchema + seedIfNeeded at boot, pruneOld in backupNow,
 * and the /api/spend dispatch (after the auth gate).
 */
import { seedPrices, pickRate, priceEvent, billingClass, toMicros, fromMicros } from './spend-pricing.js';

const SEED_SENTINEL = 'spend_prices_seed_v1';
const MAX_EVENTS = 1000;
const MAX_INT = 2 ** 31 - 1;
const MIN_TS = Date.parse('2020-01-01T00:00:00Z');
const FUTURE_SLACK_MS = 48 * 3600e3;
const SKEW_MS = 120e3;          // attribution time-rule tolerance (hook/lease vs event clocks)
const DAY_MS = 86400e3;
const REPRICE_CHUNK = 5000;
const SOURCES = new Set(['claude_code', 'codex']);   // sources with an aigate launcher: session/lease attribution
// usage events may also come from tools aigate has no collector for (imported from otari); never attributed
const EVENT_SOURCES = new Set([...SOURCES, 'opencode', 'muse', 'hermes', 'qwen', 'kimi', 'gemini']);
const KINDS = new Set(['claude', 'codex']);

const ID_RE = /^[A-Za-z0-9._:/-]+$/;
const ACCT_RE = /^[A-Za-z0-9._:@/+-]{1,128}$/;
const PRICE_PROVIDER_RE = /^[A-Za-z0-9._:*-]{1,128}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BATCH_KEYS = new Set(['source', 'host', 'collector_version', 'summary', 'events']);
const SUMMARY_KEYS = new Set(['files', 'scanned', 'errors']);
const EVENT_KEYS = new Set(['source_event_id', 'ts', 'provider', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'cache_write_1h_tokens', 'cache_tokens_in_prompt', 'duration_ms', 'status', 'project', 'session_id',
  'session_started_at', 'scope']);
const SESSION_KEYS = new Set(['source', 'host', 'session_id', 'scope', 'account', 'kind', 'via', 'ts']);
// belt and braces: these are refused by name with the content message even though the allow-list already excludes them
const FORBIDDEN = new Set(['prompt', 'completion', 'content', 'messages', 'text', 'input', 'output', 'tool_input', 'tool_output',
  'tool_result', 'transcript', 'response', 'system', 'thinking']);

// ---- schema / seed / retention ------------------------------------------

export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      source                TEXT    NOT NULL,
      source_event_id       TEXT    NOT NULL,
      ts                    TEXT    NOT NULL,
      received_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      provider              TEXT    NOT NULL,
      model                 TEXT    NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      cache_tokens_in_prompt INTEGER NOT NULL DEFAULT 0,
      duration_ms           INTEGER,
      status                TEXT,
      host                  TEXT    NOT NULL DEFAULT '',
      project               TEXT    NOT NULL DEFAULT '',
      session_id            TEXT,
      session_started_at    TEXT,
      scope                 TEXT    NOT NULL DEFAULT '',
      account               TEXT,
      account_kind          TEXT,
      attributed_by         TEXT,
      billing               TEXT    NOT NULL DEFAULT 'unknown',
      cost_micros           INTEGER,
      price_id              INTEGER,
      priced_at             TEXT,
      UNIQUE(source, source_event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ue_ts        ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_ue_session   ON usage_events(host, session_id);
    CREATE INDEX IF NOT EXISTS idx_ue_scope     ON usage_events(host, scope, session_started_at);
    CREATE INDEX IF NOT EXISTS idx_ue_unpriced  ON usage_events(provider, model) WHERE price_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ue_unattr    ON usage_events(source, host)    WHERE account IS NULL;

    CREATE TABLE IF NOT EXISTS spend_sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL, host TEXT NOT NULL,
      session_id  TEXT,
      scope       TEXT NOT NULL DEFAULT '',
      account     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      via         TEXT NOT NULL DEFAULT '',
      first_seen  TEXT NOT NULL, last_seen TEXT NOT NULL,
      UNIQUE(source, host, session_id, scope, account, first_seen)
    );
    CREATE INDEX IF NOT EXISTS idx_ss_session ON spend_sessions(host, session_id);
    CREATE INDEX IF NOT EXISTS idx_ss_scope   ON spend_sessions(host, scope, first_seen);

    CREATE TABLE IF NOT EXISTS spend_prices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      provider        TEXT NOT NULL, model TEXT NOT NULL,
      match           TEXT NOT NULL DEFAULT 'exact',
      effective_from  TEXT NOT NULL,
      input_micros    INTEGER NOT NULL, output_micros INTEGER NOT NULL,
      cache_read_micros INTEGER, cache_write_micros INTEGER, cache_write_1h_micros INTEGER,
      tiers_json      TEXT NOT NULL DEFAULT '[]',
      note            TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(provider, model, effective_from)
    );

    CREATE TABLE IF NOT EXISTS spend_collectors (
      host TEXT NOT NULL, source TEXT NOT NULL,
      last_post_at TEXT NOT NULL, last_event_ts TEXT,
      files INTEGER, scanned INTEGER, accepted INTEGER, duplicate INTEGER, rejected INTEGER, errors INTEGER,
      collector_version TEXT,
      PRIMARY KEY(host, source)
    );
  `);
}

const PRICE_COLS = 'provider, model, match, effective_from, input_micros, output_micros, cache_read_micros, cache_write_micros, cache_write_1h_micros, tiers_json, note';

// Once, gated on a meta sentinel: operator-added or edited rows are never overwritten on boot.
// Returns how many rows it inserted (0 when already seeded).
export function seedIfNeeded(db) {
  if (db.prepare(`SELECT 1 FROM meta WHERE k=?`).get(SEED_SENTINEL)) return 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO spend_prices(${PRICE_COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of seedPrices()) {
      n += Number(ins.run(r.provider, r.model, r.match, r.effective_from, r.input_micros, r.output_micros, r.cache_read_micros,
        r.cache_write_micros, r.cache_write_1h_micros, r.tiers_json, r.note).changes);
    }
    db.prepare(`INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)`).run(SEED_SENTINEL, new Date().toISOString());
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ } throw e; }
  priceCache.delete(db);
  return n;
}

const retentionDays = () => {
  const n = Number(process.env.AIGATE_SPEND_RETENTION_DAYS ?? 400);
  return Number.isFinite(n) && n >= 0 ? n : 400;
};

// days = 0 keeps everything. Never throws: a failed prune must not starve the daily backup.
export function pruneOld(db, days = retentionDays()) {
  if (!(days > 0)) return 0;
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
  try {
    const n = Number(db.prepare(`DELETE FROM usage_events WHERE ts < ?`).run(cutoff).changes);
    db.prepare(`DELETE FROM spend_sessions WHERE last_seen < ?`).run(cutoff);
    return n;
  } catch (e) { console.error('[spend] retention prune failed', String((e && e.message) || e)); return 0; }
}

// ---- small helpers ------------------------------------------------------

const priceCache = new WeakMap();   // db -> spend_prices rows; dropped on any price write
function priceRows(db) {
  let rows = priceCache.get(db);
  if (!rows) { rows = db.prepare(`SELECT * FROM spend_prices`).all(); priceCache.set(db, rows); }
  return rows;
}

const stmtCache = new WeakMap();
function stmts(db) {
  let s = stmtCache.get(db);
  if (s) return s;
  s = {
    insEvent: db.prepare(`INSERT INTO usage_events(source, source_event_id, ts, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, cache_tokens_in_prompt, duration_ms, status, host, project,
      session_id, session_started_at, scope, account, account_kind, attributed_by, billing, cost_micros, price_id, priced_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source, source_event_id) DO NOTHING`),
    claudeMap: db.prepare(`SELECT account, kind, first_seen FROM spend_sessions WHERE source='claude_code' AND host=? AND session_id=? ORDER BY first_seen, id`),
    codexMap: db.prepare(`SELECT account, kind, first_seen FROM spend_sessions WHERE source='codex' AND host=? AND scope=? ORDER BY first_seen, id`),
    predecessor: db.prepare(`SELECT id, account, first_seen, last_seen FROM spend_sessions WHERE source=? AND host=? AND session_id IS ? AND scope=?
      AND first_seen <= ? ORDER BY first_seen DESC, id DESC LIMIT 1`),
    earliest: db.prepare(`SELECT id, account FROM spend_sessions WHERE source=? AND host=? AND session_id IS ? AND scope=? ORDER BY first_seen, id LIMIT 1`),
    extendSession: db.prepare(`UPDATE spend_sessions SET last_seen=?, via=CASE WHEN ?<>'' THEN ? ELSE via END WHERE id=?`),
    lowerSession: db.prepare(`UPDATE spend_sessions SET first_seen=? WHERE id=?`),
    insSession: db.prepare(`INSERT INTO spend_sessions(source, host, session_id, scope, account, kind, via, first_seen, last_seen) VALUES(?,?,?,?,?,?,?,?,?)`),
    unattrClaude: db.prepare(`SELECT id, provider, ts, session_started_at FROM usage_events WHERE host=? AND session_id=? AND source='claude_code' AND account IS NULL`),
    unattrCodex: db.prepare(`SELECT id, provider, ts, session_started_at FROM usage_events WHERE host=? AND scope=? AND source='codex' AND account IS NULL`),
    setAttr: db.prepare(`UPDATE usage_events SET account=?, account_kind=?, attributed_by=?, billing=? WHERE id=?`),
    upsertCollector: db.prepare(`INSERT INTO spend_collectors(host, source, last_post_at, last_event_ts, files, scanned, accepted, duplicate, rejected, errors, collector_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(host, source) DO UPDATE SET last_post_at=excluded.last_post_at,
        last_event_ts=CASE WHEN excluded.last_event_ts IS NOT NULL AND (last_event_ts IS NULL OR excluded.last_event_ts > last_event_ts) THEN excluded.last_event_ts ELSE last_event_ts END,
        files=COALESCE(excluded.files, files), scanned=COALESCE(excluded.scanned, scanned), accepted=excluded.accepted,
        duplicate=excluded.duplicate, rejected=excluded.rejected, errors=COALESCE(excluded.errors, errors),
        collector_version=COALESCE(excluded.collector_version, collector_version)`),
  };
  stmtCache.set(db, s);
  return s;
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, max = MAX_INT) => Number.isInteger(v) && v >= 0 && v <= max;

function parseTs(v, now) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t < MIN_TS || t > now + FUTURE_SLACK_MS) return null;
  return new Date(t).toISOString();
}

const contentError = (field, key) => (FORBIDDEN.has(key)
  ? { error: 'content fields are not accepted', field }
  : { error: 'unknown field', field });

const runTx = (db, fn) => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ } throw e; }
};

// ---- attribution (DESIGN 2.2) -------------------------------------------

// rows sorted ascending by first_seen. Claude: one account -> it; several -> latest started
// at/before ts+120s, else the earliest. Codex: latest lease started at/before the session
// start (or the event) +120s, no fallback. An account '' row means "not aigate-managed".
function pickAttribution(source, rows, ts, startedAt) {
  if (!rows.length) return null;
  let row = null;
  if (source === 'claude_code') {
    if (rows.length === 1) row = rows[0];
    else {
      const limit = Date.parse(ts) + SKEW_MS;
      for (const r of rows) if (Date.parse(r.first_seen) <= limit) row = r;
      row ??= rows[0];
    }
  } else {
    const limit = Date.parse(startedAt || ts) + SKEW_MS;
    for (const r of rows) if (Date.parse(r.first_seen) <= limit) row = r;
  }
  if (!row || !row.account) return null;
  return { account: row.account, kind: row.kind, via: source === 'claude_code' ? 'hook' : 'lease' };
}

function mapRows(s, source, host, sessionId, scope) {
  if (!SOURCES.has(source)) return [];   // imported tools have no launcher map: never attributed, never borrow a codex lease
  return source === 'claude_code'
    ? (sessionId ? s.claudeMap.all(host, sessionId) : [])
    : (scope ? s.codexMap.all(host, scope) : []);
}

// ---- ingest (DESIGN 4.1) ------------------------------------------------

function validateBatch(b, now) {
  if (!isPlain(b)) return { error: 'body must be a JSON object' };
  for (const k of Object.keys(b)) if (!BATCH_KEYS.has(k)) return contentError(k, k);
  if (!Array.isArray(b.events) || b.events.length === 0) return { error: 'events must be a non-empty array' };
  if (b.events.length > MAX_EVENTS) return { error: `events exceeds ${MAX_EVENTS}` };
  if (b.summary !== undefined) {
    if (!isPlain(b.summary)) return { error: 'summary must be an object', field: 'summary' };
    for (const k of Object.keys(b.summary)) if (!SUMMARY_KEYS.has(k)) return contentError(`summary.${k}`, k);
  }
  for (let i = 0; i < b.events.length; i++) {
    const e = b.events[i];
    if (!isPlain(e)) return { error: 'event must be an object', index: i };
    for (const k of Object.keys(e)) if (!EVENT_KEYS.has(k)) return { ...contentError(`events[${i}].${k}`, k), index: i };
  }
  if (!EVENT_SOURCES.has(b.source)) return { error: 'source must be one of ' + [...EVENT_SOURCES].join(', ') };
  if (typeof b.host !== 'string' || !b.host.trim()) return { error: 'host is required' };
  if (b.collector_version !== undefined && !(typeof b.collector_version === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(b.collector_version)))
    return { error: 'bad collector_version' };
  for (const k of SUMMARY_KEYS) if (b.summary && b.summary[k] !== undefined && !isInt(b.summary[k], Number.MAX_SAFE_INTEGER))
    return { error: `summary.${k} must be a non-negative integer`, field: `summary.${k}` };

  const events = [];
  for (let i = 0; i < b.events.length; i++) {
    const e = b.events[i];
    const bad = (error) => ({ error, index: i });
    if (typeof e.source_event_id !== 'string' || e.source_event_id.length > 256 || !ID_RE.test(e.source_event_id)) return bad('bad source_event_id');
    const ts = parseTs(e.ts, now);
    if (!ts) return bad('bad ts');
    if (typeof e.provider !== 'string' || e.provider.length > 128 || !ID_RE.test(e.provider)) return bad('bad provider');
    if (typeof e.model !== 'string' || e.model.length > 256 || !ID_RE.test(e.model)) return bad('bad model');
    const tok = {};
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens']) {
      const v = e[k] ?? 0;
      if (!isInt(v)) return bad(`${k} must be an integer 0..${MAX_INT}`);
      tok[k] = v;
    }
    tok.cache_write_1h_tokens = Math.min(tok.cache_write_1h_tokens, tok.cache_write_tokens);
    const cip = e.cache_tokens_in_prompt;
    if (cip !== undefined && cip !== null && typeof cip !== 'boolean' && cip !== 0 && cip !== 1) return bad('cache_tokens_in_prompt must be boolean');
    if (e.duration_ms != null && !isInt(e.duration_ms)) return bad('bad duration_ms');
    if (e.status != null && e.status !== 'success' && e.status !== 'error') return bad('status must be success or error');
    if (e.project != null && !(typeof e.project === 'string' && e.project.length <= 200 && (e.project === '' || ID_RE.test(e.project)))) return bad('bad project');
    if (e.session_id != null && !(typeof e.session_id === 'string' && e.session_id.length <= 256 && ID_RE.test(e.session_id))) return bad('bad session_id');
    let startedAt = null;
    if (e.session_started_at != null) { startedAt = parseTs(e.session_started_at, now); if (!startedAt) return bad('bad session_started_at'); }
    if (e.scope != null && !(typeof e.scope === 'string' && e.scope.length <= 1024 && !/[\u0000-\u001f]/.test(e.scope))) return bad('bad scope');
    events.push({
      source_event_id: e.source_event_id, ts, provider: e.provider, model: e.model, ...tok,
      cache_tokens_in_prompt: cip === true || cip === 1 ? 1 : 0,
      duration_ms: e.duration_ms ?? null, status: e.status ?? null, project: e.project || '',
      session_id: e.session_id ?? null, session_started_at: startedAt, scope: e.scope || '',
    });
  }
  return { ok: true, source: b.source, host: b.host, version: b.collector_version ?? null, summary: b.summary || {}, events };
}

function ingestBatch(db, v) {
  const s = stmts(db);
  const rows = priceRows(db);
  const nowIso = new Date().toISOString();
  const host = v.host;
  const mapCache = new Map();
  const unpricedModels = new Map();
  let accepted = 0, duplicate = 0, unpriced = 0, unattributed = 0, maxTs = null;
  runTx(db, () => {
    for (const e of v.events) {
      const key = v.source === 'claude_code' ? `c|${e.session_id}` : `x|${e.scope}`;
      let mrows = mapCache.get(key);
      if (!mrows) { mrows = mapRows(s, v.source, host, e.session_id, e.scope); mapCache.set(key, mrows); }
      const attr = pickAttribution(v.source, mrows, e.ts, e.session_started_at);
      const account = attr ? attr.account : null;
      const rate = pickRate(rows, e.provider, e.model, e.ts);
      const cost = rate ? priceEvent(e, rate).cost_micros : null;
      const r = s.insEvent.run(v.source, e.source_event_id, e.ts, e.provider, e.model, e.input_tokens, e.output_tokens,
        e.cache_read_tokens, e.cache_write_tokens, e.cache_write_1h_tokens, e.cache_tokens_in_prompt, e.duration_ms, e.status,
        host, e.project, e.session_id, e.session_started_at, e.scope, account, attr ? attr.kind : null, attr ? attr.via : null,
        billingClass(e.provider, account), cost, rate ? rate.id : null, rate ? nowIso : null);
      if (Number(r.changes) === 0) { duplicate++; continue; }
      accepted++;
      if (!maxTs || e.ts > maxTs) maxTs = e.ts;
      if (!account) unattributed++;
      if (!rate) {
        unpriced++;
        const mk = `${e.provider}\u0000${e.model}`;
        const cur = unpricedModels.get(mk);
        if (cur) cur.events++; else unpricedModels.set(mk, { provider: e.provider, model: e.model, events: 1 });
      }
    }
    const sm = v.summary;
    s.upsertCollector.run(host, v.source, nowIso, maxTs, sm.files ?? null, sm.scanned ?? null, accepted, duplicate, 0, sm.errors ?? null, v.version);
  });
  return { accepted, duplicate, rejected: 0, unpriced, unattributed,
    unpriced_models: [...unpricedModels.values()].sort((a, b) => b.events - a.events), errors: [] };
}

// ---- sessions (DESIGN 4.2) ----------------------------------------------

function validateSessions(b, now) {
  const list = Array.isArray(b) ? b : (isPlain(b) && Array.isArray(b.sessions) ? b.sessions : (isPlain(b) ? [b] : null));
  if (!list || list.length === 0) return { error: 'expected a session object or {sessions:[...]}' };
  if (list.length > MAX_EVENTS) return { error: `sessions exceeds ${MAX_EVENTS}` };
  if (isPlain(b) && Array.isArray(b.sessions)) for (const k of Object.keys(b)) if (k !== 'sessions') return contentError(k, k);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    const bad = (error) => ({ error, index: i });
    if (!isPlain(x)) return bad('session must be an object');
    for (const k of Object.keys(x)) if (!SESSION_KEYS.has(k)) return { ...contentError(`sessions[${i}].${k}`, k), index: i };
    if (!SOURCES.has(x.source)) return bad('source must be claude_code or codex');
    if (typeof x.host !== 'string' || !x.host.trim()) return bad('host is required');
    if (!KINDS.has(x.kind)) return bad('kind must be claude or codex');
    if (typeof x.account !== 'string' || (x.account !== '' && !ACCT_RE.test(x.account))) return bad('bad account');
    const via = x.via ?? '';
    if (typeof via !== 'string' || (via !== '' && !/^[A-Za-z0-9._:-]{1,64}$/.test(via))) return bad('bad via');
    let ts = new Date(now).toISOString();
    if (x.ts != null) { ts = parseTs(x.ts, now); if (!ts) return bad('bad ts'); }
    let sessionId = null, scope = '';
    if (x.source === 'claude_code') {
      if (typeof x.session_id !== 'string' || x.session_id.length > 256 || !ID_RE.test(x.session_id)) return bad('session_id is required for claude_code');
      if (x.scope != null && x.scope !== '') return bad('scope must be empty for claude_code');
      sessionId = x.session_id;
    } else {
      if (x.session_id != null) return bad('session_id must be null for codex');
      if (typeof x.scope !== 'string' || x.scope.length > 1024 || /[\u0000-\u001f]/.test(x.scope) || !/^(\/|[A-Za-z]:[\\/])/.test(x.scope))
        return bad('scope must be an absolute path for codex');
      scope = x.scope;
    }
    out.push({ source: x.source, host: x.host, session_id: sessionId, scope, account: x.account, kind: x.kind, via, ts });
  }
  return { ok: true, sessions: out };
}

function upsertSessions(db, list) {
  const s = stmts(db);
  const touched = new Map();
  let resolved = 0;
  runTx(db, () => {
    for (const x of list) {
      const host = x.host;
      const pre = s.predecessor.get(x.source, host, x.session_id, x.scope, x.ts);
      if (pre) {
        if (pre.account === x.account) { if (x.ts > pre.last_seen) s.extendSession.run(x.ts, x.via, x.via, pre.id); }
        else s.insSession.run(x.source, host, x.session_id, x.scope, x.account, x.kind, x.via, x.ts, x.ts);
      } else {
        const first = s.earliest.get(x.source, host, x.session_id, x.scope);
        if (first && first.account === x.account) s.lowerSession.run(x.ts, first.id);
        else s.insSession.run(x.source, host, x.session_id, x.scope, x.account, x.kind, x.via, x.ts, x.ts);
      }
      touched.set(`${x.source}|${host}|${x.session_id}|${x.scope}`, x);
    }
    for (const x of touched.values()) {
      const mrows = mapRows(s, x.source, x.host, x.session_id, x.scope);
      const events = x.source === 'claude_code' ? s.unattrClaude.all(x.host, x.session_id) : s.unattrCodex.all(x.host, x.scope);
      for (const ev of events) {
        const attr = pickAttribution(x.source, mrows, ev.ts, ev.session_started_at);
        if (!attr) continue;
        s.setAttr.run(attr.account, attr.kind, attr.via, billingClass(ev.provider, attr.account), ev.id);
        resolved++;
      }
    }
  });
  return { upserted: list.length, resolved };
}

// ---- read model (DESIGN 4.3) --------------------------------------------

const GROUP_EXPR = {
  account: 'account', model: 'model', project: `NULLIF(project,'')`, host: 'host', source: 'source', billing: 'billing',
};

const AGG = `COUNT(*) AS events, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens,
  COALESCE(SUM(cache_write_1h_tokens),0) AS cache_write_1h_tokens,
  COALESCE(SUM(CASE WHEN billing='subscription' THEN cost_micros END),0) AS value_m,
  COALESCE(SUM(CASE WHEN billing='api' THEN cost_micros END),0) AS spend_m,
  COALESCE(SUM(CASE WHEN billing='unknown' THEN cost_micros END),0) AS unknown_m,
  COALESCE(SUM(price_id IS NULL),0) AS unpriced_events`;

const usd = (m) => Number(m) / 1e6;
const money = (r) => ({ value_usd: usd(r.value_m), spend_usd: usd(r.spend_m), unknown_usd: usd(r.unknown_m) });
const tokenCols = (r) => ({ input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens,
  cache_write_tokens: r.cache_write_tokens, cache_write_1h_tokens: r.cache_write_1h_tokens });

function parseRange(v, endOfDay) {
  if (DATE_ONLY_RE.test(v)) {
    const t = Date.parse(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    return Number.isFinite(t) ? t : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function readSpend(db, url) {
  const qs = url.searchParams;
  const nowMs = Date.now();
  const toMs = qs.has('to') ? parseRange(qs.get('to'), true) : nowMs;
  const fromMs = qs.has('from') ? parseRange(qs.get('from'), false) : (toMs ?? nowMs) - 7 * DAY_MS;
  if (toMs == null || fromMs == null) return { code: 400, body: { error: 'from/to must be an ISO date or datetime' } };
  if (fromMs > toMs) return { code: 400, body: { error: 'from is after to' } };
  if (toMs - fromMs > 400 * DAY_MS) return { code: 400, body: { error: 'range exceeds 400 days' } };
  const bucket = qs.get('bucket') || 'day';
  if (bucket !== 'day' && bucket !== 'hour') return { code: 400, body: { error: 'bucket must be day or hour' } };
  if (bucket === 'hour' && toMs - fromMs > 14 * DAY_MS) return { code: 400, body: { error: 'hour buckets need a range of 14 days or less' } };
  const group = qs.get('group') || 'account';
  if (!GROUP_EXPR[group]) return { code: 400, body: { error: `group must be one of ${Object.keys(GROUP_EXPR).join(', ')}` } };
  const topRaw = qs.get('top');
  const top = topRaw == null ? 8 : Number(topRaw);
  if (!Number.isInteger(top) || top < 1 || top > 20) return { code: 400, body: { error: 'top must be an integer 1..20' } };

  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const where = ['ts >= ?', 'ts <= ?'];
  const args = [from, to];
  for (const f of ['account', 'source', 'host']) {
    const val = qs.get(f);
    if (val) { where.push(`${f} = ?`); args.push(val); }
  }
  const W = where.join(' AND ');
  const expr = GROUP_EXPR[group];

  const totalsRow = db.prepare(`SELECT ${AGG}, COALESCE(SUM(price_id IS NOT NULL),0) AS priced_events,
    COALESCE(SUM(account IS NULL),0) AS unattributed_events FROM usage_events WHERE ${W}`).get(...args);
  const unpricedModels = db.prepare(`SELECT provider, model, COUNT(*) AS events FROM usage_events WHERE ${W} AND price_id IS NULL
    GROUP BY provider, model ORDER BY events DESC, provider, model LIMIT 50`).all(...args).map((r) => ({ provider: r.provider, model: r.model, events: r.events }));

  let kinds = new Map();
  if (group === 'account') {
    try { kinds = new Map(db.prepare(`SELECT account, kind FROM accounts`).all().map((a) => [a.account, a.kind])); } catch { /* accounts table absent */ }
  }
  const label = (k) => {
    if (k == null) return 'unknown';
    if (group === 'account' && kinds.get(k)) return `${k} · ${kinds.get(k)}`;
    return String(k);
  };

  const raw = db.prepare(`SELECT ${expr} AS k, ${AGG} FROM usage_events WHERE ${W} GROUP BY k`).all(...args);
  const rank = (r) => r.value_m + r.spend_m + r.unknown_m;
  raw.sort((a, b) => (rank(b) - rank(a)) || (b.events - a.events) || String(a.k).localeCompare(String(b.k)));
  const head = raw.slice(0, top);
  const tail = raw.slice(top);
  const shape = (r, extra) => ({ events: r.events, ...tokenCols(r), ...money(r), unpriced_events: r.unpriced_events, ...extra });
  const groups = head.map((r) => ({ key: r.k, label: label(r.k), ...shape(r, { is_other: false }) }));
  if (tail.length) {
    const sum = (f) => tail.reduce((n, r) => n + r[f], 0);
    const o = { events: sum('events'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_tokens: sum('cache_read_tokens'),
      cache_write_tokens: sum('cache_write_tokens'), cache_write_1h_tokens: sum('cache_write_1h_tokens'),
      value_m: sum('value_m'), spend_m: sum('spend_m'), unknown_m: sum('unknown_m'), unpriced_events: sum('unpriced_events') };
    groups.push({ key: null, label: `other (${tail.length})`, ...shape(o, { is_other: true }) });
  }

  const bucketExpr = bucket === 'day' ? `substr(ts,1,10)` : `substr(ts,1,13) || ':00:00.000Z'`;
  const topKeys = new Set(head.map((r) => r.k));
  const sraw = db.prepare(`SELECT ${bucketExpr} AS b, ${expr} AS k, ${AGG} FROM usage_events WHERE ${W} GROUP BY b, k ORDER BY b`).all(...args);
  const folded = new Map();
  const series = [];
  const add = (acc, r) => { for (const f of ['events', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens',
    'value_m', 'spend_m', 'unknown_m', 'unpriced_events']) acc[f] = (acc[f] || 0) + r[f]; };
  for (const r of sraw) {
    if (topKeys.has(r.k)) series.push({ bucket: r.b, key: r.k, ...shape(r, { is_other: false }) });
    else { let o = folded.get(r.b); if (!o) { o = {}; folded.set(r.b, o); } add(o, r); }
  }
  for (const [b, o] of folded) series.push({ bucket: b, key: null, ...shape(o, { is_other: true }) });
  series.sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));

  const collectors = collectorRows(db, nowMs);
  return { code: 200, body: {
    range: { from, to, bucket, group },
    totals: { events: totalsRow.events, ...tokenCols(totalsRow), ...money(totalsRow), priced_events: totalsRow.priced_events,
      unpriced_events: totalsRow.unpriced_events, unattributed_events: totalsRow.unattributed_events, unpriced_models: unpricedModels },
    groups, series, collectors,
    prices_count: db.prepare(`SELECT COUNT(*) AS n FROM spend_prices`).get().n,
  } };
}

function collectorRows(db, nowMs = Date.now()) {
  return db.prepare(`SELECT host, source, last_post_at, last_event_ts, files, scanned, accepted, duplicate, rejected, errors, collector_version
    FROM spend_collectors ORDER BY host, source`).all().map((r) => ({
    ...r, age_s: Math.max(0, Math.round((nowMs - Date.parse(r.last_post_at)) / 1000)),
  }));
}

// ---- prices (DESIGN 4.5) ------------------------------------------------

const usdOrNull = (m) => (m == null ? null : fromMicros(m));
const microsOrNull = (v) => (v == null ? null : toMicros(v));
const MAX_MICROS = 100_000 * 1_000_000;   // $100k/MTok: anything above is a typo

function tiersOut(json) {
  let t = [];
  try { t = JSON.parse(json || '[]'); } catch { /* corrupt tiers render empty */ }
  return t.map((x) => ({ min_input_tokens: x.min_input_tokens, input_usd: usdOrNull(x.input_micros), output_usd: usdOrNull(x.output_micros),
    cache_read_usd: usdOrNull(x.cache_read_micros), cache_write_usd: usdOrNull(x.cache_write_micros), cache_write_1h_usd: usdOrNull(x.cache_write_1h_micros) }));
}

function priceOut(r) {
  return { id: r.id, provider: r.provider, model: r.model, match: r.match, effective_from: r.effective_from,
    input_usd: usdOrNull(r.input_micros), output_usd: usdOrNull(r.output_micros), cache_read_usd: usdOrNull(r.cache_read_micros),
    cache_write_usd: usdOrNull(r.cache_write_micros), cache_write_1h_usd: usdOrNull(r.cache_write_1h_micros),
    tiers: tiersOut(r.tiers_json), note: r.note };
}

function parsePriceBody(b) {
  if (!isPlain(b)) return { error: 'body must be a JSON object' };
  const allowed = new Set(['provider', 'model', 'match', 'effective_from', 'input_usd', 'output_usd', 'cache_read_usd', 'cache_write_usd',
    'cache_write_1h_usd', 'tiers', 'note']);
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { error: 'unknown field', field: k };
  if (typeof b.provider !== 'string' || !PRICE_PROVIDER_RE.test(b.provider)) return { error: 'bad provider' };
  if (typeof b.model !== 'string' || b.model.length > 256 || !ID_RE.test(b.model)) return { error: 'bad model' };
  const match = b.match ?? 'exact';
  if (match !== 'exact' && match !== 'prefix') return { error: "match must be 'exact' or 'prefix'" };
  if (typeof b.effective_from !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(b.effective_from) || !Number.isFinite(Date.parse(b.effective_from)))
    return { error: 'effective_from must be an ISO date or datetime' };
  const effective = DATE_ONLY_RE.test(b.effective_from) ? b.effective_from : new Date(Date.parse(b.effective_from)).toISOString();
  if (b.input_usd == null || b.output_usd == null) return { error: 'input_usd and output_usd are required' };
  const note = b.note == null ? 'operator' : b.note;
  if (typeof note !== 'string' || note.length > 500) return { error: 'bad note' };
  let m;
  try {
    m = { input: toMicros(b.input_usd), output: toMicros(b.output_usd), cr: microsOrNull(b.cache_read_usd), cw: microsOrNull(b.cache_write_usd),
      cw1: microsOrNull(b.cache_write_1h_usd) };
  } catch (e) { return { error: String(e.message) }; }
  for (const v of Object.values(m)) if (v != null && v > MAX_MICROS) return { error: 'rate out of range' };
  let tiers = [];
  if (b.tiers != null) {
    if (!Array.isArray(b.tiers) || b.tiers.length > 8) return { error: 'tiers must be an array of at most 8' };
    try {
      tiers = b.tiers.map((t) => {
        if (!isPlain(t) || !Number.isInteger(t.min_input_tokens) || t.min_input_tokens < 1) throw new TypeError('tier needs an integer min_input_tokens >= 1');
        return { min_input_tokens: t.min_input_tokens, input_micros: microsOrNull(t.input_usd), output_micros: microsOrNull(t.output_usd),
          cache_read_micros: microsOrNull(t.cache_read_usd), cache_write_micros: microsOrNull(t.cache_write_usd), cache_write_1h_micros: microsOrNull(t.cache_write_1h_usd) };
      });
    } catch (e) { return { error: String(e.message) }; }
  }
  return { ok: true, provider: b.provider, model: b.model, match, effective, m, tiers_json: JSON.stringify(tiers), note };
}

function addPrice(db, p) {
  const sameTime = Date.parse(p.effective);
  const dupe = db.prepare(`SELECT effective_from FROM spend_prices WHERE provider=? AND model=?`).all(p.provider, p.model)
    .some((r) => Date.parse(r.effective_from) === sameTime);
  if (dupe) return null;
  const r = db.prepare(`INSERT INTO spend_prices(${PRICE_COLS}) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(p.provider, p.model, p.match, p.effective,
    p.m.input, p.m.output, p.m.cr, p.m.cw, p.m.cw1, p.tiers_json, p.note);
  priceCache.delete(db);
  return db.prepare(`SELECT * FROM spend_prices WHERE id=?`).get(r.lastInsertRowid);
}

// ---- reprice (DESIGN 4.5) -----------------------------------------------

async function reprice(db, b) {
  const allowed = new Set(['only_unpriced', 'from', 'to', 'provider', 'model']);
  if (!isPlain(b)) return { code: 400, body: { error: 'body must be a JSON object' } };
  for (const k of Object.keys(b)) if (!allowed.has(k)) return { code: 400, body: { error: 'unknown field', field: k } };
  const onlyUnpriced = b.only_unpriced === undefined ? true : b.only_unpriced === true;
  const where = ['id > ?'];
  const extra = [];
  if (onlyUnpriced) where.push('price_id IS NULL');
  for (const [k, op] of [['from', '>='], ['to', '<=']]) {
    if (b[k] == null) continue;
    const t = typeof b[k] === 'string' ? parseRange(b[k], k === 'to') : null;
    if (t == null) return { code: 400, body: { error: `${k} must be an ISO date or datetime` } };
    where.push(`ts ${op} ?`); extra.push(new Date(t).toISOString());
  }
  for (const k of ['provider', 'model']) {
    if (b[k] == null) continue;
    if (typeof b[k] !== 'string' || !ID_RE.test(b[k])) return { code: 400, body: { error: `bad ${k}` } };
    where.push(`${k} = ?`); extra.push(b[k]);
  }
  const sel = db.prepare(`SELECT id, ts, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    cache_write_1h_tokens, cache_tokens_in_prompt, account, cost_micros, price_id, billing FROM usage_events
    WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${REPRICE_CHUNK}`);
  const upd = db.prepare(`UPDATE usage_events SET cost_micros=?, price_id=?, priced_at=?, billing=? WHERE id=?`);
  const rows = priceRows(db);
  let cursor = 0, scanned = 0, repriced = 0, stillUnpriced = 0;
  for (;;) {
    const chunk = sel.all(cursor, ...extra);
    if (!chunk.length) break;
    const nowIso = new Date().toISOString();
    runTx(db, () => {
      for (const r of chunk) {
        const rate = pickRate(rows, r.provider, r.model, r.ts);
        const cost = rate ? priceEvent(r, rate).cost_micros : null;
        const priceId = rate ? rate.id : null;
        const billing = billingClass(r.provider, r.account);
        if (cost !== r.cost_micros || priceId !== r.price_id) repriced++;
        if (cost !== r.cost_micros || priceId !== r.price_id || billing !== r.billing) upd.run(cost, priceId, rate ? nowIso : null, billing, r.id);
        if (!rate) stillUnpriced++;
      }
    });
    scanned += chunk.length;
    cursor = chunk[chunk.length - 1].id;
    if (chunk.length < REPRICE_CHUNK) break;
    await new Promise((resolve) => setImmediate(resolve));   // let the single-threaded daemon serve /health between chunks
  }
  return { code: 200, body: { scanned, repriced, still_unpriced: stillUnpriced } };
}

// ---- router -------------------------------------------------------------

const tooBig = (res) => {
  res.writeHead(413, { 'content-type': 'application/json', 'Cache-Control': 'no-store', connection: 'close' });
  return res.end(JSON.stringify({ error: 'body too large' }));
};

// Called by server.js for every /api/spend* request AFTER the auth gate.
// ctx: { db, reqIp, json, body, shortHost, logAccess }
export async function handleSpend(req, res, url, ctx) {
  const { db, json } = ctx;
  const p = url.pathname.replace(/\/+$/, '');
  const m = req.method;
  const wrong = () => json(res, 405, { error: 'method not allowed' });
  try {
    if (p === '/api/spend') return m === 'GET' ? sendRead(res, json, readSpend(db, url)) : wrong();

    if (p === '/api/spend/events') {
      if (m !== 'POST') return wrong();
      const b = await ctx.body(req);
      if (b && b.__oversized) return tooBig(res);
      const v = validateBatch(b, Date.now());
      if (!v.ok) return json(res, 400, v);
      v.host = ctx.shortHost(v.host);
      if (!v.host) return json(res, 400, { error: 'host is required' });
      const out = ingestBatch(db, v);
      ctx.logAccess('spend', v.host, ctx.reqIp(req), 'spend-ingest', `accepted ${out.accepted} · dup ${out.duplicate} · unpriced ${out.unpriced}`);
      return json(res, 200, out);
    }

    if (p === '/api/spend/sessions') {
      if (m === 'GET') {
        const lim = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        return json(res, 200, db.prepare(`SELECT source, host, session_id, scope, account, kind, via, first_seen, last_seen FROM spend_sessions
          ORDER BY last_seen DESC, id DESC LIMIT ?`).all(lim));
      }
      if (m !== 'POST') return wrong();
      const b = await ctx.body(req);
      if (b && b.__oversized) return tooBig(res);
      const v = validateSessions(b, Date.now());
      if (!v.ok) return json(res, 400, v);
      for (const x of v.sessions) x.host = ctx.shortHost(x.host);
      if (v.sessions.some((x) => !x.host)) return json(res, 400, { error: 'host is required' });
      const out = upsertSessions(db, v.sessions);
      ctx.logAccess('spend', v.sessions[0].host, ctx.reqIp(req), 'spend-session', `upserted ${out.upserted} · resolved ${out.resolved}`);
      return json(res, 200, out);
    }

    if (p === '/api/spend/collectors') return m === 'GET' ? json(res, 200, collectorRows(db)) : wrong();

    if (p === '/api/spend/prices') {
      if (m === 'GET') return json(res, 200, db.prepare(`SELECT * FROM spend_prices ORDER BY provider, model, effective_from`).all().map(priceOut));
      if (m !== 'PUT') return wrong();
      const b = await ctx.body(req);
      if (b && b.__oversized) return tooBig(res);
      const v = parsePriceBody(b);
      if (!v.ok) return json(res, 400, v);
      const row = addPrice(db, v);
      if (!row) return json(res, 409, { error: 'a price for that provider/model/effective_from already exists — add a newer effective_from instead' });
      ctx.logAccess('spend', '', ctx.reqIp(req), 'price-add', `${v.provider}/${v.model} from ${v.effective}`);
      return json(res, 201, priceOut(row));
    }

    if (p === '/api/spend/reprice') {
      if (m !== 'POST') return wrong();
      const b = await ctx.body(req);
      if (b && b.__oversized) return tooBig(res);
      const out = await reprice(db, b);
      if (out.code === 200) ctx.logAccess('spend', '', ctx.reqIp(req), 'spend-reprice', `scanned ${out.body.scanned} · repriced ${out.body.repriced} · unpriced ${out.body.still_unpriced}`);
      return json(res, out.code, out.body);
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[spend] handler failed', String((e && e.stack) || e));
    if (!res.headersSent) return json(res, 500, { error: 'spend internal error' });
  }
}

const sendRead = (res, json, r) => json(res, r.code, r.body);
