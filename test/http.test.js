import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, statSync } from 'node:fs';
import WebSocket from 'ws';

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

const { server, db, backupNow } = await import('../src/server.js');
const BACKUPS = join(tmpdir(), 'backups');   // dirname(DB)/backups
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
  rmSync(BACKUPS, { recursive: true, force: true });
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

test('boot canary: meta.canary row written on first boot (encryption-key guard)', () => {
  const row = db.prepare(`SELECT v FROM meta WHERE k='canary'`).get();
  assert.ok(row && row.v);
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

test('key_hint = first8…last4: same-prefix keys coexist, exact re-POST still upserts', async () => {
  const post = (key) => fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'collideco', key }) });
  await post('sk-proj-collide-AAAA');   // shares first 14 chars with the next key…
  await post('sk-proj-collide-BBBB');
  await post('sk-proj-collide-BBBB');   // exact duplicate → upsert, not a third row
  const hints = (await (await fetch(base + '/api/keys', { headers: H })).json())
    .filter((k) => k.provider === 'collideco').map((k) => k.key_hint).sort();
  assert.deepEqual(hints, ['sk-proj-…AAAA', 'sk-proj-…BBBB']);   // both survive
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

test('/api/select?exclude= skips the excluded account (retry path)', async () => {
  // both alice & bob live; alice has lower usage so is picked by default.
  db.prepare('UPDATE accounts SET five_hour_pct=1,seven_day_pct=1,disabled=0,reauth_needed=0 WHERE account=?').run('alice');
  db.prepare('UPDATE accounts SET five_hour_pct=5,seven_day_pct=5,disabled=0,reauth_needed=0 WHERE account=?').run('bob');
  let j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'alice');                        // best headroom
  j = await (await fetch(base + '/api/select?host=t&exclude=alice', { headers: H })).json();
  assert.equal(j.account, 'bob');                          // retry skips alice
  const r = await fetch(base + '/api/select?host=t&exclude=alice,bob', { headers: H });
  assert.equal(r.status, 503);                             // nothing left
});

test('POST /api/events/limit parks an account (skipped on select) WITHOUT clobbering its usage', async () => {
  db.prepare("UPDATE accounts SET five_hour_pct=1,seven_day_pct=1,parked_until=NULL,usage_updated=datetime('now') WHERE account=?").run('alice');
  db.prepare("UPDATE accounts SET five_hour_pct=5,seven_day_pct=5,parked_until=NULL,usage_updated=datetime('now') WHERE account=?").run('bob');
  await fetch(base + '/api/events/limit', { method: 'POST', headers: H, body: JSON.stringify({ account: 'alice' }) });
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'bob');                          // alice parked → skipped
  const a = (await (await fetch(base + '/api/accounts', { headers: H })).json()).find((x) => x.account === 'alice');
  assert.equal(a.five_hour_pct, 1);                        // real usage preserved, NOT clobbered to 100
  assert.ok(a.parked_until);                               // parked timestamp set
});

test('parked state is visible: computed flag, parked_until echo, reasoned 503', async () => {
  // alice is still parked from the previous test; park bob too → ALL accounts parked
  const r = await (await fetch(base + '/api/events/limit', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'bob' }) })).json();
  assert.ok(r.parked_until);                               // limit response echoes the actual expiry
  let list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  assert.equal(list.find((a) => a.account === 'bob').parked, 1);   // plain 0/1, no string parsing
  const s = await fetch(base + '/api/select?host=t', { headers: H });
  assert.equal(s.status, 503);
  const j = await s.json();
  assert.equal(j.accounts, list.length);                   // reasoned 503 counts every account
  assert.ok(j.parked >= 1);
  db.prepare('UPDATE accounts SET parked_until=NULL WHERE account=?').run('bob');
  list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  assert.equal(list.find((a) => a.account === 'bob').parked, 0);   // flag clears with the timestamp
});

