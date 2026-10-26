import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FIREWALL_META_KEY } from '../src/firewall.js';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-firewall-server-'));
const ADMIN = randomBytes(24).toString('hex');
const PROXY = 'firewall-fixture-proxy-only';
const PASSWORD = 'firewall-fixture-dashboard-password';
Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'), AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AIGATE_TOKEN: ADMIN, AIGATE_DASHBOARD_PASSWORD: PASSWORD, AIGATE_PROXY_TOKEN: PROXY,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0', AIGATE_ALERT_WEBHOOK: '',
  AIGATE_ALLOW_CIDR: '192.0.2.0/24,fd7a:115c:a1e0::/48',
  AIGATE_TRUST_PROXY: '1', AIGATE_TRUSTED_PROXIES: '127.0.0.1',
});
const { server, db } = await import('../src/server.js');
let base, hits = 0;
const sockets = new Set();
server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const upstream = http.createServer((req, res) => { hits++;req.resume();res.end('local fixture response'); });
const initialRules = [{ cidr: '192.0.2.0/24', label: 'fixture LAN' }, { cidr: 'fd7a:115c:a1e0::/48', label: 'fixture IPv6' }];

async function request(path, { method = 'GET', data, token = ADMIN, headers = {}, raw } = {}) {
  const response = await fetch(base + path, {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
const policy = () => request('/api/firewall');
async function save(rules = initialRules, enabled = true, extra = {}) {
  const current = await policy();
  return request('/api/firewall', { method: 'PUT', data: { revision: current.body.revision, enabled, rules }, ...extra });
}
function rawExchange(text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let result = '';
    socket.setTimeout(2500, () => { socket.destroy();reject(new Error('raw request did not close')); });
    socket.on('connect', () => socket.end(text));
    socket.on('data', (chunk) => { result += chunk; });
    socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(result));
  });
}
function openWs(ip) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', ['aigate', 'bearer.' + ADMIN], { headers: { 'x-forwarded-for': ip } });
    ws.once('message', () => resolve(ws));ws.once('error', reject);
  });
}

before(async () => {
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  process.env.AIGATE_TRANSPARENT_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const result = await request('/api/proxy/credentials', { method: 'POST', data: { provider: 'anthropic', kind: 'api_key', fields: { api_key: 'test-only-manually-added-provider-key' } } });
  assert.equal(result.status, 201);
});
beforeEach(async () => {
  process.env.AIGATE_TRUST_PROXY = '1';process.env.AIGATE_TRUSTED_PROXIES = '127.0.0.1';
  assert.equal((await save()).status, 200);
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  server.closeAllConnections();upstream.closeAllConnections();
  await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  db.close();rmSync(TMP, { recursive: true, force: true });
});

test('firewall management requires administrator bearer/session; proxy-only keys cannot read or write', async () => {
  const before = (await policy()).body;
  for (const token of [null, PROXY]) {
    assert.equal((await request('/api/firewall', { token })).status, 401);
    assert.equal((await request('/api/firewall', { method: 'PUT', token, data: { revision: before.revision, enabled: false, rules: [] } })).status, 401);
  }
  const login = await request('/api/login', { method: 'POST', token: null, data: { password: PASSWORD } });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const browser = await request('/api/firewall', { token: null, headers: { cookie } });
  assert.equal(browser.status, 200);
  assert.equal(browser.body.client_ip, '127.0.0.1');
  assert.equal(browser.body.peer_ip, '127.0.0.1');
  assert.equal(browser.body.loopback_always_allowed, true);
  const saved = await request('/api/firewall', { method: 'PUT', token: null, headers: { cookie }, data: { revision: browser.body.revision, enabled: true, rules: initialRules } });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, before.revision + 1);
});

