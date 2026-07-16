#!/usr/bin/env node
/**
 * aigate — safe multi-account Claude Code manager.
 *
 * A daemon that: stores account OAuth/setup-tokens encrypted at rest, hands the
 * best account (most rate-limit headroom) to whoever asks (audited by IP),
 * ingests prompt + usage events from the fleet's Claude Code hooks, and streams
 * everything live over WebSocket to a dashboard.
 *
 * It is NOT a proxy — it never sits in Anthropic's request path. Clients run the
 * official `claude` binary against a per-account CLAUDE_CONFIG_DIR profile; this
 * daemon only picks which profile and records what happened (via local hooks).
 */
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { makeVault, tokenMatches, ipAllowed, clientIp, safeStaticPath, tokenIsAlive } from './lib.js';
import { PROVIDERS, isKnownProvider, PROVIDER_BY_ID } from './providers.js';

// ---- config -------------------------------------------------------------
try { process.loadEnvFile(); } catch { /* no .env, use real env */ }
const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');
// AIGATE_VERSION (set by the fleet tar-path deploy) wins so a box stamps its real
// sha; fall back to package.json semver. Served by /health + /api/capabilities.
const VERSION = (process.env.AIGATE_VERSION || '').trim() || JSON.parse(readFileSync(join(__dir, '..', 'package.json'), 'utf8')).version;
const PORT = Number(process.env.PORT || 20200);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.AIGATE_TOKEN || '';
const DB_PATH = process.env.AIGATE_DB || join(__dir, '..', 'data', 'aigate.db');
const CUTOFF = Number(process.env.AIGATE_HEADROOM_CUTOFF || 95);
// Optional network gate (defense-in-depth under the bearer token). Comma-sep
// IPv4 CIDRs, e.g. "192.168.1.0/24". Empty = allow all. Loopback always allowed.
const ALLOW_CIDR = (process.env.AIGATE_ALLOW_CIDR || '').split(',').map(s => s.trim()).filter(Boolean);
const ENC_KEY = (process.env.AIGATE_ENCRYPTION_KEY || '').trim();
// Only trust X-Forwarded-For when aigate sits behind a reverse proxy we control
// (e.g. NPM). Off by default so a direct client can't spoof its source IP past
// the CIDR gate. Set AIGATE_TRUST_PROXY=1 when deployed behind a trusted proxy.
const TRUST_PROXY = process.env.AIGATE_TRUST_PROXY === '1';
// Optional: the IP(s) of the proxy peers we trust to set X-Forwarded-For. When
// set, XFF is only honored if the socket peer is one of these — defense-in-depth
// so a direct LAN client can't present a forged XFF even under TRUST_PROXY.
const TRUSTED_PROXIES = (process.env.AIGATE_TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
// Optional outbound alert webhook (Slack/Discord/generic {text} JSON). Fires on the
// events an operator wants to hear about at 2am: selection outage, a provider key
// going dead, a failed backup. Empty = disabled. Fire-and-forget, never blocks a request.
const ALERT_WEBHOOK = (process.env.AIGATE_ALERT_WEBHOOK || '').trim();

// weak = empty / the .env.example placeholder / under 16 chars — any of these boots the
// vault behind a GUESSABLE shared bearer that gates every OAuth token + provider key.
const isWeakToken = (t) => !t || t === 'change-me-to-a-long-random-string' || t.length < 16;
if (isWeakToken(TOKEN)) {
  console.error('FATAL: set AIGATE_TOKEN to a strong random value — clients send it as Authorization: Bearer; generate: openssl rand -hex 24');
  process.exit(1);
}
if (!/^[0-9a-fA-F]{64}$/.test(ENC_KEY)) {
  console.error('FATAL: set AIGATE_ENCRYPTION_KEY to 32-byte hex (openssl rand -hex 32)');
  process.exit(1);
}
// CUTOFF gates every selection (pickRanked: max(usage) < CUTOFF). A non-numeric
// value → NaN → every `< NaN` is false → ZERO selectable accounts forever, an
// outage indistinguishable from "everyone's over quota". Validate like its
// load-bearing siblings above instead of trusting the env blindly.
if (!Number.isFinite(CUTOFF) || CUTOFF <= 0 || CUTOFF > 100) {
  console.error('FATAL: AIGATE_HEADROOM_CUTOFF must be a number in (0,100] — got', JSON.stringify(process.env.AIGATE_HEADROOM_CUTOFF));
  process.exit(1);
}
const { encrypt, decrypt } = makeVault(Buffer.from(ENC_KEY, 'hex'));

// ---- db -----------------------------------------------------------------
mkdirSync(dirname(DB_PATH), { recursive: true });
const BACKUP_DIR = join(dirname(DB_PATH), 'backups');

// Boot preflight: a malformed DB (hard power-off mid-write) would throw here
// uncaught → docker restart → same throw → a crash-loop self-heal can't fix,
// while a good snapshot sits in data/backups/. Quarantine the corrupt file(s),
// restore the newest backup, retry ONCE; anything else exits with the manual
// restore command instead of looping in the dark.
function openDb(path = DB_PATH) {
  const tryOpen = () => {
    const d = new DatabaseSync(path);
    try {
      if (d.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
        throw new Error('quick_check failed: database corrupt');
      d.exec(`
        PRAGMA busy_timeout = 5000; -- 5s = Dockerfile HEALTHCHECK timeout: a lock outlasting it still fails /health honestly
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS accounts (
          account        TEXT PRIMARY KEY,
          token_enc      TEXT,
          label          TEXT DEFAULT '',
          five_hour_pct  REAL DEFAULT 0,
          seven_day_pct  REAL DEFAULT 0,
          usage_updated  TEXT,
          disabled       INTEGER NOT NULL DEFAULT 0,
          reauth_needed  INTEGER NOT NULL DEFAULT 0,
          parked_until   TEXT,
          created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS request_log (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          ts       TEXT NOT NULL DEFAULT (datetime('now')),
          account  TEXT, host TEXT, ip TEXT, cwd TEXT, model TEXT,
          prompt   TEXT, tokens INTEGER
        );
        CREATE TABLE IF NOT EXISTS access_log (
          id       INTEGER PRIMARY KEY AUTOINCREMENT,
          ts       TEXT NOT NULL DEFAULT (datetime('now')),
          account  TEXT, host TEXT, ip TEXT, action TEXT, result TEXT
        );
        CREATE TABLE IF NOT EXISTS provider_keys (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          provider     TEXT NOT NULL,
          label        TEXT DEFAULT '',
          key_enc      TEXT NOT NULL,
          key_hint     TEXT,
          status       TEXT DEFAULT 'working',
          last_checked TEXT,
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(provider, key_hint)
        );
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        CREATE INDEX IF NOT EXISTS idx_req_host ON request_log(host);
        DROP INDEX IF EXISTS idx_req_acct;
      `);
      return d;
    } catch (e) { try { d.close(); } catch { /* never opened */ } throw e; }
  };
  try { return tryOpen(); } catch (e) {
    if (!/malformed|not a database|corrupt/i.test(String(e && e.message))) throw e;
    const stamp = Date.now();
    for (const suf of ['', '-wal', '-shm'])
      if (existsSync(path + suf)) renameSync(path + suf, `${path}.corrupt-${stamp}${suf}`);
    const bak = existsSync(BACKUP_DIR)
      ? readdirSync(BACKUP_DIR).filter((f) => /^aigate-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().at(-1)
      : undefined;
    if (bak) {
      console.error(`[db] CORRUPT vault (${e.message}) — quarantined to ${path}.corrupt-${stamp}, restoring backup ${bak}`);
      copyFileSync(join(BACKUP_DIR, bak), path);
      try { return tryOpen(); } catch (e2) { console.error('[db] restored backup failed to open too', e2); }
    } else console.error(`[db] CORRUPT vault (${e.message}) — quarantined to ${path}.corrupt-${stamp}, NO backup in ${BACKUP_DIR}`);
    console.error(`[db] manual restore: cp ${BACKUP_DIR}/aigate-<date>.db ${path}  then restart aigate`);
    process.exit(1);
  }
}
const db = openDb();

// key canary: fail LOUD at boot if ENC_KEY can't decrypt this vault, instead of
// decrypt() exploding deep inside /api/select later. First boot writes it.
const canary = db.prepare(`SELECT v FROM meta WHERE k='canary'`).get();
if (!canary) db.prepare(`INSERT INTO meta(k,v) VALUES('canary',?)`).run(encrypt('aigate-canary'));
else try { decrypt(canary.v); } catch {
  console.error('FATAL: AIGATE_ENCRYPTION_KEY does not match this vault — restore the original key/.env; a regenerated key CANNOT recover it');
  process.exit(1);
}

// ponytail: the presence-check below is idempotent + crash-safe for ADD COLUMN ONLY.
// A future migration that also BACKFILLS data must gate the backfill on its OWN sentinel
// (e.g. a meta row): a crash between ADD COLUMN and the UPDATE leaves the column present,
// so the next boot's presence-check reads it as 'done' and the backfill never re-runs.
// migration: older DBs predate reauth_needed — add it if missing
if (!db.prepare(`PRAGMA table_info(accounts)`).all().some((c) => c.name === 'reauth_needed'))
  db.exec(`ALTER TABLE accounts ADD COLUMN reauth_needed INTEGER NOT NULL DEFAULT 0`);
// migration: park an over-limit account by TTL instead of clobbering its usage
if (!db.prepare(`PRAGMA table_info(accounts)`).all().some((c) => c.name === 'parked_until'))
  db.exec(`ALTER TABLE accounts ADD COLUMN parked_until TEXT`);

// prepared once
const q = {
  // reauth_needed=0 on re-add: the recovery flow (setup-token → re-POST the fresh token) must
  // clear the poller's 401-flag NOW, else the account stays unselectable up to a full poll cycle.
  // parked_until/disabled are deliberately untouched — parking is usage-driven, disabling is manual.
  upsertAccount: db.prepare(`INSERT INTO accounts(account,token_enc,label) VALUES(?,?,?)
    ON CONFLICT(account) DO UPDATE SET token_enc=excluded.token_enc, label=excluded.label, reauth_needed=0`),
  // parked computed in the SAME clock domain as pickRanked — clients get a plain 0/1
  // instead of parsing a bare sqlite UTC string (no Z) in the right timezone.
  listAccounts: db.prepare(`SELECT account,label,five_hour_pct,seven_day_pct,usage_updated,disabled,reauth_needed,parked_until,
    (parked_until IS NOT NULL AND parked_until > datetime('now')) AS parked,
    CAST(strftime('%s','now') - strftime('%s', usage_updated) AS INTEGER) AS usage_age_s,
    (token_enc IS NOT NULL) AS has_token FROM accounts ORDER BY account`),
  getToken: db.prepare(`SELECT token_enc FROM accounts WHERE account=?`),
  delAccount: db.prepare(`DELETE FROM accounts WHERE account=? RETURNING label`),
  setDisabled: db.prepare(`UPDATE accounts SET disabled=? WHERE account=?`),
  setReauth: db.prepare(`UPDATE accounts SET reauth_needed=? WHERE account=?`),
  updUsage: db.prepare(`UPDATE accounts SET five_hour_pct=?, seven_day_pct=?, usage_updated=datetime('now') WHERE account=?`),
  // park an over-limit account for a TTL WITHOUT clobbering its real usage — pickRanked
  // skips it until parked_until passes (auto-recover); the poller keeps its % honest.
  parkAccount: db.prepare(`UPDATE accounts SET parked_until=datetime('now', ?) WHERE account=?`),
  getParked: db.prepare(`SELECT parked_until FROM accounts WHERE account=?`),
  // most headroom = lowest worst-window usage; skip disabled / over cutoff / tokenless /
  // needs-reauth / currently-parked. Unpolled (usage_updated IS NULL) sorts LAST so a
  // freshly-added account isn't handed out as a phantom "0%" before its first real poll.
  // Ranked (no LIMIT) so /api/select can skip client-excluded accounts on retry.
  pickRanked: db.prepare(`SELECT account FROM accounts
    WHERE disabled=0 AND reauth_needed=0 AND token_enc IS NOT NULL AND max(five_hour_pct,seven_day_pct) < ?
      AND (parked_until IS NULL OR parked_until < datetime('now'))
    ORDER BY (usage_updated IS NULL) ASC, max(five_hour_pct,seven_day_pct) ASC, usage_updated ASC`),
  insReq: db.prepare(`INSERT INTO request_log(account,host,ip,cwd,model,prompt,tokens) VALUES(?,?,?,?,?,?,?)`),
  insAccess: db.prepare(`INSERT INTO access_log(account,host,ip,action,result) VALUES(?,?,?,?,?)`),
  recentReq: db.prepare(`SELECT id,ts,account,host,ip,cwd,model,substr(prompt,1,400) AS prompt,tokens
    FROM request_log ORDER BY id DESC LIMIT ?`),
  recentAccess: db.prepare(`SELECT id,ts,account,host,ip,action,result FROM access_log ORDER BY id DESC LIMIT ?`),
  // julianday (not strftime string-parse) to dodge the sqlite-UTC trap; NULL when nothing polled yet
  pollAge: db.prepare(`SELECT CAST((julianday('now')-julianday(MAX(usage_updated)))*86400 AS INT) AS s FROM accounts WHERE usage_updated IS NOT NULL`),
  statByHost: db.prepare(`SELECT host, count(*) AS requests, sum(coalesce(tokens,0)) AS tokens,
    max(ts) AS last FROM request_log GROUP BY host ORDER BY requests DESC`),
  addKey: db.prepare(`INSERT INTO provider_keys(provider,label,key_enc,key_hint,status,last_checked)
    VALUES(?,?,?,?,?,datetime('now'))
    ON CONFLICT(provider,key_hint) DO UPDATE SET key_enc=excluded.key_enc, label=excluded.label,
      status=excluded.status, last_checked=datetime('now')`),
  // last_used is per-PROVIDER not per-key (correlated on provider_keys.provider) — fine for "which subs do I never touch"
  listKeys: db.prepare(`SELECT id,provider,label,key_hint,status,last_checked,created_at,
    (SELECT max(ts) FROM access_log a WHERE a.action='key' AND a.account=provider_keys.provider) AS last_used,
    -- stale = never fetched, or not fetched in 90d — surfaces "subs I'm paying for but never touch"
    (COALESCE((SELECT max(ts) FROM access_log a WHERE a.action='key' AND a.account=provider_keys.provider),'1970-01-01') < datetime('now','-90 days')) AS stale
    FROM provider_keys ORDER BY provider,id`),
  // read-only capability map: one row per provider with a working key (counts + newest last_checked, NEVER secrets).
  // label is correlated to the NEWEST key (the one getKeyByProvider actually serves) — max(label) picked an
  // arbitrary lexical max that could disagree with the served key when a provider has >1 working key.
  capabilities: db.prepare(`SELECT provider, count(*) AS keys,
      (SELECT label FROM provider_keys p2 WHERE p2.provider=provider_keys.provider AND p2.status='working' ORDER BY id DESC LIMIT 1) AS label,
      max(last_checked) AS last_checked
    FROM provider_keys WHERE status='working' GROUP BY provider ORDER BY provider`),
  // ranked working keys for a provider (newest first) so /api/keys/:provider can
  // skip a client-excluded key on retry — mirrors accounts' pickRanked/exclude.
  rankedKeys: db.prepare(`SELECT id,key_enc,label,key_hint FROM provider_keys WHERE provider=? AND status='working' ORDER BY id DESC`),
  delKey: db.prepare(`DELETE FROM provider_keys WHERE id=? RETURNING provider,key_hint`),
  // provider-key liveness poller (mirror of the account poller): keys are otherwise
  // insert-and-forget, so a revoked key stays 'working' forever and gets served silently.
  allWorkingKeys: db.prepare(`SELECT id,provider,key_enc FROM provider_keys WHERE status='working'`),
  getKeyRow: db.prepare(`SELECT id,provider,key_enc,label FROM provider_keys WHERE id=?`),
  setKeyStatus: db.prepare(`UPDATE provider_keys SET status=?, last_checked=datetime('now') WHERE id=?`),
};

// ---- websocket hub ------------------------------------------------------
// browsers abort unless the server echoes one offered subprotocol — echo 'aigate', never the bearer
const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('aigate') ? 'aigate' : false) });
function broadcast(type, data) {
  if (wss.clients.size === 0) return;   // 0 dashboard tabs is the common case — skip stringify + loop
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  for (const ws of wss.clients) {
    // backpressure guard: a half-open socket never drains — it would buffer every broadcast forever
    if (ws.bufferedAmount > 4e6) { ws.terminate(); continue; }
    if (ws.readyState === 1) ws.send(msg);
  }
}
// every audited event also hits the live feed — an audit row nobody sees is not accountability
function logAccess(account, host, ip, action, result) {
  q.insAccess.run(account, host, ip, action, result);
  broadcast('access', { account, host, ip, action, result });
}
// one-pass count of unusable accounts — shared by /health and the reasoned select-503
const tally = (list) => {
  let parked = 0, reauth = 0, disabled = 0;
  for (const a of list) { parked += a.parked; reauth += a.reauth_needed; disabled += a.disabled; }
  return { parked, reauth, disabled };
};
// fire-and-forget outbound alert; never throws into a request path
function alert(text, extra = {}) {
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ts: new Date().toISOString(), ...extra }),
    signal: AbortSignal.timeout(10000), redirect: 'error',
  }).catch((e) => console.error('[alert] webhook failed', String((e && e.message) || e)));
}
// selection-outage edge trigger: alert only on the 0↔>0 transition, not every probe
let zeroAlerted = false;
function noteSelectable(n, ctx) {
  if (n === 0 && !zeroAlerted) { zeroAlerted = true; alert('aigate: 0 selectable accounts — selection is down', ctx); }
  else if (n > 0 && zeroAlerted) { zeroAlerted = false; alert('aigate: recovered — accounts selectable again'); }
}
// last poller cycle health, surfaced on /health so fleet autoheal/dashboard see degradation
let lastPoll = { ts: null, ok: 0, failed: [] };

