// Independent boundary coverage for the two optional .env consumer keys.
// All credentials are explicitly provisioned against a disposable vault; every
// upstream is a local HTTP server, including requests with hostile-looking URLs.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-preset-boundaries-'));
const ADMIN = randomBytes(24).toString('hex');
const PRIMARY = 'primary-preset-test-only';
const SECONDARY = 'secondary-preset-test-only';
const hits = [];
const queueModel = '/fal-ai/flux/schnell';
const queueRequest = '/fal-ai/flux/requests/test-id';
const queueSubmission = JSON.stringify({
  request_id: 'test-id',
  status_url: 'https://queue.fal.run' + queueRequest + '/status',
  response_url: 'https://queue.fal.run' + queueRequest,
});
const mediaBytes = Buffer.from([0, 255, 1, 128]);
let finishVideo;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    hits.push({ target: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === queueModel && req.headers.host === 'queue.fal.run') {
      res.writeHead(202, { 'content-type': 'application/json' });
      return res.end(queueSubmission);
    }
    if (req.url === queueRequest + '/cancel') {
      res.writeHead(204);
      return res.end();
    }
    if (req.url === '/v1/predictions/redirect') {
      res.writeHead(307, { location: upstreamBase + '/redirect-target' });
      return res.end('redirect from Replicate');
    }
    if (req.url === '/v1/predictions/invalid' || req.url === '/v1/predictions/failed') {
      res.writeHead(req.url.endsWith('/invalid') ? 422 : 502);
      return res.end(mediaBytes);
    }
    if (req.url === '/api/v1/videos/test-id/content') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      finishVideo = () => res.end(mediaBytes);
      return res.write(mediaBytes);
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('local upstream response');
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'),
  AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AIGATE_TOKEN: ADMIN,
  AIGATE_DASHBOARD_PASSWORD: '',
  AIGATE_PROXY_TOKEN: PRIMARY,
  AIGATE_PROXY_TOKEN_2: SECONDARY,
  AIGATE_TRANSPARENT_UPSTREAM_OPENAI: upstreamBase,
  AIGATE_TRANSPARENT_UPSTREAM_ANTHROPIC: upstreamBase,
  AIGATE_POLL_MS: '0',
  AIGATE_KEY_POLL_MS: '0',
  AIGATE_ALLOW_CIDR: '',
  AIGATE_TRUST_PROXY: '0',
});
const { server, db } = await import('../src/server.js');
let base;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function settledCaptures() {
  for (let i = 0; i < 200; i++) {
    if (!db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n) return;
    await delay(10);
  }
  throw new Error('proxy captures did not finish');
}
async function request(path, { token = PRIMARY, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + path, {
    method, headers: { authorization: 'Bearer ' + token, ...headers }, body,
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}
async function admin(path, method = 'GET', data) {
  const response = await fetch(base + path, {
    method,
    headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, data: await response.json() };
}
async function typed(provider, key) {
  const result = await admin('/api/proxy/credentials', 'POST', { provider, kind: 'api_key', fields: { api_key: key } });
  assert.equal(result.status, 201);
  return result.data;
}
async function legacy(provider, key, status = 'working') {
  const result = await admin('/api/keys', 'POST', { provider, key, status });
  assert.equal(result.status, 200);
  return result.data;
}
function credentialCounts() {
  return Object.fromEntries(['accounts', 'provider_keys', 'proxy_credentials', 'proxy_clients'].map(table => [table, db.prepare('SELECT count(*) AS n FROM ' + table).get().n]));
}
const rawRequest = (path, token, body) => new Promise((resolve, reject) => {
  const url = new URL(base);
  const req = http.request({
    hostname: url.hostname, port: url.port, method: 'POST', path,
    headers: {
      authorization: 'Bearer ' + token,
      host: 'never-connect-here.invalid',
      'content-length': String(body.length),
      'content-type': 'application/octet-stream',
      'x-original-client': 'preset-boundary-test',
    },
  }, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject);
  req.end(body);
});

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await settledCaptures();
  db.exec('DELETE FROM proxy_clients; DELETE FROM proxy_credentials; DELETE FROM provider_keys; DELETE FROM accounts');
  process.env.AIGATE_PROXY_TOKEN = PRIMARY;
  process.env.AIGATE_PROXY_TOKEN_2 = SECONDARY;
  hits.length = 0;
});
after(async () => {
  await settledCaptures();
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => upstream.close(resolve)),
  ]);
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test('both preset keys route only to the provider selected in the URL', async () => {
  await typed('openai', 'manual-openai-key-for-preset-test');
  await typed('anthropic', 'manual-anthropic-key-for-preset-test');
  for (const token of [PRIMARY, SECONDARY]) {
    assert.equal((await request('/proxy/openai/v1/models', { token })).status, 200);
    assert.equal(hits.at(-1).target, '/v1/models');
    assert.equal(hits.at(-1).headers.authorization, 'Bearer manual-openai-key-for-preset-test');
    assert.equal((await request('/proxy/anthropic/v1/messages', { token })).status, 200);
    assert.equal(hits.at(-1).target, '/v1/messages');
    assert.equal(hits.at(-1).headers['x-api-key'], 'manual-anthropic-key-for-preset-test');
    assert.equal(hits.at(-1).headers.authorization, undefined);
  }
  assert.deepEqual(credentialCounts(), { accounts: 0, provider_keys: 0, proxy_credentials: 2, proxy_clients: 0 });
});

