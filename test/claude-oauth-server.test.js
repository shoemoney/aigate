import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVault } from '../src/lib.js';

const dir = mkdtempSync(join(tmpdir(), 'aigate-claude-oauth-'));
const key = crypto.randomBytes(32).toString('hex');
Object.assign(process.env, {
  AIGATE_TOKEN: 'test-token-claude-oauth-only', AIGATE_ENCRYPTION_KEY: key,
  AIGATE_DB: join(dir, 'test.db'), AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0',
  AIGATE_ALERT_WEBHOOK: '', HOST: '127.0.0.1',
});
const { server, db, tickClaudeOauth } = await import('../src/server.js');
const vault = makeVault(Buffer.from(key, 'hex'));
const headers = { authorization: `Bearer ${process.env.AIGATE_TOKEN}`, 'content-type': 'application/json' };
let base, hits = [], handler;
const output = [];
const realWarn = console.warn, realError = console.error;
console.warn = (...args) => output.push(args.join(' '));
console.error = (...args) => output.push(args.join(' '));
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const hit = { method: req.method, headers: req.headers, body: JSON.parse(raw) };
  hits.push(hit);
  const reply = await handler(hit);
  if (reply.drop) { req.socket.destroy(); return; }
  res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
  res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
});
const scopes = ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:plugins', 'user:file_upload', 'user:privacy_consents:write'];
const login = (extra = {}) => ({ accessToken: 'test-claude-access-original', refreshToken: 'test-claude-refresh-original', expiresAt: Date.now() + 9 * 3600000, refreshTokenExpiresAt: Date.now() + 27 * 86400000, scopes, subscriptionType: 'max', accountUuid: 'account-id', organizationUuid: 'org-id', ...extra });
const row = (name = 'one') => db.prepare('SELECT * FROM accounts WHERE account=?').get(name);
const stored = (name) => JSON.parse(vault.decrypt(row(name).oauth_enc));
const request = (path, method = 'GET', data) => fetch(base + path, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
const add = (data = {}) => request('/api/accounts', 'POST', { account: 'one', setup_token: 'sk-ant-oat01-test-setup', ...data });
const select = (suffix = '') => request('/api/select' + suffix);
before(async () => {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  process.env.AIGATE_CLAUDE_OAUTH_TOKEN_URL = `http://127.0.0.1:${upstream.address().port}/token`;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  db.exec('DELETE FROM accounts; DELETE FROM access_log'); hits = []; output.length = 0;
  delete process.env.AIGATE_CLAUDE_OAUTH_REFRESH_AHEAD_S;
  delete process.env.AIGATE_CLAUDE_OAUTH_CLIENT_ID;
  handler = () => ({ body: { access_token: 'test-claude-access-rotated', refresh_token: 'test-claude-refresh-rotated', expires_in: 31320, refresh_token_expires_in: 27 * 86400, scope: scopes.join(' ') } });
});
after(() => { console.warn = realWarn; console.error = realError; server.close(); upstream.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('intake accepts object, credentials wrapper and JSON string; existing setup token is optional', async () => {
  assert.equal((await add()).status, 200);
  const setup = row().token_enc;
  for (const oauth_json of [login(), { claudeAiOauth: login(), mcpOAuth: { secret: 'never-import-mcp' } }, JSON.stringify(login())]) {
    const r = await request('/api/accounts', 'POST', { account: 'one', oauth_json });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.deepEqual(stored(), login({ expiresAt: stored().expiresAt, refreshTokenExpiresAt: stored().refreshTokenExpiresAt }));
    assert.equal(row().token_enc, setup);
    assert.ok(!vault.decrypt(row().oauth_enc).includes('never-import-mcp'));
  }
  const r = await add({ account: 'new', oauth_json: login() });
  assert.equal(r.status, 200); assert.equal(stored('new').accessToken, login().accessToken);
  assert.equal(row('new').oauth_reauth_needed, 0);
});

test('invalid intake rejects missing tokens, bad expiry, scopes, JSON and Codex oauth_json without echoing input', async () => {
  for (const oauth_json of [null, [], 'broken', {}, login({ accessToken: '' }), login({ refreshToken: ' ' }), login({ expiresAt: '123' }), login({ expiresAt: 0 }), login({ expiresAt: null }), login({ scopes: 'scope' }), login({ refreshTokenExpiresAt: -1 })]) {
    const r = await add({ oauth_json }); assert.equal(r.status, 400);
    assert.ok(!(await r.text()).includes(login().refreshToken)); assert.equal(row(), undefined);
  }
  assert.equal((await add({ kind: 'codex', oauth_json: login() })).status, 400);
  assert.equal((await request('/api/accounts', 'POST', { account: 'one', oauth_json: login() })).status, 400);
});

test('PATCH imports and heals full-login health without changing setup-token flags or ciphertext', async () => {
  await add(); const setup = row().token_enc;
  db.exec("UPDATE accounts SET reauth_needed=1,oauth_reauth_needed=1,oauth_refresh_unknown=1 WHERE account='one'");
  const r = await request('/api/accounts/one', 'PATCH', { oauth_json: { claudeAiOauth: login() } });
  assert.equal(r.status, 200); assert.equal(row().reauth_needed, 1);
  assert.equal(row().oauth_reauth_needed, 0); assert.equal(row().oauth_refresh_unknown, 0); assert.equal(row().token_enc, setup);
  db.prepare("UPDATE accounts SET kind='codex' WHERE account='one'").run();
  assert.equal((await request('/api/accounts/one', 'PATCH', { oauth_json: login() })).status, 400);
});

test('normal select is unchanged; full select adds only access token, expiry and scopes; dry never refreshes', async () => {
  const auth = login(); await add({ oauth_json: auth });
  const normal = { account: 'one', setup_token: 'sk-ant-oat01-test-setup', five_hour_pct: 0, seven_day_pct: 0, five_hour_reset: null, seven_day_reset: null };
  assert.deepEqual(await (await select()).json(), normal);
  assert.deepEqual(await (await select('?full=1')).json(), { ...normal, oauth_access_token: auth.accessToken, oauth_expires_at: auth.expiresAt, oauth_scopes: scopes });
  db.exec("UPDATE accounts SET oauth_expires_at=1 WHERE account='one'");
  const dry = await (await select('?full=1&dry=1')).json();
  assert.equal(dry.dry, true); assert.equal(dry.oauth_access_token, undefined); assert.equal(dry.setup_token, undefined); assert.equal(hits.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action='select-dry'").get().n, 1);
  assert.equal((await select('?kind=codex&full=1')).status, 400);
});

test('full login missing uses same ranked pick and setup token with a reason; excludes and parking still apply', async () => {
  await add(); await add({ account: 'two', oauth_json: login() });
  db.exec("UPDATE accounts SET seven_day_pct=1 WHERE account='two'");
  const j = await (await select('?full=1')).json(); assert.equal(j.account, 'one'); assert.equal(j.full_unavailable, 'not_present'); assert.ok(j.setup_token);
  assert.equal((await (await select('?full=1&exclude=one')).json()).account, 'two');
  db.exec("UPDATE accounts SET parked_until=datetime('now','+1 hour') WHERE account='two'");
  assert.equal((await select('?full=1&exclude=one')).status, 503);
});

test('near-expiry refresh is single-flight, request matches binary, rotated login is durable before handout', async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3600000 }) });
  let release, enter;
  const entered = new Promise((r) => { enter = r; }); const released = new Promise((r) => { release = r; });
  const defaultHandler = handler;
  handler = async (hit) => { assert.equal(row().oauth_refresh_unknown, 1); enter(); await released; return defaultHandler(hit); };
  const a = select('?full=1'); await entered;
  const b = select('?full=1');
  for (const [path, method, data] of [['/api/accounts/one', 'DELETE'], ['/api/accounts/one', 'PATCH', { account: 'renamed' }], ['/api/accounts/one', 'PATCH', { oauth_json: login() }], ['/api/accounts', 'POST', { account: 'one', setup_token: 'new' }]])
    assert.equal((await request(path, method, data)).status, 409);
  release();
  for (const r of await Promise.all([a, b])) {
    assert.equal(r.status, 200); const j = await r.json();
    assert.equal(j.oauth_access_token, stored().accessToken); assert.equal(stored().refreshToken, 'test-claude-refresh-rotated');
    assert.equal(row().oauth_refresh_unknown, 0); assert.ok(j.oauth_expires_at > Date.now() + 8 * 3600000);
  }
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, 'POST'); assert.equal(hits[0].headers['content-type'], 'application/json');
  assert.deepEqual(hits[0].body, { grant_type: 'refresh_token', refresh_token: login().refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: scopes.join(' ') });
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
  await select('?full=1'); assert.equal(hits.length, 1);
});

