import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'node:net';
import WebSocket from 'ws';

// Isolate this run onto a throwaway DB + token BEFORE importing server.js.
// process.env takes precedence over any repo .env (Node does not override
// already-set vars), so this never touches real data.
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const DASH_PW = 'master-' + crypto.randomBytes(6).toString('hex');
const DB = join(tmpdir(), `aigate-test-${process.pid}-${Date.now()}.db`);
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_DASHBOARD_PASSWORD = DASH_PW;
process.env.AIGATE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;

const { server, db, backupNow, openDb, isWeakToken, pollProviderKeys, authFail, authLocked, authOk, shortHost } = await import('../src/server.js');
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

test('GET /api/accounts without token → 401 with JSON body', async () => {
  const r = await fetch(base + '/api/accounts');
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'unauthorized' });
});

test('?token= query auth is dead — header-only → 401', async () => {
  assert.equal((await fetch(base + `/api/accounts?token=${TOKEN}`)).status, 401);
});

test('dashboard master password: login → session cookie authorizes the browser', async () => {
  // wrong password → 401 (and counts toward the brute-force lockout)
  let r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'wrong password' });

  // correct password → 200 + an HttpOnly SameSite session cookie
  r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: DASH_PW }) });
  assert.equal(r.status, 200);
  const setc = r.headers.get('set-cookie');
  assert.match(setc, /aigate_sess=\d+\.[a-f0-9]{64}/);
  assert.match(setc, /HttpOnly/i);
  assert.match(setc, /SameSite=Strict/i);
  const cookie = setc.split(';')[0];   // aigate_sess=<val>

  // the cookie alone (NO bearer) now authorizes an API call
  r = await fetch(base + '/api/accounts', { headers: { cookie } });
  assert.equal(r.status, 200);

  // a forged/garbage cookie does NOT
  r = await fetch(base + '/api/accounts', { headers: { cookie: 'aigate_sess=9999999999999.' + 'f'.repeat(64) } });
  assert.equal(r.status, 401);

  // logout clears the cookie (Max-Age=0)
  r = await fetch(base + '/api/logout', { method: 'POST' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /aigate_sess=;[^]*Max-Age=0/i);

  authOk('::ffff:127.0.0.1'); authOk('127.0.0.1');   // clear the one bad-password fail we just logged
});

test('GET // (a directory) → 404, not a hang', async () => {
  assert.equal((await fetch(base + '//')).status, 404);
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

test('isWeakToken: true for empty / the placeholder / under-16-char, false for a strong token', () => {
  for (const w of ['', 'short', 'a'.repeat(15), 'change-me-to-a-long-random-string'])
    assert.equal(isWeakToken(w), true, JSON.stringify(w));
  assert.equal(isWeakToken('a'.repeat(16)), false);
  assert.equal(isWeakToken(TOKEN), false);   // the suite's own >16-char token boots the guard past
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
  assert.equal(hints.length, 2);
  assert.ok(hints[0].includes('AAAA') && hints[1].includes('BBBB'), `expected AAAA+BBBB hints got ${hints}`);
  assert.notEqual(hints[0], hints[1]);
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

test('shortHost: strips everything after the first dot, empty/undefined-safe', () => {
  assert.equal(shortHost('mbp.shoemoney.ai'), 'mbp');
  assert.equal(shortHost('mbp'), 'mbp');
  assert.equal(shortHost(''), '');
  assert.equal(shortHost(undefined), '');
});

test('POST /api/events/prompt stores an FQDN host as the short name', async () => {
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', host: 'mbp.shoemoney.ai', prompt: 'host normalize check' }) });
  const [row] = await (await fetch(base + '/api/logs?limit=1', { headers: H })).json();
  assert.equal(row.host, 'mbp');
});

test('POST /api/events/prompt truncates stored prompt to 400 chars', async () => {
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt: 'x'.repeat(1000) }) });
  const [row] = await (await fetch(base + '/api/logs?limit=1', { headers: H })).json();
  assert.equal(row.prompt.length, 400);
});

test('negative ?limit is clamped, not unbounded (SQLite reads LIMIT -1 as ALL)', async () => {
  for (let i = 0; i < 3; i++)                                  // seed a few request_log rows
    await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
      body: JSON.stringify({ account: 'alice', prompt: 'seed ' + i }) });
  const logs = await (await fetch(base + '/api/logs?limit=-1', { headers: H })).json();
  const access = await (await fetch(base + '/api/access?limit=-1', { headers: H })).json();
  assert.equal(logs.length, 1, 'logs limit -1 clamped to 1');
  assert.equal(access.length, 1, 'access limit -1 clamped to 1');
  // limit 0 must clamp to 1 per [1,1000] contract (Number("0")||100 bug → 100)
  const logs0 = await (await fetch(base + '/api/logs?limit=0', { headers: H })).json();
  const access0 = await (await fetch(base + '/api/access?limit=0', { headers: H })).json();
  assert.equal(logs0.length, 1, 'logs limit 0 clamped to 1');
  assert.equal(access0.length, 1, 'access limit 0 clamped to 1');
});

test('POST /api/events/prompt round-trips a multibyte UTF-8 prompt (no mojibake)', async () => {
  // body() now collects Buffers and decodes ONCE — a per-chunk toString() would split an
  // emoji/CJK UTF-8 sequence across TCP boundaries into replacement chars. Can't force a
  // chunk split in-process, but proving the emoji survives a normal POST exercises the
  // decode-once path this fix restores.
  const prompt = '🛡️ café 日本語';
  await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'alice', prompt }) });
  const [row] = await (await fetch(base + '/api/logs?limit=1', { headers: H })).json();
  assert.equal(row.prompt, prompt);                 // byte-for-byte, no U+FFFD replacement chars
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

test('re-adding a token clears reauth_needed (recovery flow) → account selectable again', async () => {
  const add = (setup_token) => fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'recov', setup_token }) });
  await add('sk-ant-oat01-recov-old');
  db.prepare('UPDATE accounts SET reauth_needed=1 WHERE account=?').run('recov');   // poller 401'd it
  await add('sk-ant-oat01-recov-new');                        // setup-token recovery: re-POST a fresh token
  assert.equal(db.prepare('SELECT reauth_needed FROM accounts WHERE account=?').get('recov').reauth_needed, 0);
  // and it's servable NOW (not after a poll cycle): exclude every other account so recov is the only candidate
  const others = (await (await fetch(base + '/api/accounts', { headers: H })).json())
    .map((a) => a.account).filter((a) => a !== 'recov');
  const j = await (await fetch(base + `/api/select?host=t&exclude=${others.join(',')}`, { headers: H })).json();
  assert.equal(j.account, 'recov');
  assert.equal(j.setup_token, 'sk-ant-oat01-recov-new');     // fresh token, not the dead one
  db.prepare('DELETE FROM accounts WHERE account=?').run('recov');   // keep shared state (alice+bob) intact
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

