// Codex (ChatGPT) accounts alongside Claude: import both auth shapes, usage poll via
// chatgpt.com's wham/usage, aigate-owned OAuth refresh, kind-aware select, sync-back.
// One fake upstream serves BOTH the usage URL and the token URL (AIGATE_CODEX_*_URL
// overrides); per-test behavior comes from swapping `usageFor` / `tokenHandler`. Mirrors
// oai-proxy.test.js: boot server.js in-process on port 0, never touch the real network.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, readFileSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { rtHash } from '../src/lib.js';
import { makeVault } from '../src/lib.js';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
// own temp dir: the server backs up into dirname(DB)/backups — a DB straight in $TMPDIR shared that
// dir with every other test file, and their parallel backups/rm's raced each other's assertions
const TMP = mkdtempSync(join(tmpdir(), 'aigate-codex-'));
const DB = join(TMP, `aigate-codex-test-${process.pid}-${Date.now()}.db`);
const ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_ENCRYPTION_KEY = ENC_KEY;
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.AIGATE_KEY_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;
delete process.env.AIGATE_CODEX_REFRESH_AHEAD_S;

// alert receiver: server.js reads AIGATE_ALERT_WEBHOOK once at import, so it must exist first
const alertPosts = [];
const alertSink = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { alertPosts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { alertPosts.push({ bad: true }); } res.writeHead(200); res.end('ok'); });
});
await new Promise((r) => alertSink.listen(0, '127.0.0.1', r));
process.env.AIGATE_ALERT_WEBHOOK = `http://127.0.0.1:${alertSink.address().port}/hook`;

const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(ENC_KEY, 'hex'));
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

// ---- helpers ------------------------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64u({ alg: 'none' })}.${b64u({ ...payload, jti: crypto.randomBytes(6).toString('hex') })}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const iso = (s) => new Date(s * 1000).toISOString();
function mkAuth({ email = 'a@x.test', plan = 'pro', acct = 'acct-' + crypto.randomBytes(4).toString('hex'), expIn = 5 * 86400, refresh = 'rt-' + crypto.randomBytes(4).toString('hex'), lastRefresh = iso(now()) } = {}) {
  return {
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan, chatgpt_account_id: acct } }),
      access_token: jwt({ exp: now() + expIn }), refresh_token: refresh, account_id: acct,
    },
    last_refresh: lastRefresh,
  };
}
const win = (used, secs, resetAt = now() + 1000) => ({ used_percent: used, limit_window_seconds: secs, reset_after_seconds: 1000, reset_at: resetAt });
const usage = (primary, secondary = null, extra = {}) => ({ plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false, primary_window: primary, secondary_window: secondary, ...extra }, credits: {} });

// fake upstream: usage keyed by the bearer access token, token endpoint pluggable
const usageHits = [], tokenHits = [];
let usageFor = () => ({ status: 200, body: usage(win(3, 604800)) });
let tokenHandler;
const defaultTokenHandler = (reqBody) => ({ status: 200, body: { id_token: jwt({ email: 'a@x.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }), access_token: jwt({ exp: now() + 10 * 86400 }), refresh_token: 'rt-rotated-' + tokenHits.length } });
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const reply = (r) => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body)); };
    if (req.url.startsWith('/usage')) {
      usageHits.push({ headers: req.headers });
      return reply(usageFor(req.headers.authorization.slice(7), req));
    }
    if (req.url.startsWith('/token')) {
      let j = null; try { j = JSON.parse(text); } catch { /* keep null */ }
      tokenHits.push({ headers: req.headers, body: j });
      await new Promise((r) => setTimeout(r, 40));   // widen the window so concurrent callers really overlap
      return reply(await tokenHandler(j));
    }
    res.writeHead(404); res.end();
  });
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const ub = `http://127.0.0.1:${upstream.address().port}`;
  process.env.AIGATE_CODEX_USAGE_URL = ub + '/usage';
  process.env.AIGATE_CODEX_TOKEN_URL = ub + '/token';
});
after(() => {
  server.close();
  upstream.close();
  alertSink.close();
  try { db.close(); } catch { /* already closed */ }
  for (const f of [DB, DB + '-wal', DB + '-shm', DB + '.codex-ledger.json']) { try { rmSync(f); } catch { /* gone */ } }
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  db.exec(`DELETE FROM accounts; DELETE FROM access_log`);
  usageHits.length = 0; tokenHits.length = 0; alertPosts.length = 0;
  usageFor = () => ({ status: 200, body: usage(win(3, 604800)) });
  tokenHandler = defaultTokenHandler;
});

const add = (account, auth, extra = {}) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify({ account, kind: 'codex', auth_json: auth, ...extra }) });
const poll = async (account) => (await fetch(`${base}/api/accounts/${account}/refresh`, { method: 'POST', headers: H })).json();
const select = (qs = '') => fetch(`${base}/api/select${qs}`, { headers: H });
const list = async () => (await fetch(base + '/api/accounts', { headers: H })).json();
const row = (account) => db.prepare('SELECT * FROM accounts WHERE account=?').get(account);
const stored = (account) => JSON.parse(vault.decrypt(row(account).token_enc));
const audit = (action) => db.prepare('SELECT account,result FROM access_log WHERE action=?').all(action).map((r) => ({ ...r }));
const addClaude = (account) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify({ account, setup_token: 'sk-ant-oat01-' + crypto.randomBytes(12).toString('hex') }) });

