import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// Isolate this run onto a throwaway DB + token BEFORE importing server.js.
// process.env takes precedence over any repo .env (Node does not override
// already-set vars), so this never touches real data.
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const DB = join(tmpdir(), `aigate-test-${process.pid}-${Date.now()}.db`);
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;

const { server, db } = await import('../src/server.js');
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* already closed */ }
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
});

test('GET / serves the dashboard', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('GET /api/accounts without token → 401', async () => {
  assert.equal((await fetch(base + '/api/accounts')).status, 401);
});

test('GET /api/accounts with token → 200 empty array (fresh DB sanity)', async () => {
  const r = await fetch(base + '/api/accounts', { headers: H });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), []);
});

test('GET /api/select with no accounts → 503', async () => {
  assert.equal((await fetch(base + '/api/select?host=t', { headers: H })).status, 503);
});

test('POST /api/accounts stores an account; secret never leaks in the list', async () => {
  const r = await fetch(base + '/api/accounts', {
    method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', setup_token: 'sk-secret-xyz', label: 'primary' }),
  });
  assert.equal(r.status, 200);
  const list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].account, 'alice');
  assert.equal(list[0].has_token, 1);
  assert.ok(!JSON.stringify(list).includes('sk-secret-xyz'));
});

test('GET /api/select returns the decrypted token for the picked account', async () => {
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'alice');
  assert.equal(j.setup_token, 'sk-secret-xyz');   // round-trips through the AES-GCM vault
});

test('POST /api/accounts requires account + setup_token', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify({ account: 'x' }) });
  assert.equal(r.status, 400);
});

test('POST /api/keys stores a provider key; list returns hint but not the secret', async () => {
  const r = await fetch(base + '/api/keys', {
    method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'openai', key: 'sk-proj-supersecretkey123', label: 'main' }),
  });
  assert.equal(r.status, 200);
  const keys = await (await fetch(base + '/api/keys', { headers: H })).json();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].provider, 'openai');
  assert.ok(keys[0].key_hint);
  assert.ok(!JSON.stringify(keys).includes('supersecretkey'));
});

test('/api/select skips a needs-reauth account and hands back a live one', async () => {
  // alice (live) already exists. Add bob, then flag alice's token dead.
  await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'bob', setup_token: 'sk-bob-live' }) });
  db.prepare('UPDATE accounts SET reauth_needed=1 WHERE account=?').run('alice');
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'bob');             // never serves alice's dead token
  assert.equal(j.setup_token, 'sk-bob-live');
});

test('/api/select → 503 when every account needs reauth', async () => {
  db.prepare('UPDATE accounts SET reauth_needed=1').run();
  assert.equal((await fetch(base + '/api/select?host=t', { headers: H })).status, 503);
  db.prepare('UPDATE accounts SET reauth_needed=0').run();   // restore for later assertions
});

test('listAccounts exposes reauth_needed for the dashboard badge', async () => {
  db.prepare('UPDATE accounts SET reauth_needed=1 WHERE account=?').run('alice');
  const list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  assert.equal(list.find((a) => a.account === 'alice').reauth_needed, 1);
  assert.equal(list.find((a) => a.account === 'bob').reauth_needed, 0);
});

test('unknown API route → 404', async () => {
  assert.equal((await fetch(base + '/api/nope', { headers: H })).status, 404);
});

test('bad JSON body is tolerated, not fatal', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H, body: '{not json' });
  assert.equal(r.status, 400);   // parsed as {} → missing fields → 400, no crash
});
