import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { open } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeVault } from '../src/lib.js';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-failure-boundaries-'));
const TOKEN = randomBytes(24).toString('hex');
const KEY = randomBytes(32).toString('hex');
const CLIENT = 'test-only-failure-boundary-client';
Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'), AIGATE_ENCRYPTION_KEY: KEY,
  AIGATE_TOKEN: TOKEN, AIGATE_PROXY_TOKEN: CLIENT,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0',
});
for (const name of ['AIGATE_ALLOW_CIDR', 'AIGATE_TRUST_PROXY', 'AIGATE_PROXY_TOKEN_2']) delete process.env[name];
const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(KEY, 'hex'));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const deadline = async (promise, ms = 6000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms); })]);
  } finally { clearTimeout(timer); }
};
let base, upstreamBase, activeGate, filePrototype, originalWrite, originalSync;
const lastEvent = new Map();
const hits = [];
let upstreamHandler = (req, res) => { req.resume(); res.end('upstream is responsive'); };
const upstream = http.createServer((req, res) => { hits.push(req.url); upstreamHandler(req, res); });
const admin = (path, method = 'GET', data) => fetch(base + path, {
  method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
  body: data ? JSON.stringify(data) : undefined,
});
const consumer = path => fetch(base + path, { headers: { authorization: 'Bearer ' + CLIENT } });
const gateEvent = predicate => {
  const gate = { predicate, entered: deferred(), release: deferred(), used: false };
  activeGate = gate;
  return gate;
};
const recordAfter = async id => {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const row = db.prepare('SELECT id,state FROM proxy_traffic WHERE id>? ORDER BY id LIMIT 1').get(id);
    if (row && row.state !== 'running') return (await admin('/api/proxy/traffic/' + row.id + '?limit=1000')).json();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('capture did not settle');
};
const latestId = () => db.prepare('SELECT coalesce(max(id),0) AS id FROM proxy_traffic').get().id;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.AIGATE_TRANSPARENT_UPSTREAM_OPENAI = upstreamBase;
  const response = await admin('/api/proxy/credentials', 'POST', {
    provider: 'openai', kind: 'api_key', fields: { api_key: 'test-only-manually-provisioned-provider-key' },
  });
  assert.equal(response.status, 201);

  // Delay a real capture fsync at a specific encrypted event, without adding a
  // production hook or replacing the transport. Every test file has its own
  // process; this patch never touches any user or other fixture's data.
  const probe = await open(join(TMP, 'filehandle-probe'), 'w');
  filePrototype = Object.getPrototypeOf(probe);
  originalWrite = filePrototype.writeFile;
  originalSync = filePrototype.sync;
  await probe.close();
  filePrototype.writeFile = async function (data, ...args) {
    try { lastEvent.set(this.fd, JSON.parse(vault.decrypt(String(data).trim())).event); } catch { /* noncapture fixture file */ }
    return originalWrite.call(this, data, ...args);
  };
  filePrototype.sync = async function (...args) {
    const gate = activeGate;
    const event = lastEvent.get(this.fd);
    if (gate && !gate.used && gate.predicate(event)) {
      gate.used = true;
      gate.entered.resolve(event);
      await gate.release.promise;
    }
    return originalSync.apply(this, args);
  };
});

after(async () => {
  activeGate?.release.resolve();
  if (filePrototype) { filePrototype.writeFile = originalWrite; filePrototype.sync = originalSync; }
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  db.close(); rmSync(TMP, { recursive: true, force: true });
});

for (const phase of ['request', 'forward']) {
  test(`client cancellation during ${phase} capture setup never contacts upstream and settles the record`, async () => {
    const path = '/proxy/openai/v1/abort-' + phase;
    const beforeId = latestId(), beforeHits = hits.length;
    const gate = gateEvent(event => event?.type === phase && event.target.endsWith('/abort-' + phase));
    const closed = deferred();
    const onRequest = (req, res) => { if (req.url === path) res.once('close', () => closed.resolve()); };
    server.on('request', onRequest);
    const request = http.request(base + path, { headers: { authorization: 'Bearer ' + CLIENT } });
    request.on('error', () => {});
    request.end();
    try {
      await deadline(gate.entered.promise);
      request.destroy();
      await deadline(closed.promise);
      // Release only after the server has observed downstream closure. This
      // tests a fully parsed request whose response closed during async setup.
      gate.release.resolve();
      const record = await recordAfter(beforeId);
      assert.equal(record.state, 'client_abort');
      assert.equal(record.events.at(-1).type, 'end');
      assert.equal(record.events.at(-1).state, 'client_abort');
      assert.equal(record.events.some(event => event.type === 'response'), false);
      assert.equal(hits.length, beforeHits);
      assert.equal((await admin('/health')).status, 200);
    } finally {
      gate.release.resolve(); activeGate = null;
      server.off('request', onRequest); request.destroy();
    }
  });
}

test('overlapping timeout and connection error during capture fsync generate one response and keep the daemon alive', async () => {
  const beforeId = latestId();
  const gate = gateEvent(event => event?.type === 'error' && event.reason === 'upstream timed out');
  const arrived = deferred(), connectionError = deferred();
  upstreamHandler = (req, _res) => { req.resume(); arrived.resolve(req.socket); };
  process.env.AIGATE_TRANSPARENT_TIMEOUT_MS = '1000';
  const originalRequest = http.request;
  http.request = function (destination, options, ...args) {
    const request = originalRequest.call(this, destination, options, ...args);
    if (destination instanceof URL && destination.port === new URL(upstreamBase).port && options?.path === '/v1/error-race') {
      request.once('error', error => connectionError.resolve(error));
    }
    return request;
  };
  const responsePromise = consumer('/proxy/openai/v1/error-race');
  try {
    const socket = await deadline(arrived.promise);
    await deadline(gate.entered.promise);
    // The timeout is admitted but blocked in durable logging. A separate
    // upstream connection error now reaches the proxy before logging resumes.
    socket.destroy();
    const error = await deadline(connectionError.promise);
    assert.equal(error.code, 'ECONNRESET');
    gate.release.resolve();
    const response = await deadline(responsePromise);
    assert.equal(response.status, 504);
    assert.equal(response.headers.has('date'), false);
    assert.match(await response.text(), /upstream timed out/);
    const record = await recordAfter(beforeId);
    assert.equal(record.state, 'error');
    assert.equal(record.events.filter(event => event.type === 'error').length, 1);
    assert.equal(record.events.filter(event => event.type === 'response' && event.generated).length, 1);
    assert.equal(record.events.filter(event => event.type === 'end').length, 1);
    assert.equal((await admin('/health')).status, 200);
    activeGate = null;
    upstreamHandler = (req, res) => { req.resume(); res.end('upstream is responsive'); };
    const next = await consumer('/proxy/openai/v1/still-alive');
    assert.equal(next.status, 200);
    assert.equal(await next.text(), 'upstream is responsive');
    await recordAfter(record.id);
  } finally {
    gate.release.resolve(); activeGate = null;
    http.request = originalRequest;
    delete process.env.AIGATE_TRANSPARENT_TIMEOUT_MS;
    await responsePromise.catch(() => {});
  }
});