// ---- http helpers -------------------------------------------------------
// header-only: a ?token= bearer would land in edge (NPM) access logs and outlive rotation
const authed = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') && tokenMatches(h.slice(7), TOKEN);
};
const reqIp = (req) => clientIp(req.headers, req.socket.remoteAddress, { trustProxy: TRUST_PROXY, proxies: TRUSTED_PROXIES });
// collect Buffers and decode ONCE: coercing each chunk to a string splits a multibyte
// UTF-8 sequence (emoji/CJK) across TCP boundaries into replacement chars; the 1MB cap
// must count bytes, not UTF-16 units. Never rejects (bad/oversized body → {}).
const body = (req) => new Promise((resolve) => {
  const chunks = []; let n = 0, settled = false;
  const done = (v) => { if (!settled) { settled = true; resolve(v); } };
  // stop buffering past 1MB but DON'T destroy the socket — the handler still needs
  // a live connection to send its 413 back; pause so we ignore the rest of the body.
  req.on('data', (c) => { n += c.length; if (n > 1e6) { req.pause(); return done({ __oversized: true }); } chunks.push(c); });
  req.on('end', () => { try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { done({}); } });
  // a client abort / socket error must still settle the promise, else the awaiting
  // handler hangs forever holding the request open (slow-loris-style pre-handler leak).
  req.on('aborted', () => done({}));
  req.on('error', () => done({}));
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
// prefix-shaped secrets only (sk-…, ghp…, xoxb…) — no generic long-hex rule, git SHAs must survive
const scrub = (s) => String(s || '').replace(/\b(sk-[A-Za-z0-9_-]{12,}|(?:ghp|gho|xox[bp]|tvly|pplx|fc|AIza)[A-Za-z0-9_-]{12,})\b/g, (m) => m.slice(0, 8) + '…[redacted]');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- routes -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // a malformed target ('//', protocol-relative) makes new URL throw; in an async
  // handler that's an unhandled rejection → socket hangs (pre-auth DoS). 404 it.
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(404); return res.end('not found'); }
  const p = url.pathname;

  // network gate (defense-in-depth, before anything else)
  if (!ipAllowed(reqIp(req), ALLOW_CIDR)) {
    console.warn('[net] denied', reqIp(req), req.method, p);   // stderr only — unauth clients must not write DB rows
    return json(res, 403, { error: 'forbidden (network)' });
  }

  // health probe (no bearer — supervisors/watchdog don't have it; still gated
  // by network, and loopback/docker healthchecks are always allowed). db-backed:
  // a wedged DB → 503 so the supervisor can restart us.
  if (req.method === 'GET' && (p === '/health' || p === '/healthz')) {
    try {
      db.prepare('SELECT 1').get();
      const accts = q.listAccounts.all();
      // same query /api/select uses — a hand-rolled filter here once ignored parked_until
      // and reported selectable>0 while select 503'd, so autoheal never restarted anything.
      const selectable = q.pickRanked.all(CUTOFF).length;
      const { parked, reauth, disabled } = tally(accts);
      // newest aigate-*.db backup mtime → age; numbers only, safe on this unauth endpoint
      let backup_age_s = null;
      if (existsSync(BACKUP_DIR)) {
        const mtimes = readdirSync(BACKUP_DIR)
          .filter((f) => /^aigate-\d{4}-\d{2}-\d{2}\.db$/.test(f))
          .map((f) => statSync(join(BACKUP_DIR, f)).mtimeMs);
        if (mtimes.length) backup_age_s = Math.round((Date.now() - Math.max(...mtimes)) / 1000);
      }
      return json(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), accounts: accts.length, selectable,
        poll_age_s: q.pollAge.get().s, backup_age_s, parked, reauth, disabled,
        // last poller cycle health — surfaces poll degradation (all tokens erroring) that
        // usage staleness alone wouldn't flag; numbers only, safe on this unauth endpoint
        poll_ok: lastPoll.ok, poll_failed: lastPoll.failed.length });
    } catch (e) {
      // unauth endpoint: log the detail, return a generic 503 (don't leak DB_PATH / SQLite internals)
      console.error('[health] db check failed', String((e && e.message) || e));
      return json(res, 503, { ok: false });
    }
  }

  // static dashboard (index gated at load; API gated per-request)
  if (req.method === 'GET' && !p.startsWith('/api')) {
    const fp = safeStaticPath(PUBLIC, p);
    // regular files only: GET // resolves to PUBLIC itself → readFile(dir) rejects
    // outside the try/catch → socket hangs forever (pre-auth DoS)
    try {
      if (fp && existsSync(fp) && statSync(fp).isFile()) {
        const data = await readFile(fp);
        res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
        return res.end(data);
      }
    } catch { /* file vanished between existsSync and read (deploy swapping public/) → 404, not a hung pre-auth socket */ }
    res.writeHead(404); return res.end('not found');
  }

  if (!authed(req)) { console.error('[auth] denied', reqIp(req), req.method, p); return json(res, 401, { error: 'unauthorized' }); }

  try {
    // --- accounts / vault ---
    if (p === '/api/accounts' && req.method === 'GET')
      return json(res, 200, q.listAccounts.all());
    if (p === '/api/accounts' && req.method === 'POST') {
      const b = await body(req);
      if (!b.account || !b.setup_token) return json(res, 400, { error: 'account + setup_token required' });
      // a name with '/' or whitespace breaks the /api/accounts/<name>/<verb> path
      // parsing (split('/')[3]) and can't be targeted for disable/refresh/delete.
      if (/[/\s]/.test(String(b.account))) return json(res, 400, { error: 'account name cannot contain spaces or slashes' });
      // the browser "Authentication Code" (code#state) paste vaults fine and only surfaces
      // ~10min later as a mystery reauth_needed when the poller 401s — reject it NOW
      const tok = String(b.setup_token).trim();
      if (!tok || /#|\s/.test(tok))
        return json(res, 400, { error: "that looks like the browser Authentication Code (code#state) — send the sk-ant-oat01-… line the TERMINAL prints after 'claude setup-token'" });
      const existed = !!q.getToken.get(b.account);   // BEFORE upsert — overwrite vs add
      q.upsertAccount.run(b.account, encrypt(tok), b.label || '');
      logAccess(b.account, '', reqIp(req), existed ? 'account-overwrite' : 'account-add', b.label || '');
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, tok.startsWith('sk-ant-') ? { ok: true }
        : { ok: true, warning: "doesn't look like a setup token (sk-ant-…)" });
    }
    // --- provider catalog (top ~50 providers) for the add-key dropdown ---
    if (p === '/api/providers' && req.method === 'GET')
      return json(res, 200, PROVIDERS);

    // --- provider API key registry (encrypted at rest; list never returns secrets) ---
    if (p === '/api/keys' && req.method === 'GET')
      return json(res, 200, q.listKeys.all());
    // ponytail: READ-ONLY by design — reports provider key counts + Claude selectability, NEVER meters/holds/
    // forwards a request. Putting aigate in a provider's request path stays unbuilt until the secure-proxy ring
    // earns it. Path MUST be '/api/capabilities' ('/capabilities' would hit the static branch and 404.)
    if (p === '/api/capabilities' && req.method === 'GET') {
      const providers = {};
      for (const r of q.capabilities.all()) providers[r.provider] = { keys: r.keys, label: r.label, last_checked: r.last_checked };
      return json(res, 200, { version: VERSION, providers, claude: { selectable: q.pickRanked.all(CUTOFF).length, accounts: q.listAccounts.all().length } });
    }
    // on-demand liveness check for ONE key (mirror of /api/accounts/:name/refresh)
    if (p.startsWith('/api/keys/') && p.endsWith('/refresh') && req.method === 'POST') {
      const row = q.getKeyRow.get(Number(p.split('/')[3]));
      if (!row) return json(res, 404, { error: 'unknown key id' });
      let key; try { key = decrypt(row.key_enc); } catch { return json(res, 500, { error: 'decrypt failed' }); }
      const chk = await checkProviderKey(PROVIDER_BY_ID.get(row.provider), key);
      if (chk.skip) return json(res, 200, { id: row.id, provider: row.provider, checked: false, note: 'no liveness probe for this provider' });
      if (chk.error) return json(res, 502, { id: row.id, provider: row.provider, error: chk.error });  // network blip → status untouched
      q.setKeyStatus.run(chk.alive ? 'working' : 'dead', row.id);
      logAccess(row.provider, '', reqIp(req), 'key-refresh', chk.alive ? 'working' : `dead (${chk.status})`);
      broadcast('keys', q.listKeys.all());
      return json(res, 200, { id: row.id, provider: row.provider, checked: true, alive: chk.alive, status: chk.status });
    }
    // fetch the newest working key for a provider (bearer-gated, audited) — used
    // by clients/skills that need the actual secret to call the provider. ?exclude=
    // <hint,hint> lets a client whose key just 401'd retry the next working key.
    if (p.startsWith('/api/keys/') && req.method === 'GET') {
      // normalize like POST does — 'Brave ' vs 'brave' must not silently 404 hydrate
      const provider = decodeURIComponent(p.split('/').pop()).trim().toLowerCase();
      const excl = new Set((url.searchParams.get('exclude') || '').split(',').map((s) => s.trim()).filter(Boolean));
      const row = q.rankedKeys.all(provider).find((r) => !excl.has(r.key_hint));
      if (!row) return json(res, 404, { error: 'no working key for ' + provider });
      // decrypt BEFORE the audit — a 'key ok' row written ahead of a decrypt that
      // then throws makes the vault's audit trail claim a handout that never happened.
      const host = url.searchParams.get('host') || '';
      let key; try { key = decrypt(row.key_enc); } catch {
        logAccess(provider, host, reqIp(req), 'key', 'decrypt-fail');
        return json(res, 500, { error: 'decrypt failed' });
      }
      logAccess(provider, host, reqIp(req), 'key', 'ok');
      return json(res, 200, { provider, label: row.label, key, key_hint: row.key_hint });
    }
    if (p === '/api/keys' && req.method === 'POST') {
      const b = await body(req);
      const provider = String(b.provider || '').trim().toLowerCase();
      if (!provider) return json(res, 400, { error: 'provider + key required' });
      // pastes arrive as `export NAME="sk-…"` and the failure surfaces days later as a
      // provider 401 — strip one layer of matching quotes, reject anything not a bare value.
      let key = String(b.key || '').trim();
      const qm = /^(['"])([\s\S]*)\1$/.exec(key); if (qm) key = qm[2];
      if (!key || /\s/.test(key) || /^(export\s|\w+=)/.test(key))
        return json(res, 400, { error: 'key looks malformed (contains whitespace or an export/NAME= prefix — send the raw value only)' });
      // first8…last4: UNIQUE(provider,key_hint) is the upsert target — a prefix-only hint
      // made same-prefix keys (sk-proj-…, sk-or-v1-…) silently overwrite each other.
      const hint = key.slice(0, 8) + '…' + key.slice(-4);
      // a mistyped status ('workign'/'Working'/'active') would vault a key that getKeyByProvider's
      // exact status='working' filter then 404s forever — coerce anything but the two legit values
      // to 'working' ('disabled' = deliberately shelved). Lazy on purpose: default, don't 400.
      const status = (b.status === 'working' || b.status === 'disabled') ? b.status : 'working';
      q.addKey.run(provider, b.label || '', encrypt(key), hint, status);
      logAccess(provider, '', reqIp(req), 'key-add', hint);
      broadcast('keys', q.listKeys.all());
      return json(res, 200, isKnownProvider(provider) ? { ok: true }
        : { ok: true, warning: `unknown provider ${provider} — not in the catalog` });
    }
    if (p.startsWith('/api/keys/') && req.method === 'DELETE') {
      // RETURNING: a typo'd id used to no-op with {ok:true} — surface it as a 404
      const dead = q.delKey.get(Number(p.split('/').pop()));
      if (!dead) return json(res, 404, { error: 'unknown key id' });
      logAccess(dead.provider, '', reqIp(req), 'key-delete', dead.key_hint);
      broadcast('keys', q.listKeys.all());
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
      const name = decodeURIComponent(p.split('/').pop());
      const dead = q.delAccount.get(name);
      if (!dead) return json(res, 404, { error: 'unknown account' });
      logAccess(name, '', reqIp(req), 'account-delete', dead.label);
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/accounts/') && p.endsWith('/disabled') && req.method === 'POST') {
      const name = decodeURIComponent(p.split('/')[3]); const b = await body(req);
      // check .changes like the sibling mutation routes — disabling an unknown/typo'd
      // account used to no-op yet still return {ok:true} + broadcast, hiding the miss.
      if (q.setDisabled.run(b.disabled ? 1 : 0, name).changes === 0) return json(res, 404, { error: 'unknown account ' + name });
      logAccess(name, '', reqIp(req), b.disabled ? 'account-disable' : 'account-enable', 'ok');
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }
    // poll ONE account's real headroom RIGHT NOW (not the 10-min cache) so a client can
    // decide, on session exit, whether it's exhausted and should switch accounts.
    if (p.startsWith('/api/accounts/') && p.endsWith('/refresh') && req.method === 'POST') {
      const name = decodeURIComponent(p.split('/')[3]);
      const row = q.getToken.get(name);
      if (!row || !row.token_enc) return json(res, 404, { error: 'unknown account' });
      let tok; try { tok = decrypt(row.token_enc); } catch { return json(res, 500, { error: 'decrypt failed' }); }
      const r = await pollAccountUsage(name, tok);   // updates usage/reauth in the DB
      // poll failure (timeout/outage) → 502, DB untouched — a 200 {alive:true,maxed:0} here
      // would read as "healthy and empty" exactly when the client must keep-or-switch
      if (r.error) return json(res, 502, { account: name, error: r.error });
      broadcast('accounts', q.listAccounts.all());
      const worst = Math.max(Number(r.five) || 0, Number(r.seven) || 0);
      return json(res, 200, { account: name, five: r.five ?? null, seven: r.seven ?? null,
        alive: r.alive !== false, maxed: worst >= CUTOFF ? 1 : 0 });
    }

    // --- the selector: hand out the best account's token (audited) ---
    // ?exclude=a,b lets a client retry past an account that just hit its limit.
    if (p === '/api/select' && req.method === 'GET') {
      const host = url.searchParams.get('host') || '', ip = reqIp(req);
      const excl = new Set((url.searchParams.get('exclude') || '').split(',').map((s) => s.trim()).filter(Boolean));
      // Walk the ranked candidates, not just the top one: a poison account (corrupt
      // ciphertext or a since-rotated key) used to throw on decrypt and 500 — and
      // pickRanked kept re-electing it, so EVERY select 500'd forever. Park a poison
      // account (so pickRanked skips it), audit the fault, and fall through to next.
      let picked = null, tok = null;
      for (const r of q.pickRanked.all(CUTOFF)) {
        if (excl.has(r.account)) continue;
        const row = q.getToken.get(r.account);
        if (!row || !row.token_enc) continue;   // TOCTOU: deleted between rank and read
        try { tok = decrypt(row.token_enc); picked = r; break; }
        catch {
          q.parkAccount.run('+60 minutes', r.account);
          logAccess(r.account, host, ip, 'select', 'decrypt-fail — parked 60m');
        }
      }
      if (!picked) {
        // reasoned 503: WHY is nothing servable — one account may tick several counters.
        // Tally BEFORE the audit so the feed AND /api/access record the reason, not a bare 'none-available'.
        const all = q.listAccounts.all();
        const { parked, reauth, disabled } = tally(all);
        logAccess(null, host, ip, 'select', `none-available · ${all.length} accts (${parked} parked, ${reauth} re-auth, ${disabled} off)`);
        noteSelectable(0, { via: 'select', accounts: all.length, parked, reauth, disabled });   // edge-alert on first outage
        return json(res, 503, { error: 'no account with headroom', accounts: all.length, parked, reauth, disabled });
      }
      noteSelectable(1, { via: 'select' });   // a real handout means selection is up → clears the outage latch
      logAccess(picked.account, host, ip, 'select', 'ok');
      return json(res, 200, { account: picked.account, setup_token: tok });
    }
    // client hit an over-limit/unavailable account → PARK it for a TTL (default 15m) so
    // the next select skips it, WITHOUT clobbering its real usage; the poller keeps the %
    // honest and it auto-recovers when parked_until passes. ?minutes overrides the TTL.
    if (p === '/api/events/limit' && req.method === 'POST') {
      const b = await body(req);
      if (!b.account) return json(res, 400, { error: 'account required' });
      const mins = Math.min(Math.max(Number(b.minutes) || 15, 1), 360);
      // a mistyped/stale account matches zero rows — {ok:true} there means selection
      // keeps running on stale data while the client thinks it reported fine.
      if (q.parkAccount.run(`+${mins} minutes`, b.account).changes === 0)
        return json(res, 404, { error: 'unknown account ' + b.account });
      logAccess(b.account, b.host || '', reqIp(req), 'limit', `parked ${mins}m`);
      broadcast('accounts', q.listAccounts.all());
      // read back so the caller can display/log the actual expiry
      return json(res, 200, { ok: true, parked_minutes: mins, parked_until: q.getParked.get(b.account).parked_until });
    }

    // --- event ingest (from the fleet's hooks) ---
    if (p === '/api/events/prompt' && req.method === 'POST') {
      const b = await body(req);
      // an oversized body was dropped to a sentinel — say so (413) instead of silently
      // writing a hollow row of empty defaults under a 200 the client reads as "logged".
      // Connection:close — we paused mid-body, so the socket has unread bytes that would
      // poison a keep-alive reuse (ECONNRESET on the NEXT request); close it cleanly.
      if (b.__oversized) { res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }); return res.end(JSON.stringify({ error: 'payload too large' })); }
      // store scrubbed + truncated: every read already substr's to 400 — never retain full prompts
      const prompt = scrub(b.prompt).slice(0, 400);
      q.insReq.run(b.account || '', b.host || '', reqIp(req), b.cwd || '', b.model || '', prompt, b.tokens ?? null);
      broadcast('prompt', { account: b.account, host: b.host, ip: reqIp(req), cwd: b.cwd, model: b.model,
        prompt, ts: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/events/usage' && req.method === 'POST') {
      const b = await body(req);
      if (!b.account) return json(res, 400, { error: 'account required' });
      if (q.updUsage.run(Number(b.five_hour_pct) || 0, Number(b.seven_day_pct) || 0, b.account).changes === 0)
        return json(res, 404, { error: 'unknown account ' + b.account });
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }

    // --- read models for the dashboard ---
    // Math.max(1,…) floor: SQLite reads a negative LIMIT as unbounded, so a truthy -1 would dump the whole log.
    if (p === '/api/logs' && req.method === 'GET')
      return json(res, 200, q.recentReq.all(Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 1000))));
    // audit trail read path (access_log holds only hints/labels/actions, never secrets)
    if (p === '/api/access' && req.method === 'GET')
      return json(res, 200, q.recentAccess.all(Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 100, 1000))));
    if (p === '/api/stats' && req.method === 'GET')
      return json(res, 200, { by_host: q.statByHost.all(), accounts: q.listAccounts.all() });

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    // malformed %-encoding in a path segment throws URIError from decodeURIComponent —
    // that's a client mistake (400), not our fault (500).
    if (e instanceof URIError) return json(res, 400, { error: 'bad url encoding' });
    // keep the raw fault server-side; a bearer holder isn't necessarily the operator,
    // and SQLite/fs error strings leak paths + internals.
    console.error('[500]', req.method, p, String((e && e.message) || e));
    return json(res, 500, { error: 'internal error' });
  }
});