test('neither preset key can read secrets or traffic, create credentials, or create aliases', async () => {
  await typed('openai', 'manually-provisioned-before-admin-boundary-test');
  const before = credentialCounts();
  for (const token of [PRIMARY, SECONDARY]) {
    for (const path of ['/api/accounts', '/api/keys/openai', '/api/proxy/credentials', '/api/proxy/clients', '/api/proxy/traffic']) {
      assert.equal((await request(path, { token })).status, 401, path);
    }
    for (const [path, payload] of [
      ['/api/keys', { provider: 'openai', key: 'consumer-must-not-store-this' }],
      ['/api/proxy/credentials', { provider: 'openai', kind: 'api_key', fields: { api_key: 'consumer-must-not-store-this' } }],
      ['/api/proxy/clients', { token: 'consumer-must-not-bind-this', provider: 'openai', credential_id: 1 }],
    ]) {
      assert.equal((await request(path, { token, method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })).status, 401, path);
    }
    const session = await request('/api/session', { token });
    assert.equal(JSON.parse(session.text).authenticated, false);
  }
  assert.deepEqual(credentialCounts(), before);
  assert.equal(hits.length, 0);
});

test('preset keys can be independently revoked by removing their explicit environment setting', async () => {
  await typed('openai', 'manual-revocation-test-key');
  delete process.env.AIGATE_PROXY_TOKEN;
  assert.equal((await request('/proxy/openai/v1/models', { token: PRIMARY })).status, 401);
  assert.equal((await request('/proxy/openai/v1/models', { token: SECONDARY })).status, 200);
  process.env.AIGATE_PROXY_TOKEN = PRIMARY;
  delete process.env.AIGATE_PROXY_TOKEN_2;
  assert.equal((await request('/proxy/openai/v1/models', { token: SECONDARY })).status, 401);
  assert.equal((await request('/proxy/openai/v1/models', { token: PRIMARY })).status, 200);
  assert.equal(hits.length, 2);
  assert.equal(credentialCounts().proxy_clients, 0);
});

test('provider prefix removal preserves raw encoded paths, repeated queries and opaque request bytes', async () => {
  await typed('openai', 'manual-path-fidelity-test-key');
  const original = '/v1/files/%2e%2e/keep%2Fid?target=https%3A%2F%2Fnever-connect-here.invalid&x=a%2Fb&x=second&empty=';
  const bytes = Buffer.from([0, 255, 1, 13, 10, 128, 65]);
  const result = await rawRequest('/proxy/openai' + original, PRIMARY, bytes);
  assert.equal(result.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].target, original);
  assert.deepEqual(hits[0].body, bytes);
  assert.equal(hits[0].headers.host, new URL(upstreamBase).host);
  assert.equal(hits[0].headers['x-original-client'], 'preset-boundary-test');
  assert.deepEqual(result.body, Buffer.from('local upstream response'));
});