test('strict policy saves reject invalid JSON, fields, media type and oversized input without changes', async () => {
  const before = (await policy()).body;
  for (const data of [null, [], {}, { revision: before.revision, enabled: true, rules: [] }, { revision: before.revision, enabled: false, rules: [], secret: 'ignored-is-unsafe' }]) {
    const result = await request('/api/firewall', { method: 'PUT', data });
    assert.equal(result.status, 400);assert.equal(result.body.code, 'invalid_policy');
  }
  assert.equal((await request('/api/firewall', { method: 'PUT', raw: '{broken' })).status, 400);
  assert.equal((await request('/api/firewall', { method: 'PUT', data: { revision: before.revision, enabled: false, rules: [] }, headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await request('/api/firewall', { method: 'PUT', raw: 'x'.repeat(1_000_001) })).status, 413);
  assert.equal((await policy()).body.revision, before.revision);
});

test('current observed client is protected against self-lockout and stale revisions cannot overwrite saves', async () => {
  const before = (await policy()).body;
  const denied = await save([{ cidr: '198.51.100.0/24', label: 'other client' }], true, { headers: { 'x-forwarded-for': '192.0.2.10' } });
  assert.equal(denied.status, 409);assert.equal(denied.body.code, 'self_lockout');
  assert.equal((await policy()).body.revision, before.revision);
  const proposals = [false, true].map((enabled) => request('/api/firewall', { method: 'PUT', data: { revision: before.revision, enabled, rules: initialRules } }));
  const results = await Promise.all(proposals);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(results.find((result) => result.status === 409).body.code, 'revision_conflict');
});

test('new rules take immediate effect for HTTP, include IPv6/mapped clients, and ignore stale environment', async () => {
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': '198.51.100.7' } })).status, 403);
  const result = await save([...initialRules, { cidr: '198.51.100.7', label: '<b>render as text</b>' }]);
  assert.equal(result.status, 200);
  for (const ip of ['198.51.100.7', 'fd7a:115c:a1e0:abcd::2', '::ffff:c000:201', '::ffff:192.0.2.1']) assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': ip } })).status, 200, ip);
  process.env.AIGATE_ALLOW_CIDR = '0.0.0.0/0,::/0';
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': 'fe80::1%en0' } })).status, 403);
  const previousHits = hits;
  const proxied = await fetch(base + '/proxy/anthropic/v1/messages', { headers: { authorization: 'Bearer ' + PROXY, 'x-forwarded-for': '198.51.100.7' } });
  assert.equal(proxied.status, 200);assert.equal(await proxied.text(), 'local fixture response');
  assert.equal(hits, previousHits + 1);
  for (let attempt = 0; attempt < 100 && db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n, 0);
});

test('trusted proxy uses the rightmost hop and untrusted peers cannot set their client IP', async () => {
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': '127.0.0.1, 66.249.68.34' } })).status, 403);
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': '66.249.68.34, 192.0.2.10' } })).status, 200);
  process.env.AIGATE_TRUSTED_PROXIES = '192.0.2.200';
  const result = await request('/api/firewall', { headers: { 'x-forwarded-for': '66.249.68.34' } });
  assert.equal(result.status, 200);assert.equal(result.body.client_ip, '127.0.0.1');
});

test('denied HTTP/proxy/upgrade/CONNECT/Expect requests never reach the upstream or create audit/capture rows', async () => {
  const counts = () => ['access_log', 'proxy_traffic'].map((table) => db.prepare('SELECT count(*) AS n FROM ' + table).get().n);
  const previous = counts(), previousHits = hits;
  for (const path of ['/', '/health', '/api/firewall', '/proxy/anthropic/v1/messages']) {
    const result = await request(path, { token: PROXY, headers: { 'x-forwarded-for': '203.0.113.5' } });
    assert.equal(result.status, 403);assert.deepEqual(result.body, { error: 'forbidden (network)' });
  }
  for (const target of ['/ws', '/proxy/anthropic/upgrade']) {
    assert.equal(await rawExchange(`GET ${target} HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: aigate, bearer.${ADMIN}\r\nX-Forwarded-For: 203.0.113.5\r\n\r\n`), '');
  }
  assert.equal(await rawExchange(`CONNECT fixture:443 HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer ${PROXY}\r\nX-Forwarded-For: 203.0.113.5\r\n\r\n`), '');
  const expected = await rawExchange('POST /api/firewall HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 2\r\nX-Forwarded-For: 203.0.113.5\r\n\r\n{}');
  assert.match(expected, /^HTTP\/1\.1 403 /);assert.doesNotMatch(expected, /100 Continue/);
  assert.equal(hits, previousHits);assert.deepEqual(counts(), previous);
});

test('policy changes revoke disallowed dashboard WebSockets while retaining allowed sockets', async () => {
  assert.equal((await save([...initialRules, { cidr: '198.51.100.0/24' }])).status, 200);
  const removed = await openWs('192.0.2.10');
  const retained = await openWs('198.51.100.10');
  try {
    const closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('revoked WebSocket stayed connected')), 2000);
      removed.once('close', () => { clearTimeout(timer);resolve(); });
    });
    const result = await save([{ cidr: '198.51.100.0/24' }], true, { headers: { 'x-forwarded-for': '198.51.100.10' } });
    assert.equal(result.status, 200);await closed;
    assert.equal(retained.readyState, WebSocket.OPEN);
  } finally { removed.terminate();retained.terminate(); }
});

test('failed durable writes and audit failures retain previous policy and enforcement', async () => {
  const before = (await policy()).body;
  const raw = db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v;
  db.exec(`CREATE TRIGGER firewall_write_failure BEFORE UPDATE ON meta WHEN NEW.k='${FIREWALL_META_KEY}' BEGIN SELECT RAISE(ABORT,'fixture write failure'); END`);
  try { assert.equal((await save([], false)).status, 500); } finally { db.exec('DROP TRIGGER firewall_write_failure'); }
  db.exec("CREATE TRIGGER firewall_audit_failure BEFORE INSERT ON access_log WHEN NEW.action='firewall' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  try { assert.equal((await save([], false)).status, 500); } finally { db.exec('DROP TRIGGER firewall_audit_failure'); }
  assert.equal((await policy()).body.revision, before.revision);
  assert.equal(db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v, raw);
  assert.equal((await request('/health', { token: null, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
});