// ---- import / list ------------------------------------------------------
test('import the real auth.json shape: list shows kind/plan/email, never a token', async () => {
  const a = mkAuth({ email: 'pro@x.test', plan: 'pro', acct: 'acct-1' });
  const r = await add('cx1', a);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, account: 'cx1', kind: 'codex', email: 'pro@x.test', plan: 'pro' });
  const text = JSON.stringify(await list());
  const l = JSON.parse(text).find((x) => x.account === 'cx1');
  assert.equal(l.kind, 'codex'); assert.equal(l.plan, 'pro'); assert.equal(l.label, 'pro@x.test'); assert.equal(l.ext_id, 'acct-1');
  assert.ok(l.token_exp > now());
  assert.ok(!text.includes(a.tokens.access_token) && !text.includes(a.tokens.refresh_token) && !text.includes('token_enc'));
  // at rest it is the canonical auth.json, encrypted
  assert.equal(stored('cx1').tokens.refresh_token, a.tokens.refresh_token);
});

test('import the CLIProxyAPI flat shape (+08:00 stamps normalize to UTC); auth_json may be a JSON string', async () => {
  const a = mkAuth({ email: 'flat@x.test', plan: 'plus', acct: 'acct-flat' });
  const flat = { type: 'codex', access_token: a.tokens.access_token, refresh_token: a.tokens.refresh_token, id_token: a.tokens.id_token,
    account_id: 'acct-flat', email: 'flat@x.test', last_refresh: '2026-10-03T08:45:22+08:00', expired: '2026-10-13T08:45:22+08:00', plan_type: 'plus', disabled: false };
  const r = await add('cx2', JSON.stringify(flat));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).plan, 'plus');
  assert.equal(stored('cx2').last_refresh, '2026-10-03T00:45:22.000Z');
  assert.equal(stored('cx2').tokens.account_id, 'acct-flat');
});

test('kind/credential mismatches are rejected both ways; duplicates and cross-kind overwrites 409', async () => {
  const a = mkAuth();
  const post = (body) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const err = async (r, status, rx) => { assert.equal(r.status, status); assert.match((await r.json()).error, rx); };
  const goodSetup = 'sk-ant-oat01-' + crypto.randomBytes(8).toString('hex');
  // codex slot given a Claude setup_token (auth_json present, so only the setup_token guard can fire)
  await err(await add('bad1', a, { setup_token: goodSetup }), 400, /setup_token is for Claude accounts/);
  // claude slot given an auth_json (valid setup_token present, so the missing-setup_token check cannot fire)
  await err(await post({ account: 'bad2', setup_token: goodSetup, auth_json: a }), 400, /auth_json is for kind=codex accounts/);
  await err(await post({ account: 'bad2b', auth_json: a }), 400, /auth_json is for kind=codex accounts/);
  // codex slot with nothing / claude slot with nothing
  await err(await add('bad2c', ''), 400, /account \+ auth_json required for kind=codex/);
  await err(await post({ account: 'bad2d' }), 400, /account \+ setup_token required/);
  // unknown kind
  await err(await post({ account: 'bad2e', kind: 'gemini', auth_json: a }), 400, /kind must be 'claude' or 'codex'/);
  // name with a slash — on both paths
  await err(await add('bad/3', a), 400, /cannot contain spaces or slashes/);
  await err(await post({ account: 'bad 3', setup_token: goodSetup }), 400, /cannot contain spaces or slashes/);
  // codex payload that parses but lacks a refresh token (access_token present, so only that guard fires)
  await err(await add('bad4', { tokens: { access_token: 'x' } }), 400, /no refresh_token/);
  await err(await add('bad5', '{not json'), 400, /not valid JSON/);
  for (const n of ['bad1', 'bad2', 'bad2b', 'bad/3', 'bad4', 'bad5']) assert.equal(row(n), undefined, n);   // nothing leaked in
  assert.equal((await add('ok1', a)).status, 200);
  await err(await add('ok1-dupe', a), 409, /already vaulted as ok1/);        // same ChatGPT account_id under another name
  assert.equal((await add('ok1', mkAuth({ acct: a.tokens.account_id }))).status, 200);   // overwrite same name is fine
  assert.equal((await addClaude('cl1')).status, 200);
  await err(await add('cl1', mkAuth()), 409, /already exists as a Claude account/);
  await err(await addClaude('ok1'), 409, /already exists as a Codex account/);
});

// ---- kind isolation + ranking --------------------------------------------
test('kind isolation: plain select never returns codex, codex select never returns claude', async () => {
  await add('cxi', mkAuth());
  let r = await select();
  assert.equal(r.status, 503);                                   // only a codex row exists
  await addClaude('cli');
  r = await select();
  const j = await r.json();
  assert.equal(j.account, 'cli'); assert.ok(j.setup_token.startsWith('sk-ant-oat01-')); assert.equal(j.auth_json, undefined);
  const c = await (await select('?kind=codex')).json();
  assert.equal(c.account, 'cxi'); assert.equal(c.kind, 'codex'); assert.ok(c.auth_json.tokens.access_token); assert.equal(c.setup_token, undefined);
  assert.equal((await select('?kind=gemini')).status, 400);
});

