import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { makeVault } from '../src/lib.js';

const ROTATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'rotate-key.js');

function fixture(t, { legacy = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-proxy-rotation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, 'aigate.db');
  const oldKey = randomBytes(32), newKey = randomBytes(32);
  const oldVault = makeVault(oldKey), newVault = makeVault(newKey);
  const fields = [
    { api_key: 'dummy-provider-key' },
    { access_key_id: 'dummy-access-id', secret_access_key: 'dummy-aws-secret', session_token: 'dummy-session', region: 'us-east-1' },
  ];
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE accounts(account TEXT PRIMARY KEY,token_enc TEXT);
    CREATE TABLE provider_keys(id INTEGER PRIMARY KEY,key_enc TEXT);
    CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);`);
  db.prepare('INSERT INTO accounts VALUES(?,?)').run('dummy-account', oldVault.encrypt('dummy-account-token'));
  db.prepare('INSERT INTO provider_keys VALUES(?,?)').run(1, oldVault.encrypt('dummy-legacy-key'));
  db.prepare('INSERT INTO meta VALUES(?,?)').run('canary', oldVault.encrypt('aigate-canary'));
  if (!legacy) {
    db.exec('CREATE TABLE proxy_credentials(id INTEGER PRIMARY KEY,fields_enc TEXT NOT NULL)');
    fields.forEach((value, i) => db.prepare('INSERT INTO proxy_credentials VALUES(?,?)').run(i + 1, oldVault.encrypt(JSON.stringify(value))));
  }
  db.close();
  function read() {
    const handle = new DatabaseSync(database, { readOnly: true });
    try {
      return {
        account: handle.prepare('SELECT token_enc FROM accounts').get().token_enc,
        key: handle.prepare('SELECT key_enc FROM provider_keys').get().key_enc,
        canary: handle.prepare("SELECT v FROM meta WHERE k='canary'").get().v,
        credentials: legacy ? [] : handle.prepare('SELECT fields_enc FROM proxy_credentials ORDER BY id').all().map((row) => row.fields_enc),
      };
    } finally { handle.close(); }
  }
  function mutate(fn) {
    const handle = new DatabaseSync(database);
    try { fn(handle); } finally { handle.close(); }
  }
  function rotate() {
    return spawnSync(process.execPath, [ROTATE, newKey.toString('hex')], {
      cwd: directory,
      env: { ...process.env, AIGATE_DB: database, AIGATE_ENCRYPTION_KEY: oldKey.toString('hex') },
      encoding: 'utf8', timeout: 8000,
    });
  }
  return { directory, database, oldKey, newKey, oldVault, newVault, fields, read, mutate, rotate };
}

test('key rotation reencrypts structured API-key and AWS fields with the rest of the vault', (t) => {
  const f = fixture(t);
  const result = f.rotate();
  assert.equal(result.status, 0, result.stderr);
  const encrypted = f.read();
  assert.equal(f.newVault.decrypt(encrypted.account), 'dummy-account-token');
  assert.equal(f.newVault.decrypt(encrypted.key), 'dummy-legacy-key');
  assert.equal(f.newVault.decrypt(encrypted.canary), 'aigate-canary');
  encrypted.credentials.forEach((value, i) => {
    assert.deepEqual(JSON.parse(f.newVault.decrypt(value)), f.fields[i]);
    assert.throws(() => f.oldVault.decrypt(value));
  });
  assert.throws(() => f.oldVault.decrypt(encrypted.account));
  assert.match(result.stdout, /2 proxy credential set/);
  assert.ok(!result.stdout.includes(f.newKey.toString('hex')), 'rotation output must not print the new encryption key');
});

test('key rotation refuses existing traffic metadata before changing any ciphertext', (t) => {
  const f = fixture(t);
  f.mutate((db) => db.exec('CREATE TABLE proxy_traffic(id INTEGER PRIMARY KEY); INSERT INTO proxy_traffic VALUES(1)'));
  const before = f.read();
  const result = f.rotate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /encrypted proxy traffic exists; rotation refused/);
  assert.deepEqual(f.read(), before);
  assert.equal(f.oldVault.decrypt(before.canary), 'aigate-canary');
});

test('key rotation refuses orphan encrypted capture files even without traffic metadata', (t) => {
  const f = fixture(t);
  const directory = join(f.directory, 'proxy-traffic');
  mkdirSync(directory, { mode: 0o700 });
  const capture = join(directory, 'orphan.events');
  const content = f.oldVault.encrypt(JSON.stringify({ type: 'request', headers: ['Authorization', 'Bearer dummy-token'] })) + '\n';
  writeFileSync(capture, content, { mode: 0o600 });
  const before = f.read();
  const result = f.rotate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /encrypted proxy traffic exists; rotation refused/);
  assert.deepEqual(f.read(), before);
  assert.equal(readFileSync(capture, 'utf8'), content);
});

test('key rotation rolls back every vault row when a structured credential is unreadable', (t) => {
  const f = fixture(t);
  f.mutate((db) => db.prepare('UPDATE proxy_credentials SET fields_enc=? WHERE id=2').run('not-a-valid-encrypted-record'));
  const before = f.read();
  const result = f.rotate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rotation failed, rolled back/);
  assert.deepEqual(f.read(), before, 'account, legacy key, prior proxy credential and canary must all remain under the old key');
});

test('key rotation still supports vaults without the new proxy tables', (t) => {
  const f = fixture(t, { legacy: true });
  const result = f.rotate();
  assert.equal(result.status, 0, result.stderr);
  const encrypted = f.read();
  assert.equal(f.newVault.decrypt(encrypted.account), 'dummy-account-token');
  assert.equal(f.newVault.decrypt(encrypted.key), 'dummy-legacy-key');
  assert.equal(f.newVault.decrypt(encrypted.canary), 'aigate-canary');
});

test('key rotation refuses when the capture directory cannot be inspected', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'proxy-traffic'), 'not a directory');
  const before = f.read();
  const result = f.rotate();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot inspect encrypted proxy traffic; rotation refused/);
  assert.deepEqual(f.read(), before);
});
