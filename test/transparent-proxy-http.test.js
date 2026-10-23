import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, readdirSync, renameSync } from 'node:fs';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-transparent-'));
const TOKEN = randomBytes(24).toString('hex');
const REAL = 'sk-real-only-manually-entered-for-test';
const CLIENT = '11111111111';
Object.assign(process.env, { AIGATE_DB: join(TMP, 'test.db'), AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AIGATE_TOKEN: TOKEN, AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0' });
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;
const { server, db } = await import('../src/server.js');
let base, upstreamBase, binding, credential;
let handler = (req, res) => { const body = []; req.on('data', c => body.push(c)); req.on('end', () => res.end(Buffer.concat(body))); };
const hits = [];
const upstream = http.createServer((req, res) => { hits.push({ method: req.method, target: req.url, rawHeaders: req.rawHeaders, headers: req.headers }); handler(req, res); });
const admin = (path, method = 'GET', data) => fetch(base + path, { method, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
const client = (path, options = {}) => fetch(base + path, { ...options, headers: { authorization: 'Bearer ' + CLIENT, ...options.headers } });
const latest = async () => (await (await admin('/api/proxy/traffic')).json())[0];
const detail = async id => {
  for (let i = 0; i < 100; i++) {
    const record = await (await admin('/api/proxy/traffic/' + id + '?limit=1000')).json();
    if (record.state !== 'running') return record;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('capture did not finish');
};
const bodyOf = (record, direction) => Buffer.concat(record.events.filter(e => e.type === direction + '_body').map(e => Buffer.from(e.data, 'base64')));
const rawRequest = (path, headers, data, method = 'POST') => new Promise((resolve, reject) => {
  const req = http.request(base + path, { method, headers: ['Host', new URL(base).host, ...headers] }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, headers: res.headers, body: Buffer.concat(chunks), trailers: res.rawTrailers })); });
  req.on('error', reject); req.end(data);
});

before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  await new Promise(r => upstream.listen(0, '127.0.0.1', r)); upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  credential = await (await admin('/api/proxy/credentials', 'POST', { provider: 'openai', kind: 'api_key', fields: { api_key: REAL } })).json();
  binding = await (await admin('/api/proxy/clients', 'POST', { provider: 'openai', token: CLIENT, credential_id: credential.id, upstream: upstreamBase })).json();
});
after(() => { server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); db.close(); rmSync(TMP, { recursive: true, force: true }); });

test('credential and alias creation is manual, encrypted and admin-only', async () => {
  assert.ok(credential.id); assert.ok(binding.id);
  assert.deepEqual(credential.fields, ['api_key']);
  assert.equal(JSON.stringify(await (await admin('/api/proxy/credentials')).json()).includes(REAL), false);
  assert.equal(db.prepare('SELECT fields_enc FROM proxy_credentials').get().fields_enc.includes(REAL), false);
  assert.equal(db.prepare('SELECT token_hash FROM proxy_clients').get().token_hash.includes(CLIENT), false);
  assert.equal((await client('/api/proxy/credentials')).status, 401);
  assert.equal((await client('/api/proxy/clients', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await admin('/api/proxy/clients', 'POST', { provider: 'openai', token: TOKEN, credential_id: credential.id })).status, 400);
  const n = db.prepare('SELECT count(*) AS n FROM proxy_credentials').get().n;
  assert.equal((await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: 'Bearer unknown123' }, body: '{"api_key":"sneak-in"}' })).status, 401);
  assert.equal(db.prepare('SELECT count(*) AS n FROM proxy_credentials').get().n, n);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_keys').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 0);
});