test('POST /api/events/usage + /limit for an unknown account → 404, not silent ok', async () => {
  for (const ev of ['usage', 'limit']) {
    const r = await fetch(base + `/api/events/${ev}`, { method: 'POST', headers: H,
      body: JSON.stringify({ account: 'ghost', five_hour_pct: 9 }) });
    assert.equal(r.status, 404, ev);
    assert.match((await r.json()).error, /unknown account ghost/);
  }
});

test('POST /api/events/prompt truncates stored prompt to 400 chars', async () => {
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt: 'x'.repeat(1000) }) });
  const [row] = await (await fetch(base + '/api/logs?limit=1', { headers: H })).json();
  assert.ok(row.prompt.length <= 400);
});

test('POST /api/events/prompt scrubs pasted secrets; git SHAs survive', async () => {
  const log1 = async () => (await (await fetch(base + '/api/logs?limit=1', { headers: H })).json())[0];
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt: 'please vault sk-ant-oat01-ABCDEFGHIJKLMNOP' }) });
  let row = await log1();
  assert.ok(row.prompt.includes('sk-ant-o…[redacted]'));
  assert.ok(!row.prompt.includes('sk-ant-oat01-ABCDEFGHIJKLMNOP'));
  const sha = 'deadbeef'.repeat(5);                          // 40-char git SHA, not a secret
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt: 'revert commit ' + sha }) });
  row = await log1();
  assert.equal(row.prompt, 'revert commit ' + sha);          // untouched
});

test('/health selectable counts parked accounts as unusable (matches /api/select)', async () => {
  // alice is still parked from the previous test; park bob too → nothing servable
  await fetch(base + '/api/events/limit', { method: 'POST', headers: H, body: JSON.stringify({ account: 'bob' }) });
  assert.equal((await (await fetch(base + '/health')).json()).selectable, 0);
});

test('unpolled account (usage_updated NULL) sorts LAST, not as a phantom 0%', async () => {
  db.prepare("UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=3,seven_day_pct=3,usage_updated=datetime('now') WHERE account=?").run('bob');
  db.prepare('UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=0,seven_day_pct=0,usage_updated=NULL WHERE account=?').run('alice');
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'bob');                          // polled bob (3%) beats unpolled alice despite alice's raw 0
});

test('/api/select skips an account at/over the headroom cutoff (default 95)', async () => {
  db.prepare("UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=99,seven_day_pct=1,usage_updated=datetime('now') WHERE account=?").run('alice');
  db.prepare("UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=5,seven_day_pct=5,usage_updated=datetime('now') WHERE account=?").run('bob');
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'bob');                          // alice at 99% ≥ cutoff → skipped
});

test('/api/select auto-recovers an account whose parked_until has passed', async () => {
  db.prepare("UPDATE accounts SET five_hour_pct=1,seven_day_pct=1,parked_until=datetime('now','-1 minute'),usage_updated=datetime('now') WHERE account=?").run('alice');
  const j = await (await fetch(base + '/api/select?host=t', { headers: H })).json();
  assert.equal(j.account, 'alice');                        // park expired → back in rotation, best headroom
  db.prepare('UPDATE accounts SET parked_until=NULL WHERE account=?').run('alice');   // reset for later tests
});

test('listAccounts exposes reauth_needed for the dashboard badge', async () => {
  db.prepare('UPDATE accounts SET reauth_needed=1 WHERE account=?').run('alice');
  const list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  assert.equal(list.find((a) => a.account === 'alice').reauth_needed, 1);
  assert.equal(list.find((a) => a.account === 'bob').reauth_needed, 0);
});

test('/health is unauthenticated and reports db-backed status', async () => {
  const r = await fetch(base + '/health');          // deliberately no bearer
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.uptime_s, 'number');
  assert.equal(j.accounts, 2);                       // alice + bob
  assert.equal(typeof j.selectable, 'number');
});

test('/health selectable drops to 0 when no account is usable', async () => {
  db.prepare('UPDATE accounts SET disabled=1').run();
  assert.equal((await (await fetch(base + '/health')).json()).selectable, 0);
  db.prepare('UPDATE accounts SET disabled=0').run();
});