// ws upgrade (token-gated; bearer rides the 'bearer.<token>' subprotocol so it never lands in URL access logs)
server.on('upgrade', (req, socket, head) => {
  // same '//' trap as the request handler, but this listener is SYNC — an unguarded
  // throw here is uncaughtException → shutdown(1) → autoheal crash-loop, pre-auth
  let path; try { path = new URL(req.url, 'http://x').pathname; } catch { socket.destroy(); return; }
  const wsAuthed = String(req.headers['sec-websocket-protocol'] || '').split(',')
    .some((p) => p.trim().startsWith('bearer.') && tokenMatches(p.trim().slice(7), TOKEN));
  if (path !== '/ws' || !wsAuthed || !ipAllowed(reqIp(req), ALLOW_CIDR)) { console.warn('[ws] denied', reqIp(req)); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // a mid-send ECONNRESET (sleeping laptop tab) otherwise emits an unlistened
    // 'error' → uncaughtException → the whole vault daemon restarts
    ws.isAlive = true;
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => { ws.isAlive = true; });
    ws.send(JSON.stringify({ type: 'accounts', data: q.listAccounts.all(), ts: new Date().toISOString() }));
  });
});

// ---- usage poller ------------------------------------------------------
// Read each account's REAL rate-limit headroom straight from Anthropic and
// update the vault. No proxy: this is aigate polling on its own tokens so
// selection/skip stays accurate and auto-recovers after a reset window.
const allTokensStmt = db.prepare(`SELECT account, token_enc FROM accounts WHERE token_enc IS NOT NULL`);
async function pollAccountUsage(account, token) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15000),
      // never follow a redirect: this request carries a live OAuth token as Bearer,
      // and a hijacked-DNS 30x could bounce it to an attacker-controlled host.
      redirect: 'error',
    });
    // status + headers are all we read — cancel the body or undici pins the connection until GC
    r.body?.cancel().catch(() => {});
    // 401/403 = token expired/revoked → flag for reauth so /api/select skips it;
    // any authenticated response clears the flag (auto-recovers after re-token).
    const alive = tokenIsAlive(r.status);
    q.setReauth.run(alive ? 0 : 1, account);
    const u5 = r.headers.get('anthropic-ratelimit-unified-5h-utilization');
    const u7 = r.headers.get('anthropic-ratelimit-unified-7d-utilization');
    if (u5 == null && u7 == null)
      return { account, status: r.status, alive, note: alive ? 'no rate-limit headers' : 'auth failed — needs reauth' };
    const f5 = parseFloat(u5), f7 = parseFloat(u7);
    // a header that's PRESENT but unparseable (Anthropic renamed/reformatted it) must
    // not become a phantom 0% = "max headroom" that then gets selected FIRST and routes
    // traffic to an exhausted token. Keep the last-known-good % and alarm instead.
    if ((u5 != null && Number.isNaN(f5)) || (u7 != null && Number.isNaN(f7))) {
      console.warn('[poll] E_HEADER_DRIFT unparseable rate header for', account, JSON.stringify({ u5, u7 }));
      return { account, status: r.status, alive, note: 'unparseable rate header — kept last-known-good' };
    }
    const five = Math.round((f5 || 0) * 100);
    const seven = Math.round((f7 || 0) * 100);
    q.updUsage.run(five, seven, account);
    return { account, five, seven, status: r.status, alive };
  } catch (e) {
    // network error: can't tell if the token is dead → leave the flag as-is
    return { account, error: String((e && e.message) || e) };
  }
}
let polling = false;   // ponytail: skip-not-queue — a skipped cycle self-corrects next interval
async function pollUsage() {
  if (polling) { console.warn('[poll] previous cycle still running, skipping'); return; }
  polling = true;
  try {
    // parallel: one hung/dead token no longer makes the cycle N×15s and stalls later accounts.
    // node:sqlite is sync so the interleaved DB writes stay serialized on the event loop.
    const results = await Promise.all(allTokensStmt.all().map(async (row) => {
      let tok;
      // no exit: partial failure stays partial, and a restart won't fix a key mismatch
      try { tok = decrypt(row.token_enc); }
      catch (e) { console.error('[poll] decrypt failed for', row.account, '— wrong AIGATE_ENCRYPTION_KEY or corrupt row:', String(e && e.message || e)); return { account: row.account, error: 'decrypt' }; }
      const res = await pollAccountUsage(row.account, tok);
      console.log('[poll]', new Date().toISOString(), JSON.stringify(res));
      return res;
    }));
    // record cycle health so /health (and thus fleet autoheal/dashboard) can see poller degradation
    const failed = results.filter((r) => r && r.error).map((r) => ({ account: r.account, error: r.error }));
    lastPoll = { ts: new Date().toISOString(), ok: results.length - failed.length, failed };
    // unconditional: a 401'd token returns no rate-limit headers (five==null) but still
    // setReauth(1)'d the DB — a guarded broadcast left the dashboard showing a dying account green.
    broadcast('accounts', q.listAccounts.all());
    // edge-alert if this cycle left nothing selectable (or recovered)
    noteSelectable(q.pickRanked.all(CUTOFF).length, { via: 'poll' });
  } finally { polling = false; }
}
const POLL_MS = Number(process.env.AIGATE_POLL_MS || 600000); // 10 min

