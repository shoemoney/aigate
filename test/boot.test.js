import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeVault } from '../src/lib.js';

// Boot-guard tests spawn a fresh `node src/server.js` because the FATAL checks
// call process.exit(1) at import — you can't assert that in-process. Each run
// gets a throwaway DB + valid TOKEN/ENC_KEY so only the var under test is bad.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

function boot(extraEnv) {
  const DB = join(tmpdir(), `aigate-boot-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const env = {
    ...process.env,
    AIGATE_TOKEN: 'boot-token-' + crypto.randomBytes(8).toString('hex'),
    AIGATE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
    AIGATE_DB: DB,
    AIGATE_POLL_MS: '0',
    AIGATE_WATCHDOG_MS: '0',
    HOST: '127.0.0.1',
    PORT: '0',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [SERVER], { env, timeout: 8000, encoding: 'utf8', killSignal: 'SIGKILL' });
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
  return r;
}

test('boot: non-numeric AIGATE_HEADROOM_CUTOFF is FATAL (would silently zero selection)', () => {
  const r = boot({ AIGATE_HEADROOM_CUTOFF: 'ninety-five' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /AIGATE_HEADROOM_CUTOFF/);
});

test('boot: out-of-range AIGATE_HEADROOM_CUTOFF is FATAL', () => {
  assert.equal(boot({ AIGATE_HEADROOM_CUTOFF: '0' }).status, 1);
  assert.equal(boot({ AIGATE_HEADROOM_CUTOFF: '250' }).status, 1);
});

test('boot: AIGATE_VERSION env overrides the served version (/api/capabilities)', async () => {
  const DB = join(tmpdir(), `aigate-ver-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const TOKEN = 'boot-token-' + crypto.randomBytes(8).toString('hex');
  const PORT = 38700 + (process.pid % 900);
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, AIGATE_TOKEN: TOKEN, AIGATE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
      AIGATE_DB: DB, AIGATE_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0', HOST: '127.0.0.1', PORT: String(PORT),
      AIGATE_VERSION: 'sha-deadbeef' },
    stdio: 'ignore',
  });
  try {
    const url = `http://127.0.0.1:${PORT}`;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { if ((await fetch(url + '/health')).ok) break; } catch { /* not up yet */ }
    }
    const res = await fetch(url + '/api/capabilities', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).version, 'sha-deadbeef');
  } finally {
    child.kill('SIGKILL');
    for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
  }
});