test('raw request bytes, model, query and application headers pass through; response duplicates survive', async () => {
  const bytes = Buffer.from(' { "model": "leave:the-model/alone", "input" : "hello" } \n');
  let received;
  handler = (req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    received = Buffer.concat(chunks); res.writeHead(207, 'Custom Status', ['X-Provider', 'one', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2', 'X-Duplicate', 'first', 'X-Duplicate', 'second', 'Content-Type', 'application/json']); res.end(bytes);
  }); };
  const headers = ['Authorization', 'Bearer ' + CLIENT, 'Content-Type', 'application/json', 'Content-Length', String(bytes.length), 'Anthropic-Beta', 'custom-beta', 'User-Agent', 'my-original-client', 'X-Duplicate', 'one', 'X-Duplicate', 'two', 'OpenAI-Organization', 'org-manual'];
  const r = await rawRequest('/v1/responses?x=a%2Fb&x=two', headers, bytes);
  assert.equal(r.status, 207); assert.deepEqual(r.body, bytes); assert.deepEqual(received, bytes);
  const hit = hits.at(-1); assert.equal(hit.target, '/v1/responses?x=a%2Fb&x=two');
  assert.equal(hit.headers.authorization, 'Bearer ' + REAL);
  assert.equal(hit.headers['user-agent'], 'my-original-client'); assert.equal(hit.headers['anthropic-beta'], 'custom-beta');
  assert.equal(hit.headers['openai-organization'], 'org-manual');
  const pairs = []; for (let i = 0; i < hit.rawHeaders.length; i += 2) if (hit.rawHeaders[i] === 'X-Duplicate') pairs.push(hit.rawHeaders[i + 1]);
  assert.deepEqual(pairs, ['one', 'two']); assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2']);
  const record = await detail((await latest()).id);
  assert.deepEqual(bodyOf(record, 'request'), bytes); assert.deepEqual(bodyOf(record, 'response'), bytes);
  assert.equal(record.state, 'complete');
  const authorization = event => event.headers[event.headers.findIndex(h => h.toLowerCase() === 'authorization') + 1];
  assert.equal(authorization(record.events.find(e => e.type === 'request')), 'Bearer ' + CLIENT);
  assert.equal(authorization(record.events.find(e => e.type === 'forward')), 'Bearer ' + REAL);
});

test('binary/compressed payloads are streamed unchanged, without decompression or JSON parsing', async () => {
  const bytes = gzipSync(randomBytes(170000));
  let got;
  handler = (req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => { got = Buffer.concat(chunks); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Content-Length': bytes.length }); res.end(bytes); }); };
  const r = await rawRequest('/v1/files?purpose=anything', ['Authorization', 'Bearer ' + CLIENT, 'Content-Type', 'multipart/form-data; boundary=abc', 'Content-Encoding', 'gzip', 'Content-Length', String(bytes.length)], bytes, 'PUT');
  assert.deepEqual(got, bytes); assert.deepEqual(r.body, bytes); assert.equal(r.headers['content-encoding'], 'gzip');
  const record = await detail((await latest()).id);
  assert.deepEqual(bodyOf(record, 'request'), bytes); assert.deepEqual(bodyOf(record, 'response'), bytes);
});

test('provider errors and redirects pass through without retrying', async () => {
  for (const code of [401, 429, 503, 302]) {
    const before = hits.length;
    handler = (_req, res) => { res.writeHead(code, { 'Retry-After': '17', Location: '/do-not-follow', 'X-Provider-Error': 'retained' }); res.end('original upstream body'); };
    const r = await client('/v1/responses', { redirect: 'manual' });
    assert.equal(r.status, code); assert.equal(await r.text(), 'original upstream body'); assert.equal(r.headers.get('retry-after'), '17');
    assert.equal(hits.length, before + 1);
  }
});

test('SSE first chunk arrives before upstream completion, cancellation closes upstream', async () => {
  let release;
  const upstreamClosed = new Promise(resolve => {
    handler = (req, res) => {
      req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream', 'x-stream': 'original' }); res.write('data: first\n\n');
      release = () => res.end('data: final\n\n');
      res.on('close', resolve);
    };
  });
  const controller = new AbortController();
  const r = await client('/v1/responses', { signal: controller.signal });
  const reader = r.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.abort(); await upstreamClosed;
  assert.equal((await detail((await latest()).id)).state, 'client_abort');
  release();
});

test('conflicting or duplicate auth is rejected and all rejected body bytes are captured', async () => {
  const before = hits.length;
  const bytes = Buffer.from('rejected body');
  const r = await rawRequest('/v1/responses', ['Authorization', 'Bearer ' + CLIENT, 'x-api-key', CLIENT, 'Content-Length', String(bytes.length)], bytes);
  assert.equal(r.status, 401); assert.equal(hits.length, before);
  const record = await detail((await latest()).id);
  assert.equal(record.state, 'rejected'); assert.deepEqual(bodyOf(record, 'request'), bytes);
});

test('chunked GET bodies and bidirectional trailers survive; HEAD remains bodyless', async () => {
  let requestBytes, requestTrailers;
  handler = (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requestBytes = Buffer.concat(chunks); requestTrailers = req.rawTrailers;
      res.writeHead(200, ['Content-Type', 'application/octet-stream', 'Trailer', 'X-Response-Trailer']);
      res.write(requestBytes); res.addTrailers({ 'X-Response-Trailer': 'response-tail' }); res.end();
    });
  };
  const bytes = Buffer.from('chunked GET request');
  const r = await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/body', { method: 'GET', headers: { authorization: 'Bearer ' + CLIENT, 'transfer-encoding': 'chunked', trailer: 'X-Request-Trailer' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ body: Buffer.concat(chunks), trailers: res.rawTrailers }));
    });
    req.on('error', reject); req.write(bytes); req.addTrailers({ 'X-Request-Trailer': 'request-tail' }); req.end();
  });
  assert.deepEqual(requestBytes, bytes); assert.deepEqual(r.body, bytes);
  assert.deepEqual(requestTrailers, ['X-Request-Trailer', 'request-tail']);
  assert.deepEqual(r.trailers, ['X-Response-Trailer', 'response-tail']);
  const record = await detail((await latest()).id);
  assert.deepEqual(record.events.find(e => e.type === 'request_end').trailers, requestTrailers);
  assert.deepEqual(record.events.find(e => e.type === 'response_end').trailers, r.trailers);
  handler = (_req, res) => { res.writeHead(200, { 'Content-Length': '1234' }); res.end(); };
  const head = await rawRequest('/v1/files', ['Authorization', 'Bearer ' + CLIENT], undefined, 'HEAD');
  assert.equal(head.headers['content-length'], '1234'); assert.equal(head.body.length, 0);
});

