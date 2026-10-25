// Synthetic credentials, disposable encrypted vault and local TLS only.
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { unifiTLSOptions } from '../src/transparent-proxy.js';
import { PROVIDER_BY_ID } from '../src/providers.js';
import { makeVault } from '../src/lib.js';
import { runSetup } from '../setupscripts/setup.mjs';

const root = mkdtempSync(join(tmpdir(), 'aigate-unifi-'));
const setupTemporary = join(root, 'setup-temporary');
mkdirSync(setupTemporary, { mode: 0o700 });
const originalTemporary = process.env.TMPDIR;
process.env.TMPDIR = setupTemporary;
const ADMIN = randomBytes(24).toString('hex');
const CLIENT = 'synthetic-unifi-proxy-consumer';
const KEY = 'synthetic-manually-entered-unifi-key';
const encryptionKey = randomBytes(32);
const vault = makeVault(encryptionKey);
Object.assign(process.env, {
  AIGATE_DB: join(root, 'vault.db'), AIGATE_TOKEN: ADMIN, AIGATE_PROXY_TOKEN: CLIENT,
  AIGATE_PROXY_TOKEN_2: '', AIGATE_ENCRYPTION_KEY: encryptionKey.toString('hex'),
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0',
  AIGATE_ALLOW_CIDR: '', AIGATE_TRUST_PROXY: '0', AIGATE_DASHBOARD_PASSWORD: '',
});
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
const { server, db } = await import('../src/server.js');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=synthetic-unifi', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt')], { stdio: 'ignore' });
let base, origin;
let hits = [];
const upstream = https.createServer({ key: readFileSync(join(root, 'tls.key')), cert: readFileSync(join(root, 'tls.crt')) }, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    hits.push({ method: req.method, target: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(307, 'Preserved UniFi Response', ['Content-Type', 'application/octet-stream', 'Location', origin + '/must-not-follow', 'X-UniFi-Result', 'preserved', 'Set-Cookie', 'one=1', 'Set-Cookie', 'two=2']);
    res.end(Buffer.from([255, 0, 10, 128]));
  });
});
const admin = async (path, method = 'GET', data) => {
  const response = await fetch(base + path, { method, headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, data: await response.json() };
};
const request = (path = '/proxy/unifi/proxy/network/api/s/default/rest/user', { token = CLIENT, method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request(base, { path, method, headers: { authorization: 'Bearer ' + token, ...headers } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end(body);
});
async function provision(provider = 'unifi', key = KEY) {
  const result = await admin('/api/keys', 'POST', { provider, key, label: 'synthetic' });
  assert.equal(result.status, 200);
  return result.data;
}
async function settled() {
  for (let i = 0; i < 300; i++) {
    if (!db.prepare("SELECT count(*) AS n FROM proxy_traffic WHERE state='running'").get().n) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('encrypted capture did not finish');
}
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  origin = `https://127.0.0.1:${upstream.address().port}`;
});
beforeEach(async () => {
  await settled(); db.exec('DELETE FROM proxy_clients; DELETE FROM proxy_credentials; DELETE FROM provider_keys');
  hits = [];
  process.env.AIGATE_TRANSPARENT_UPSTREAM_UNIFI = origin;
  process.env.AIGATE_TRANSPARENT_UPSTREAM_OPENAI = origin;
  delete process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN;
});
after(async () => {
  await settled(); server.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  db.close(); rmSync(root, { recursive: true, force: true });
  if (originalTemporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTemporary;
});

test('UniFi catalog supplies its LAN upstream without advertising OpenAI compatibility', () => {
  assert.equal(PROVIDER_BY_ID.get('unifi').base, 'https://192.168.1.1');
  assert.equal(PROVIDER_BY_ID.get('unifi').oaiCompat, undefined);
});

test('self-signed UniFi TLS fails by default and no TLS setting is disabled globally', async () => {
  await provision();
  assert.equal((await request()).status, 502);
  assert.equal(hits.length, 0);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.deepEqual(unifiTLSOptions('unifi', new URL(origin), ''), {});
});

test('exact opt-in preserves raw request and response while substituting only the vault key', async () => {
  await provision(); process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = origin;
  const target = '/proxy/network/api/s/default/rest/user/%2e%2e/keep%2Fid?x=a%2Fb&x=two&empty=';
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  const result = await request('/proxy/unifi' + target, { method: 'PATCH', body: bytes, headers: { 'content-length': bytes.length, 'content-type': 'application/octet-stream', 'x-client-data': 'preserved' } });
  assert.equal(result.status, 307); assert.equal(result.statusMessage, 'Preserved UniFi Response');
  assert.equal(result.headers.location, origin + '/must-not-follow');
  assert.equal(result.headers['x-unifi-result'], 'preserved');
  assert.deepEqual(result.headers['set-cookie'], ['one=1', 'two=2']);
  assert.deepEqual(result.body, Buffer.from([255, 0, 10, 128]));
  assert.equal(hits.length, 1, 'redirect remains unfollowed');
  assert.equal(hits[0].method, 'PATCH'); assert.equal(hits[0].target, target);
  assert.deepEqual(hits[0].body, bytes);
  assert.equal(hits[0].headers.host, new URL(origin).host);
  assert.equal(hits[0].headers['x-client-data'], 'preserved');
  assert.equal(hits[0].headers['x-api-key'], KEY); assert.equal(hits[0].headers.authorization, undefined);
  await settled();
  const row = db.prepare('SELECT * FROM provider_keys').get();
  assert.equal(row.key_enc.includes(KEY), false); assert.equal(vault.decrypt(row.key_enc), KEY);
  const captureRow = db.prepare('SELECT * FROM proxy_traffic ORDER BY id DESC LIMIT 1').get();
  const encrypted = readFileSync(join(root, 'proxy-traffic', captureRow.file_id + '.events'), 'utf8');
  assert.equal(encrypted.includes(KEY), false); assert.equal(encrypted.includes(CLIENT), false);
  const capture = (await admin('/api/proxy/traffic/' + captureRow.id + '?limit=1000')).data;
  assert.equal(capture.state, 'complete');
  const body = direction => Buffer.concat(capture.events.filter(event => event.type === direction + '_body').map(event => Buffer.from(event.data, 'base64')));
  assert.deepEqual(body('request'), bytes); assert.deepEqual(body('response'), result.body);
  const forward = capture.events.find(event => event.type === 'forward');
  assert.equal(forward.headers[forward.headers.findIndex(name => name.toLowerCase() === 'x-api-key') + 1], KEY);
  assert.equal(forward.headers.includes('Bearer ' + CLIENT), false);
});

test('typed encrypted UniFi credentials reuse selection and x-api-key substitution', async () => {
  process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = origin;
  const result = await admin('/api/proxy/credentials', 'POST', { provider: 'unifi', kind: 'api_key', fields: { api_key: KEY }, label: 'synthetic typed' });
  assert.equal(result.status, 201);
  assert.equal(db.prepare('SELECT fields_enc FROM proxy_credentials').get().fields_enc.includes(KEY), false);
  assert.equal((await request()).status, 307);
  assert.equal(hits[0].headers['x-api-key'], KEY);
});

test('unknown client keys and body credentials never provision or reach UniFi', async () => {
  process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = origin;
  assert.equal((await request(undefined, { token: 'unknown-synthetic-consumer', method: 'POST', body: JSON.stringify({ api_key: KEY }) })).status, 401);
  assert.equal((await request()).status, 503);
  for (const table of ['provider_keys', 'proxy_credentials', 'proxy_clients']) assert.equal(db.prepare('SELECT count(*) AS n FROM ' + table).get().n, 0);
  assert.equal(hits.length, 0);
});

test('the opt-in cannot affect a different provider, hostname or port', async () => {
  await provision(); await provision('openai', 'sk-synthetic-unifi-other-provider');
  process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = origin;
  assert.equal((await request('/proxy/openai/v1/models')).status, 502);
  process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = 'https://127.0.0.1:' + (upstream.address().port + 1);
  assert.equal((await request()).status, 502);
  process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = origin.replace('127.0.0.1', '127.0.0.2');
  assert.equal((await request()).status, 502);
  assert.equal(hits.length, 0);
});

test('public, DNS, HTTP and malformed exception origins fail closed', async () => {
  await provision();
  for (const value of ['https://8.8.8.8', 'https://localhost', 'https://gateway.example', 'http://127.0.0.1', origin + '/path', origin + '?x=1', origin + '#fragment', 'https://user:pass@127.0.0.1', 'https://2130706433', 'https://127.1', 'https://0177.0.0.1', 'true', ' https://127.0.0.1', 'https://[fe80::1]', 'https://[::ffff:127.0.0.1]', 'https://127.0.0.1:99999']) {
    process.env.AIGATE_UNIFI_TLS_INSECURE_ORIGIN = value;
    assert.equal((await request()).status, 503, value);
  }
  assert.equal(hits.length, 0);
});

test('TLS exception compares the full origin and accepts only private literal ranges', () => {
  for (const value of ['https://10.2.3.4:7443', 'https://172.16.0.1', 'https://172.31.255.254', 'https://192.168.1.1', 'https://127.0.0.1', 'https://[::1]:7443', 'https://[fc00::1]', 'https://[fdff::1]']) {
    assert.deepEqual(unifiTLSOptions('unifi', new URL(value), value), { rejectUnauthorized: false });
    assert.deepEqual(unifiTLSOptions('anthropic', new URL(value), value), {});
    assert.deepEqual(unifiTLSOptions('unifi', new URL(value.replace('https:', 'http:')), value), {});
  }
  for (const value of ['https://172.15.0.1', 'https://172.32.0.1', 'https://192.169.1.1', 'https://169.254.1.1', 'https://[2001:db8::1]']) assert.throws(() => unifiTLSOptions('unifi', new URL(value), value));
});

function interactiveSetup(answer) {
  const input = new PassThrough(); input.isTTY = true;
  let raw = false, output = '', keyPrompts = 0;
  input.setRawMode = enabled => { raw = enabled; };
  const sink = { write(value) {
    output += value;
    let response;
    if (value.startsWith('AIGate administrator token')) { assert.equal(raw, true); response = ADMIN; }
    else if (value.startsWith('Account/credential label')) response = 'synthetic setup';
    else if (value.startsWith('API key value')) { assert.equal(raw, true); response = KEY + (++keyPrompts); }
    else if (value.startsWith('Save the credential?')) response = answer;
    else if (value.startsWith('Set up another')) response = keyPrompts < 2 ? 'yes' : 'no';
    if (response !== undefined) queueMicrotask(() => input.write(response + '\r'));
  } };
  return { input, sink, output: () => output, raw: () => raw };
}

test('actual server setup performs hidden manual intake, explicit save, metadata read-back, repeat and cleanup', async () => {
  const terminal = interactiveSetup('yes');
  await runSetup(['unifi'], { env: { AIGATE_URL: base }, input: terminal.input, output: terminal.sink, error: terminal.sink });
  assert.equal(db.prepare("SELECT count(*) AS n FROM provider_keys WHERE provider='unifi'").get().n, 2);
  assert.equal((terminal.output().match(/matching credential metadata was read back/g) || []).length, 2);
  assert.equal((terminal.output().match(/Temporary local credentials removed/g) || []).length, 2);
  assert.deepEqual(readdirSync(setupTemporary), []);
  assert.equal(terminal.output().includes(KEY), false); assert.equal(terminal.output().includes(ADMIN), false);
  assert.equal(terminal.raw(), false);
});

test('actual server setup cancellation never saves a key and restores terminal after cleanup', async () => {
  const terminal = interactiveSetup('no');
  await assert.rejects(runSetup(['unifi', '--once'], { env: { AIGATE_URL: base }, input: terminal.input, output: terminal.sink, error: terminal.sink }), /cancelled before save/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM provider_keys').get().n, 0);
  assert.match(terminal.output(), /Temporary local credentials removed/);
  assert.deepEqual(readdirSync(setupTemporary), []);
  assert.equal(terminal.output().includes(KEY), false); assert.equal(terminal.output().includes(ADMIN), false);
  assert.equal(terminal.raw(), false);
});