test('plain claude select keeps {account, setup_token} and only ADDS usage fields', async () => {
  await addClaude('cl-compat');
  const j = await (await select()).json();
  assert.deepEqual(Object.keys(j).sort(), ['account', 'five_hour_pct', 'five_hour_reset', 'setup_token', 'seven_day_pct', 'seven_day_reset']);
  assert.equal(j.account, 'cl-compat');
});

test('ranking by worst window; ?exclude walks to the next; Pro weekly-only writes five=0', async () => {
  const hi = mkAuth(), lo = mkAuth();
  await add('hi', hi); await add('lo', lo);
  usageFor = (tok) => tok === hi.tokens.access_token
    ? { status: 200, body: usage(win(40, 604800)) }
    : { status: 200, body: usage(win(10, 604800)) };
  await poll('hi'); await poll('lo');
  assert.equal(row('lo').seven_day_pct, 10);
  assert.equal(row('lo').five_hour_pct, 0);                       // no 5h window → explicit 0
  let j = await (await select('?kind=codex')).json();
  assert.equal(j.account, 'lo'); assert.equal(j.seven_day_pct, 10);
  assert.ok(j.seven_day_reset > now());
  j = await (await select('?kind=codex&exclude=lo')).json();
  assert.equal(j.account, 'hi');
  // usage headers the upstream saw
  assert.equal(usageHits[0].headers['chatgpt-account-id'], hi.tokens.account_id);
  assert.match(usageHits[0].headers['user-agent'], /^aigate\/\S+ \(codex-usage\)$/);   // honest UA, no codex impersonation
});

test('a window that disappears is written back as 0, not frozen', async () => {
  const a = mkAuth(); await add('flip', a);
  usageFor = () => ({ status: 200, body: usage(win(60, 18000), win(20, 604800)) });
  await poll('flip');
  assert.equal(row('flip').five_hour_pct, 60);
  usageFor = () => ({ status: 200, body: usage(win(20, 604800)) });
  await poll('flip');
  assert.equal(row('flip').five_hour_pct, 0);
  assert.equal(row('flip').five_hour_reset, null);
});

test('windows map by limit_window_seconds, not primary/secondary: 18000s → five_hour_pct', async () => {
  const a = mkAuth(); await add('five', a);
  // 5h window sits in the SECONDARY slot here on purpose
  usageFor = () => ({ status: 200, body: usage(win(25, 604800), win(55, 18000, 1791000000)) });
  const r = await poll('five');
  assert.equal(r.five, 55); assert.equal(r.seven, 25);
  assert.equal(row('five').five_hour_pct, 55); assert.equal(row('five').seven_day_pct, 25);
  assert.equal(row('five').five_hour_reset, 1791000000);
});

test('reset falls back to now + reset_after_seconds when reset_at is absent', async () => {
  await add('rs', mkAuth());
  usageFor = () => ({ status: 200, body: usage({ used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 3600 }) });
  await poll('rs');
  const d = row('rs').seven_day_reset - now();
  assert.ok(d >= 3598 && d <= 3602, 'reset ≈ now+3600, got ' + d);
});

test('limit_reached → worst window treated as 100 → excluded from select', async () => {
  await add('lim', mkAuth());
  usageFor = () => ({ status: 200, body: usage(win(30, 604800), null, { limit_reached: true, allowed: false }) });
  await poll('lim');
  assert.equal(row('lim').seven_day_pct, 100);
  const r = await select('?kind=codex');
  assert.equal(r.status, 503);
  assert.equal((await r.json()).over_cutoff, 1);
});