test('upstream 103 headers are forwarded and captured before final response', async () => {
  handler = (_req, res) => { res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style', 'x-original-hint': 'yes' }); res.end('final'); };
  const information = [];
  await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/hints', { headers: { authorization: 'Bearer ' + CLIENT } }, res => { res.resume(); res.on('end', resolve); res.on('error', reject); });
    req.on('information', event => information.push(event)); req.on('error', reject); req.end();
  });
  assert.equal(information[0].statusCode, 103); assert.equal(information[0].headers['x-original-hint'], 'yes');
  const record = await detail((await latest()).id);
  const infoIndex = record.events.findIndex(e => e.type === 'information');
  assert.ok(infoIndex >= 0); assert.ok(infoIndex < record.events.findIndex(e => e.type === 'response'));
});

test('103 without Link retains raw duplicate headers and queued response ordering', async () => {
  handler = (req, res) => {
    req.resume();
    if (req.url.includes('slow')) { setTimeout(() => res.end('FIRST_RESPONSE'), 60); return; }
    // Fixture emits actual interim HTTP bytes independently of proxy writers.
    res.socket.write('HTTP/1.1 103 Early Hints\r\nX-No-Link: first\r\nX-No-Link: second\r\n\r\n');
    res.end('SECOND_RESPONSE');
  };
  const wire = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1');
    let received = '';
    socket.on('data', chunk => { received += chunk.toString('latin1'); }); socket.on('error', reject); socket.on('end', () => resolve(received));
    socket.on('connect', () => socket.write(`GET /v1/slow HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${CLIENT}\r\n\r\nGET /v1/fast HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${CLIENT}\r\nConnection: close\r\n\r\n`));
  });
  assert.ok(wire.includes('X-No-Link: first\r\nX-No-Link: second'));
  assert.ok(wire.indexOf('FIRST_RESPONSE') < wire.indexOf('103 Early Hints'));
  assert.ok(wire.indexOf('103 Early Hints') < wire.indexOf('SECOND_RESPONSE'));
});

test('100 Continue is durably recorded before accepting an upload', async () => {
  handler = (req, res) => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => res.end(Buffer.concat(chunks))); };
  const bytes = Buffer.from('body after continue');
  const got = await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/upload', { method: 'POST', headers: { authorization: 'Bearer ' + CLIENT, expect: '100-continue', 'content-length': bytes.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    });
    req.on('continue', () => req.end(bytes)); req.on('error', reject); req.flushHeaders();
  });
  assert.deepEqual(got, bytes);
  const record = await detail((await latest()).id);
  const firstBody = record.events.findIndex(e => e.type === 'request_body');
  const continueIndex = record.events.findIndex(e => e.type === 'information' && e.status === 100 && e.generated);
  assert.ok(continueIndex >= 0 && continueIndex < firstBody);
});

test('CONNECT and upgrade are explicitly rejected, recorded and never forwarded', async () => {
  const before = hits.length;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base, { method: 'CONNECT', path: 'example.com:443', headers: { authorization: 'Bearer ' + CLIENT } });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(result, 501); assert.equal(hits.length, before);
  assert.equal((await detail((await latest()).id)).state, 'rejected');
  const upgrade = await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/realtime', { headers: { authorization: 'Bearer ' + CLIENT, connection: 'upgrade', upgrade: 'websocket' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(upgrade, 501); assert.equal(hits.length, before);
});