for (const status of [400, 401]) test(`${status} invalid_grant affects full login only and never retries`, async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3600000 }) }); const setup = row().token_enc;
  handler = () => ({ status, body: { error: 'invalid_grant', error_description: login().refreshToken } });
  for (let i = 0; i < 3; i++) assert.equal((await (await select('?full=1')).json()).full_unavailable, 'needs_reauth');
  await tickClaudeOauth(); assert.equal(hits.length, 1); assert.equal(row().reauth_needed, 0); assert.equal(row().oauth_reauth_needed, 1); assert.equal(row().token_enc, setup);
  assert.ok((await (await select()).json()).setup_token);
});

for (const reply of [{ status: 503, body: 'outage' }, { status: 200, body: 'bad JSON' }, { status: 200, body: { access_token: 'incomplete' } }, { drop: true }]) test(`uncertain ${JSON.stringify(reply)} halts refresh until reimport`, async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3600000 }) }); handler = () => reply;
  assert.equal((await (await select('?full=1')).json()).full_unavailable, 'refresh_unknown');
  await select('?full=1'); await tickClaudeOauth(); assert.equal(hits.length, 1);
  assert.equal(row().oauth_refresh_unknown, 1); assert.equal(row().reauth_needed, 0);
  assert.equal((await request('/api/accounts/one', 'PATCH', { oauth_json: login() })).status, 200);
  assert.ok((await (await select('?full=1')).json()).oauth_access_token);
});