// ---- refresh --------------------------------------------------------------
test('usage 401 → one refresh (confirmed body shape) → rotated tokens persisted → retry ok', async () => {
  const a = mkAuth({ expIn: 5 * 86400 }); await add('rot', a);
  let fresh;
  tokenHandler = () => { fresh = { id_token: a.tokens.id_token, access_token: jwt({ exp: now() + 10 * 86400 }), refresh_token: 'rt-NEW' }; return { status: 200, body: fresh }; };
  usageFor = (tok) => tok === a.tokens.access_token ? { status: 401, body: { error: 'expired' } } : { status: 200, body: usage(win(7, 604800)) };
  const r = await poll('rot');
  assert.equal(r.seven, 7);
  assert.equal(tokenHits.length, 1);
  assert.deepEqual(tokenHits[0].body, { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann', grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token });
  assert.match(tokenHits[0].headers['content-type'], /application\/json/);
  const s = stored('rot');
  assert.equal(s.tokens.refresh_token, 'rt-NEW'); assert.equal(s.tokens.access_token, fresh.access_token);
  assert.ok(Date.parse(s.last_refresh) >= Date.now() - 5000);
  assert.ok(row('rot').token_exp > now() + 9 * 86400);
  assert.equal(row('rot').reauth_needed, 0);
});

test('refresh response without refresh_token keeps the old one', async () => {
  const a = mkAuth({ expIn: 3600 }); await add('keeprt', a);
  tokenHandler = () => ({ status: 200, body: { access_token: jwt({ exp: now() + 10 * 86400 }) } });
  const j = await (await select('?kind=codex')).json();
  assert.equal(j.auth_json.tokens.refresh_token, a.tokens.refresh_token);
  assert.equal(j.auth_json.tokens.id_token, a.tokens.id_token);
});

test('invalid_grant → reauth_needed, audited codex-refresh, select 503 afterwards', async () => {
  const a = mkAuth(); await add('dead', a);
  tokenHandler = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'refresh_token_reused' } });
  usageFor = () => ({ status: 401, body: {} });
  const r = await poll('dead');
  assert.equal(r.alive, false);
  assert.equal(row('dead').reauth_needed, 1);
  assert.deepEqual(audit('codex-refresh'), [{ account: 'dead', result: 'invalid_grant' }]);
  assert.equal(stored('dead').tokens.refresh_token, a.tokens.refresh_token);   // state untouched
  assert.equal((await select('?kind=codex')).status, 503);
});

test('5xx from the token endpoint AFTER the send → refresh_unknown, audited once, no second token call', async () => {
  const a = mkAuth(); await add('flaky', a);
  tokenHandler = () => ({ status: 503, body: 'upstream down' });
  usageFor = () => ({ status: 401, body: {} });
  const r = await poll('flaky');
  assert.ok(r.error);
  assert.equal(row('flaky').reauth_needed, 0);
  assert.equal(row('flaky').refresh_unknown, 1);
  assert.equal(stored('flaky').tokens.refresh_token, a.tokens.refresh_token);
  assert.deepEqual(audit('codex-refresh'), [{ account: 'flaky', result: 'unknown — auto-refresh halted' }]);
  assert.equal(tokenHits.length, 1);
  await poll('flaky'); await select('?kind=codex');
  assert.equal(tokenHits.length, 1);                              // halted: the maybe-spent token is not re-spent
  assert.equal(audit('codex-refresh').length, 1);
});

test('abort-after-send (upstream accepts then never answers) → refresh_unknown, no retry; operator force clears it', async () => {
  process.env.AIGATE_CODEX_TOKEN_TIMEOUT_MS = '300';
  try {
    const a = mkAuth({ expIn: 3600 }); await add('hang', a);
    tokenHandler = () => new Promise(() => {});                    // never replies
    const r = await select('?kind=codex');
    assert.equal(r.status, 200);                                   // still-valid access token is handed out
    assert.equal((await r.json()).auth_json.tokens.access_token, a.tokens.access_token);
    assert.equal(row('hang').refresh_unknown, 1);
    assert.equal(tokenHits.length, 1);
    await select('?kind=codex'); await poll('hang');
    assert.equal(tokenHits.length, 1);
    const h = await (await fetch(base + '/health')).json();
    assert.equal(h.codex_refresh_unknown, 1);
    tokenHandler = defaultTokenHandler;
    await fetch(`${base}/api/accounts/hang/refresh?force=1`, { method: 'POST', headers: H });
    assert.equal(row('hang').refresh_unknown, 0);
    assert.equal(tokenHits.length, 2);                             // near expiry → the forced poll refreshed
  } finally { delete process.env.AIGATE_CODEX_TOKEN_TIMEOUT_MS; }
});

test('connection refused (provably before send) → no flag, retried later', async () => {
  const a = mkAuth({ expIn: 3600 }); await add('refused', a);
  const saved = process.env.AIGATE_CODEX_TOKEN_URL;
  const tmp = http.createServer(); await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const deadPort = tmp.address().port; await new Promise((r) => tmp.close(r));   // a port that refuses
  process.env.AIGATE_CODEX_TOKEN_URL = `http://127.0.0.1:${deadPort}/token`;
  try {
    const r = await select('?kind=codex');
    assert.equal(r.status, 200);
    assert.equal(row('refused').refresh_unknown, 0);
    assert.equal(audit('codex-refresh').length, 0);
  } finally { process.env.AIGATE_CODEX_TOKEN_URL = saved; }
  await select('?kind=codex');
  assert.equal(tokenHits.length, 1);                              // next attempt reached the restored upstream
  assert.equal(stored('refused').tokens.refresh_token, 'rt-rotated-1');
});

test('unparseable 200 → refresh_unknown', async () => {
  await add('junk', mkAuth({ expIn: 3600 }));
  tokenHandler = () => ({ status: 200, body: 'not json' });
  await select('?kind=codex');
  assert.equal(row('junk').refresh_unknown, 1);
});

test('refresh_unknown clears on sync apply and on re-add', async () => {
  const a = mkAuth({ expIn: 3600, lastRefresh: iso(now() - 100) }); await add('clr', a);
  db.prepare(`UPDATE accounts SET refresh_unknown=1 WHERE account='clr'`).run();
  const newer = mkAuth({ acct: a.tokens.account_id, refresh: 'rt-newer', lastRefresh: iso(now()) });
  await fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: newer }) });
  assert.equal(row('clr').refresh_unknown, 0);
  db.prepare(`UPDATE accounts SET refresh_unknown=1 WHERE account='clr'`).run();
  await add('clr', newer);
  assert.equal(row('clr').refresh_unknown, 0);
});

