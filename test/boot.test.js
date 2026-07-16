import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