test('maintenance refreshes idle login at least daily, including parked and disabled accounts; threshold configurable', async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3 * 86400000 }) });
  await tickClaudeOauth(); assert.equal(hits.length, 0);
  db.exec("UPDATE accounts SET disabled=1,parked_until=datetime('now','+1 day'),oauth_refreshed_at=1 WHERE account='one'");
  await tickClaudeOauth(); assert.equal(hits.length, 1);
  assert.equal(stored().refreshToken, 'test-claude-refresh-rotated');
  await tickClaudeOauth(); assert.equal(hits.length, 1);
  db.exec("UPDATE accounts SET disabled=0,parked_until=NULL WHERE account='one'");
  process.env.AIGATE_CLAUDE_OAUTH_REFRESH_AHEAD_S = '40000';
  process.env.AIGATE_CLAUDE_OAUTH_CLIENT_ID = 'custom-client';
  await select('?full=1'); assert.equal(hits.length, 2); assert.equal(hits[1].body.client_id, 'custom-client');
});

test('expired refresh token needs reauth without a request; metadata reports independent full-login health', async () => {
  await add({ oauth_json: login({ expiresAt: 1, refreshTokenExpiresAt: 1 }) });
  assert.equal((await (await select('?full=1')).json()).full_unavailable, 'needs_reauth'); assert.equal(hits.length, 0);
  for (const path of ['/api/accounts', '/api/usage/claude']) {
    const [j] = await (await request(path)).json();
    assert.equal(j.has_full_login, 1); assert.equal(j.oauth_expires_at, 1); assert.equal(j.oauth_reauth_needed, 1); assert.equal(j.oauth_refresh_unknown, 0);
    if (j.status) assert.equal(j.status, 'ok');
  }
});