test('incoming requests and unrelated credential environment/files never provision a missing provider key', async () => {
  const old = Object.fromEntries(['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SHARED_CREDENTIALS_FILE', 'AIGATE_CODEX_HOME'].map(name => [name, process.env[name]]));
  const awsFile = join(TMP, 'manual-discovery-trap-aws');
  writeFileSync(awsFile, '[default]\naws_access_key_id=AKIA_TEST_TRAP\naws_secret_access_key=not-a-real-secret\n', { mode: 0o600 });
  Object.assign(process.env, {
    OPENAI_API_KEY: 'environment-key-must-never-be-imported',
    AWS_ACCESS_KEY_ID: 'AKIA_ENVIRONMENT_TRAP',
    AWS_SECRET_ACCESS_KEY: 'environment-secret-must-never-be-imported',
    AWS_SHARED_CREDENTIALS_FILE: awsFile,
    AIGATE_CODEX_HOME: TMP,
  });
  writeFileSync(join(TMP, 'auth.json'), JSON.stringify({ tokens: { access_token: 'file-token-must-never-be-imported', refresh_token: 'file-refresh-must-never-be-imported' } }), { mode: 0o600 });
  try {
    const before = credentialCounts();
    const result = await request('/proxy/openai/v1/responses', {
      method: 'POST', body: JSON.stringify({ model: 'unchanged', api_key: 'body-key-must-never-be-imported', credentials: { access_key_id: 'AKIA_BODY_TRAP', secret_access_key: 'body-secret-must-never-be-imported' } }),
      headers: { 'content-type': 'application/json', 'x-provider-api-key': 'header-key-must-never-be-imported' },
    });
    assert.equal(result.status, 503);
    assert.deepEqual(credentialCounts(), before);
    assert.deepEqual(before, { accounts: 0, provider_keys: 0, proxy_credentials: 0, proxy_clients: 0 });
    assert.equal(hits.length, 0);
  } finally {
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('preset keys require an explicit provider path and never infer routing from the model', async () => {
  await typed('openai', 'manual-explicit-routing-key');
  const result = await request('/v1/responses', {
    method: 'POST', body: '{"model":"openai:guess-this-route","input":"test"}', headers: { 'content-type': 'application/json' },
  });
  assert.equal(result.status, 400);
  assert.equal(hits.length, 0);
  assert.equal(credentialCounts().proxy_clients, 0);
});

test('newest typed manual API key takes precedence; legacy fallback uses only working keys', async () => {
  await legacy('openai', 'sk-legacy-working-key-preset-test');
  await legacy('openai', 'sk-legacy-disabled-key-preset-test', 'disabled');
  assert.equal((await request('/proxy/openai/v1/models')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer sk-legacy-working-key-preset-test');
  const first = await typed('openai', 'typed-first-manual-key-preset-test');
  const newest = await typed('openai', 'typed-newest-manual-key-preset-test');
  await legacy('openai', 'sk-even-newer-legacy-key-preset-test');
  assert.equal((await request('/proxy/openai/v1/models')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer typed-newest-manual-key-preset-test');
  assert.equal((await admin('/api/proxy/credentials/' + newest.id, 'DELETE')).status, 200);
  assert.equal((await request('/proxy/openai/v1/models')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer typed-first-manual-key-preset-test');
  assert.equal((await admin('/api/proxy/credentials/' + first.id, 'DELETE')).status, 200);
  assert.equal((await request('/proxy/openai/v1/models')).status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer sk-even-newer-legacy-key-preset-test');
});

test('unsupported multi-field credentials stop before any upstream call instead of becoming bearer keys', async () => {
  await legacy('openai', 'sk-legacy-must-not-bypass-unsupported-bundle');
  const stored = await admin('/api/proxy/credentials', 'POST', {
    provider: 'openai', kind: 'bundle', fields: { client_id: 'manual-first-field', client_secret: 'manual-second-field' },
  });
  assert.equal(stored.status, 201);
  assert.equal((await request('/proxy/openai/v1/models')).status, 422);
  const aws = await admin('/api/proxy/credentials', 'POST', {
    provider: 'aws', kind: 'aws_sigv4', fields: { access_key_id: 'AKIA_MANUAL_TEST', secret_access_key: 'manual-aws-secret', session_token: 'manual-aws-session', region: 'us-east-1' },
  });
  assert.equal(aws.status, 201);
  const binding = await admin('/api/proxy/clients', 'POST', { token: 'aws-consumer-test-token', provider: 'aws', credential_id: aws.data.id, upstream: upstreamBase });
  assert.equal(binding.status, 422);
  assert.equal(hits.length, 0);
  assert.equal(credentialCounts().proxy_clients, 0);
});


// Check the actual default HTTPS destinations without making any network calls.
function mockMediaUpstream(t) {
  return t.mock.method(https, 'request', (destination, options) => http.request(upstreamBase, options));
}

test('Replicate uses bearer auth, preserves wait and cancellation headers, and relays errors and redirects once', async t => {
  const upstreamRequests = mockMediaUpstream(t);
  const key = 'r8_manual-replicate-test-key';
  await typed('replicate', key);
  const body = '{"input":{"prompt":"test"}}';
  const path = '/v1/predictions?name=a%2Fb&name=c';
  const result = await request('/proxy/replicate' + path, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', prefer: 'wait', 'cancel-after': '90s' },
  });
  assert.equal(result.status, 200);
  assert.equal(upstreamRequests.mock.calls[0].arguments[0].origin, 'https://api.replicate.com');
  assert.equal(hits[0].target, path);
  assert.equal(hits[0].method, 'POST');
  assert.equal(hits[0].headers.host, 'api.replicate.com');
  assert.equal(hits[0].headers.authorization, 'Bearer ' + key);
  assert.ok(!JSON.stringify(hits[0].headers).includes(PRIMARY));
  assert.equal(hits[0].headers.prefer, 'wait');
  assert.equal(hits[0].headers['cancel-after'], '90s');
  assert.equal(hits[0].body.toString(), body);

  for (const [id, status] of [['invalid', 422], ['failed', 502], ['redirect', 307]]) {
    const response = await fetch(base + '/proxy/replicate/v1/predictions/' + id, {
      headers: { 'x-api-key': PRIMARY }, redirect: 'manual',
    });
    assert.equal(response.status, status);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), status === 307 ? Buffer.from('redirect from Replicate') : mediaBytes);
    assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + key);
    assert.equal(hits.at(-1).headers['x-api-key'], undefined);
    if (status === 307) assert.equal(response.headers.get('location'), upstreamBase + '/redirect-target');
  }
  assert.equal(hits.length, 4);
});

test('fal queue and synchronous routes share a key and relay submit, status, result, and cancel', async t => {
  const upstreamRequests = mockMediaUpstream(t);
  const key = 'manual-fal:test-key';
  await typed('fal', key);
  const body = '{"prompt":"test"}';
  const routes = [
    ['/proxy/fal', queueModel, 'POST', 'https://fal.run', 200],
    ['/proxy/fal-queue', queueModel, 'POST', 'https://queue.fal.run', 202],
    ['/proxy/fal-queue', queueRequest + '/status?logs=1', 'GET', 'https://queue.fal.run', 200],
    ['/proxy/fal-queue', queueRequest, 'GET', 'https://queue.fal.run', 200],
    ['/proxy/fal-queue', queueRequest + '/cancel', 'PUT', 'https://queue.fal.run', 204],
  ];
  for (const [prefix, target, method, origin, status] of routes) {
    const result = await request(prefix + target, { method, body: method === 'POST' ? body : undefined });
    assert.equal(result.status, status);
    if (status === 202) assert.equal(result.text, queueSubmission);
    const hit = hits.at(-1);
    assert.equal(upstreamRequests.mock.calls.at(-1).arguments[0].origin, origin);
    assert.equal(hit.method, method);
    assert.equal(hit.target, target);
    assert.equal(hit.headers.host, new URL(origin).host);
    assert.equal(hit.headers.authorization, 'Key ' + key);
    assert.equal(hit.body.toString(), method === 'POST' ? body : '');
  }
  await settledCaptures();
  const queueCapture = db.prepare("SELECT * FROM proxy_traffic WHERE provider='fal' ORDER BY id DESC LIMIT 1").get();
  assert.equal(queueCapture.status, 204);
  assert.equal(queueCapture.state, 'complete');
  assert.equal(credentialCounts().proxy_credentials, 1);
  const response = await fetch(base + '/api/proxy/traffic/' + queueCapture.id + '/events', {
    headers: { authorization: 'Bearer ' + ADMIN },
  });
  assert.equal(response.status, 200);
  const capture = await response.text();
  assert.ok(capture.includes('[redacted]'));
  assert.ok(!capture.includes(key));
  assert.ok(!capture.includes(PRIMARY));
});

test('fal queue has an independent upstream override and requires a fal credential', async t => {
  t.mock.method(https, 'request', () => assert.fail('unexpected default upstream'));
  process.env.AIGATE_TRANSPARENT_UPSTREAM_FAL = upstreamBase + '/sync';
  process.env.AIGATE_TRANSPARENT_UPSTREAM_FAL_QUEUE = upstreamBase + '/queue';
  t.after(() => {
    delete process.env.AIGATE_TRANSPARENT_UPSTREAM_FAL;
    delete process.env.AIGATE_TRANSPARENT_UPSTREAM_FAL_QUEUE;
  });
  await typed('fal-queue', 'unused-credential-for-alias-test');
  assert.equal((await request('/proxy/fal-queue' + queueModel)).status, 503);
  assert.equal((await request('/proxy/replicate/v1/account')).status, 503);
  assert.equal((await request('/proxy/huggingface/v1/models')).status, 422);
  assert.equal((await request('/proxy/no-such-provider/v1/models')).status, 422);
  assert.equal(hits.length, 0);

  const key = 'manual-fal:override-test-key';
  await legacy('fal', key);
  assert.equal((await request('/proxy/fal' + queueModel)).status, 200);
  assert.equal((await request('/proxy/fal-queue' + queueModel)).status, 200);
  assert.deepEqual(hits.map(hit => hit.target), ['/sync' + queueModel, '/queue' + queueModel]);
  assert.ok(hits.every(hit => hit.headers.authorization === 'Key ' + key));
});

test('OpenRouter preserves non-chat URLs, JSON and binary bodies, and streams video output', async t => {
  const upstreamRequests = mockMediaUpstream(t);
  const key = 'sk-or-manual-media-test-key';
  await typed('openrouter', key);
  assert.equal((await rawRequest('/proxy/openrouter/v1/images', PRIMARY, mediaBytes)).status, 200);
  const body = '{"model":"provider/video-model","prompt":"test"}';
  assert.equal((await request('/proxy/openrouter/v1/videos', {
    method: 'POST', body, headers: { 'content-type': 'application/json' },
  })).status, 200);
  assert.equal((await request('/proxy/openrouter/v1/videos/test-id')).status, 200);
  assert.equal((await request('/proxy/openrouter/v1/videos/models')).status, 200);
  const response = await fetch(base + '/proxy/openrouter/v1/videos/test-id/content', {
    headers: { authorization: 'Bearer ' + PRIMARY }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  try {
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.deepEqual(Buffer.from(first.value), mediaBytes);
  } finally {
    finishVideo?.();
  }
  const second = await reader.read();
  assert.deepEqual(Buffer.from(second.value), mediaBytes);
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(hits.map(hit => [hit.method, hit.target]), [
    ['POST', '/api/v1/images'],
    ['POST', '/api/v1/videos'],
    ['GET', '/api/v1/videos/test-id'],
    ['GET', '/api/v1/videos/models'],
    ['GET', '/api/v1/videos/test-id/content'],
  ]);
  assert.deepEqual(hits[0].body, mediaBytes);
  assert.equal(hits[1].body.toString(), body);
  assert.ok(hits.every(hit => hit.headers.authorization === 'Bearer ' + key));
  assert.ok(upstreamRequests.mock.calls.every(call => call.arguments[0].origin === 'https://openrouter.ai'));
});
