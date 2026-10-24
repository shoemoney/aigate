import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { open } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVault } from '../src/lib.js';

const dir = mkdtempSync(join(tmpdir(), 'aigate-claude-boundaries-'));
const key = randomBytes(32), adminToken = randomBytes(24).toString('hex'), gateway = 'local-boundary-gateway';
Object.assign(process.env, { AIGATE_DB: join(dir, 'vault.db'), AIGATE_ENCRYPTION_KEY: key.toString('hex'), AIGATE_TOKEN: adminToken,
  AIGATE_PROXY_TOKEN: gateway, AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0' });
delete process.env.AIGATE_PROXY_TOKEN_2; delete process.env.AIGATE_ALLOW_CIDR;
const { server, db, claudePool } = await import('../src/server.js');
const vault = makeVault(key), hits = [];
let base, activeGate, prototype, originalWrite, originalSync, upstreamHandler;
const events = new Map();
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const deadline = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout')), 5000); })]); } finally { clearTimeout(timer); } };
const upstream = http.createServer((req, res) => { hits.push(req.headers.authorization); req.resume(); upstreamHandler(req, res); });
const admin = (path, method = 'GET', body) => fetch(base + path, { method, headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const consumer = () => fetch(base + '/proxy/claude-code/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + gateway, 'content-type': 'application/json' }, body: '{"model":"claude-sonnet-4-6","max_tokens":5,"messages":[]}' });
const visibleConsumer = (model = 'claude-sonnet-4-6') => new Promise((resolve, reject) => {
  const information = [], request = http.request(base + '/proxy/claude-code/v1/messages', { method: 'POST',
    headers: { authorization: 'Bearer ' + gateway, 'content-type': 'application/json' } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
    response.on('end', () => resolve({ status: response.statusCode, statusMessage: response.statusMessage,
      headers: response.headers, trailers: response.rawTrailers, body: Buffer.concat(chunks), information }));
  });
  request.on('information', info => information.push({ status: info.statusCode, headers: info.headers }));
  request.on('error', reject); request.end(JSON.stringify({ model, max_tokens: 5, messages: [] }));
});
const gateEvent = (predicate, fail = false) => { activeGate = { predicate, fail, entered: deferred(), release: deferred(), used: false }; return activeGate; };
const latestId = () => db.prepare('SELECT coalesce(max(id),0) id FROM proxy_traffic').get().id;
const recordAfter = async id => {
  for (let i = 0; i < 500; i++) {
    const row = db.prepare('SELECT id,state FROM proxy_traffic WHERE id>? ORDER BY id LIMIT 1').get(id);
    if (row && row.state !== 'running') return (await admin(`/api/proxy/traffic/${row.id}?limit=1000`)).json();
    await new Promise(resolve => setTimeout(resolve, 5));
  } throw new Error('capture never settled');
};
const reset = () => {
  activeGate = null; hits.length = 0; db.prepare('DELETE FROM claude_pool_blocks').run();
  for (const account of ['a', 'b']) claudePool.observeHeaders(account, ['anthropic-ratelimit-unified-5h-utilization', '.1',
    'anthropic-ratelimit-unified-7d-utilization', '.2', 'anthropic-ratelimit-unified-7d-reset', String(Math.floor(Date.now() / 1000) + (account === 'a' ? 100000 : 200000))], { status: 200 });
  upstreamHandler = (_req, res) => res.end('okay');
};
before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.AIGATE_TRANSPARENT_UPSTREAM_CLAUDE_CODE = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  for (const account of ['a', 'b']) assert.equal((await admin('/api/accounts', 'POST', { account, setup_token: 'sk-ant-oat01-manual-boundary-' + account })).status, 200);
  const file = await open(join(dir, 'handle-probe'), 'w'); prototype = Object.getPrototypeOf(file); originalWrite = prototype.writeFile; originalSync = prototype.sync; await file.close();
  prototype.writeFile = async function(data, ...args) {
    try { const record = JSON.parse(vault.decrypt(String(data).trim())); events.set(this.fd, record.event || { ...record, spool: true }); } catch {}
    return originalWrite.call(this, data, ...args);
  };
  prototype.sync = async function(...args) {
    const gate = activeGate, event = events.get(this.fd);
    if (gate && !gate.used && gate.predicate(event)) { gate.used = true; gate.entered.resolve(event); await gate.release.promise; if (gate.fail) throw Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' }); }
    return originalSync.apply(this, args);
  };
});
after(async () => {
  activeGate?.release.resolve(); if (prototype) { prototype.writeFile = originalWrite; prototype.sync = originalSync; }
  await claudePool.stop(); server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  db.close(); rmSync(dir, { recursive: true, force: true });
});

for (const phase of ['request', 'forward']) test(`Claude cancellation during ${phase} fsync prevents upstream admission`, async () => {
  reset(); const id = latestId(), gate = gateEvent(event => event?.type === phase), closed = deferred();
  const onRequest = (req, res) => { if (req.url === '/proxy/claude-code/v1/messages') res.once('close', () => closed.resolve()); };
  server.on('request', onRequest);
  const request = http.request(base + '/proxy/claude-code/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + gateway, 'content-type': 'application/json' } });
  request.on('error', () => {}); request.end('{"model":"claude-sonnet-4-6","messages":[]}');
  try { await deadline(gate.entered.promise); request.destroy(); await deadline(closed.promise); gate.release.resolve(); const row = await recordAfter(id); assert.equal(row.state, 'client_abort'); assert.equal(hits.length, 0); assert.equal(row.events.filter(event => event.type === 'end').length, 1); }
  finally { gate.release.resolve(); activeGate = null; server.off('request', onRequest); request.destroy(); }
});

test('Claude cancellation during failover selection never admits a second upstream', async () => {
  reset(); upstreamHandler = (_req, res) => { res.writeHead(429, { 'anthropic-ratelimit-unified-5h-utilization': '1', 'content-type': 'application/json' }); res.end('{"error":{"type":"rate_limit_error"}}'); };
  const id = latestId(), gate = gateEvent(event => event?.type === 'attempt_decision' && event.decision === 'try_eligible_account'), closed = deferred();
  const onRequest = (req, res) => { if (req.url === '/proxy/claude-code/v1/messages') res.once('close', () => closed.resolve()); }; server.on('request', onRequest);
  const request = http.request(base + '/proxy/claude-code/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + gateway, 'content-type': 'application/json' } }); request.on('error', () => {}); request.end('{"model":"claude-sonnet-4-6","messages":[]}');
  try { await deadline(gate.entered.promise); request.destroy(); await deadline(closed.promise); gate.release.resolve(); const row = await recordAfter(id); assert.equal(row.state, 'client_abort'); assert.equal(hits.length, 1); }
  finally { gate.release.resolve(); activeGate = null; server.off('request', onRequest); request.destroy(); }
});

test('capture or encrypted spool fsync failure stops forwarding before a billable admission', async () => {
  for (const spool of [false, true]) {
    reset(); const id = latestId(), gate = gateEvent(event => spool ? event?.spool && event.type === 'body' : event?.type === 'forward', true);
    const result = consumer().then(async response => ({ status: response.status, text: await response.text() }), error => ({ error }));
    await deadline(gate.entered.promise); gate.release.resolve(); await deadline(result);
    const row = await recordAfter(id); assert.equal(hits.length, 0); assert.ok(['error', 'logging_error'].includes(row.state));
  }
});

test('deadline closes upstream before terminal fsync and admits one error despite competing connection failure', async () => {
  reset(); const arrived = deferred(); upstreamHandler = req => arrived.resolve(req.socket);
  process.env.AIGATE_TRANSPARENT_TIMEOUT_MS = '1000';
  const id = latestId(), gate = gateEvent(event => event?.type === 'error' && event.reason === 'Claude proxy deadline exceeded');
  const result = consumer();
  try {
    const socket = await deadline(arrived.promise); await deadline(gate.entered.promise); socket.destroy(); gate.release.resolve();
    const response = await deadline(result); assert.equal(response.status, 504); await response.text();
    const row = await recordAfter(id); assert.equal(row.state, 'error'); assert.equal(row.events.filter(event => event.type === 'error').length, 1); assert.equal(row.events.filter(event => event.type === 'end').length, 1); assert.equal(hits.length, 1);
  } finally { gate.release.resolve(); activeGate = null; delete process.env.AIGATE_TRANSPARENT_TIMEOUT_MS; }
});

test('an upstream informational response prevents hidden quota failover', async () => {
  reset(); upstreamHandler = (_req, res) => { res.writeEarlyHints({ link: '</app.css>; rel=preload' }); res.writeHead(429, { 'anthropic-ratelimit-unified-5h-utilization': '1', 'content-type': 'text/plain' }); res.end('original quota response'); };
  const id = latestId(), response = await consumer(); assert.equal(response.status, 429); assert.equal(await response.text(), 'original quota response');
  const row = await recordAfter(id); assert.equal(hits.length, 1); assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 1); assert.ok(row.events.some(event => event.type === 'information' && event.status === 103));
});

for (const [claim, positive] of [['five_hour', false], ['seven_day', false], ['seven_day_sonnet', false], ['seven_day_sonnet', true]]) test(`visible103 preserves ${claim} refusal with ${positive ? 'positive utilization' : 'claim-only headers'} and blocks the next matching request`, async () => {
  reset(); const resetAt = Math.floor(Date.now() / 1000) + 500, body = Buffer.from('original quota response\nwith every byte preserved');
  const revision = db.prepare("SELECT revision FROM claude_pool_usage WHERE account='a'").get().revision;
  upstreamHandler = (_req, res) => {
    res.writeEarlyHints({ link: '</app.css>; rel=preload' });
    res.writeHead(429, 'Original Quota Refusal', { 'content-type': 'text/plain', 'retry-after': '17',
      'x-original': ['first', 'second'], Trailer: 'X-Quota-Trailer', 'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': claim, 'anthropic-ratelimit-unified-reset': String(resetAt),
      ...(positive ? { 'anthropic-ratelimit-unified-5h-utilization': '.1', 'anthropic-ratelimit-unified-7d-utilization': '.2' } : {}) });
    res.write(body.subarray(0, 9)); res.addTrailers({ 'X-Quota-Trailer': 'original trailer' }); res.end(body.subarray(9));
  };
  const id = latestId(), response = await visibleConsumer(), row = await recordAfter(id);
  assert.equal(response.status, 429); assert.equal(response.statusMessage, 'Original Quota Refusal'); assert.deepEqual(response.body, body);
  assert.equal(response.headers['retry-after'], '17'); assert.equal(response.headers['x-original'], 'first, second');
  assert.deepEqual(response.trailers, ['X-Quota-Trailer', 'original trailer']);
  assert.deepEqual(response.information, [{ status: 103, headers: { link: '</app.css>; rel=preload' } }]);
  assert.deepEqual(hits, ['Bearer sk-ant-oat01-manual-boundary-a']); assert.equal(row.state, 'complete');
  const starts = row.events.filter(event => event.type === 'attempt_start'); assert.equal(starts.length, 1);
  const attemptId = starts[0].attempt_id;
  assert.equal(row.events.find(event => event.type === 'attempt_response').withheld, false);
  const outcomes = row.events.filter(event => event.type === 'attempt_outcome'); assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].attempt_id, attemptId); assert.equal(outcomes[0].outcome, 'quota_refused'); assert.equal(outcomes[0].cooldown_applied, true);
  assert.deepEqual(row.events.filter(event => event.type === 'attempt_decision').map(event => [event.attempt_id, event.decision, event.reason]),
    [[attemptId, 'return_quota_response', 'response_already_visible']]);
  for (const type of ['attempt_response_body', 'response_body']) assert.deepEqual(Buffer.concat(row.events.filter(event => event.type === type)
    .map(event => Buffer.from(event.data, 'base64'))), body);
  for (const type of ['attempt_response_end', 'response_end']) assert.deepEqual(row.events.find(event => event.type === type).trailers, response.trailers);
  assert.equal(row.events.filter(event => event.type === 'end').length, 1);
  assert.equal(db.prepare("SELECT revision FROM claude_pool_usage WHERE account='a'").get().revision, revision + (positive ? 2 : 1), 'record the refusal once, independently of utilization');
  const state = claudePool.status({ model: 'claude-sonnet-4-6' }), a = state.accounts.find(account => account.account === 'a');
  assert.equal(a.eligible, false); assert.equal(a.five_hour.remaining_pct, 90); assert.equal(a.seven_day.remaining_pct, 80);
  assert.equal(a.cooldown_until, new Date(resetAt * 1000).toISOString());
  assert.deepEqual(a.cooldowns, claim === 'seven_day_sonnet' ? [{ model: 'sonnet', until: new Date(resetAt * 1000).toISOString() }] : []);
  assert.deepEqual(db.prepare('SELECT DISTINCT model_family,window,until_ms,reason FROM claude_pool_blocks').all().map(block => ({ ...block })),
    [{ model_family: claim === 'seven_day_sonnet' ? 'sonnet' : '', window: claim === 'seven_day_sonnet' ? 'model' : claim,
      until_ms: resetAt * 1000, reason: claim === 'seven_day_sonnet' ? 'model_quota_exhausted' : 'quota_exhausted' }]);
  assert.equal(state.accounts.find(account => account.account === 'b').eligible, true);
  assert.equal(claudePool.status({ model: 'claude-opus-4-6' }).accounts.find(account => account.account === 'a').eligible, claim === 'seven_day_sonnet');
  upstreamHandler = (_req, res) => res.end('next request'); const nextId = latestId(), next = await visibleConsumer();
  assert.equal(next.status, 200); assert.equal(next.body.toString(), 'next request'); await recordAfter(nextId);
  assert.deepEqual(hits, ['Bearer sk-ant-oat01-manual-boundary-a', 'Bearer sk-ant-oat01-manual-boundary-b']);
});

for (const change of ['credential', 'scope']) test(`visible quota refusal cannot block a newer ${change} generation`, async () => {
  reset(); upstreamHandler = (_req, res) => {
    res.writeEarlyHints({ link: '</app.css>; rel=preload' });
    res.writeHead(429, { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_sonnet',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 500) }); res.end('original refusal');
  };
  const id = latestId(), gate = gateEvent(event => event?.type === 'attempt_response'), pending = visibleConsumer();
  try {
    await deadline(gate.entered.promise);
    if (change === 'credential') assert.equal((await admin('/api/accounts', 'POST', { account: 'a', setup_token: 'sk-ant-oat01-new-boundary-credential' })).status, 200);
    else claudePool.setMetadata('a', { quota_scope: 'new-boundary-scope' });
    claudePool.observeHeaders('a', ['anthropic-ratelimit-unified-5h-utilization', '.1', 'anthropic-ratelimit-unified-7d-utilization', '.2'], { status: 200 });
    const revision = db.prepare("SELECT revision FROM claude_pool_usage WHERE account='a'").get().revision;
    gate.release.resolve(); const response = await deadline(pending), row = await recordAfter(id);
    assert.equal(response.status, 429); assert.equal(response.body.toString(), 'original refusal'); assert.equal(hits.length, 1);
    assert.equal(row.events.find(event => event.type === 'attempt_outcome').cooldown_applied, false);
    assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM claude_pool_blocks').get().n, 0);
    assert.equal(db.prepare("SELECT revision FROM claude_pool_usage WHERE account='a'").get().revision, revision);
    assert.equal(claudePool.status({ model: 'claude-sonnet-4-6' }).accounts.find(account => account.account === 'a').eligible, true);
  } finally {
    gate.release.resolve(); activeGate = null;
    if (change === 'credential') await admin('/api/accounts', 'POST', { account: 'a', setup_token: 'sk-ant-oat01-manual-boundary-a' });
    else claudePool.setMetadata('a', { quota_scope: null });
  }
});

for (const [label, status, claim, model] of [['bare429', 429, null, 'claude-sonnet-4-6'],
  ['overload529', 529, 'seven_day_sonnet', 'claude-sonnet-4-6'], ['unrelated family', 429, 'seven_day_opus', 'claude-sonnet-4-6'],
  ['partial family name', 429, 'seven_day_sonnet', 'claude-sonnetish-4-6']]) test(`visible103 ${label} does not exhaust or retry`, async () => {
  reset(); upstreamHandler = (_req, res) => {
    res.writeEarlyHints({ link: '</app.css>; rel=preload' });
    res.writeHead(status, { 'content-type': 'text/plain', ...(claim ? { 'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': claim, 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 500) } : {}) });
    res.end('original refusal');
  };
  const id = latestId(), response = await visibleConsumer(model), row = await recordAfter(id);
  assert.equal(response.status, status); assert.equal(response.body.toString(), 'original refusal'); assert.equal(response.information[0].status, 103);
  assert.equal(hits.length, 1); assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 1);
  assert.deepEqual(row.events.filter(event => event.type === 'attempt_decision'), []);
  assert.equal(row.events.find(event => event.type === 'attempt_outcome').outcome, 'forwarded');
  assert.equal(claudePool.status({ model }).accounts.find(account => account.account === 'a').eligible, true);
  assert.equal(db.prepare('SELECT count(*) n FROM claude_pool_blocks').get().n, 0);
  upstreamHandler = (_req, res) => res.end('next request'); const nextId = latestId(); await visibleConsumer(model); await recordAfter(nextId);
  assert.deepEqual(hits, ['Bearer sk-ant-oat01-manual-boundary-a', 'Bearer sk-ant-oat01-manual-boundary-a']);
});