test('proactive refresh on select when inside the ahead-window; a far-off exp is NOT refreshed', async () => {
  await add('far', mkAuth({ expIn: 6 * 86400 }));
  await select('?kind=codex');
  assert.equal(tokenHits.length, 0);
  db.exec(`DELETE FROM accounts`);
  const a = mkAuth({ expIn: 3600 }); await add('near', a);
  const j = await (await select('?kind=codex')).json();
  assert.equal(tokenHits.length, 1);
  assert.notEqual(j.auth_json.tokens.access_token, a.tokens.access_token);
  assert.equal(j.auth_json.tokens.refresh_token, 'rt-rotated-1');
  assert.ok(j.token_exp > now() + 9 * 86400);
  // the next select sees the fresh exp and spends nothing
  await select('?kind=codex');
  assert.equal(tokenHits.length, 1);
});

test('a failed early refresh never withholds a still-valid access token', async () => {
  const a = mkAuth({ expIn: 3600 }); await add('early', a);
  tokenHandler = () => ({ status: 503, body: '' });
  const r = await select('?kind=codex');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).auth_json.tokens.access_token, a.tokens.access_token);
});

test('two concurrent selects needing a refresh share exactly ONE token call', async () => {
  await add('conc', mkAuth({ expIn: 600 }));
  const [x, y] = await Promise.all([select('?kind=codex'), select('?kind=codex')]);
  const [jx, jy] = [await x.json(), await y.json()];
  assert.equal(tokenHits.length, 1);
  assert.equal(jx.auth_json.tokens.access_token, jy.auth_json.tokens.access_token);
  assert.equal(jx.auth_json.tokens.refresh_token, 'rt-rotated-1');
});

// ---- sync -----------------------------------------------------------------
test('POST /api/codex/sync: accepts newer rotated login; ignores older, same; 404 for unknown account_id', async () => {
  const t0 = now() - 7200;
  const a = mkAuth({ acct: 'acct-sync', refresh: 'rt0', lastRefresh: iso(t0) }); await add('syn', a);
  const sync = (auth) => fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: auth }) });
  const newer = mkAuth({ acct: 'acct-sync', refresh: 'rt1', lastRefresh: iso(t0 + 3600), expIn: 9 * 86400 });
  let r = await sync(newer);
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.equal(j.applied, true);
  assert.equal(stored('syn').tokens.refresh_token, 'rt1');
  assert.equal(row('syn').token_exp, JSON.parse(Buffer.from(newer.tokens.access_token.split('.')[1], 'base64url')).exp);

  const older = mkAuth({ acct: 'acct-sync', refresh: 'rt-old', lastRefresh: iso(t0 - 3600) });
  j = await (await sync(older)).json();
  assert.equal(j.applied, false); assert.match(j.reason, /not newer/);
  assert.equal(stored('syn').tokens.refresh_token, 'rt1');

  j = await (await sync(newer)).json();                            // identical refresh_token
  assert.equal(j.applied, false); assert.match(j.reason, /same refresh_token/);

  r = await sync(mkAuth({ acct: 'acct-nobody', lastRefresh: iso(now()) }));
  assert.equal(r.status, 404);
  assert.equal(audit('codex-sync').length, 3);                     // applied + older + same (404 has no row to name)
});

test('sync clears a reauth flag (a fresh login heals a dead refresh token)', async () => {
  const t0 = now() - 7200;
  await add('heal', mkAuth({ acct: 'acct-heal', refresh: 'rtA', lastRefresh: iso(t0) }));
  db.prepare(`UPDATE accounts SET reauth_needed=1 WHERE account='heal'`).run();
  await fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: mkAuth({ acct: 'acct-heal', refresh: 'rtB', lastRefresh: iso(now()) }) }) });
  assert.equal(row('heal').reauth_needed, 0);
});

// ---- health / metrics / dry ------------------------------------------------
test('/health: codex counters are separate and `selectable` stays claude-only', async () => {
  await addClaude('hc');
  await add('hx1', mkAuth()); await add('hx2', mkAuth());
  db.prepare(`UPDATE accounts SET reauth_needed=1 WHERE account='hx2'`).run();
  let h = await (await fetch(base + '/health')).json();
  assert.equal(h.accounts, 1); assert.equal(h.selectable, 1); assert.equal(h.reauth, 0);
  assert.equal(h.codex_accounts, 2); assert.equal(h.codex_selectable, 1); assert.equal(h.codex_reauth, 1);
  db.exec(`DELETE FROM accounts WHERE account='hc'`);              // codex still selectable, claude not
  h = await (await fetch(base + '/health')).json();
  assert.equal(h.selectable, 0); assert.equal(h.codex_selectable, 1);
  const m = await (await fetch(base + '/api/metrics', { headers: H })).text();
  assert.match(m, /^aigate_codex_selectable 1$/m);
  assert.match(m, /^aigate_selectable 0$/m);
  // a second, different count — a hardcoded value cannot satisfy both
  await add('hx3', mkAuth()); await add('hx4', mkAuth()); await addClaude('hc2');
  const m2 = await (await fetch(base + '/api/metrics', { headers: H })).text();
  assert.match(m2, /^aigate_codex_selectable 3$/m);
  assert.match(m2, /^aigate_selectable 1$/m);
  h = await (await fetch(base + '/health')).json();
  assert.equal(h.codex_selectable, 3); assert.equal(h.codex_accounts, 4); assert.equal(h.selectable, 1);
});

