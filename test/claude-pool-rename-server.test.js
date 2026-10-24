import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aigate-claude-rename-'));
const adminToken = randomBytes(24).toString('hex');
const probeRequests = [], tokenNames = new Map(), pendingProbes = new Map();
const quotas = (five = .2, seven = .3) => ({
  'anthropic-ratelimit-unified-5h-utilization': String(five),
  'anthropic-ratelimit-unified-7d-utilization': String(seven),
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 10000),
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + 20000),
});
const probeUsage = new Map();
const upstream = http.createServer((req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const name = tokenNames.get(token);
  const chunks = [];
  req.on('error', () => {});
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    probeRequests.push({ name, path: req.url, headers: req.headers, body });
    if (!name || req.url !== '/v1/messages' || body.max_tokens !== 1) {
      res.writeHead(400); res.end('unexpected non-probe request'); return;
    }
    const finish = () => {
      res.writeHead(200, { ...quotas(...(probeUsage.get(name) || [])), 'content-type': 'application/json' });
      res.end('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}');
    };
    const pending = pendingProbes.get(name);
    if (pending) { pendingProbes.delete(name); pending.arrived(finish); }
    else finish();
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  AIGATE_DB: join(dir, 'vault.db'), AIGATE_TOKEN: adminToken,
  AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0',
  AIGATE_TRANSPARENT_UPSTREAM_CLAUDE_CODE: `http://127.0.0.1:${upstream.address().port}`,
});
delete process.env.AIGATE_ALLOW_CIDR;
const { server, db, claudePool } = await import('../src/server.js');
let base;
const admin = (path, method = 'GET', body) => fetch(base + path, {
  method, headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const accountPath = name => '/api/accounts/' + encodeURIComponent(name);
const metadata = (name, body) => admin(`/api/proxy/claude-code/accounts/${encodeURIComponent(name)}/metadata`, 'POST', body);
async function add(name) {
  const token = 'sk-ant-oat01-dummy-manually-entered-' + name;
  tokenNames.set(token, name);
  const response = await admin('/api/accounts', 'POST', { account: name, label: 'original ' + name, setup_token: token });
  assert.equal(response.status, 200);
  return { token, fingerprint: createHash('sha256').update(token).digest('hex') };
}
async function refresh(name) {
  const response = await admin(accountPath(name) + '/refresh', 'POST', {});
  assert.equal(response.status, 200);
  return response.json();
}
async function status(name, model = 'claude-sonnet-4-6') {
  const response = await admin('/api/proxy/claude-code/status?model=' + encodeURIComponent(model));
  assert.equal(response.status, 200);
  return (await response.json()).accounts.find(row => row.account === name);
}
const metaRow = name => db.prepare('SELECT * FROM claude_pool_metadata WHERE account=?').get(name);
const usageRow = name => db.prepare('SELECT * FROM claude_pool_usage WHERE account=?').get(name);
const blocks = () => db.prepare('SELECT * FROM claude_pool_blocks ORDER BY scope_key,model_family,window').all();
const rename = (oldName, newName, label) => admin(accountPath(oldName), 'PATCH', { account: newName, ...(label === undefined ? {} : { label }) });

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await claudePool.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  db.close(); rmSync(dir, { recursive: true, force: true });
});

