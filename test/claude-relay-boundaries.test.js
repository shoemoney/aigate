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