test('?dry=1 returns the would-be pick without any token and audits select-dry, never select', async () => {
  const a = mkAuth({ expIn: 3600 }); await add('dry1', a);   // inside the 2-day refresh window: a non-dry select WOULD refresh
  await addClaude('dry-cl');
  const rc = await select('?kind=codex&dry=1');
  const txt = await rc.text();
  const j = JSON.parse(txt);
  assert.equal(j.account, 'dry1'); assert.equal(j.dry, true); assert.ok('seven_day_pct' in j);
  assert.ok(!txt.includes(a.tokens.access_token) && !txt.includes(a.tokens.refresh_token) && !txt.includes('auth_json'));
  const cl = await (await select('?dry=1')).json();
  assert.equal(cl.account, 'dry-cl'); assert.equal(cl.setup_token, undefined);
  assert.equal(audit('select').length, 0);
  assert.equal(audit('select-dry').length, 2);
  assert.equal(tokenHits.length, 0);                              // dry never refreshes either
  assert.equal(stored('dry1').tokens.refresh_token, a.tokens.refresh_token);
  assert.equal((await select('?kind=codex&dry=1&exclude=dry1')).status, 503);
  // control: the same near-expiry fixture DOES hit the token endpoint on a real select, so the 0 above means something
  assert.equal((await select('?kind=codex')).status, 200);
  assert.equal(tokenHits.length, 1);
});

test('/api/events/limit parks a codex row by name and select skips it', async () => {
  await add('pk1', mkAuth()); await add('pk2', mkAuth());
  const r = await fetch(base + '/api/events/limit', { method: 'POST', headers: H, body: JSON.stringify({ account: 'pk1', minutes: 30 }) });
  assert.equal(r.status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await (await select('?kind=codex')).json()).account, 'pk2');
});

test('poison codex ciphertext is parked and the next account is served', async () => {
  await add('poison', mkAuth());
  await add('good', mkAuth());
  db.prepare(`UPDATE accounts SET token_enc='AAAA' WHERE account='poison'`).run();
  db.prepare(`UPDATE accounts SET seven_day_pct=0, usage_updated=datetime('now') WHERE account='poison'`).run();
  const j = await (await select('?kind=codex')).json();
  assert.equal(j.account, 'good');
  assert.ok(row('poison').parked_until);
});

// ---- disabled / reauth rows are never refreshed ---------------------------------
test('poller: disabled and reauth rows make no token call; usage polls cannot clear reauth; sync does', async () => {
  await add('dis', mkAuth({ expIn: 600 })); await add('rea', mkAuth({ expIn: 600 }));
  db.prepare(`UPDATE accounts SET disabled=1 WHERE account='dis'`).run();
  db.prepare(`UPDATE accounts SET reauth_needed=1 WHERE account='rea'`).run();
  usageFor = () => ({ status: 200, body: usage(win(3, 604800)) });
  for (const n of ['dis', 'rea']) { await poll(n); await poll(n); }
  assert.equal(tokenHits.length, 0);
  assert.equal(row('rea').reauth_needed, 1);                      // even a good usage read never clears it
  usageFor = () => ({ status: 401, body: {} });
  await poll('dis'); await poll('rea');
  assert.equal(tokenHits.length, 0);
  assert.equal(row('rea').reauth_needed, 1);
  const cur = stored('rea');
  await fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: mkAuth({ acct: cur.tokens.account_id, expIn: 600, refresh: 'rt-x', lastRefresh: iso(now() + 5) }) }) });
  assert.equal(row('rea').reauth_needed, 0);
});

test('invalid_grant is spent once: later polls of the reauth row never touch the token endpoint again', async () => {
  await add('edge', mkAuth());
  tokenHandler = () => ({ status: 400, body: { error: 'invalid_grant' } });
  usageFor = () => ({ status: 401, body: {} });
  await poll('edge'); await poll('edge'); await poll('edge');
  assert.equal(tokenHits.length, 1);
  assert.equal(audit('codex-refresh').length, 1);                 // audited (and alerted) on the 0→1 edge only
});