test('large-response client cancellation records partial capture rather than completion', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024, 42);
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length }); res.end(bytes); };
  await new Promise((resolve, reject) => {
    const req = http.request(base + '/v1/large', { headers: { authorization: 'Bearer ' + CLIENT } }, res => {
      res.once('data', () => { res.destroy(); resolve(); }); res.on('error', () => {});
    });
    req.on('error', reject); req.end();
  });
  const record = await detail((await latest()).id);
  assert.equal(record.state, 'client_abort'); assert.ok(record.response_bytes < bytes.length);
});

test('an early upstream response does not finalize capture before the upload is recorded', async () => {
  handler = (req, res) => { req.resume(); res.end('early upstream result'); };
  const bytes = Buffer.from('first part and the later upload tail');
  const agent = new http.Agent({ keepAlive: true });
  try {
    const responseBody = await new Promise((resolve, reject) => {
      const req = http.request(base + '/v1/early', { method: 'POST', agent, headers: { authorization: 'Bearer ' + CLIENT, 'content-length': bytes.length } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
        setTimeout(() => req.end(bytes.subarray(10)), 30);
      });
      req.on('error', reject); req.write(bytes.subarray(0, 10));
    });
    assert.equal(responseBody.toString(), 'early upstream result');
    const record = await detail((await latest()).id);
    assert.equal(record.state, 'complete');
    assert.deepEqual(bodyOf(record, 'request'), bytes);
  } finally { agent.destroy(); }
});

test('bundles store all fields manually but cannot be misused as bearer credentials', async () => {
  const aws = await admin('/api/proxy/credentials', 'POST', { provider: 'aws', kind: 'aws_sigv4', fields: { access_key_id: 'AKIA_TEST', secret_access_key: 'secret-test-aws', session_token: 'temporary-test', region: 'us-east-1' } });
  assert.equal(aws.status, 201); const saved = await aws.json(); assert.equal(saved.kind, 'aws_sigv4'); assert.ok(saved.fields.includes('session_token'));
  assert.equal(JSON.stringify(saved).includes('secret-test-aws'), false);
  assert.equal((await admin('/api/proxy/clients', 'POST', { provider: 'aws', token: 'aws-incoming-token', credential_id: saved.id, upstream: upstreamBase })).status, 422);
  const generic = await admin('/api/proxy/credentials', 'POST', { provider: 'two-key-service', kind: 'bundle', fields: { client_id: 'first-secret', client_secret: 'second-secret' } });
  assert.equal(generic.status, 201);
  assert.equal((await admin('/api/proxy/credentials/' + saved.id, 'DELETE')).status, 200);
});

test('encrypted traffic download is administrative only and includes every event', async () => {
  const row = await latest();
  assert.equal((await client('/api/proxy/traffic/' + row.id + '/events')).status, 401);
  const r = await admin('/api/proxy/traffic/' + row.id + '/events');
  assert.equal(r.headers.get('content-type'), 'application/x-ndjson');
  const events = (await r.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'request'); assert.equal(events.at(-1).type, 'end');
  for (const name of readdirSync(join(TMP, 'proxy-traffic'))) {
    const encrypted = readFileSync(join(TMP, 'proxy-traffic', name)); assert.equal(encrypted.includes(REAL), false); assert.equal(encrypted.includes(CLIENT), false);
  }
});

test('missing credential rejects without automatic replacement; alias revocation takes effect', async () => {
  assert.equal((await admin('/api/proxy/credentials/' + credential.id, 'DELETE')).status, 200);
  const before = hits.length;
  assert.equal((await client('/v1/models')).status, 401); assert.equal(hits.length, before);
  const newCredential = await (await admin('/api/proxy/credentials', 'POST', { provider: 'openai', kind: 'api_key', fields: { api_key: 'a-new-manual-key' } })).json();
  assert.notEqual(newCredential.id, credential.id);
  assert.equal((await client('/v1/models')).status, 401);
  assert.equal((await admin('/api/proxy/clients/' + binding.id, 'DELETE')).status, 404);
  assert.equal((await client('/v1/models')).status, 401);
});

test('capture storage failure fails closed before contacting upstream', async () => {
  const directory = join(TMP, 'proxy-traffic');
  renameSync(directory, directory + '-moved');
  try {
    const before = hits.length;
    const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer not-registered' } });
    assert.equal(r.status, 503); assert.equal(hits.length, before);
  } finally { renameSync(directory + '-moved', directory); }
});