test('POST /api/keys coerces a mistyped status to working; disabled shelves the key', async () => {
  // a status typo must NOT silently hide the key — coerced to 'working' so the fetch path still finds it
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'typoco', key: 'tk-typo-status-1234', status: 'workign' }) });
  const j = await (await fetch(base + '/api/keys/typoco', { headers: H })).json();
  assert.equal(j.key, 'tk-typo-status-1234');                // 'workign' → 'working', getKeyByProvider returns it
  // 'disabled' is the ONE legit non-working value — deliberately shelved, not served
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'shelfco', key: 'dk-shelf-key-5678', status: 'disabled' }) });
  assert.equal((await fetch(base + '/api/keys/shelfco', { headers: H })).status, 404);
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

test('backup snapshot is atomic and intact: 0600, no .tmp sibling, quick_check ok', () => {
  backupNow();
  const f = join(BACKUPS, `aigate-${new Date().toISOString().slice(0, 10)}.db`);
  assert.ok(existsSync(f));
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.ok(!existsSync(f + '.tmp'));
  const snap = new DatabaseSync(f, { readOnly: true });
  assert.equal(snap.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  snap.close();
});

test('backups are private: dir 0700, snapshot file 0600', () => {
  const f = join(BACKUPS, `aigate-${new Date().toISOString().slice(0, 10)}.db`);
  assert.equal(statSync(BACKUPS).mode & 0o777, 0o700);
  assert.equal(statSync(f).mode & 0o777, 0o600);
});

test('openDb: corrupt DB is quarantined and auto-restored from the newest backup', () => {
  // plant a marker-carrying backup that sorts newest, so a passing assert
  // proves THIS file (not luck) was restored
  mkdirSync(BACKUPS, { recursive: true });
  const bak = join(BACKUPS, 'aigate-2099-01-01.db');
  const src = new DatabaseSync(bak);
  src.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
            INSERT INTO meta(k,v) VALUES('restore-marker','yes')`);
  src.close();
  const CORRUPT = join(tmpdir(), `aigate-corrupt-${process.pid}-${Date.now()}.db`);
  writeFileSync(CORRUPT, 'definitely not a sqlite database — hard power-off garbage');
  const d = openDb(CORRUPT);
  try {
    assert.equal(d.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(d.prepare(`SELECT v FROM meta WHERE k='restore-marker'`).get().v, 'yes');
    const quarantined = readdirSync(tmpdir()).filter((f) => f.startsWith(CORRUPT.split('/').pop() + '.corrupt-'));
    assert.ok(quarantined.length >= 1, 'no .corrupt-* quarantine file');
  } finally {
    d.close();
    for (const f of readdirSync(tmpdir()))
      if (f.startsWith(CORRUPT.split('/').pop())) rmSync(join(tmpdir(), f), { force: true });
    rmSync(bak, { force: true });
  }
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

test('WS auth via session cookie — the master-password browser has no in-page token', async () => {
  const lr = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: DASH_PW }) });
  const cookie = lr.headers.get('set-cookie').split(';')[0];
  const m = await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', ['aigate'], { headers: { cookie } });
    ws.on('message', (d) => { ws.close(); resolve(JSON.parse(d)); });
    ws.on('error', reject);
  });
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

test('WS ?token= query auth is dead — socket destroyed', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws?token=' + TOKEN);
    ws.on('message', () => reject(new Error('?token= socket got data')));
    ws.on('error', resolve);
    ws.on('close', resolve);
  });
});
test('network gate: disallowed XFF IP → 403 forbidden (network), allowed IP passes (HTTP)', async () => {
  const prevCidr = process.env.AIGATE_ALLOW_CIDR;
  const prevTrust = process.env.AIGATE_TRUST_PROXY;
  process.env.AIGATE_ALLOW_CIDR = '10.0.0.0/24';
  process.env.AIGATE_TRUST_PROXY = '1';
  try {
    // disallowed external IP via trusted XFF → 403 with exact JSON shape (gate fires before auth)
    let r = await fetch(base + '/health', { headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden (network)' });
    // also on an authed route — gate still wins over 401
    r = await fetch(base + '/api/accounts', { headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden (network)' });
    // allowed IP in the CIDR → passes through (200 on /health)
    r = await fetch(base + '/health', { headers: { 'x-forwarded-for': '10.0.0.5' } });
    assert.equal(r.status, 200);
    // loopback with no XFF → still allowed (loopback is always allowed)
    r = await fetch(base + '/health');
    assert.equal(r.status, 200);
  } finally {
    if (prevCidr === undefined) delete process.env.AIGATE_ALLOW_CIDR; else process.env.AIGATE_ALLOW_CIDR = prevCidr;
    if (prevTrust === undefined) delete process.env.AIGATE_TRUST_PROXY; else process.env.AIGATE_TRUST_PROXY = prevTrust;
  }
});

test('network gate: WS with disallowed XFF IP is destroyed before any message (403 gate)', async () => {
  const prevCidr = process.env.AIGATE_ALLOW_CIDR;
  const prevTrust = process.env.AIGATE_TRUST_PROXY;
  process.env.AIGATE_ALLOW_CIDR = '10.0.0.0/24';
  process.env.AIGATE_TRUST_PROXY = '1';
  try {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws', ['aigate', 'bearer.' + TOKEN], { headers: { 'x-forwarded-for': '203.0.113.5' } });
      ws.on('message', () => reject(new Error('disallowed WS got data (gate did not fire)')));
      ws.on('error', resolve);
      ws.on('close', resolve);
      setTimeout(() => reject(new Error('WS disallowed timeout — gate did not destroy socket')), 1500);
    });
    // allowed IP still gets through
    const m = await wsFirstMsg('/ws', ['aigate', 'bearer.' + TOKEN]);
    // need XFF allowed header for this connection too — but remote loopback without XFF is already allowed, so default works
    assert.equal(m.type, 'accounts');
  } finally {
    if (prevCidr === undefined) delete process.env.AIGATE_ALLOW_CIDR; else process.env.AIGATE_ALLOW_CIDR = prevCidr;
    if (prevTrust === undefined) delete process.env.AIGATE_TRUST_PROXY; else process.env.AIGATE_TRUST_PROXY = prevTrust;
  }
});

test('malformed WS upgrade target ("//") is destroyed pre-auth — daemon survives', async () => {
  // ws-the-library validates URLs client-side, so hand-roll the frame: '//' parses
  // as a request-target but makes the listener's new URL() throw (protocol-relative)
  const sock = connect(server.address().port, '127.0.0.1');
  sock.on('error', () => {});                                  // RST on destroy is expected
  await new Promise((r) => sock.once('connect', r));
  sock.write('GET // HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await fetch(base + '/health')).status, 200);   // unguarded parse would have shutdown(1)'d
  sock.destroy();
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

test('POST /api/accounts/:name/refresh — poll failure → 502 with error, usage untouched', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('https://api.anthropic.com') ? Promise.reject(new Error('anthropic unreachable')) : realFetch(url, opts);
  try {
    db.prepare('UPDATE accounts SET five_hour_pct=42,seven_day_pct=10 WHERE account=?').run('bob');
    const r = await realFetch(base + '/api/accounts/bob/refresh', { method: 'POST', headers: H });
    assert.equal(r.status, 502);                             // NOT 200 {alive:true,maxed:0}
    assert.match((await r.json()).error, /unreachable/);
    const b = (await (await realFetch(base + '/api/accounts', { headers: H })).json()).find((a) => a.account === 'bob');
    assert.equal(b.five_hour_pct, 42);                       // poller stays authoritative
  } finally { globalThis.fetch = realFetch; }
});

test('GET a missing file under public/ → 404 (static branch falls through, never hangs)', async () => {
  assert.equal((await fetch(base + '/nope-does-not-exist.html')).status, 404);
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

test('audit trail: every mutation lands in access_log with an ip, never a secret', async () => {
  db.prepare('DELETE FROM access_log').run();
  const post = (path, b) => fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(b) });
  await post('/api/accounts', { account: 'gaunt', setup_token: 'sk-ant-oat01-gauntsecret', label: 'g1' });
  await post('/api/accounts', { account: 'gaunt', setup_token: 'sk-ant-oat01-gauntsecret2', label: 'g2' });   // overwrite
  await post('/api/accounts/gaunt/disabled', { disabled: true });
  await post('/api/accounts/gaunt/disabled', { disabled: false });
  await post('/api/keys', { provider: 'gauntco', key: 'gk-gaunt-key-9999' });
  await fetch(base + '/api/keys/gauntco', { headers: H });                                    // secret fetch
  const keyId = (await (await fetch(base + '/api/keys', { headers: H })).json()).find((k) => k.provider === 'gauntco').id;
  assert.equal((await fetch(base + `/api/keys/${keyId}`, { method: 'DELETE', headers: H })).status, 200);
  assert.equal((await fetch(base + '/api/accounts/gaunt', { method: 'DELETE', headers: H })).status, 200);
  await fetch(base + '/api/select?host=t', { headers: H });                                   // ok OR none — both audited
  const rows = db.prepare('SELECT action,ip FROM access_log').all();
  for (const a of ['account-add', 'account-overwrite', 'account-disable', 'account-enable',
    'key-add', 'key', 'key-delete', 'account-delete', 'select'])
    assert.ok(rows.some((r) => r.action === a), 'missing action ' + a);
  for (const r of rows) assert.ok(r.ip, 'empty ip on ' + r.action);
  assert.ok(!JSON.stringify(rows).includes('sk-'));                                          // trail never holds secrets
});

test('DELETE with a bogus key id / account name → 404, not silent ok', async () => {
  assert.equal((await fetch(base + '/api/keys/999999', { method: 'DELETE', headers: H })).status, 404);
  assert.equal((await fetch(base + '/api/keys/abc', { method: 'DELETE', headers: H })).status, 404);   // Number→NaN
  assert.equal((await fetch(base + '/api/accounts/ghost', { method: 'DELETE', headers: H })).status, 404);
});

test('GET /api/access exposes the audit trail (key-add present, never a raw secret)', async () => {
  db.prepare('DELETE FROM access_log').run();
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'accessco', key: 'xk-access-topsecret-1234' }) });   // non-sk so the hint carries no 'sk-'
  const rows = await (await fetch(base + '/api/access', { headers: H })).json();
  assert.ok(rows.some((r) => r.action === 'key-add'), 'key-add row present');
  assert.ok(!JSON.stringify(rows).includes('sk-'));
  assert.ok(!JSON.stringify(rows).includes('topsecret'));   // only the first8…last4 hint is stored, never the value
});

test('reasoned select-503 writes WHY into the audit result', async () => {
  db.prepare('DELETE FROM access_log').run();
  db.prepare("UPDATE accounts SET disabled=1,reauth_needed=0,parked_until=NULL").run();
  assert.equal((await fetch(base + '/api/select?host=t', { headers: H })).status, 503);
  const sel = (await (await fetch(base + '/api/access', { headers: H })).json()).find((r) => r.action === 'select');
  assert.ok(sel, 'select row present');
  assert.ok(sel.result.includes('none-available'));
  assert.match(sel.result, /parked|re-auth|off/);   // the reason, not a bare 'none-available'
  db.prepare('UPDATE accounts SET disabled=0').run();   // restore for later assertions
});

test('listAccounts exposes usage_age_s: numeric for a polled account, null for never-polled', async () => {
  db.prepare("UPDATE accounts SET usage_updated=datetime('now') WHERE account=?").run('alice');
  db.prepare('UPDATE accounts SET usage_updated=NULL WHERE account=?').run('bob');
  const list = await (await fetch(base + '/api/accounts', { headers: H })).json();
  const alice = list.find((a) => a.account === 'alice');
  assert.equal(typeof alice.usage_age_s, 'number');
  assert.ok(alice.usage_age_s >= 0);
  assert.equal(list.find((a) => a.account === 'bob').usage_age_s, null);
});

test('/health includes poll_age_s, backup_age_s, and the unusable tally', async () => {
  backupNow();   // guarantee a backup file exists so backup_age_s is a number, not null
  const j = await (await fetch(base + '/health')).json();
  assert.equal(j.ok, true);
  for (const k of ['poll_age_s', 'backup_age_s', 'parked', 'reauth', 'disabled'])
    assert.ok(k in j, 'missing ' + k);
  assert.equal(typeof j.backup_age_s, 'number');
});

test('GET /api/capabilities is a read-only registry slice: counts + selectability, never a secret', async () => {
  // dedicated provider so keys===1 is exact — 'openai' already accumulated multiple keys upstream
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'capco', key: 'sk-cap-test-key-value', label: 'cap' }) });
  const j = await (await fetch(base + '/api/capabilities', { headers: H })).json();
  assert.equal(j.providers.capco.keys, 1);
  assert.equal(typeof j.claude.selectable, 'number');
  assert.equal(typeof j.claude.accounts, 'number');
  const blob = JSON.stringify(j);
  assert.ok(!blob.includes('sk-'), 'capability map leaked a secret');   // counts only, never the key value
});

test('GET /api/capabilities exposes the server version matching package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const j = await (await fetch(base + '/api/capabilities', { headers: H })).json();
  assert.equal(typeof j.version, 'string');
  assert.equal(j.version, pkg.version);
});

test('listKeys surfaces last_used per provider: non-null after a key-fetch, null for an untouched provider', async () => {
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'fal', key: 'fal-lastused-test-key' }) });
  await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'untouchedco', key: 'uk-never-fetched-key' }) });   // vaulted but never GET'd
  await fetch(base + '/api/keys/fal', { headers: H });                  // logs a key-fetch (action='key', account='fal')
  const keys = await (await fetch(base + '/api/keys', { headers: H })).json();
  assert.ok(keys.find((k) => k.provider === 'fal').last_used, 'fetched provider has a last_used ts');
  assert.equal(keys.find((k) => k.provider === 'untouchedco').last_used, null);   // never fetched → null
});

test('GET /api/select skips a poison (undecryptable) account, parks it, and hands out the next good one — never 500s (bug B1)', async () => {
  // pre-existing selectable accounts get excluded so only our two candidates remain
  const before = await (await fetch(base + '/api/accounts', { headers: H })).json();
  const excl = before.map((a) => a.account).join(',');
  // poison: valid-looking row but token_enc is not decryptable; ranked FIRST (usage set, low)
  db.prepare(`INSERT INTO accounts(account,token_enc,five_hour_pct,seven_day_pct,usage_updated)
    VALUES('poisonsel','@@not-base64-ciphertext@@',1,1,datetime('now'))`).run();
  await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'goodsel', setup_token: 'sk-ant-oat01-goodtok' }) });
  try {
    const r = await fetch(base + `/api/select?exclude=${encodeURIComponent(excl)}`, { headers: H });
    assert.equal(r.status, 200);                       // NOT 500
    assert.equal((await r.json()).account, 'goodsel'); // skipped poison, served the good one
    // poison is now parked so pickRanked won't re-elect it next call
    const poison = (await (await fetch(base + '/api/accounts', { headers: H })).json()).find((a) => a.account === 'poisonsel');
    assert.equal(poison.parked, 1);
    // and the fault is audited
    const access = await (await fetch(base + '/api/access?limit=50', { headers: H })).json();
    assert.ok(access.some((a) => a.account === 'poisonsel' && /decrypt-fail/.test(a.result)));
  } finally {
    db.prepare(`DELETE FROM accounts WHERE account IN ('poisonsel','goodsel')`).run();
  }
});

test('GET /api/keys/:provider on an undecryptable key → 500 {decrypt failed} + audited, no "ok" row (bug B2)', async () => {
  db.prepare(`INSERT INTO provider_keys(provider,key_enc,key_hint,status)
    VALUES('poisonprov','@@not-base64-ciphertext@@','poi…son','working')`).run();
  try {
    const r = await fetch(base + '/api/keys/poisonprov', { headers: H });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'decrypt failed' });
    const access = await (await fetch(base + '/api/access?limit=50', { headers: H })).json();
    const rows = access.filter((a) => a.account === 'poisonprov' && a.action === 'key');
    assert.ok(rows.some((a) => a.result === 'decrypt-fail'), 'fault audited');
    assert.ok(!rows.some((a) => a.result === 'ok'), 'no lying "ok" handout row');
  } finally {
    db.prepare(`DELETE FROM provider_keys WHERE provider='poisonprov'`).run();
  }
});

test('POST /api/accounts rejects a name containing a slash (path-safety, bug B11)', async () => {
  const r = await fetch(base + '/api/accounts', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'a/b', setup_token: 'sk-ant-oat01-x' }) });
  assert.equal(r.status, 400);
});
test('POST /api/accounts/:name/disabled on an unknown account → 404, not a silent ok (bug B11)', async () => {
  const r = await fetch(base + '/api/accounts/nope-not-here/disabled', { method: 'POST', headers: H,
    body: JSON.stringify({ disabled: 1 }) });
  assert.equal(r.status, 404);
});
test('PATCH /api/accounts/:name — rename keeps label + token, label-only keeps name', async () => {
  // dedicated accounts (ren-*) so the shared alice/bob state stays untouched
  const post = (b) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify(b) });
  const patch = (name, b) => fetch(base + `/api/accounts/${name}`, { method: 'PATCH', headers: H, body: JSON.stringify(b) });
  const acct = async (name) => (await (await fetch(base + '/api/accounts', { headers: H })).json()).find((a) => a.account === name);
  await post({ account: 'ren-a', setup_token: 'sk-ant-oat01-renasecret', label: 'first' });

  // rename ok — the edit pill's rename path; label + vault token must SURVIVE it
  let r = await patch('ren-a', { account: 'ren-c' });
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(j, { ok: true, account: 'ren-c', label: 'first' });
  assert.ok(!(await acct('ren-a')), 'old name is gone from the list');
  assert.equal((await acct('ren-c')).label, 'first');
  assert.ok(db.prepare('SELECT token_enc FROM accounts WHERE account=?').get('ren-c').token_enc, 'token row survived the rename');

  // label-only ok — name unchanged
  r = await patch('ren-c', { label: 'second' });
  assert.equal(r.status, 200);
  j = await r.json();
  assert.deepEqual(j, { ok: true, account: 'ren-c', label: 'second' });
  assert.equal((await acct('ren-c')).label, 'second');

  // audited: rename logs 'old → new' under the NEW name, relabel logs 'label update'
  const log = db.prepare(`SELECT account,result FROM access_log WHERE action='account-rename'`).all();
  assert.ok(log.some((x) => x.account === 'ren-c' && x.result === 'ren-a → ren-c'), 'rename audited');
  assert.ok(log.some((x) => x.account === 'ren-c' && x.result === 'label update'), 'relabel audited');

  db.prepare(`DELETE FROM accounts WHERE account IN ('ren-a','ren-c')`).run();   // cleanup
});
test('PATCH /api/accounts/:name — rejection matrix (404/400/409)', async () => {
  const post = (b) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify(b) });
  const patch = (name, b) => fetch(base + `/api/accounts/${name}`, { method: 'PATCH', headers: H, body: JSON.stringify(b) });
  await post({ account: 'ren-x', setup_token: 'sk-ant-oat01-renx', label: 'x' });
  await post({ account: 'ren-y', setup_token: 'sk-ant-oat01-reny', label: 'y' });

  // 404 unknown account
  let r = await patch('ren-ghost', { label: 'z' });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /unknown account ren-ghost/);

  // 400 bad names: spaces / slash / whitespace-only (same rule as POST)
  for (const bad of ['has space', 'a/b', '   ']) {
    r = await patch('ren-x', { account: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match((await r.json()).error, /account name cannot contain spaces or slashes/);
  }

  // 409 rename onto an existing name
  r = await patch('ren-x', { account: 'ren-y' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /account ren-y already exists/);

  // 400 empty body — neither account nor label given
  r = await patch('ren-x', {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /nothing to update/);

  // nothing above may have mutated the rows
  const names = (await (await fetch(base + '/api/accounts', { headers: H })).json()).map((a) => a.account);
  assert.ok(names.includes('ren-x') && names.includes('ren-y'), 'rows untouched by rejected PATCHes');

  db.prepare(`DELETE FROM accounts WHERE account IN ('ren-x','ren-y')`).run();   // cleanup
});
test('GET /api/accounts surfaces the 5h/7d reset epochs (dashboard reset-time)', async () => {
  await fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify({ account: 'rst-a', setup_token: 'sk-ant-oat01-rst', label: '' }) });
  // the poller's updResets write, simulated directly (unix epoch seconds)
  db.prepare('UPDATE accounts SET five_hour_reset=?, seven_day_reset=? WHERE account=?').run(1785613200, 1785675600, 'rst-a');
  const a = (await (await fetch(base + '/api/accounts', { headers: H })).json()).find((x) => x.account === 'rst-a');
  assert.equal(a.five_hour_reset, 1785613200);
  assert.equal(a.seven_day_reset, 1785675600);
  db.prepare(`DELETE FROM accounts WHERE account='rst-a'`).run();   // cleanup
});
test('malformed %-encoding in a path → 400, not 500 (bug B9)', async () => {
  const r = await fetch(base + '/api/keys/%C3%28', { headers: H });   // 0xC3 0x28 = invalid UTF-8, decodeURIComponent throws
  assert.equal(r.status, 400);
});
test('oversized POST body → 413, no hollow row written (bug B6)', async () => {
  const big = 'x'.repeat(1_100_000);
  const r = await fetch(base + '/api/events/prompt', { method: 'POST', headers: H,
    body: JSON.stringify({ account: 'oversize-test', prompt: big }) });
  assert.equal(r.status, 413);
  const logs = await (await fetch(base + '/api/logs?limit=50', { headers: H })).json();
  assert.ok(!logs.some((l) => l.account === 'oversize-test'), 'no hollow row from the dropped body');
});

test('poll: a present-but-unparseable rate header keeps last-known-good, never phantom-0 (bug B7)', async () => {
  const realFetch = globalThis.fetch;
  let next;
  const canned = (status, u5, u7) => new Response('{}', { status, headers: (u5 == null ? {} : {
    'anthropic-ratelimit-unified-5h-utilization': u5, 'anthropic-ratelimit-unified-7d-utilization': u7 }) });
  globalThis.fetch = (url, opts) =>
    String(url).startsWith('https://api.anthropic.com') ? Promise.resolve(next) : realFetch(url, opts);
  const refresh = async (name) => (await realFetch(base + `/api/accounts/${name}/refresh`, { method: 'POST', headers: H })).json();
  const acct = async (name) => (await (await realFetch(base + '/api/accounts', { headers: H })).json()).find((a) => a.account === name);
  try {
    db.prepare("UPDATE accounts SET reauth_needed=0,disabled=0,parked_until=NULL,five_hour_pct=77,seven_day_pct=77,usage_updated=datetime('now') WHERE account=?").run('bob');
    next = canned(200, 'not-a-number', '0.10');   // 5h header is garbage
    const r = await refresh('bob');
    assert.equal(r.five, null);                    // no usage written this cycle
    const b = await acct('bob');
    assert.equal(b.five_hour_pct, 77);             // kept last-known-good, NOT zeroed
    assert.equal(b.seven_day_pct, 77);
  } finally { globalThis.fetch = realFetch; }
});

test('/api/capabilities label reflects the SERVED (newest) key, not lexical max (bug B8)', async () => {
  const postKey = (b) => fetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify(b) });
  await postKey({ provider: 'labtest', key: 'labtest-key-oldddd', label: 'ZZZ-old' });
  await postKey({ provider: 'labtest', key: 'labtest-key-newwww', label: 'AAA-new' });  // higher id = newest = served
  const caps = (await (await fetch(base + '/api/capabilities', { headers: H })).json()).providers.labtest;
  assert.equal(caps.keys, 2);
  assert.equal(caps.label, 'AAA-new');   // correlated to newest; max('ZZZ-old','AAA-new') would wrongly be 'ZZZ-old'
});

test('listKeys marks a never-fetched key stale, clears after a fetch (F10)', async () => {
  const list = async () => (await (await fetch(base + '/api/keys', { headers: H })).json());
  await fetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'staleco', key: 'staleco-key-xxxx' }) });
  assert.equal((await list()).find((k) => k.provider === 'staleco').stale, 1);   // never fetched → stale
  await fetch(base + '/api/keys/staleco', { headers: H });                        // fetch → last_used=now
  assert.equal((await list()).find((k) => k.provider === 'staleco').stale, 0);    // fresh
});

test('pollProviderKeys flips a revoked oaiCompat key to dead, keeps live, skips no-probe providers (F1)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);   // this suite's own calls
    const auth = (opts && opts.headers && opts.headers.authorization) || '';
    return Promise.resolve(new Response('{}', { status: /DEAD/.test(auth) ? 401 : 200 }));  // provider /models probe
  };
  const add = (p, k) => realFetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: p, key: k }) });
  try {
    await add('groq', 'gsk-live-key-AAAA');
    await add('groq', 'gsk-revoked-key-DEAD');
    await add('cohere', 'cohere-key-BBBB');   // cohere has no probe defined → must be skipped, never flipped
    await pollProviderKeys();
    const keys = await (await realFetch(base + '/api/keys', { headers: H })).json();
    assert.equal(keys.find((k) => /AAAA/.test(k.key_hint)).status, 'working');   // live stays
    assert.equal(keys.find((k) => /DEAD/.test(k.key_hint)).status, 'dead');      // revoked flips
    assert.equal(keys.find((k) => /BBBB/.test(k.key_hint)).status, 'working');   // no-probe provider untouched
  } finally { globalThis.fetch = realFetch; }
});

// 2026-08-14 incident: an anthropic key 401'd for real while its registry row stayed
// 'working' because anthropic has no oaiCompat /models route — checkProviderKey skipped
// it unconditionally. These lock in the fix: a dedicated /v1/messages probe, dead only
// on a definitive 401/403, never on a transient error/429/timeout.
test('pollProviderKeys flips a dead anthropic key via the /v1/messages probe (key-liveness)', async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1')) return realFetch(url, opts);
    seen = { url: u, opts };
    return Promise.resolve(new Response('{}', { status: 401 }));
  };
  const add = (k) => realFetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'anthropic', key: k }) });
  try {
    await add('sk-ant-dead-EEEE');
    await pollProviderKeys();
    const keys = await (await realFetch(base + '/api/keys', { headers: H })).json();
    assert.equal(keys.find((k) => /EEEE/.test(k.key_hint)).status, 'dead');
    // probe shape: POST /v1/messages, x-api-key + anthropic-version, 1-token body
    assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers['x-api-key'], 'sk-ant-dead-EEEE');
    assert.equal(seen.opts.headers['anthropic-version'], '2023-06-01');
    assert.equal(JSON.parse(seen.opts.body).max_tokens, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('pollProviderKeys leaves an anthropic key untouched on 429 or a network timeout (key-liveness)', async () => {
  const realFetch = globalThis.fetch;
  const add = (k) => realFetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'anthropic', key: k }) });
  try {
    await add('sk-ant-ratelimited-FFFF');
    await add('sk-ant-timeout-GGGG');
    globalThis.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1')
      ? realFetch(url, opts) : Promise.resolve(new Response('{}', { status: 429 }));
    await pollProviderKeys();
    let keys = await (await realFetch(base + '/api/keys', { headers: H })).json();
    assert.equal(keys.find((k) => /FFFF/.test(k.key_hint)).status, 'working');   // 429 is transient, not fatal

    globalThis.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1')
      ? realFetch(url, opts) : Promise.reject(new Error('fetch failed: timeout'));
    await pollProviderKeys();
    keys = await (await realFetch(base + '/api/keys', { headers: H })).json();
    assert.equal(keys.find((k) => /GGGG/.test(k.key_hint)).status, 'working');   // network error ≠ dead key
  } finally { globalThis.fetch = realFetch; }
});

test('POST /api/keys/:id/refresh flips a dead anthropic key on demand (key-liveness)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1')
    ? realFetch(url, opts) : Promise.resolve(new Response('{}', { status: 403 }));
  try {
    await realFetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-refresh-HHHH' }) });
    const id = (await (await realFetch(base + '/api/keys', { headers: H })).json()).find((k) => /HHHH/.test(k.key_hint)).id;
    const r = await realFetch(base + `/api/keys/${id}/refresh`, { method: 'POST', headers: H });
    const j = await r.json();
    assert.equal(j.checked, true);
    assert.equal(j.alive, false);
    const status = (await (await realFetch(base + '/api/keys', { headers: H })).json()).find((k) => k.id === id).status;
    assert.equal(status, 'dead');
  } finally { globalThis.fetch = realFetch; }
});

test('POST /api/keys/:id/refresh probes one key on demand (F1)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => String(url).startsWith('http://127.0.0.1')
    ? realFetch(url, opts) : Promise.resolve(new Response('{}', { status: 401 }));
  try {
    await realFetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'together', key: 'tog-refresh-CCCC' }) });
    const id = (await (await realFetch(base + '/api/keys', { headers: H })).json()).find((k) => /CCCC/.test(k.key_hint)).id;
    const r = await realFetch(base + `/api/keys/${id}/refresh`, { method: 'POST', headers: H });
    const j = await r.json();
    assert.equal(j.checked, true);
    assert.equal(j.alive, false);
    const status = (await (await realFetch(base + '/api/keys', { headers: H })).json()).find((k) => k.id === id).status;
    assert.equal(status, 'dead');
  } finally { globalThis.fetch = realFetch; }
});

test('GET /api/keys/:provider?exclude= skips a hint and serves the next working key (F9)', async () => {
  const add = (k) => fetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider: 'excltest', key: k }) });
  await add('excltest-older-1111');
  await add('excltest-newer-2222');   // newest = default pick
  const def = await (await fetch(base + '/api/keys/excltest', { headers: H })).json();
  assert.match(def.key_hint, /2222/);                         // newest served by default
  const next = await (await fetch(base + `/api/keys/excltest?exclude=${encodeURIComponent(def.key_hint)}`, { headers: H })).json();
  assert.match(next.key_hint, /1111/);                        // excluded newest → falls to older
});

test('/health surfaces last-poller-cycle health fields (F6)', async () => {
  const h = await (await fetch(base + '/health')).json();
  assert.equal(h.ok, true);
  assert.equal(typeof h.poll_ok, 'number');
  assert.equal(typeof h.poll_failed, 'number');
});

test('auth throttle: locks a source IP after too many fails, clears on success, exempts loopback (F4)', () => {
  const ip = '203.0.113.77';
  authOk(ip);
  for (let i = 0; i < 9; i++) authFail(ip);
  assert.equal(authLocked(ip), false);   // under the threshold
  authFail(ip);                          // 10th
  assert.equal(authLocked(ip), true);
  authOk(ip);                            // a good auth clears the lock
  assert.equal(authLocked(ip), false);
  for (let i = 0; i < 30; i++) authFail('127.0.0.1');   // loopback never locks (tests + healthcheck)
  assert.equal(authLocked('127.0.0.1'), false);
});

test('GET /api/metrics returns Prometheus text with the core gauges (F5)', async () => {
  const r = await fetch(base + '/api/metrics', { headers: H });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/plain/);
  const body = await r.text();
  for (const m of ['aigate_selectable', 'aigate_accounts_total', 'aigate_poll_failed', 'aigate_provider_keys_working'])
    assert.match(body, new RegExp('^' + m + ' \\d+', 'm'));
  assert.equal((await fetch(base + '/api/metrics')).status, 401);   // bearer-gated
});

test('POST /api/keys warns when the key does not match the catalog prefix (F8)', async () => {
  // openai keys start sk- ; paste a clearly-wrong value → 200 with a heads-up warning
  const r = await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'openai', key: 'AIzawrongprovider1234' }) });
  assert.equal(r.status, 200);
  assert.match((await r.json()).warning || '', /prefix/);
  // a correctly-prefixed key gets no prefix warning
  const ok = await (await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'openai', key: 'sk-proj-correct-prefix-1234' }) })).json();
  assert.ok(!ok.warning || !/prefix/.test(ok.warning));
});

test('POST /api/keys/import vaults many keys, reporting per-row ok/error (F11)', async () => {
  const r = await fetch(base + '/api/keys/import', { method: 'POST', headers: H, body: JSON.stringify([
    { provider: 'groq', key: 'gsk-import-one-1111' },
    { provider: 'together', key: 'tog-import-two-2222', label: 'batch' },
    { provider: '', key: 'no-provider-3333' },              // bad row → reported, not fatal
  ]) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.total, 3);
  assert.equal(j.imported, 2);
  assert.equal(j.results.filter((x) => x.ok).length, 2);
  assert.ok(j.results.some((x) => x.error));                // the empty-provider row errored
  const keys = await (await fetch(base + '/api/keys', { headers: H })).json();
  assert.ok(keys.some((k) => /1111/.test(k.key_hint)) && keys.some((k) => /2222/.test(k.key_hint)));
});

// ---- kanban board ----------------------------------------------------------
const P = (path, method, body) => fetch(base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });

test('board routes require auth (401 without bearer)', async () => {
  assert.equal((await fetch(base + '/api/board')).status, 401);
  assert.equal((await fetch(base + '/api/board/claim', { method: 'POST' })).status, 401);
});

test('board: create → list shows a todo card with cwd/model/effort', async () => {
  const r = await P('/api/board', 'POST', { title: 'demo', cwd: '/tmp/x', prompt: 'do the thing', model: 'claude-sonnet-5', effort: 'high' });
  assert.equal(r.status, 200);
  const card = await r.json();
  assert.equal(card.status, 'todo');
  assert.equal(card.cwd, '/tmp/x');       // was never checked — a dropped cwd column would have gone unnoticed
  assert.equal(card.model, 'claude-sonnet-5');
  assert.equal(card.effort, 'high');
  const list = await (await P('/api/board', 'GET')).json();
  const listed = list.find((c) => c.id === card.id);
  assert.ok(listed, 'card missing from GET /api/board list');
  // GET /api/board (listCards) selects its own column list — assert THROUGH it, not just the
  // POST echo, so a column dropped from that SELECT (cwd/model/effort) fails here, not silently.
  assert.equal(listed.prompt, 'do the thing');
  assert.equal(listed.cwd, '/tmp/x');
  assert.equal(listed.model, 'claude-sonnet-5');
  assert.equal(listed.effort, 'high');
});

test('board: create rejects empty prompt (400) and invalid effort defaults to medium', async () => {
  assert.equal((await P('/api/board', 'POST', { prompt: '   ' })).status, 400);
  const card = await (await P('/api/board', 'POST', { prompt: 'x', effort: 'bogus' })).json();
  assert.equal(card.effort, 'medium');
});

test('board: atomic claim hands a card out exactly once', async () => {
  // fresh isolated DB may already hold cards from earlier tests — drain to a known floor,
  // then add one card and prove two concurrent claims can't both get it.
  while ((await (await P('/api/board/claim', 'POST', {})).status) === 200) { /* drain */ }
  const card = await (await P('/api/board', 'POST', { prompt: 'claim-me', cwd: '/tmp', model: 'claude-opus-5', effort: 'low' })).json();
  const [a, b] = await Promise.all([P('/api/board/claim', 'POST', { worker: 'w1' }), P('/api/board/claim', 'POST', { worker: 'w2' })]);
  const codes = [a.status, b.status].sort();
  assert.deepEqual(codes, [200, 204]);                       // one gets it, one gets nothing
  const won = await (a.status === 200 ? a : b).json();
  assert.equal(won.id, card.id);
  assert.equal(won.cwd, '/tmp');
  assert.equal(won.model, 'claude-opus-5');
  // claimed card is now 'running'
  const list = await (await P('/api/board', 'GET')).json();
  assert.equal(list.find((c) => c.id === card.id).status, 'running');
});

test('board: result appends a turn, stores session id, flips to done', async () => {
  const card = await (await P('/api/board', 'POST', { prompt: 'summarize' })).json();
  await P('/api/board/claim', 'POST', {});                    // (may claim an earlier card; claim this one specifically below is unnecessary — result targets by id)
  const r = await P(`/api/board/${card.id}/result`, 'POST', { ok: true, result: 'Done:\n- did X', session_id: 'sess-abc' });
  assert.equal(r.status, 200);
  const done = await r.json();
  assert.equal(done.status, 'done');
  assert.equal(done.session_id, 'sess-abc');
  const turns = JSON.parse(done.turns);
  assert.equal(turns.length, 1);
  assert.match(turns[0].summary, /did X/);
  assert.equal(turns[0].prompt, 'summarize');
});

test('board: followup re-queues a settled card keeping its session id', async () => {
  const card = await (await P('/api/board', 'POST', { prompt: 'first' })).json();
  await P(`/api/board/${card.id}/result`, 'POST', { ok: true, result: 'r1', session_id: 'keep-me' });
  const r = await P(`/api/board/${card.id}/followup`, 'POST', { prompt: 'second' });
  assert.equal(r.status, 200);
  const c2 = await r.json();
  assert.equal(c2.status, 'todo');
  assert.equal(c2.prompt, 'second');
  assert.equal(c2.session_id, 'keep-me');                    // session survives → --resume continues context
});

test('board: result with ok:false → error status carries the message', async () => {
  const card = await (await P('/api/board', 'POST', { prompt: 'boom' })).json();
  const c = await (await P(`/api/board/${card.id}/result`, 'POST', { ok: false, error: 'directory not found' })).json();
  assert.equal(c.status, 'error');
  assert.match(c.error, /directory not found/);
  // retry resets it to todo
  const back = await (await P(`/api/board/${card.id}/retry`, 'POST')).json();
  assert.equal(back.status, 'todo');
  assert.equal(back.error, null);
});

test('board: delete removes the card; unknown ids 404', async () => {
  const card = await (await P('/api/board', 'POST', { prompt: 'gone' })).json();
  assert.equal((await P(`/api/board/${card.id}`, 'DELETE')).status, 200);
  assert.equal((await P(`/api/board/${card.id}`, 'DELETE')).status, 404);
  assert.equal((await P('/api/board/99999/result', 'POST', { ok: true })).status, 404);
});

test('board: WS pushes a board event on mutation', async () => {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', ['aigate', 'bearer.' + TOKEN]);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const got = new Promise((res) => ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'board') res(m.data); }));
  await P('/api/board', 'POST', { prompt: 'ws-ping' });
  const data = await got;
  assert.ok(Array.isArray(data) && data.some((c) => c.prompt === 'ws-ping'));
  ws.close();
});

test('board: host targeting — a pinned card is only claimable by its box', async () => {
  while ((await (await P('/api/board/claim', 'POST', { host: 'drainer' })).status) === 200) { /* drain any-host cards */ }
  const pinned = await (await P('/api/board', 'POST', { prompt: 'reek-only', host: 'reek' })).json();
  assert.equal(pinned.host, 'reek');
  // a different box must NOT get it
  assert.equal((await P('/api/board/claim', 'POST', { worker: 'wick/1', host: 'wick' })).status, 204);
  // the targeted box does
  const got = await (await P('/api/board/claim', 'POST', { worker: 'reek/1', host: 'reek' })).json();
  assert.equal(got.id, pinned.id);
  // both boxes now show as live workers
  const hosts = await (await P('/api/board/hosts', 'GET')).json();
  assert.ok(hosts.includes('reek') && hosts.includes('wick'));
});

test('board: activity heartbeat updates the roster; workers list shows it non-idle', async () => {
  const worker = 'activity-tester/1';
  const r = await P('/api/board/activity', 'POST', { worker, host: 'act-host', cardId: 42, activity: 'running tests' });
  assert.equal(r.status, 200);
  const roster = await (await P('/api/board/workers', 'GET')).json();
  const mine = roster.find((w) => w.worker === worker);
  assert.ok(mine, 'worker not present in roster after activity POST');
  assert.equal(mine.idle, false);
  assert.equal(mine.activity, 'running tests');
  assert.equal(mine.host, 'act-host');
  assert.equal(mine.cardId, 42);
});

test('board: hosts lists a host after it claims (even with no card available)', async () => {
  const hostsBefore = await (await P('/api/board/hosts', 'GET')).json();
  assert.ok(!hostsBefore.includes('claim-host-x'));
  const r = await P('/api/board/claim', 'POST', { worker: 'claim-host-x/1', host: 'claim-host-x' });
  assert.equal(r.status, 204);   // no card queued for it — still registers as a live worker
  const hostsAfter = await (await P('/api/board/hosts', 'GET')).json();
  assert.ok(hostsAfter.includes('claim-host-x'));
});

test('board: reorder persists position order', async () => {
  const a = await (await P('/api/board', 'POST', { prompt: 'reorder-a' })).json();
  const b = await (await P('/api/board', 'POST', { prompt: 'reorder-b' })).json();
  const c = await (await P('/api/board', 'POST', { prompt: 'reorder-c' })).json();
  const r = await P('/api/board/reorder', 'POST', { ids: [c.id, a.id, b.id] });
  assert.equal(r.status, 200);
  const list = await (await P('/api/board', 'GET')).json();
  const idx = (id) => list.findIndex((card) => card.id === id);
  assert.ok(idx(c.id) < idx(a.id));
  assert.ok(idx(a.id) < idx(b.id));
});

test('GET /api/stats — by_host_1h merges normalized hosts, rates are numeric, stale rows excluded', async () => {
  const insReq = db.prepare(`INSERT INTO request_log(account,host,ip,cwd,model,prompt,tokens) VALUES(?,?,?,?,?,?,?)`);
  insReq.run('a', 'web1.local', '1.1.1.1', '/', 'x', 'p', 100);
  insReq.run('a', 'web1.other', '1.1.1.2', '/', 'x', 'p', 50);
  // a row over an hour old — inserted with an explicit stale ts (the API always stamps 'now')
  db.prepare(`INSERT INTO request_log(ts,account,host,ip,cwd,model,prompt,tokens) VALUES(datetime('now','-2 hours'),?,?,?,?,?,?,?)`)
    .run('a', 'web1.ancient', '1.1.1.3', '/', 'x', 'p', 9999);

  const s = await (await P('/api/stats', 'GET')).json();
  assert.ok(Array.isArray(s.by_host_1h));
  for (const row of s.by_host_1h) {
    assert.ok(typeof row.host === 'string');
    assert.equal(typeof row.requests, 'number');
    assert.equal(typeof row.tokens, 'number');
    assert.equal(typeof row.rps, 'number');
    assert.equal(typeof row.tps, 'number');
  }

  const web1 = s.by_host_1h.find((r) => r.host === 'web1');
  assert.ok(web1, 'normalized web1 row present');
  assert.equal(web1.requests, 2);       // merged web1.local + web1.other
  assert.equal(web1.tokens, 150);       // 100 + 50, ancient row's 9999 excluded
  assert.equal(web1.rps, +(2 / 3600).toFixed(3));
  assert.equal(web1.tps, +(150 / 3600).toFixed(2));
});