test('GET /api/providers returns the catalog (>=50, well-formed)', async () => {
  const r = await fetch(base + '/api/providers', { headers: H });
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.ok(list.length >= 50, `expected >=50 providers, got ${list.length}`);
  for (const p of list) { assert.ok(p.id && p.name && p.cat); }   // no half-filled rows
  assert.ok(list.some((p) => p.id === 'openai') && list.some((p) => p.id === 'groq'));
});

test('GET /api/keys/:provider returns the decrypted key for the newest working one', async () => {
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'openai', key: 'sk-newest-openai-key', label: 'v2' }) });
  const j = await (await fetch(base + '/api/keys/openai', { headers: H })).json();
  assert.equal(j.provider, 'openai');
  assert.equal(j.key, 'sk-newest-openai-key');   // decrypts + picks newest
});

test('GET /api/keys/:provider → 404 for a provider with no key', async () => {
  assert.equal((await fetch(base + '/api/keys/nonesuch', { headers: H })).status, 404);
});

test('POST /api/keys strips one layer of surrounding quotes — round-trips the raw value', async () => {
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'groq', key: '"gsk_quoted-paste-1234"' }) });
  const j = await (await fetch(base + '/api/keys/groq', { headers: H })).json();
  assert.equal(j.key, 'gsk_quoted-paste-1234');   // quotes stripped before vaulting
});

test('POST /api/keys rejects export/NAME= pastes → 400', async () => {
  const r = await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'openai', key: 'export FOO=abc' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /malformed/);
});

test('POST /api/keys with an uncataloged provider → 200 with a non-fatal warning', async () => {
  const r = await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'nonesuchco', key: 'nk-abc123' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.warning, /unknown provider nonesuchco/);
});

test('GET /api/keys/:provider normalizes case/whitespace — BRAVE%20 finds brave', async () => {
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'brave', key: 'BSA-abc123' }) });
  const j = await (await fetch(base + '/api/keys/BRAVE%20', { headers: H })).json();
  assert.equal(j.provider, 'brave');
  assert.equal(j.key, 'BSA-abc123');
});

test('unknown API route → 404', async () => {
  assert.equal((await fetch(base + '/api/nope', { headers: H })).status, 404);
});

test('bad JSON body is tolerated, not fatal', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H, body: '{not json' });
  assert.equal(r.status, 400);   // parsed as {} → missing fields → 400, no crash
});

test("backupNow() snapshots the vault to today's file; second call is a no-op", () => {
  backupNow();
  const f = join(BACKUPS, `aigate-${new Date().toISOString().slice(0, 10)}.db`);
  assert.ok(existsSync(f));
  backupNow();                   // already exists → skip, no throw
  assert.ok(existsSync(f));
});

test('backups are private: dir 0700, snapshot file 0600', () => {
  const f = join(BACKUPS, `aigate-${new Date().toISOString().slice(0, 10)}.db`);
  assert.equal(statSync(BACKUPS).mode & 0o777, 0o700);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

const wsFirstMsg = (path, protocols) => new Promise((resolve, reject) => {
  const ws = new WebSocket(base.replace('http', 'ws') + path, protocols);
  ws.on('message', (d) => { ws.close(); resolve(JSON.parse(d)); });
  ws.on('error', reject);
});

test('WS auth via bearer.<token> subprotocol — no token in the URL', async () => {
  const m = await wsFirstMsg('/ws', ['aigate', 'bearer.' + TOKEN]);
  assert.equal(m.type, 'accounts');
});

test('WS with no auth is destroyed before any message', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    ws.on('message', () => reject(new Error('unauthenticated socket got data')));
    ws.on('error', resolve);
    ws.on('close', resolve);
  });
});

test('legacy WS ?token= query auth still works (deprecated fallback)', async () => {
  const m = await wsFirstMsg('/ws?token=' + TOKEN);
  assert.equal(m.type, 'accounts');
});