test('HTTP rename preserves manual expiry, fingerprint and subscription scope even after a fresh positive native probe', async () => {
  const oldName = 'expired-original', newName = 'expired-renamed';
  const { token, fingerprint } = await add(oldName);
  const expires = new Date(Date.now() - 60000).toISOString();
  assert.equal((await metadata(oldName, { quota_scope: 'subscription-expired', credential_expires_at: expires })).status, 200);
  await refresh(oldName);
  assert.equal((await status(oldName)).reason, 'credential_expired');

  assert.equal((await rename(oldName, newName, 'renamed expired')).status, 200);
  const renamed = await status(newName);
  assert.equal(renamed.label, 'renamed expired');
  assert.equal(renamed.quota_scope, 'subscription-expired');
  assert.equal(renamed.credential_expires_at, expires);
  assert.equal(renamed.reason, 'credential_expired');
  assert.equal(renamed.eligible, false);
  assert.equal(metaRow(newName).expiry_fingerprint, fingerprint);
  assert.equal(usageRow(newName).fingerprint, fingerprint);
  assert.equal(metaRow(oldName), undefined, 'old metadata must not remain as an orphan');
  assert.equal(usageRow(oldName), undefined, 'old usage must move with the identity');

  const requestCount = probeRequests.length;
  await refresh(newName);
  assert.equal(probeRequests.length, requestCount + 1, 'exercise the real local native quota probe after rename');
  const observed = await status(newName);
  assert.equal(observed.five_hour.remaining_pct, 80);
  assert.equal(observed.seven_day.remaining_pct, 70);
  assert.equal(observed.reason, 'credential_expired');
  assert.equal(observed.eligible, false, 'positive quota does not override operator credential expiry');
  const requests = probeRequests.slice(requestCount);
  assert.equal(requests[0].headers.authorization, 'Bearer ' + token);
  assert.equal(JSON.stringify(observed).includes(token), false);
});

test('HTTP rename retains shared subscription observations and model cooldowns from both directions', async () => {
  const peer = 'shared-peer', oldName = 'shared-original', newName = 'shared-renamed';
  await add(peer); await add(oldName);
  for (const name of [peer, oldName]) assert.equal((await metadata(name, { quota_scope: 'same-subscription' })).status, 200);
  probeUsage.set(peer, [.4, .6]);
  await refresh(peer);
  assert.equal(claudePool.markExhausted(peer, { window: 'model', model: 'claude-sonnet-4-6', until: Date.now() + 120000 }), true);

  assert.equal((await rename(oldName, newName)).status, 200);
  const renamed = await status(newName);
  assert.equal(renamed.quota_scope, 'same-subscription');
  assert.equal(renamed.reason, 'model_cooldown');
  assert.equal(renamed.cooldowns.some(row => row.model === 'sonnet'), true);
  assert.equal(metaRow(oldName), undefined);
  assert.equal(usageRow(oldName), undefined);

  probeUsage.set(peer, [.65, .75]);
  await refresh(peer); // Native Haiku probe must retain a Sonnet-specific block.
  const afterPeerProbe = await status(newName);
  assert.equal(afterPeerProbe.five_hour.remaining_pct, 35);
  assert.equal(afterPeerProbe.seven_day.remaining_pct, 25);
  assert.equal(afterPeerProbe.reason, 'model_cooldown');
  assert.equal(claudePool.markExhausted(newName, { window: 'model', model: 'claude-opus-4-6', until: Date.now() + 180000 }), true);
  assert.equal((await status(peer, 'claude-opus-4-6')).reason, 'model_cooldown');
  assert.equal((await status(newName, 'claude-opus-4-6')).reason, 'model_cooldown');
});

test('HTTP rename moves default account scope model blocks without relying on the token scope fallback', async () => {
  const oldName = 'default-original', newName = 'default-renamed';
  const { fingerprint } = await add(oldName);
  await refresh(oldName);
  claudePool.markExhausted(oldName, { window: 'model', model: 'claude-sonnet-4-6', until: Date.now() + 180000 });
  // Isolate the default account block: the token block would otherwise mask a
  // dropped account:<name> block and make this regression pass accidentally.
  db.prepare('DELETE FROM claude_pool_blocks WHERE scope_key=?').run('token:' + fingerprint);
  assert.equal((await status(oldName)).reason, 'model_cooldown');
  const originalBlock = db.prepare('SELECT * FROM claude_pool_blocks WHERE scope_key=?').get('account:' + oldName);
  assert.ok(originalBlock);

  assert.equal((await rename(oldName, newName)).status, 200);
  assert.equal((await status(newName)).quota_scope, newName);
  assert.equal((await status(newName)).reason, 'model_cooldown');
  assert.equal(db.prepare('SELECT * FROM claude_pool_blocks WHERE scope_key=?').get('account:' + oldName), undefined);
  assert.deepEqual({ ...db.prepare('SELECT * FROM claude_pool_blocks WHERE scope_key=?').get('account:' + newName), scope_key: originalBlock.scope_key }, { ...originalBlock });
  await refresh(newName);
  assert.equal((await status(newName)).reason, 'model_cooldown');
  assert.equal((await status(newName, 'claude-haiku-4-5')).eligible, true);
});

