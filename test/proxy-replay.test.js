import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { makeVault } from '../src/lib.js';
import { createReplayStore } from '../src/proxy-replay.js';
import { classifyClaudeExhaustion } from '../src/claude-relay.js';

test('encrypted replay preserves binary chunks/trailers, bounds capacity, and removes interrupted files without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aigate-replay-')), vault = makeVault(randomBytes(32));
  try {
    const store = await createReplayStore({ directory: dir, ...vault, maxBytes: 100, totalBytes: 120 });
    const spool = await store.start(), body = Buffer.from('secret binary body\u0000\u00ff');
    await spool.append(body);
    assert.equal((await readFile(spool.path, 'utf8')).includes('secret binary body'), false);
    assert.equal((await stat(spool.path)).mode & 0o777, 0o600); assert.equal((await stat(dir)).mode & 0o777, 0o700);
    await assert.rejects(async () => { for await (const _ of spool.read()) {} }, /not completely replayable/);
    await spool.seal(['X-Trailer', 'exact value']);
    const records = []; for await (const record of spool.read()) records.push(record);
    assert.deepEqual(Buffer.concat(records.filter(record => record.chunk).map(record => record.chunk)), body);
    assert.deepEqual(records.at(-1).trailers, ['X-Trailer', 'exact value']);
    const second = await store.start(); await assert.rejects(second.append(Buffer.alloc(101)), { code: 'REPLAY_LIMIT' });
    await second.append(Buffer.alloc(99));
    const third = await store.start(); await assert.rejects(third.append(Buffer.alloc(10)), { code: 'REPLAY_LIMIT' });
    await third.dispose(); await second.dispose(); await spool.dispose(); assert.deepEqual(await readdir(dir), []);
    const interrupted = await store.start(); await interrupted.append(Buffer.from('must never be sent'));
    await createReplayStore({ directory: dir, ...vault }); assert.deepEqual(await readdir(dir), []);
    await interrupted.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('replay identity, sequence, authentication and completion corruption are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aigate-replay-corrupt-')), vault = makeVault(randomBytes(32));
  try {
    const store = await createReplayStore({ directory: dir, ...vault });
    const a = await store.start(), b = await store.start(); await a.append(Buffer.from('a')); await a.seal([]); await b.append(Buffer.from('b')); await b.seal([]);
    const original = await readFile(a.path, 'utf8'), foreign = await readFile(b.path, 'utf8');
    const read = async () => { for await (const _ of a.read()) {} };
    await writeFile(a.path, foreign); await assert.rejects(read, /identity or ordering/);
    const lines = original.trim().split('\n'); await writeFile(a.path, lines[0] + '\n'); await assert.rejects(read, /incomplete/);
    await writeFile(a.path, lines.reverse().join('\n') + '\n'); await assert.rejects(read, /identity or ordering/);
    await writeFile(a.path, 'broken authentication\n'); await assert.rejects(read);
    await a.dispose(); await b.dispose();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('quota classifier requires authoritative rejection and isolates known model-family claims', () => {
  const raw = (status, claim, reset) => ['anthropic-ratelimit-unified-status', status, 'anthropic-ratelimit-unified-representative-claim', claim, 'anthropic-ratelimit-unified-reset', String(reset)];
  const future = Math.floor(Date.now() / 1000) + 300;
  assert.equal(classifyClaudeExhaustion(429, []), null);
  assert.equal(classifyClaudeExhaustion(529, raw('rejected', 'seven_day', future)), null);
  assert.equal(classifyClaudeExhaustion(429, raw('allowed', 'seven_day', future)), null);
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'unknown', future)), null);
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'seven_day_opus', 0)), null);
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'five_hour', future)).window, 'five_hour');
  const family = classifyClaudeExhaustion(429, raw('rejected', 'seven_day_opus', future));
  assert.equal(family.window, 'model'); assert.equal(family.modelFamily, 'opus');
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'seven_day_opus', future), { model: 'claude-haiku-4-5' }), null);
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'seven_day_opus', future), { model: null }), null);
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'seven_day_opus', future), { model: 'claude-opus-4-6' }).modelFamily, 'opus');
  const controlled = Date.UTC(2020, 0, 1), reset = controlled / 1000 + 100;
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'five_hour', reset), { now: controlled }).window, 'five_hour');
  assert.equal(classifyClaudeExhaustion(429, raw('rejected', 'five_hour', reset), { now: controlled + 100001 }), null);
});

test('offline key rotation refuses orphaned encrypted replay even when traffic metadata is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aigate-replay-key-')), oldKey = randomBytes(32), vault = makeVault(oldKey);
  const dbPath = join(dir, 'vault.db'), db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);');
    db.prepare('INSERT INTO meta VALUES(?,?)').run('canary', vault.encrypt('aigate-canary'));
    const store = await createReplayStore({ directory: join(dir, 'proxy-replay'), ...vault });
    const spool = await store.start(); await spool.append(Buffer.from('private upload'));
    const result = spawnSync(process.execPath, ['scripts/rotate-key.js', randomBytes(32).toString('hex')], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, AIGATE_DB: dbPath, AIGATE_ENCRYPTION_KEY: oldKey.toString('hex') }, encoding: 'utf8',
    });
    assert.equal(result.status, 1); assert.match(result.stderr, /encrypted proxy replay exists/);
    assert.equal(vault.decrypt(db.prepare("SELECT v FROM meta WHERE k='canary'").get().v), 'aigate-canary');
    await spool.dispose();
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