test('responses, access logs, broadcasts metadata and console output never contain refresh tokens', async () => {
  const auth = login({ expiresAt: Date.now() + 3600000 }); await add({ oauth_json: auth });
  const texts = [];
  for (const path of ['/api/select', '/api/select?full=1', '/api/accounts', '/api/usage', '/api/access']) texts.push(await (await request(path)).text());
  texts.push(JSON.stringify(db.prepare('SELECT * FROM access_log').all()), ...output);
  for (const text of texts) {
    assert.ok(!text.includes(auth.refreshToken)); assert.ok(!text.includes('test-claude-refresh-rotated'));
    assert.ok(!text.includes('refreshToken')); assert.ok(!text.includes('oauth_enc'));
  }
});

test('before-send failure permits retry; crash-pending state blocks refresh', async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3600000 }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...args) => {
    if (String(url) === process.env.AIGATE_CLAUDE_OAUTH_TOKEN_URL)
      return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    return realFetch(url, ...args);
  };
  try { assert.equal((await (await select('?full=1')).json()).full_unavailable, 'refresh_unreachable'); }
  finally { globalThis.fetch = realFetch; }
  assert.equal(row().oauth_refresh_unknown, 0);
  assert.ok((await (await select('?full=1')).json()).oauth_access_token); assert.equal(hits.length, 1);
  db.exec("UPDATE accounts SET oauth_refresh_unknown=1,oauth_expires_at=1 WHERE account='one'");
  assert.equal((await (await select('?full=1')).json()).full_unavailable, 'refresh_unknown');
  await tickClaudeOauth(); assert.equal(hits.length, 1);
});

test('failed persistence never hands out rotated access and leaves refresh halted', async () => {
  await add({ oauth_json: login({ expiresAt: Date.now() + 3600000 }) });
  db.exec("CREATE TEMP TRIGGER fail_oauth_write BEFORE UPDATE OF oauth_enc ON accounts BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  try {
    const j = await (await select('?full=1')).json();
    assert.equal(j.full_unavailable, 'refresh_unknown'); assert.equal(j.oauth_access_token, undefined);
    assert.equal(row().oauth_refresh_unknown, 1); assert.equal(stored().refreshToken, login().refreshToken);
    await select('?full=1'); await tickClaudeOauth(); assert.equal(hits.length, 1);
  } finally { db.exec('DROP TRIGGER fail_oauth_write'); }
});

test('key rotation includes full-login ciphertext in the vault transaction', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { spawnSync } = await import('node:child_process');
  const file = join(dir, 'rotate.db'), fixture = new DatabaseSync(file);
  const nextKey = crypto.randomBytes(32).toString('hex');
  fixture.exec('CREATE TABLE accounts(account TEXT,token_enc TEXT,oauth_enc TEXT); CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); CREATE TABLE provider_keys(id INTEGER,key_enc TEXT)');
  fixture.prepare('INSERT INTO accounts VALUES(?,?,?)').run('one', vault.encrypt('setup'), vault.encrypt(JSON.stringify(login())));
  const result = spawnSync(process.execPath, ['scripts/rotate-key.js', nextKey], { env: { ...process.env, AIGATE_DB: file }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const rotated = fixture.prepare('SELECT * FROM accounts').get();
  assert.equal(JSON.parse(makeVault(Buffer.from(nextKey, 'hex')).decrypt(rotated.oauth_enc)).refreshToken, login().refreshToken);
  assert.throws(() => vault.decrypt(rotated.oauth_enc));
  fixture.close();
});