test('label-only HTTP PATCH preserves exact metadata, usage and model cooldown state', async () => {
  const name = 'label-only';
  await add(name);
  const expires = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await metadata(name, { quota_scope: 'label-subscription', credential_expires_at: expires })).status, 200);
  await refresh(name);
  claudePool.markExhausted(name, { window: 'model', model: 'claude-sonnet-4-6', until: Date.now() + 120000 });
  const beforeMeta = metaRow(name), beforeUsage = usageRow(name), beforeBlocks = blocks();

  const response = await admin(accountPath(name), 'PATCH', { label: 'changed label only' });
  assert.equal(response.status, 200);
  assert.deepEqual(metaRow(name), beforeMeta);
  assert.deepEqual(usageRow(name), beforeUsage);
  assert.deepEqual(blocks(), beforeBlocks);
  const updated = await status(name);
  assert.equal(updated.label, 'changed label only');
  assert.equal(updated.quota_scope, 'label-subscription');
  assert.equal(updated.credential_expires_at, expires);
  assert.equal(updated.reason, 'model_cooldown');
});

test('HTTP rename rolls back the account, metadata, usage and blocks when a metadata rename write aborts', async () => {
  const oldName = 'rollback-original', newName = 'rollback-target';
  await add(oldName);
  assert.equal((await metadata(oldName, { credential_expires_at: new Date(Date.now() + 86400000).toISOString() })).status, 200);
  await refresh(oldName);
  claudePool.markExhausted(oldName, { window: 'model', model: 'claude-sonnet-4-6', until: Date.now() + 120000 });
  const accountRow = db.prepare('SELECT * FROM accounts WHERE account=?');
  const beforeAccount = accountRow.get(oldName), beforeMeta = metaRow(oldName), beforeUsage = usageRow(oldName), beforeBlocks = blocks();
  db.exec(`CREATE TEMP TRIGGER reject_pool_metadata_rename BEFORE UPDATE OF account ON claude_pool_metadata
    WHEN NEW.account='rollback-target' BEGIN SELECT RAISE(ABORT, 'injected pool metadata rename failure'); END`);
  try {
    const response = await rename(oldName, newName, 'must roll back too');
    assert.equal(response.status, 500, 'the injected database fault must fail the HTTP mutation');
    assert.deepEqual(accountRow.get(oldName), beforeAccount);
    assert.deepEqual(metaRow(oldName), beforeMeta);
    assert.deepEqual(usageRow(oldName), beforeUsage);
    assert.deepEqual(blocks(), beforeBlocks);
    assert.equal(accountRow.get(newName), undefined);
    assert.equal(metaRow(newName), undefined);
    assert.equal(usageRow(newName), undefined);
  } finally { db.exec('DROP TRIGGER reject_pool_metadata_rename'); }
  assert.equal((await status(oldName)).reason, 'model_cooldown');
  assert.equal((await rename(oldName, newName)).status, 200, 'rollback releases the savepoint and allows a later valid rename');
  assert.equal((await status(newName)).reason, 'model_cooldown');
});

test('a native probe started before HTTP rename cannot revive the renamed identity after newer exhaustion', async () => {
  const oldName = 'inflight-original', newName = 'inflight-renamed';
  await add(oldName);
  await refresh(oldName);
  let arrived;
  const admitted = new Promise(resolve => { arrived = resolve; });
  pendingProbes.set(oldName, { arrived });
  const oldRefresh = admin(accountPath(oldName) + '/refresh', 'POST', {});
  const finishProbe = await admitted;
  try {
    assert.equal((await rename(oldName, newName)).status, 200);
    assert.equal(claudePool.markExhausted(newName, { window: 'account', until: Date.now() + 120000 }), true);
  } finally { finishProbe(); }
  await oldRefresh;
  const current = await status(newName);
  assert.equal(current.eligible, false);
  assert.equal(current.reason, 'exhausted');
  assert.equal(metaRow(oldName), undefined);
  assert.equal(usageRow(oldName), undefined);
  assert.equal((await status(oldName)), undefined);
});
