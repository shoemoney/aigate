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
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

// ---- config -------------------------------------------------------------
try { process.loadEnvFile(); } catch { /* no .env, use real env */ }
const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dir, '..', 'public');
const PORT = Number(process.env.PORT || 20200);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.AIGATE_TOKEN || '';
const DB_PATH = process.env.AIGATE_DB || join(__dir, '..', 'data', 'aigate.db');
const CUTOFF = Number(process.env.AIGATE_HEADROOM_CUTOFF || 95);
const ENC_KEY = (process.env.AIGATE_ENCRYPTION_KEY || '').trim();

if (!TOKEN) { console.error('FATAL: set AIGATE_TOKEN'); process.exit(1); }
if (!/^[0-9a-fA-F]{64}$/.test(ENC_KEY)) {
  console.error('FATAL: set AIGATE_ENCRYPTION_KEY to 32-byte hex (openssl rand -hex 32)');
  process.exit(1);
}
const KEY = Buffer.from(ENC_KEY, 'hex');

// ---- token encryption (AES-256-GCM) ------------------------------------
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

// ---- db -----------------------------------------------------------------
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS accounts (
    account        TEXT PRIMARY KEY,
    token_enc      TEXT,
    label          TEXT DEFAULT '',
    five_hour_pct  REAL DEFAULT 0,
    seven_day_pct  REAL DEFAULT 0,
    usage_updated  TEXT,
    disabled       INTEGER NOT NULL DEFAULT 0,
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
  CREATE INDEX IF NOT EXISTS idx_req_host ON request_log(host);
  CREATE INDEX IF NOT EXISTS idx_req_acct ON request_log(account);
`);

// prepared once
const q = {
  upsertAccount: db.prepare(`INSERT INTO accounts(account,token_enc,label) VALUES(?,?,?)
    ON CONFLICT(account) DO UPDATE SET token_enc=excluded.token_enc, label=excluded.label`),
  listAccounts: db.prepare(`SELECT account,label,five_hour_pct,seven_day_pct,usage_updated,disabled,
    (token_enc IS NOT NULL) AS has_token FROM accounts ORDER BY account`),
  getToken: db.prepare(`SELECT token_enc FROM accounts WHERE account=?`),
  delAccount: db.prepare(`DELETE FROM accounts WHERE account=?`),
  setDisabled: db.prepare(`UPDATE accounts SET disabled=? WHERE account=?`),
  updUsage: db.prepare(`UPDATE accounts SET five_hour_pct=?, seven_day_pct=?, usage_updated=datetime('now') WHERE account=?`),
  // most headroom = lowest worst-window usage; skip disabled / over cutoff / tokenless
  pickBest: db.prepare(`SELECT account FROM accounts
    WHERE disabled=0 AND token_enc IS NOT NULL AND max(five_hour_pct,seven_day_pct) < ?
    ORDER BY max(five_hour_pct,seven_day_pct) ASC, usage_updated ASC LIMIT 1`),
  insReq: db.prepare(`INSERT INTO request_log(account,host,ip,cwd,model,prompt,tokens) VALUES(?,?,?,?,?,?,?)`),
  insAccess: db.prepare(`INSERT INTO access_log(account,host,ip,action,result) VALUES(?,?,?,?,?)`),
  recentReq: db.prepare(`SELECT id,ts,account,host,ip,cwd,model,substr(prompt,1,400) AS prompt,tokens
    FROM request_log ORDER BY id DESC LIMIT ?`),
  statByAccount: db.prepare(`SELECT account, count(*) AS requests, sum(coalesce(tokens,0)) AS tokens,
    max(ts) AS last FROM request_log GROUP BY account`),
  statByHost: db.prepare(`SELECT host, count(*) AS requests, sum(coalesce(tokens,0)) AS tokens,
    max(ts) AS last FROM request_log GROUP BY host ORDER BY requests DESC`),
};

// ---- websocket hub ------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: new Date().toISOString() });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// ---- http helpers -------------------------------------------------------
const authed = (req) => {
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7) : '';
  const url = new URL(req.url, 'http://x');
  const t = bearer || url.searchParams.get('token') || '';
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
};
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
const body = (req) => new Promise((res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch { res({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// ---- routes -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // static dashboard (index gated at load; API gated per-request)
  if (req.method === 'GET' && !p.startsWith('/api')) {
    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const fp = join(PUBLIC, file);
    if (existsSync(fp) && fp.startsWith(PUBLIC)) {
      const data = await readFile(fp);
      res.writeHead(200, { 'content-type': MIME[extname(fp)] || 'application/octet-stream' });
      return res.end(data);
    }
    res.writeHead(404); return res.end('not found');
  }

  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

  try {
    // --- accounts / vault ---
    if (p === '/api/accounts' && req.method === 'GET')
      return json(res, 200, q.listAccounts.all());
    if (p === '/api/accounts' && req.method === 'POST') {
      const b = await body(req);
      if (!b.account || !b.setup_token) return json(res, 400, { error: 'account + setup_token required' });
      q.upsertAccount.run(b.account, encrypt(b.setup_token), b.label || '');
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/accounts/') && req.method === 'DELETE') {
      q.delAccount.run(decodeURIComponent(p.split('/').pop()));
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }
    if (p.startsWith('/api/accounts/') && p.endsWith('/disabled') && req.method === 'POST') {
      const name = decodeURIComponent(p.split('/')[3]); const b = await body(req);
      q.setDisabled.run(b.disabled ? 1 : 0, name);
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }

    // --- the selector: hand out the best account's token (audited) ---
    if (p === '/api/select' && req.method === 'GET') {
      const host = url.searchParams.get('host') || '', ip = clientIp(req);
      const row = q.pickBest.get(CUTOFF);
      if (!row) { q.insAccess.run(null, host, ip, 'select', 'none-available'); return json(res, 503, { error: 'no account with headroom' }); }
      const tok = decrypt(q.getToken.get(row.account).token_enc);
      q.insAccess.run(row.account, host, ip, 'select', 'ok');
      broadcast('access', { account: row.account, host, ip, action: 'select' });
      return json(res, 200, { account: row.account, setup_token: tok });
    }

    // --- event ingest (from the fleet's hooks) ---
    if (p === '/api/events/prompt' && req.method === 'POST') {
      const b = await body(req);
      q.insReq.run(b.account || '', b.host || '', clientIp(req), b.cwd || '', b.model || '', b.prompt || '', b.tokens ?? null);
      broadcast('prompt', { account: b.account, host: b.host, ip: clientIp(req), cwd: b.cwd, model: b.model,
        prompt: String(b.prompt || '').slice(0, 400), ts: new Date().toISOString() });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/events/usage' && req.method === 'POST') {
      const b = await body(req);
      if (!b.account) return json(res, 400, { error: 'account required' });
      q.updUsage.run(Number(b.five_hour_pct) || 0, Number(b.seven_day_pct) || 0, b.account);
      broadcast('accounts', q.listAccounts.all());
      return json(res, 200, { ok: true });
    }

    // --- read models for the dashboard ---
    if (p === '/api/logs' && req.method === 'GET')
      return json(res, 200, q.recentReq.all(Math.min(Number(url.searchParams.get('limit')) || 100, 1000)));
    if (p === '/api/stats' && req.method === 'GET')
      return json(res, 200, { by_account: q.statByAccount.all(), by_host: q.statByHost.all(), accounts: q.listAccounts.all() });

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

// ws upgrade (token-gated)
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authed(req)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'accounts', data: q.listAccounts.all(), ts: new Date().toISOString() }));
  });
});

server.listen(PORT, HOST, () =>
  console.log(`aigate on http://${HOST}:${PORT}  (db ${DB_PATH})`));
