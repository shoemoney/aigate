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