// ---- provider-key liveness ---------------------------------------------
// Accounts self-heal (poll → reauth flag); provider keys were insert-and-forget,
// so a revoked/rotated key sat status='working' forever and got served silently.
// Probe = GET <base>/models with the key as Bearer. Only providers that speak the
// OpenAI API (oaiCompat) get a generic probe; others have no universal cheap check
// and are left untouched (skip), never wrongly flipped to dead.
async function checkProviderKey(meta, key) {
  if (!meta || !meta.oaiCompat || !meta.base) return { skip: true };
  try {
    const r = await fetch(meta.base.replace(/\/+$/, '') + '/models', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    r.body?.cancel().catch(() => {});
    return { alive: r.status !== 401 && r.status !== 403, status: r.status };
  } catch (e) { return { error: String((e && e.message) || e) }; }
}
let keyPolling = false;
async function pollProviderKeys() {
  if (keyPolling) { console.warn('[keypoll] previous cycle still running, skipping'); return; }
  keyPolling = true;
  try {
    let flipped = 0;
    await Promise.all(q.allWorkingKeys.all().map(async (row) => {
      let key; try { key = decrypt(row.key_enc); }
      catch { return; }   // poison key: the /api/keys decrypt guards handle it, don't flip on a read we can't do
      const chk = await checkProviderKey(PROVIDER_BY_ID.get(row.provider), key);
      if (chk.skip || chk.error) return;   // unknown provider / network blip → leave status as-is
      q.setKeyStatus.run(chk.alive ? 'working' : 'dead', row.id);
      if (!chk.alive) {
        flipped++;
        console.warn('[keypoll] E_KEY_DEAD', row.provider, 'id', row.id, 'status', chk.status);
        alert(`aigate: provider key went dead — ${row.provider}`, { provider: row.provider, id: row.id, status: chk.status });
      }
    }));
    if (flipped) broadcast('keys', q.listKeys.all());
  } finally { keyPolling = false; }
}

// ---- vault backup --------------------------------------------------------
// VACUUM INTO = consistent WAL-safe snapshot, zero deps. .env is deliberately
// NOT copied (no secret sprawl — backups hold ciphertext only). A failed
// backup logs loudly but never kills the daemon.
function backupNow() {
  try {
    mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    // ponytail: backupNow doubles as daily maintenance — 30-day log retention, no env knob.
    // Retention runs BEFORE the snapshot so a failing backup (full disk) can't starve it.
    db.exec(`DELETE FROM request_log WHERE ts < datetime('now','-30 days')`);
    db.exec(`DELETE FROM access_log WHERE ts < datetime('now','-30 days')`);
    const cutoff = Date.now() - 14 * 86400000;
    for (const f of readdirSync(BACKUP_DIR)) {
      const m = /^aigate-(\d{4}-\d{2}-\d{2})\.db$/.exec(f);
      if (m && Date.parse(m[1]) < cutoff) unlinkSync(join(BACKUP_DIR, f));
    }
    const target = join(BACKUP_DIR, `aigate-${new Date().toISOString().slice(0, 10)}.db`);
    if (!existsSync(target)) {
      // VACUUM into a tmp then rename (atomic, same fs) — an aigate-*.db is
      // only ever a COMPLETED snapshot, never a crash/disk-full partial.
      const tmp = target + '.tmp';
      if (existsSync(tmp)) unlinkSync(tmp);
      db.exec(`VACUUM INTO '${tmp}'`);
      chmodSync(tmp, 0o600);
      renameSync(tmp, target);
    }
  } catch (e) { console.error('[backup] failed', e); alert('aigate: vault backup FAILED', { error: String((e && e.message) || e) }); }
}

// Close server + db and exit. On a fatal fault we exit non-zero so the
// supervisor (docker restart:unless-stopped / launchd KeepAlive) revives us —
// that's the self-heal. On a signal we exit 0 for a clean stop.
function shutdown(code) {
  try { server.close(); } catch { /* not listening */ }
  try { db.close(); } catch { /* already closed */ }
  process.exit(code);
}

// Only auto-start (listen + poll + supervise) when run directly. When imported
// (tests) the caller drives server.listen() and none of this installs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // don't let a stray async throw silently kill the daemon
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); shutdown(1); });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`[${sig}] shutting down`); shutdown(0); });

  // internal watchdog: WRITE-ping, not SELECT — in WAL mode readers never block
  // on a wedged writer (disk full, ro-remount, stuck write lock), so a read
  // ping stays green while every POST 500s. A failed write exits so the
  // supervisor restarts a fresh process. ponytail: db-ping only — widen the
  // check if other subsystems can hang.
  const WATCHDOG_MS = Number(process.env.AIGATE_WATCHDOG_MS || 30000);
  if (WATCHDOG_MS > 0) setInterval(() => {
    try { db.prepare(`INSERT INTO meta(k,v) VALUES('watchdog',datetime('now')) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(); }
    catch (e) { console.error('[watchdog] db write failed — exiting for restart', e); shutdown(1); }
  }, WATCHDOG_MS).unref();

  // WS heartbeat: a socket that missed a pong since the last sweep is dead
  // (sleeping laptop tab) — terminate it instead of letting it rot in wss.clients
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30000).unref();

  // poller cycles are wrapped so a rejected cycle logs instead of crashing
  const poll = () => pollUsage().catch((e) => console.error('[poll] cycle failed', e));
  if (POLL_MS > 0) { setTimeout(poll, 8000); setInterval(poll, POLL_MS); }

  // provider-key liveness runs on its own (slower) cadence — keys change far less
  // often than account headroom. Offset from the account poll so they don't burst together.
  const KEY_POLL_MS = Number(process.env.AIGATE_KEY_POLL_MS || 3600000); // 1h
  const keyPoll = () => pollProviderKeys().catch((e) => console.error('[keypoll] cycle failed', e));
  if (KEY_POLL_MS > 0) { setTimeout(keyPoll, 25000); setInterval(keyPoll, KEY_POLL_MS); }

  // daily vault backup (~20s after boot, then every 24h)
  setTimeout(backupNow, 20000).unref();
  setInterval(backupNow, 86400000).unref();

  server.listen(PORT, HOST, () =>
    console.log(`aigate on http://${HOST}:${PORT}  (db ${DB_PATH})`));
}

export { server, db, pollUsage, pollProviderKeys, backupNow, openDb, isWeakToken };
