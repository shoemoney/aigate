import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { makeVault } from '../src/lib.js';

const root = mkdtempSync(join(tmpdir(), 'aigate-create-only-'));
const token = 'fake-admin-' + randomBytes(16).toString('hex');
const key = randomBytes(32).toString('hex');
const env = {
  ...process.env,
  AIGATE_DB: join(root, 'vault.db'), AIGATE_TOKEN: token, AIGATE_ENCRYPTION_KEY: key,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0',
  AIGATE_ALERT_WEBHOOK: '', AIGATE_ALLOW_CIDR: '', AIGATE_TRUST_PROXY: '', HOST: '127.0.0.1',
};
Object.assign(process.env, env);
const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(key, 'hex'));
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
let base;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => db.exec('DELETE FROM accounts; DELETE FROM access_log;'));

function codexAuth(id, suffix = 'original') {
  return {
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: `fake-access-${suffix}`, refresh_token: `fake-refresh-${suffix}`, account_id: id, id_token: '' },
    last_refresh: '2026-10-24T00:00:00Z',
  };
}
function material(kind, account, suffix = 'original') {
  return kind === 'codex'
    ? { kind, account, auth_json: codexAuth(account, suffix), label: `label-${suffix}` }
    : { kind, account, setup_token: `sk-ant-oat01-fake-${suffix}`, label: `label-${suffix}` };
}
const post = (body, url = base) => fetch(url + '/api/accounts', { method: 'POST', headers, body: JSON.stringify(body) });
const row = account => ({ ...db.prepare('SELECT * FROM accounts WHERE account=?').get(account) });

test('create_only validates a boolean for both supported account kinds', async () => {
  for (const kind of ['claude', 'codex']) {
    for (const value of [null, 0, 1, 'true', 'false', [], {}]) {
      const response = await post({ ...material(kind, kind + '-bad'), create_only: value });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /create_only must be boolean/);
    }
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
});

for (const kind of ['claude', 'codex']) {
  test(`${kind} create_only inserts once and preserves every existing credential and metadata field on 409`, async () => {
    const account = `${kind}-create`;
    const response = await post({ ...material(kind, account), create_only: true });
    assert.equal(response.status, 200);
    db.prepare('UPDATE accounts SET disabled=1,reauth_needed=1,refresh_unknown=1,five_hour_pct=57,seven_day_pct=81,plan=?,parked_until=? WHERE account=?').run('preserved-plan', '2030-01-01 00:00:00', account);
    const original = row(account);
    const duplicate = await post({ ...material(kind, account, 'replacement'), create_only: true });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).error, /already exists/);
    assert.deepEqual(row(account), original);
    assert.ok(!vault.decrypt(row(account).token_enc).includes('replacement'));
    assert.equal(db.prepare("SELECT count(*) AS n FROM access_log WHERE action='account-add'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM access_log WHERE action='account-overwrite'").get().n, 0);
  });

  test(`${kind} legacy intake retains overwrite behavior with absent or false create_only`, async () => {
    const account = `${kind}-legacy`;
    assert.equal((await post(material(kind, account))).status, 200);
    for (const flag of [undefined, false]) {
      const body = material(kind, account, flag === false ? 'false-flag' : 'absent-flag');
      if (flag !== undefined) body.create_only = flag;
      const response = await post(body);
      assert.equal(response.status, 200);
      assert.equal(row(account).label, body.label);
      const stored = vault.decrypt(row(account).token_enc);
      assert.ok(stored.includes(flag === false ? 'false-flag' : 'absent-flag'));
    }
  });
}

test('create_only cannot replace an existing account with the other kind', async () => {
  for (const kind of ['claude', 'codex']) {
    const account = `${kind}-cross-kind`;
    assert.equal((await post(material(kind, account))).status, 200);
    const original = row(account);
    const opposite = kind === 'codex' ? 'claude' : 'codex';
    assert.equal((await post({ ...material(opposite, account), create_only: true })).status, 409);
    assert.deepEqual(row(account), original);
  }
});

async function secondServer(t) {
  const source = `const {server,db}=await import(${JSON.stringify(new URL('../src/server.js', import.meta.url).href)});server.listen(0,'127.0.0.1',()=>{process.send({port:server.address().port});});process.on('message',()=>server.close(()=>{db.close();process.exit(0);}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostic = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { diagnostic += data.toString(); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.send('close');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    timeout.unref();
    await once(child, 'exit');
    clearTimeout(timeout);
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(() => { throw new Error('throwaway second server exited: ' + diagnostic); }),
  ]);
  return `http://127.0.0.1:${ready.port}`;
}

test('independent server processes race create_only through the database constraint for Claude and Codex', async t => {
  const other = await secondServer(t);
  for (const kind of ['claude', 'codex']) {
    // Distinct callers use the same fresh name repeatedly across two SQLite
    // connections. Exactly one gets to insert; no loser can rewrite its token.
    for (let round = 0; round < 5; round++) {
      const account = `${kind}-race-${round}`;
      const contenders = [material(kind, account, 'left'), material(kind, account, 'right')];
      const replies = await Promise.all(contenders.map((body, index) => post({ ...body, create_only: true }, index ? other : base)));
      assert.deepEqual(replies.map(response => response.status).sort(), [200, 409]);
      const winner = contenders[replies.findIndex(response => response.status === 200)];
      const persisted = row(account);
      assert.equal(persisted.label, winner.label);
      assert.ok(vault.decrypt(persisted.token_enc).includes(winner.label.slice('label-'.length)));
      assert.equal(db.prepare('SELECT count(*) AS n FROM accounts WHERE account=?').get(account).n, 1);
    }
  }
});
