// Unsupported upstream switching protocols is still observed traffic. Keep its
// original headers/head distinct from the generated downstream rejection.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeVault } from '../src/lib.js';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-upstream-upgrade-'));
const ADMIN = randomBytes(24).toString('hex');
const ENC_KEY = randomBytes(32).toString('hex');
const PRESET = 'upstream-upgrade-regression-preset';
const PROVIDER_KEY = 'manually-entered-upstream-upgrade-provider-key';
const HEAD = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x2a, 0x5a, 0x00, 0x11]);
const UPGRADE_HEADERS = [
  'Connection', 'Upgrade',
  'Upgrade', 'fixture-protocol',
  'X-Upstream-Only', 'preserved-upstream-upgrade',
  'X-Duplicate', 'one',
  'X-Duplicate', 'two',
];
const RESPONSE = Buffer.concat([
  Buffer.from('HTTP/1.1 101 Fixture Upgrade\r\n' + UPGRADE_HEADERS.reduce((text, value, index, fields) => (
    index % 2 === 0 ? text + value + ': ' + fields[index + 1] + '\r\n' : text
  ), '') + '\r\n', 'latin1'),
  HEAD,
]);
const sockets = new Set();
const upstreamRequests = [];
let upstreamHandler = socket => socket.write(RESPONSE);
const upstream = net.createServer(socket => {
  sockets.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => sockets.delete(socket));
  socket.setNoDelay(true);
  let received = Buffer.alloc(0);
  const onData = chunk => {
    received = Buffer.concat([received, chunk]);
    if (!received.includes('\r\n\r\n')) return;
    socket.off('data', onData);
    upstreamRequests.push(received.toString('latin1'));
    // One small write puts the original header block and opaque initial bytes in
    // the same response read, exercising the HTTP client's upgrade bodyHead.
    upstreamHandler(socket);
  };
  socket.on('data', onData);
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'),
  AIGATE_ENCRYPTION_KEY: ENC_KEY,
  AIGATE_CODEX_LEDGER: join(TMP, 'ledger.json'),
  AIGATE_TOKEN: ADMIN,
  AIGATE_DASHBOARD_PASSWORD: '',
  AIGATE_PROXY_TOKEN: PRESET,
  AIGATE_PROXY_TOKEN_2: '',
  AIGATE_TRANSPARENT_UPSTREAM_OPENAI: `http://127.0.0.1:${upstream.address().port}`,
  AIGATE_POLL_MS: '0',
  AIGATE_KEY_POLL_MS: '0',
  AIGATE_ALLOW_CIDR: '',
  AIGATE_TRUST_PROXY: '0',
});
const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(ENC_KEY, 'hex'));
let base;

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const deadline = async promise => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('upstream upgrade fixture deadline exceeded')), 8000);
    })]);
  } finally { clearTimeout(timer); }
};
async function holdTimeoutErrorSync() {
  const probe = await open(join(TMP, 'filehandle-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalWrite = prototype.writeFile, originalSync = prototype.sync;
  await probe.close();
  const events = new Map(), entered = deferred(), release = deferred();
  let used = false;
  prototype.writeFile = async function (data, ...args) {
    try { events.set(this.fd, JSON.parse(vault.decrypt(String(data).trim())).event); } catch { /* noncapture fixture data */ }
    return originalWrite.call(this, data, ...args);
  };
  prototype.sync = async function (...args) {
    const event = events.get(this.fd);
    if (!used && event?.type === 'error' && event.reason === 'upstream timed out') {
      used = true; entered.resolve(); await release.promise;
    }
    return originalSync.apply(this, args);
  };
  return { entered, release, restore() { prototype.writeFile = originalWrite; prototype.sync = originalSync; } };
}

const values = (raw, name) => {
  const found = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name.toLowerCase()) found.push(raw[i + 1]);
  return found;
};
const admin = (path, method = 'GET', data) => fetch(base + path, {
  method,
  headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
  body: data === undefined ? undefined : JSON.stringify(data),
});
const request = (path = '/proxy/openai/v1/upstream-switch?opaque=a%2Fb') => new Promise((resolve, reject) => {
  const req = http.get(base + path, {
    headers: { authorization: 'Bearer ' + PRESET },
  }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('upgrade', (_res, socket) => { socket.on('error', () => {}); socket.destroy(); reject(new Error('gateway unexpectedly enabled upstream protocol upgrade')); });
  req.on('error', reject);
});
async function completedCapture() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const list = await (await admin('/api/proxy/traffic')).json();
    if (list.length) {
      const capture = await (await admin('/api/proxy/traffic/' + list[0].id + '?limit=1000')).json();
      if (capture.state !== 'running') return capture;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('upstream upgrade capture did not reach a terminal state');
}

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const created = await admin('/api/proxy/credentials', 'POST', {
    provider: 'openai', kind: 'api_key', fields: { api_key: PROVIDER_KEY },
  });
  assert.equal(created.status, 201);
  await created.arrayBuffer();
});
after(async () => {
  const deadline = Date.now() + 10000;
  while (db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => upstream.close(resolve)),
  ]);
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test('an unsolicited upstream 101 retains its original headers and binary head in encrypted capture while the client receives only 501', { timeout: 15000 }, async () => {
  const result = await request();
  assert.equal(result.status, 501);
  assert.equal(result.headers.upgrade, undefined);
  assert.equal(result.headers['x-upstream-only'], undefined);
  assert.equal(result.body.includes(HEAD), false);
  assert.match(JSON.parse(result.body.toString('utf8')).error.message, /upgraded protocols are not supported/);
  assert.equal(upstreamRequests.length, 1);
  assert.match(upstreamRequests[0], /^GET \/v1\/upstream-switch\?opaque=a%2Fb HTTP\/1\.1\r\n/);
  assert.match(upstreamRequests[0], new RegExp('authorization: Bearer ' + PROVIDER_KEY, 'i'));

  const capture = await completedCapture();
  assert.equal(capture.state, 'error');
  assert.equal(capture.status, 501);
  const upgrade = capture.events.find(event => event.type === 'upstream_upgrade');
  assert.ok(upgrade, 'original upstream switching-protocol response must be recorded');
  assert.equal(upgrade.status, 101);
  assert.equal(upgrade.status_message, 'Fixture Upgrade');
  assert.equal(upgrade.http_version, '1.1');
  assert.equal(upgrade.head_bytes, HEAD.length);
  assert.deepEqual(upgrade.headers, UPGRADE_HEADERS);
  assert.deepEqual(values(upgrade.headers, 'x-duplicate'), ['one', 'two']);

  const observedHead = capture.events.filter(event => event.type === 'upstream_upgrade_body');
  assert.ok(observedHead.length);
  assert.ok(observedHead.every(event => event.encoding === 'base64'));
  assert.deepEqual(Buffer.concat(observedHead.map(event => Buffer.from(event.data, 'base64'))), HEAD);
  const generated = capture.events.find(event => event.type === 'response' && event.generated);
  assert.equal(generated.status, 501);
  assert.ok(capture.events.indexOf(upgrade) < capture.events.indexOf(generated));
  assert.ok(observedHead.every(event => capture.events.indexOf(event) < capture.events.indexOf(generated)));
  assert.deepEqual(Buffer.concat(capture.events.filter(event => event.type === 'response_body').map(event => Buffer.from(event.data, 'base64'))), result.body);
  assert.equal(capture.response_bytes, result.body.length, 'upstream protocol head must not be mixed into downstream body accounting');
  assert.equal(capture.events.at(-1).type, 'end');

  for (const name of readdirSync(join(TMP, 'proxy-traffic'))) {
    const bytes = readFileSync(join(TMP, 'proxy-traffic', name));
    assert.equal(bytes.includes(PROVIDER_KEY), false);
    assert.equal(bytes.includes('preserved-upstream-upgrade'), false);
    assert.equal(bytes.includes(HEAD.toString('base64')), false);
  }
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

test('an admitted timeout closes the real upstream before error fsync completes, preventing a late protocol switch', { timeout: 15000 }, async () => {
  const arrived = deferred();
  upstreamHandler = socket => {
    const closed = deferred();
    socket.once('close', () => closed.resolve());
    arrived.resolve({ socket, closed });
  };
  const gate = await holdTimeoutErrorSync();
  const priorTimeout = process.env.AIGATE_TRANSPARENT_TIMEOUT_MS;
  process.env.AIGATE_TRANSPARENT_TIMEOUT_MS = '1000';
  const pending = request('/proxy/openai/v1/timeout-before-switch');
  pending.catch(() => {});
  try {
    const { socket, closed } = await deadline(arrived.promise);
    await deadline(gate.entered.promise);
    // This closure must occur while the real capture fsync remains held. A
    // deferred teardown would let new upstream bytes arrive after timeout.
    await deadline(closed.promise);
    assert.equal(socket.destroyed, true);
    const lateWrite = deferred();
    let accepted = false, lateError;
    try { accepted = socket.write(RESPONSE, error => lateWrite.resolve(error)); }
    catch (error) { lateError = error; }
    assert.equal(accepted, false);
    lateError ||= await deadline(lateWrite.promise);
    assert.ok(lateError, 'the already-closed real upstream must not accept a late 101 write');

    gate.release.resolve();
    const result = await deadline(pending);
    assert.equal(result.status, 504);
    assert.match(JSON.parse(result.body.toString('utf8')).error.message, /upstream timed out/);
    assert.equal(result.body.includes(HEAD), false);
    const capture = await completedCapture();
    assert.equal(capture.state, 'error');
    assert.equal(capture.status, 504);
    assert.equal(capture.events.filter(event => event.type === 'error').length, 1);
    assert.equal(capture.events.filter(event => event.type === 'response' && event.generated).length, 1);
    assert.equal(capture.events.filter(event => event.type === 'end').length, 1);
    assert.equal(capture.events.some(event => event.type.startsWith('upstream_upgrade')), false, 'unreceived late bytes must not be invented in capture');
    assert.equal((await fetch(base + '/health')).status, 200);
  } finally {
    gate.release.resolve(); gate.restore();
    if (priorTimeout === undefined) delete process.env.AIGATE_TRANSPARENT_TIMEOUT_MS;
    else process.env.AIGATE_TRANSPARENT_TIMEOUT_MS = priorTimeout;
    upstreamHandler = socket => socket.write(RESPONSE);
    await pending.catch(() => {});
  }
});