// ---- races ---------------------------------------------------------------------
test('select awaits an in-flight refresh (never the pre-rotation token); rename/overwrite 409 meanwhile', async () => {
  const a = mkAuth({ expIn: 600 }); await add('race', a);
  usageFor = (tok) => tok === a.tokens.access_token ? { status: 401, body: {} } : { status: 200, body: usage(win(3, 604800)) };
  const pollP = poll('race');                                     // starts a refresh (40ms upstream delay)
  await new Promise((r) => setTimeout(r, 15));
  const rn = await fetch(base + '/api/accounts/race', { method: 'PATCH', headers: H, body: JSON.stringify({ account: 'race2' }) });
  assert.equal(rn.status, 409);
  assert.equal((await add('race', mkAuth({ acct: a.tokens.account_id }))).status, 409);
  const j = await (await select('?kind=codex')).json();
  assert.notEqual(j.auth_json.tokens.access_token, a.tokens.access_token);
  assert.equal(j.auth_json.tokens.refresh_token, 'rt-rotated-1');
  await pollP;
  assert.equal(tokenHits.length, 1);
});

test('rotated token whose row vanished mid-refresh (0 rows changed) is flagged, not silently lost', async () => {
  await add('gone', mkAuth({ expIn: 600 }));
  tokenHandler = (b) => { db.exec(`DELETE FROM accounts WHERE account='gone'`); return defaultTokenHandler(b); };
  await select('?kind=codex');
  assert.equal(audit('codex-refresh').some((x) => x.result.startsWith('unknown')), true);
});

// ---- GET /api/codex/auth (keeper) ------------------------------------------------
test('GET /api/codex/auth: 200 with the vault auth.json, never refreshes even near expiry, audited codex-keep without secrets', async () => {
  const a = mkAuth({ expIn: 600 }); await add('keep', a);
  const r = await fetch(`${base}/api/codex/auth?account_id=${a.tokens.account_id}&host=mbp`, { headers: H });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.account, 'keep'); assert.equal(j.kind, 'codex');
  assert.deepEqual(j.auth_json, stored('keep'));
  assert.equal(j.last_refresh, a.last_refresh);
  assert.equal(j.token_exp, row('keep').token_exp);
  assert.equal(j.reauth_needed, 0); assert.equal(j.disabled, 0);
  assert.equal(tokenHits.length, 0);                              // near expiry, still no token call
  assert.deepEqual(audit('codex-keep'), [{ account: 'keep', result: 'ok' }]);
  const dump = JSON.stringify(db.prepare('SELECT * FROM access_log').all());
  assert.ok(!dump.includes(a.tokens.refresh_token) && !dump.includes(a.tokens.access_token));
  db.prepare(`UPDATE accounts SET reauth_needed=1, disabled=1 WHERE account='keep'`).run();
  const j2 = await (await fetch(`${base}/api/codex/auth?account_id=${a.tokens.account_id}`, { headers: H })).json();
  assert.equal(j2.reauth_needed, 1); assert.equal(j2.disabled, 1);   // reports, never parks or picks
  assert.equal(tokenHits.length, 0);
  assert.equal(row('keep').parked_until, null);
});

test('GET /api/codex/auth: 404 for unknown account_id (audited), 401 without bearer', async () => {
  const r = await fetch(`${base}/api/codex/auth?account_id=nope`, { headers: H });
  assert.equal(r.status, 404);
  assert.deepEqual(audit('codex-keep'), [{ account: null, result: '404' }]);
  assert.equal((await fetch(`${base}/api/codex/auth?account_id=nope`)).status, 401);
});

// ---- /health separation + durability + UA ---------------------------------------
test('/health: poll_age_s ignores codex rows; codex_poll_age_s covers them', async () => {
  await addClaude('hcl'); await add('hcx', mkAuth());
  db.prepare(`UPDATE accounts SET usage_updated=datetime('now','-1 hour') WHERE account='hcl'`).run();
  db.prepare(`UPDATE accounts SET usage_updated=datetime('now') WHERE account='hcx'`).run();
  const h = await (await fetch(base + '/health')).json();
  assert.ok(h.poll_age_s >= 3500);
  assert.ok(h.codex_poll_age_s <= 5);
});

test('credential writes restore synchronous=NORMAL afterwards', async () => {
  await add('dur', mkAuth({ expIn: 600 }));
  await select('?kind=codex');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);   // 1 = NORMAL
});

// ---- reauth alert is edge-triggered ------------------------------------------------
test('codex reauth alert is edge-triggered: two consecutive failing polls → exactly one webhook POST', async () => {
  await add('edge', mkAuth());
  tokenHandler = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'refresh_token_reused' } });
  usageFor = () => ({ status: 401, body: {} });
  const waitFor = async (n) => { for (let i = 0; i < 50 && alertPosts.length < n; i++) await new Promise((r) => setTimeout(r, 40)); };
  await poll('edge');
  await waitFor(1);
  assert.equal(row('edge').reauth_needed, 1);
  assert.equal(alertPosts.length, 1);
  assert.match(alertPosts[0].text, /codex account edge/);
  assert.equal(alertPosts[0].account, 'edge');
  await poll('edge');                                              // still failing
  await new Promise((r) => setTimeout(r, 300));                    // give a (wrong) second POST time to land
  assert.equal(alertPosts.length, 1);
  assert.equal(tokenHits.length, 1);                               // and the dead token was never spent twice
});

// ---- N2/N3/N4/N5 hardening -----------------------------------------------------
const ledgerFile = () => JSON.parse(readFileSync(DB + '.codex-ledger.json', 'utf8'));