test('boot: a canary written under a DIFFERENT key is FATAL — never opens an undecryptable vault (F7 mechanism)', () => {
  // hand-build a vault whose canary is encrypted under key A, then boot with key B
  const DB = join(tmpdir(), `aigate-canary-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const dbA = new DatabaseSync(DB);
  dbA.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)`);
  const vaultA = makeVault(crypto.randomBytes(32));
  dbA.prepare(`INSERT INTO meta(k,v) VALUES('canary',?)`).run(vaultA.encrypt('aigate-canary'));
  dbA.close();
  try {
    const r = boot({ AIGATE_DB: DB, AIGATE_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') });  // key B ≠ A
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match this vault/);
  } finally {
    for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
  }
});

test('rotate-key.js re-encrypts the vault: new key decrypts, old key no longer does (F2)', () => {
  const ROTATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rotate-key.js');
  const DB = join(tmpdir(), `aigate-rot-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  const keyA = crypto.randomBytes(32), keyB = crypto.randomBytes(32);
  const vA = makeVault(keyA), vB = makeVault(keyB);
  // seed a vault under key A: one account token, one provider key, a canary
  const d = new DatabaseSync(DB);
  d.exec(`CREATE TABLE accounts(account TEXT PRIMARY KEY, token_enc TEXT);
          CREATE TABLE provider_keys(id INTEGER PRIMARY KEY, key_enc TEXT);
          CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);`);
  d.prepare(`INSERT INTO accounts VALUES('acct',?)`).run(vA.encrypt('sk-ant-oat01-secret'));
  d.prepare(`INSERT INTO provider_keys VALUES(1,?)`).run(vA.encrypt('sk-provider-secret'));
  d.prepare(`INSERT INTO meta VALUES('canary',?)`).run(vA.encrypt('aigate-canary'));
  d.close();
  try {
    const r = spawnSync(process.execPath, [ROTATE, keyB.toString('hex')],
      { env: { ...process.env, AIGATE_ENCRYPTION_KEY: keyA.toString('hex'), AIGATE_DB: DB }, encoding: 'utf8', timeout: 8000 });
    assert.equal(r.status, 0, r.stderr);
    const d2 = new DatabaseSync(DB);
    const tok = d2.prepare(`SELECT token_enc FROM accounts WHERE account='acct'`).get().token_enc;
    const key = d2.prepare(`SELECT key_enc FROM provider_keys WHERE id=1`).get().key_enc;
    d2.close();
    assert.equal(vB.decrypt(tok), 'sk-ant-oat01-secret');   // new key opens it
    assert.equal(vB.decrypt(key), 'sk-provider-secret');
    assert.throws(() => vA.decrypt(tok));                    // old key no longer does
  } finally {
    for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
  }
});

// ---- N2: a restored backup must never re-spend rotated codex refresh tokens ----
// Real processes (the guard runs at import, before any poll): seed → snapshot DB → rotate →
// put the OLD DB back → reboot. The ledger sits beside the DB, so it remembers the rotation.
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (p) => `${b64u({ alg: 'none' })}.${b64u({ ...p, jti: crypto.randomBytes(6).toString('hex') })}.sig`;
const nowS = () => Math.floor(Date.now() / 1000);

async function restoreRig() {
  const { spawn } = await import('node:child_process');
  const http = await import('node:http');
  const fs = await import('node:fs');
  const hits = { token: 0, alert: [] };
  const fake = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.url.startsWith('/token')) {
        hits.token++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: jwt({ exp: nowS() + 864000 }), refresh_token: 'rt-rotated-' + hits.token }));
      }
      if (req.url.startsWith('/alert')) { hits.alert.push(Buffer.concat(chunks).toString()); res.writeHead(200); return res.end('ok'); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fb = `http://127.0.0.1:${fake.address().port}`;
  const dir = fs.mkdtempSync(join(tmpdir(), 'aigate-restore-'));
  const DB = join(dir, 'aigate.db');
  const TOKEN = 'boot-token-' + crypto.randomBytes(8).toString('hex');
  const KEY = crypto.randomBytes(32).toString('hex');
  const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
  const kids = [];   // a failed assertion must not leave a server alive to hang the runner
  let port = 39700 + Math.floor(Math.random() * 200);
  async function start(extraEnv = {}) {
    port++;
    const child = spawn(process.execPath, [SERVER], { stdio: 'ignore', env: { ...process.env, AIGATE_TOKEN: TOKEN, AIGATE_ENCRYPTION_KEY: KEY,
      AIGATE_DB: DB, AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0', HOST: '127.0.0.1', PORT: String(port),
      AIGATE_CODEX_TOKEN_URL: fb + '/token', AIGATE_CODEX_USAGE_URL: fb + '/usage', AIGATE_ALERT_WEBHOOK: fb + '/alert', ...extraEnv } });
    kids.push(child);
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 100)); try { if ((await fetch(url + '/health')).ok) break; } catch { /* not yet */ } }
    const stop = () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    return { url, stop, api: (path, init = {}) => fetch(url + path, { ...init, headers: H }) };
  }
  const cleanup = () => { for (const k of kids) k.kill('SIGKILL'); fake.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { start, hits, DB, dir, fs, cleanup, H };
}
const authJson = (rt, expIn) => ({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
  tokens: { id_token: jwt({ email: 'r@x.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-r' } }),
    access_token: jwt({ exp: nowS() + expIn }), refresh_token: rt, account_id: 'acct-r' } });

test('restore guard: old DB put back after a rotation → refresh_unknown, ZERO token calls, ONE alert', async () => {
  const rig = await restoreRig();
  try {
    let s = await rig.start();
    assert.equal((await s.api('/api/accounts', { method: 'POST', body: JSON.stringify({ account: 'rx', kind: 'codex', auth_json: authJson('rt-original', 3600) }) })).status, 200);
    await s.stop();
    rig.fs.copyFileSync(rig.DB, rig.DB + '.old');
    s = await rig.start();                                           // normal restart: no halt, no alert
    let rows = await (await s.api('/api/accounts')).json();
    assert.equal(rows.find((r) => r.account === 'rx').refresh_unknown, 0);
    assert.equal(rig.hits.alert.length, 0);
    await s.api('/api/accounts/rx/refresh', { method: 'POST' });     // near expiry → rotates rt-original away
    assert.equal(rig.hits.token, 1);
    await s.stop();
    for (const suf of ['-wal', '-shm']) rig.fs.rmSync(rig.DB + suf, { force: true });
    rig.fs.copyFileSync(rig.DB + '.old', rig.DB);                    // the restore
    rig.hits.token = 0;
    s = await rig.start();
    rows = await (await s.api('/api/accounts')).json();
    assert.equal(rows.find((r) => r.account === 'rx').refresh_unknown, 1);
    await s.api('/api/accounts/rx/refresh', { method: 'POST' });
    // the restored (possibly spent) token must NOT be handed out: select + dry both 503, and the
    // keeper read flags it so boxes refuse to write it to disk
    const sel = await s.api('/api/select?kind=codex');
    assert.equal(sel.status, 503);
    const selBody = await sel.json();
    assert.equal(selBody.refresh_unknown, 1);
    assert.ok(!JSON.stringify(selBody).includes('auth_json'));
    assert.equal((await s.api('/api/select?kind=codex&dry=1')).status, 503);
    const keep = await (await s.api('/api/codex/auth?account_id=acct-r')).json();
    assert.equal(keep.refresh_unknown, 1);
    assert.equal(rig.hits.token, 0);                                 // the dead token was never spent
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rig.hits.alert.length, 1);
    assert.match(rig.hits.alert[0], /restored from backup.*halted for 1 account.*rx/);
    const audit = await (await s.api('/api/access?limit=50')).json();
    assert.ok(JSON.stringify(audit).includes('codex-restore-guard'));
    await s.stop();
    assert.equal(rig.fs.existsSync(join(rig.dir, 'backups', 'codex-ledger.json')), false);
    assert.equal(rig.fs.statSync(join(rig.dir, 'codex-ledger.json')).mode & 0o777, 0o600);
  } finally { rig.cleanup(); }
});