test('daemon survives an abrupt WS client death; broadcast still reaches a healthy client', async () => {
  const wsUrl = base.replace('http', 'ws') + '/ws';
  const dead = new WebSocket(wsUrl, ['aigate', 'bearer.' + TOKEN]);
  await new Promise((r) => dead.once('message', r));         // fully established
  dead._socket.resetAndDestroy();                            // RST, no close frame — the sleeping-laptop failure
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(base + '/health')).status, 200); // server-side 'error' didn't bounce the daemon
  const live = new WebSocket(wsUrl, ['aigate', 'bearer.' + TOKEN]);
  await new Promise((r) => live.once('message', r));
  const got = new Promise((r) => live.once('message', (d) => r(JSON.parse(d))));
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt: 'still broadcasting' }) });
  assert.equal((await got).type, 'prompt');
  live.close();
});

test('POST /api/accounts/:name/refresh — fetch-mocked poll drives usage, maxed, and the reauth round-trip', async () => {
  // URL-routing mock: anthropic.com gets the canned response, everything else
  // (this suite's own 127.0.0.1 calls) delegates to the real fetch.
  const realFetch = globalThis.fetch;
  let next;
  const canned = (status, u5, u7) => new Response('{}', { status, headers: u5 == null ? {} : {
    'anthropic-ratelimit-unified-5h-utilization': u5, 'anthropic-ratelimit-unified-7d-utilization': u7 } });
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('https://api.anthropic.com') ? Promise.resolve(next) : realFetch(url, opts);
  const refresh = async (name) => (await realFetch(base + `/api/accounts/${name}/refresh`, { method: 'POST', headers: H })).json();
  const acct = async (name) => (await (await realFetch(base + '/api/accounts', { headers: H })).json()).find((a) => a.account === name);
  try {
    db.prepare("UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=50,seven_day_pct=50,usage_updated=datetime('now')").run();

    next = canned(200, '0.42', '0.10');                    // (a) headers land in the row, under cutoff
    let r = await refresh('bob');
    assert.deepEqual([r.five, r.seven, r.maxed], [42, 10, 0]);
    const b = await acct('bob');
    assert.equal(b.five_hour_pct, 42);
    assert.equal(b.seven_day_pct, 10);

    next = canned(200, '0.99', '0.99');                    // (b) over the 95 cutoff → maxed
    assert.equal((await refresh('bob')).maxed, 1);

    db.prepare('UPDATE accounts SET five_hour_pct=5,seven_day_pct=5 WHERE account=?').run('bob');
    next = canned(401);                                    // (c) dead token → reauth flag, select skips
    r = await refresh('bob');
    assert.equal(r.alive, false);
    assert.equal((await acct('bob')).reauth_needed, 1);
    let j = await (await realFetch(base + '/api/select?host=t', { headers: H })).json();
    assert.equal(j.account, 'alice');                      // bob (5%) would win were it not flagged

    next = canned(200, '0.05', '0.05');                    // (d) good poll → flag clears, selectable again
    r = await refresh('bob');
    assert.equal(r.alive, true);
    assert.equal((await acct('bob')).reauth_needed, 0);
    j = await (await realFetch(base + '/api/select?host=t', { headers: H })).json();
    assert.equal(j.account, 'bob');
  } finally { globalThis.fetch = realFetch; }
});

test('POST /api/accounts rejects the browser Authentication Code (code#state) paste → 400', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'carol', setup_token: 'abc#def-state' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Authentication Code/);
});

test('POST /api/accounts trims a trailing newline; select returns the TRIMMED token', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'carol', setup_token: 'sk-ant-oat01-goodtoken\n' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).warning, undefined);         // sk-ant- prefix → no warning
  const j = await (await fetch(base + '/api/select?host=t&exclude=alice,bob', { headers: H })).json();
  assert.equal(j.account, 'carol');
  assert.equal(j.setup_token, 'sk-ant-oat01-goodtoken');     // newline gone before vaulting
});

test('POST /api/accounts with a non-sk-ant token → 200 + non-fatal warning', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'carol', setup_token: 'weird-token' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.match(j.warning, /doesn't look like a setup token/);
});