test('default refresh-ahead window is 4 days: exp in 3d refreshes, exp in 5d does not', async () => {
  await add('d5', mkAuth({ expIn: 5 * 86400 }));
  await select('?kind=codex');
  assert.equal(tokenHits.length, 0);
  db.exec(`DELETE FROM accounts`);
  await add('d3', mkAuth({ expIn: 3 * 86400 }));
  await select('?kind=codex');
  assert.equal(tokenHits.length, 1);
});

test('ledger: written (0600, fingerprint not token) on add, refresh and sync; never inside backups/', async () => {
  const a = mkAuth({ expIn: 3600, lastRefresh: iso(now() - 100) }); await add('led', a);
  let l = ledgerFile();
  assert.deepEqual(l[a.tokens.account_id], { last_refresh: a.last_refresh, rt_hash: rtHash(a.tokens.refresh_token) });
  assert.equal(statSync(DB + '.codex-ledger.json').mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(l).includes(a.tokens.refresh_token));
  await select('?kind=codex');                                    // near expiry → rotates
  l = ledgerFile();
  assert.equal(l[a.tokens.account_id].rt_hash, rtHash('rt-rotated-1'));
  const newer = mkAuth({ acct: a.tokens.account_id, refresh: 'rt-synced', lastRefresh: iso(now() + 5) });
  await fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: newer }) });
  assert.equal(ledgerFile()[a.tokens.account_id].rt_hash, rtHash('rt-synced'));
  assert.equal(existsSync(join(DB, '..', 'backups', 'codex-ledger.json')), false);
});

// stub only the token-endpoint fetch so we can throw the exact errno undici would
async function withTokenFetchError(code, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = (u, ...rest) => {
    if (String(u).includes('/token')) { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error(code), { code }); return Promise.reject(e); }
    return real(u, ...rest);
  };
  try { await fn(); } finally { globalThis.fetch = real; }
}
for (const code of ['ENETUNREACH', 'EHOSTUNREACH']) {
  test(`${code} is provably before-send: no refresh_unknown, token kept`, async () => {
    await add('unr', mkAuth({ expIn: 3600 }));
    await withTokenFetchError(code, async () => { await select('?kind=codex'); });
    assert.equal(row('unr').refresh_unknown, 0);
    assert.equal(audit('codex-refresh').length, 0);
  });
}
test('ECONNRESET is NOT provably before-send: stays refresh_unknown', async () => {
  await add('rst', mkAuth({ expIn: 3600 }));
  await withTokenFetchError('ECONNRESET', async () => { await select('?kind=codex'); });
  assert.equal(row('rst').refresh_unknown, 1);
});

test('DELETE /api/accounts/:name is 409 while a refresh for it is in flight, 200 after', async () => {
  const a = mkAuth({ expIn: 600 }); await add('deli', a);
  usageFor = (tok) => tok === a.tokens.access_token ? { status: 401, body: {} } : { status: 200, body: usage(win(3, 604800)) };
  const pollP = poll('deli');
  await new Promise((r) => setTimeout(r, 15));
  const d = await fetch(base + '/api/accounts/deli', { method: 'DELETE', headers: H });
  assert.equal(d.status, 409);
  assert.ok(row('deli'));
  await pollP;
  assert.equal((await fetch(base + '/api/accounts/deli', { method: 'DELETE', headers: H })).status, 200);
});

test('refresh_unknown / reauth_needed flag writes run under synchronous=FULL, then NORMAL again', async () => {
  const calls = [];
  const realExec = db.exec.bind(db);
  db.exec = (sql) => { calls.push(sql); return realExec(sql); };
  try {
    await add('fl1', mkAuth({ expIn: 3600 }));
    tokenHandler = () => ({ status: 503, body: '' });
    calls.length = 0; await select('?kind=codex');                // 5xx → markRefreshUnknown (no persist)
    assert.equal(row('fl1').refresh_unknown, 1);
    assert.ok(calls.includes('PRAGMA synchronous=FULL'), 'refresh_unknown write must be FULL-sync');
    await add('fl2', mkAuth({ expIn: 3600 }));
    tokenHandler = () => ({ status: 400, body: '{"error":"invalid_grant"}' });
    calls.length = 0; await select('?kind=codex&exclude=fl1');
    assert.equal(row('fl2').reauth_needed, 1);
    assert.ok(calls.includes('PRAGMA synchronous=FULL'), 'reauth_needed write must be FULL-sync');
    await add('fl3', mkAuth({ expIn: 6 * 86400 }));               // far from expiry: the force poll refreshes nothing, so FULL can only come from the clear
    db.prepare(`UPDATE accounts SET refresh_unknown=1 WHERE account='fl3'`).run();
    calls.length = 0;
    await fetch(`${base}/api/accounts/fl3/refresh?force=1`, { method: 'POST', headers: H });
    assert.equal(row('fl3').refresh_unknown, 0);
    assert.ok(calls.includes('PRAGMA synchronous=FULL'), 'force-clear must be FULL-sync');
  } finally { db.exec = realExec; }
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
});
