// Gateway authentication cookies must stay at the gateway. Application cookies
// remain ordinary opaque HTTP headers, and the encrypted capture keeps both legs.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'aigate-session-cookie-'));
const ADMIN = randomBytes(24).toString('hex');
const DASHBOARD_PASSWORD = 'session-cookie-regression-dashboard-password';
const PRESET = 'session-cookie-regression-preset';
const ALIAS = 'session-cookie-regression-bound-client';
const PROVIDER_KEY = 'manually-entered-cookie-regression-provider-key';
const APPLICATION_SET_COOKIES = ['app_auth=from-provider; Path=/; HttpOnly', 'theme=dark; Path=/'];
const GATEWAY_SET_COOKIE = 'aigate_sess=upstream-must-not-overwrite; Path=/; HttpOnly';
const hits = [];
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits.push({ headers: req.headers, rawHeaders: req.rawHeaders });
    res.writeHead(200, [
      'Content-Type', 'application/json',
      'Set-Cookie', APPLICATION_SET_COOKIES[0],
      'Set-Cookie', GATEWAY_SET_COOKIE,
      'Set-Cookie', APPLICATION_SET_COOKIES[1],
    ]);
    res.end('{"local_fixture":true}');
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

Object.assign(process.env, {
  AIGATE_DB: join(TMP, 'vault.db'),
  AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  AIGATE_TOKEN: ADMIN,
  AIGATE_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
  AIGATE_PROXY_TOKEN: PRESET,
  AIGATE_PROXY_TOKEN_2: '',
  AIGATE_TRANSPARENT_UPSTREAM_OPENAI: upstreamBase,
  AIGATE_POLL_MS: '0',
  AIGATE_KEY_POLL_MS: '0',
  AIGATE_ALLOW_CIDR: '',
  AIGATE_TRUST_PROXY: '0',
});
const { server, db } = await import('../src/server.js');
let base, sessionCookie;

const values = (raw, name) => {
  const matches = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === name.toLowerCase()) matches.push(raw[i + 1]);
  return matches;
};
async function admin(path, method = 'GET', data) {
  return fetch(base + path, {
    method,
    headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}
function rawRequest(path, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, {
      method: 'GET',
      headers: ['Host', new URL(base).host, 'Authorization', 'Bearer ' + token, ...extraHeaders],
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function latestCompletedCapture() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const list = await (await admin('/api/proxy/traffic')).json();
    if (list.length) {
      const detail = await (await admin('/api/proxy/traffic/' + list[0].id + '?limit=1000')).json();
      if (detail.state !== 'running') return detail;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('session-cookie capture did not reach a terminal state');
}

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: DASHBOARD_PASSWORD }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  sessionCookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(sessionCookie, /^aigate_sess=.+/);
  await login.arrayBuffer();

  // This is a real, reusable administrative credential, not a fake cookie name.
  const sessionRead = await fetch(base + '/api/proxy/credentials', { headers: { cookie: sessionCookie } });
  assert.equal(sessionRead.status, 200);
  await sessionRead.arrayBuffer();

  const created = await admin('/api/proxy/credentials', 'POST', {
    provider: 'openai', kind: 'api_key', fields: { api_key: PROVIDER_KEY },
  });
  assert.equal(created.status, 201);
  const credential = await created.json();
  const bound = await admin('/api/proxy/clients', 'POST', {
    provider: 'openai', credential_id: credential.id, token: ALIAS, upstream: upstreamBase,
  });
  assert.equal(bound.status, 201);
  await bound.arrayBuffer();
});

after(async () => {
  const deadline = Date.now() + 10000;
  while (db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => upstream.close(resolve)),
  ]);
  db.close();
  rmSync(TMP, { recursive: true, force: true });
});

test('signed dashboard cookie never reaches a preset upstream, while application cookies and raw capture survive', async () => {
  const original = `app_auth=one; ${sessionCookie}; theme=dark`;
  const result = await rawRequest('/proxy/openai/v1/responses', PRESET, ['Cookie', original, 'Cookie', 'cart=three']);
  assert.equal(result.status, 200);
  assert.equal(hits.at(-1).headers.authorization, 'Bearer ' + PROVIDER_KEY);
  assert.deepEqual(values(hits.at(-1).rawHeaders, 'cookie'), ['app_auth=one; theme=dark', 'cart=three']);
  assert.equal(JSON.stringify(hits.at(-1).rawHeaders).includes(sessionCookie), false);
  assert.equal(hits.at(-1).headers.cookie.includes('aigate_sess='), false);

  const capture = await latestCompletedCapture();
  assert.equal(capture.state, 'complete');
  const request = capture.events.find(event => event.type === 'request');
  const forwarded = capture.events.find(event => event.type === 'forward');
  assert.deepEqual(values(request.headers, 'cookie'), [original, 'cart=three']);
  assert.deepEqual(values(forwarded.headers, 'cookie'), ['app_auth=one; theme=dark', 'cart=three']);
  for (const file of readdirSync(join(TMP, 'proxy-traffic'))) {
    assert.equal(readFileSync(join(TMP, 'proxy-traffic', file)).includes(sessionCookie), false);
  }
});

test('upstream cannot replace the gateway session cookie; application Set-Cookie duplicates remain intact', async () => {
  const result = await rawRequest('/proxy/openai/v1/models', PRESET, ['Cookie', sessionCookie]);
  assert.equal(result.status, 200);
  assert.deepEqual(values(hits.at(-1).rawHeaders, 'cookie'), []);
  assert.deepEqual(values(result.rawHeaders, 'set-cookie'), APPLICATION_SET_COOKIES);

  const capture = await latestCompletedCapture();
  const response = capture.events.find(event => event.type === 'response');
  assert.deepEqual(values(response.headers, 'set-cookie'), [APPLICATION_SET_COOKIES[0], GATEWAY_SET_COOKIE, APPLICATION_SET_COOKIES[1]]);
  assert.deepEqual(values(response.forwarded_headers, 'set-cookie'), APPLICATION_SET_COOKIES);

  // The unchanged original dashboard credential still grants admin access.
  const sessionRead = await fetch(base + '/api/proxy/credentials', { headers: { cookie: sessionCookie } });
  assert.equal(sessionRead.status, 200);
  await sessionRead.arrayBuffer();
});

test('application-only Cookie values stay byte-for-byte intact for an isolated alias, which alone cannot administer the vault', async () => {
  const original = 'app_auth=one;  theme=dark; quoted="a=b"';
  const result = await rawRequest('/v1/models', ALIAS, ['Cookie', original]);
  assert.equal(result.status, 200);
  assert.deepEqual(values(hits.at(-1).rawHeaders, 'cookie'), [original]);
  assert.deepEqual(values(result.rawHeaders, 'set-cookie'), APPLICATION_SET_COOKIES);
  await latestCompletedCapture();

  for (const token of [PRESET, ALIAS]) {
    const denied = await fetch(base + '/api/proxy/credentials', { headers: { authorization: 'Bearer ' + token } });
    assert.equal(denied.status, 401);
    await denied.arrayBuffer();
  }
});
