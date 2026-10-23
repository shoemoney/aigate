import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { open } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeVault } from '../src/lib.js';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-upgrade-abort-'));
const TOKEN = randomBytes(24).toString('hex');
const KEY = randomBytes(32).toString('hex');
const CLIENT = 'test-only-raw-socket-consumer';
Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'), AIGATE_ENCRYPTION_KEY: KEY,
  AIGATE_CODEX_LEDGER: join(TMP, 'ledger.json'),
  AIGATE_TOKEN: TOKEN, AIGATE_PROXY_TOKEN: CLIENT,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_ALERT_WEBHOOK: '',
});
for (const name of ['AIGATE_ALLOW_CIDR', 'AIGATE_TRUST_PROXY', 'AIGATE_PROXY_TOKEN_2']) delete process.env[name];
const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(KEY, 'hex'));
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const deadline = async (promise, ms = 6000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture deadline exceeded')), ms); })]);
  } finally { clearTimeout(timer); }
};
let base, activeGate, filePrototype, originalWrite, originalSync;
const rawSockets = new Set(), lastEvent = new Map(), upstreamHits = [];
const upstream = http.createServer((req, res) => { upstreamHits.push(req.url); req.resume(); res.end('must not be contacted'); });
server.on('connection', socket => { rawSockets.add(socket); socket.once('close', () => rawSockets.delete(socket)); });
const admin = (path, method = 'GET', data) => fetch(base + path, {
  method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
  body: data ? JSON.stringify(data) : undefined,
});
const latestId = () => db.prepare('SELECT coalesce(max(id),0) AS id FROM proxy_traffic').get().id;
const recordAfter = async id => {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const row = db.prepare('SELECT id,state FROM proxy_traffic WHERE id>? ORDER BY id LIMIT 1').get(id);
    if (row && row.state !== 'running') return (await admin('/api/proxy/traffic/' + row.id + '?limit=1000')).json();
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('raw socket capture did not settle');
};

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.AIGATE_TRANSPARENT_UPSTREAM_OPENAI = `http://127.0.0.1:${upstream.address().port}`;
  const response = await admin('/api/proxy/credentials', 'POST', {
    provider: 'openai', kind: 'api_key', fields: { api_key: 'test-only-manually-added-key' },
  });
  assert.equal(response.status, 201);

  // Block a real encrypted capture fsync at an observed event. This process
  // owns its temporary files; no production hook or fabricated socket error.
  const probe = await open(join(TMP, 'filehandle-probe'), 'w');
  filePrototype = Object.getPrototypeOf(probe);
  originalWrite = filePrototype.writeFile; originalSync = filePrototype.sync;
  await probe.close();
  filePrototype.writeFile = async function (data, ...args) {
    try { lastEvent.set(this.fd, JSON.parse(vault.decrypt(String(data).trim())).event); } catch { /* fixture files */ }
    return originalWrite.call(this, data, ...args);
  };
  filePrototype.sync = async function (...args) {
    const gate = activeGate;
    if (gate && !gate.used && lastEvent.get(this.fd)?.type === gate.phase) {
      gate.used = true; gate.entered.resolve(); await gate.release.promise;
    }
    return originalSync.apply(this, args);
  };
});

after(async () => {
  activeGate?.release.resolve();
  if (filePrototype) { filePrototype.writeFile = originalWrite; filePrototype.sync = originalSync; }
  for (const socket of rawSockets) socket.destroy();
  server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  db.close(); rmSync(TMP, { recursive: true, force: true });
});

for (const protocol of ['connect', 'upgrade']) for (const phase of ['request', 'response']) {
  test(`${protocol} peer reset during ${phase} capture is consumed and finalizes the rejected exchange`, { timeout: 10000 }, async () => {
    const id = latestId(), hits = upstreamHits.length;
    const gate = { phase, entered: deferred(), release: deferred(), used: false };
    activeGate = gate;
    const handedOff = deferred(), socketError = deferred(), closed = deferred();
    const target = protocol === 'connect' ? `abort-${phase}.example:443` : `/proxy/openai/v1/upgrade-${phase}`;
    const head = Buffer.from(`already-received\0${protocol}-${phase}`);
    let observedHead;
    const onHandoff = (req, socket, initialHead) => {
      if (req.url !== target) return;
      observedHead = Buffer.from(initialHead);
      // Observe the real error without adding a test error listener that could
      // mask the production listener omission being regressed.
      const emit = socket.emit;
      socket.emit = function (event, ...args) {
        if (event === 'error') socketError.resolve(args[0]);
        return emit.call(this, event, ...args);
      };
      socket.once('close', () => closed.resolve());
      handedOff.resolve(socket);
    };
    server.on(protocol, onHandoff);
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', () => {});
    try {
      await deadline(new Promise(resolve => client.once('connect', resolve)));
      const request = protocol === 'connect'
        ? `CONNECT ${target} HTTP/1.1\r\nHost: ignored.example:443\r\nAuthorization: Bearer ${CLIENT}\r\n\r\n`
        : `GET ${target} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${CLIENT}\r\nConnection: Upgrade\r\nUpgrade: test-protocol\r\n\r\n`;
      client.write(Buffer.concat([Buffer.from(request), head]));
      await deadline(handedOff.promise);
      await deadline(gate.entered.promise);
      client.resetAndDestroy();
      const error = await deadline(socketError.promise);
      assert.equal(error.code, 'ECONNRESET');
      await deadline(closed.promise);
      gate.release.resolve();
      const record = await recordAfter(id);
      assert.equal(record.state, 'client_abort');
      assert.equal(record.events.filter(event => event.type === 'end').length, 1);
      assert.equal(record.events.at(-1).socket_error, 'ECONNRESET');
      assert.deepEqual(observedHead, head);
      const captured = Buffer.concat(record.events.filter(event => event.type === 'request_body').map(event => Buffer.from(event.data, 'base64')));
      assert.deepEqual(captured, head);
      assert.equal(record.events.filter(event => event.type === 'response').length, phase === 'response' ? 1 : 0);
      assert.equal(upstreamHits.length, hits);
      assert.equal((await admin('/health')).status, 200);
    } finally {
      gate.release.resolve(); activeGate = null;
      client.destroy(); server.off(protocol, onHandoff);
    }
  });
}