test('restore guard: missing ledger (first boot after upgrade) does NOT halt and seeds the ledger', async () => {
  const rig = await restoreRig();
  try {
    let s = await rig.start();
    await s.api('/api/accounts', { method: 'POST', body: JSON.stringify({ account: 'rx', kind: 'codex', auth_json: authJson('rt-original', 3600) }) });
    await s.stop();
    rig.fs.rmSync(join(rig.dir, 'codex-ledger.json'));
    s = await rig.start();
    const rows = await (await s.api('/api/accounts')).json();
    assert.equal(rows.find((r) => r.account === 'rx').refresh_unknown, 0);
    assert.equal(rig.hits.alert.length, 0);
    await s.stop();
    assert.ok(JSON.parse(rig.fs.readFileSync(join(rig.dir, 'codex-ledger.json'), 'utf8'))['acct-r']);
  } finally { rig.cleanup(); }
});

test('ledger unreadable (file EXISTS, corrupt) + codex rows → all halted, moved aside, ONE alert, not reseeded over', async () => {
  const rig = await restoreRig();
  try {
    let s = await rig.start();
    await s.api('/api/accounts', { method: 'POST', body: JSON.stringify({ account: 'rx', kind: 'codex', auth_json: authJson('rt-original', 3600) }) });
    await s.stop();
    const lp = join(rig.dir, 'codex-ledger.json');
    rig.fs.writeFileSync(lp, '{ this is not json');
    s = await rig.start();
    const rows = await (await s.api('/api/accounts')).json();
    assert.equal(rows.find((r) => r.account === 'rx').refresh_unknown, 1);
    assert.equal((await s.api('/api/select?kind=codex')).status, 503);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(rig.hits.alert.length, 1);
    assert.match(rig.hits.alert[0], /ledger unreadable/);
    const audit = JSON.stringify(await (await s.api('/api/access?limit=50')).json());
    assert.ok(audit.includes('ledger unreadable'));
    await s.stop();
    const aside = rig.fs.readdirSync(rig.dir).filter((f) => f.startsWith('codex-ledger.json.corrupt-'));
    assert.equal(aside.length, 1);
    assert.equal(rig.fs.readFileSync(join(rig.dir, aside[0]), 'utf8'), '{ this is not json');
    assert.ok(JSON.parse(rig.fs.readFileSync(lp, 'utf8'))['acct-r']);   // fresh ledger, evidence preserved aside
  } finally { rig.cleanup(); }
});

test('ledger unreadable but NO codex rows → nothing to halt, no alert', async () => {
  const rig = await restoreRig();
  try {
    rig.fs.writeFileSync(join(rig.dir, 'codex-ledger.json'), 'garbage');
    const s = await rig.start();
    assert.equal(rig.hits.alert.length, 0);
    await s.stop();
  } finally { rig.cleanup(); }
});

test('AIGATE_CODEX_LEDGER in a not-yet-existing dir: server creates the parent and writes the ledger there', async () => {
  const rig = await restoreRig();
  try {
    const lp = join(rig.dir, 'outside', 'deep', 'codex-ledger.json');
    const s = await rig.start({ AIGATE_CODEX_LEDGER: lp });
    await s.api('/api/accounts', { method: 'POST', body: JSON.stringify({ account: 'rx', kind: 'codex', auth_json: authJson('rt-original', 3600) }) });
    await s.stop();
    assert.ok(JSON.parse(rig.fs.readFileSync(lp, 'utf8'))['acct-r']);
    assert.equal(rig.fs.existsSync(join(rig.dir, 'codex-ledger.json')), false);   // default location untouched
  } finally { rig.cleanup(); }
});

test('failed ledger write alerts once (edge-triggered), credential still durable', async (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores directory modes');
  const rig = await restoreRig();
  const ldir = join(rig.dir, 'ro');
  try {
    rig.fs.mkdirSync(ldir);
    const s = await rig.start({ AIGATE_CODEX_LEDGER: join(ldir, 'codex-ledger.json') });
    rig.fs.chmodSync(ldir, 0o500);                                   // ledger dir becomes unwritable
    for (const n of ['a1', 'a2']) {
      const r = await s.api('/api/accounts', { method: 'POST', body: JSON.stringify({ account: n, kind: 'codex', auth_json: { ...authJson('rt-' + n, 3600), tokens: { ...authJson('rt-' + n, 3600).tokens, account_id: 'acct-' + n } } }) });
      assert.equal(r.status, 200);                                   // the write itself still succeeds
    }
    await new Promise((r) => setTimeout(r, 400));
    const ours = rig.hits.alert.filter((a) => /ledger write FAILED/.test(a));
    assert.equal(ours.length, 1);
    await s.stop();
  } finally { try { rig.fs.chmodSync(ldir, 0o700); } catch { /* */ } rig.cleanup(); }
});
