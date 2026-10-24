import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real gateway requests, isolated credentials/database, and a loopback provider.
const dir = mkdtempSync(join(tmpdir(), 'aigate-delayed-model-'));
const ADMIN = randomBytes(24).toString('hex'), GATEWAY = 'delayed-model-local-gateway';
const tokens = { a: 'sk-ant-oat01-dummy-delayed-account-a', b: 'sk-ant-oat01-dummy-delayed-account-b' };
Object.assign(process.env, {
  AIGATE_DB: join(dir, 'vault.db'), AIGATE_TOKEN: ADMIN,
  AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AIGATE_PROXY_TOKEN: GATEWAY,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0',
});
delete process.env.AIGATE_ALLOW_CIDR;
const { server, db, claudePool } = await import('../src/server.js');
const SONNET = 'claude-sonnet-4-6', OPUS = 'claude-opus-4-6';
const admissions = [], requests = [];
let base, handler, onData, sequence = 0;
const quota = (weeklyOffset = 100000) => ({
  'anthropic-ratelimit-unified-5h-utilization': '.2',
  'anthropic-ratelimit-unified-7d-utilization': '.25',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 10000),
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + weeklyOffset),
});
const upstream = http.createServer((req, res) => {
  const account = Object.keys(tokens).find(key => req.headers.authorization === 'Bearer ' + tokens[key]);
  admissions.push(account);
  const chunks = []; req.on('error', () => {});
  req.on('data', chunk => { chunks.push(chunk); onData?.(account, chunk); });
  req.on('end', () => {
    const bytes = Buffer.concat(chunks), body = JSON.parse(bytes.toString());
    requests.push({ account, bytes, body, rawHeaders: req.rawHeaders, headers: req.headers, trailers: req.rawTrailers, target: req.url });
    if (body.max_tokens === 1) {
      res.writeHead(200, { ...quota(account === 'a' ? 100000 : 200000), 'content-type': 'application/json' });
      res.end('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}');
    } else handler(req, res, account);
  });
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (predicate, message) => {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(5); }
  assert.fail(message);
};
const admin = (path, method = 'GET', body) => fetch(base + path, {
  method, headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const success = res => { res.writeHead(200, { ...quota(), 'content-type': 'text/plain' }); res.end('delayed model accepted'); };
const reset = () => {
  db.prepare('DELETE FROM claude_pool_blocks').run();
  for (const account of ['a', 'b']) {
    claudePool.observeHeaders(account, Object.entries(quota(account === 'a' ? 100000 : 200000)).flat(), { status: 200, model: SONNET });
    assert.equal(claudePool.markExhausted(account, { window: 'model', modelFamily: 'opus', model: OPUS, resetAt: Date.now() + 300000 }), true);
  }
  admissions.length = 0; requests.length = 0; onData = null;
  handler = (_req, res) => success(res);
  assert.equal(claudePool.status({ model: SONNET }).accounts.every(row => row.eligible), true);
  assert.equal(claudePool.status({ model: OPUS }).accounts.every(row => row.reason === 'model_cooldown'), true);
};
const upload = ({ timeoutMs = 5000 } = {}) => {
  const target = `/proxy/claude-code/v1/messages?delayed_model_case=${++sequence}`;
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(base + target, { method: 'POST', headers: [
      'Host', new URL(base).host, 'Authorization', 'Bearer ' + GATEWAY,
      'Content-Type', 'application/json', 'Anthropic-Beta', 'custom-delayed,oauth-2025-04-20',
      'X-Custom-Mixed', 'first', 'x-custom-mixed', 'second', 'User-Agent', 'delayed-upload-test',
      'Trailer', 'X-Upload-Finish',
    ] }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.setTimeout(timeoutMs, () => req.destroy(new Error('local upload timed out')));
    req.flushHeaders();
  });
  return { req, response, target };
};
const capture = async target => {
  for (let i = 0; i < 400; i++) {
    const rows = await (await admin('/api/proxy/traffic')).json();
    const row = rows.find(item => item.provider === 'claude-code');
    if (row && row.state !== 'running') {
      const detail = await (await admin(`/api/proxy/traffic/${row.id}?limit=1000`)).json();
      if (detail.events.find(event => event.type === 'request')?.target === target) return detail;
    }
    await pause(5);
  }
  assert.fail('request capture did not reach a terminal state');
};
const assertForwarded = (bytes, target, accounts = ['a']) => {
  assert.deepEqual(admissions, accounts);
  assert.deepEqual(requests.map(row => row.account), accounts);
  for (const row of requests) {
    assert.deepEqual(row.bytes, bytes); assert.equal(row.body.model, SONNET);
    assert.equal(row.target, target.replace('/proxy/claude-code', ''));
    assert.equal(row.headers['anthropic-beta'], 'custom-delayed,oauth-2025-04-20');
    assert.equal(row.headers['user-agent'], 'delayed-upload-test');
    const custom = [];
    for (let i = 0; i < row.rawHeaders.length; i += 2) if (row.rawHeaders[i].toLowerCase() === 'x-custom-mixed') custom.push(row.rawHeaders[i], row.rawHeaders[i + 1]);
    assert.deepEqual(custom, ['X-Custom-Mixed', 'first', 'x-custom-mixed', 'second']);
    assert.deepEqual(row.trailers, ['X-Upload-Finish', 'exact deferred trailer']);
  }
  assert.equal(claudePool.status({ model: OPUS }).accounts.every(row => row.reason === 'model_cooldown'), true, 'unrelated Opus blocks survive a Sonnet request');
};
const finish = (req, suffix) => { req.addTrailers({ 'X-Upload-Finish': 'exact deferred trailer' }); req.end(suffix); };
const assertComplete = async target => {
  const row = await capture(target);
  assert.equal(row.state, 'complete');
  assert.equal(row.events.filter(event => event.type === 'end').length, 1);
  const downstream = Buffer.concat(row.events.filter(event => event.type === 'response_body').map(event => Buffer.from(event.data, 'base64'))).toString();
  assert.equal(downstream, 'delayed model accepted');
  return row;
};

before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  process.env.AIGATE_TRANSPARENT_UPSTREAM_CLAUDE_CODE = `http://127.0.0.1:${upstream.address().port}`;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const account of ['a', 'b']) assert.equal((await admin('/api/accounts', 'POST', { account, setup_token: tokens[account] })).status, 200);
});
after(async () => {
  await claudePool.stop(); server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('split root model key and value recover admission despite unrelated family cooldowns', { timeout: 15000 }, async () => {
  for (const parts of [
    ['{"mo', 'del":"claude-sonnet-4-6","max_tokens":10,"messages":[]}'],
    ['{"model":"claude-son', 'net-4-6","max_tokens":10,"messages":[]}'],
  ]) {
    reset(); const { req, response, target } = upload();
    req.write(parts[0]); await pause(40);
    assert.deepEqual(admissions, [], 'an unknown model must not spend an Opus-blocked account');
    finish(req, parts[1]);
    assert.deepEqual(await response, { status: 200, body: 'delayed model accepted' });
    assertForwarded(Buffer.from(parts.join('')), target); await assertComplete(target);
  }
});

test('root model beyond 64KiB ignores nested and quoted model decoys and preserves exact upload', { timeout: 10000 }, async () => {
  reset(); const { req, response, target } = upload();
  const prefix = JSON.stringify({ messages: [{ role: 'user', content: 'quoted {"model":"claude-opus-4-6"} ' + 'x'.repeat(80000), metadata: { model: OPUS } }] }).slice(0, -1);
  const suffix = ',"model":"claude-sonnet-4-6","max_tokens":10}';
  assert.ok(Buffer.byteLength(prefix) > 65536); assert.ok(Buffer.byteLength(prefix + suffix) < 1048576);
  req.write(prefix); await pause(40); assert.deepEqual(admissions, []);
  finish(req, suffix);
  assert.deepEqual(await response, { status: 200, body: 'delayed model accepted' });
  assertForwarded(Buffer.from(prefix + suffix), target); await assertComplete(target);
});

test('confirmed Sonnet quota refusal fails over after deferred initial admission with full bytes and trailers', { timeout: 10000 }, async () => {
  reset(); handler = (_req, res, account) => {
    if (account === 'b') return success(res);
    res.writeHead(429, { ...quota(), 'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day_sonnet',
      'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 300),
      'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"Sonnet allowance exhausted"}}');
  };
  const { req, response, target } = upload();
  const prefix = '{"messages":[{"role":"user","content":"before root model"}],"mo';
  const suffix = 'del":"claude-sonnet-4-6","max_tokens":10}';
  req.write(prefix); await pause(40); assert.deepEqual(admissions, []); finish(req, suffix);
  assert.deepEqual(await response, { status: 200, body: 'delayed model accepted' });
  assertForwarded(Buffer.from(prefix + suffix), target, ['a', 'b']);
  const row = await assertComplete(target);
  assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 2);
  assert.equal(claudePool.status({ model: SONNET }).accounts.find(row => row.account === 'a').reason, 'model_cooldown');
});

test('delayed actual Opus remains blocked even when nested and quoted models say Sonnet', { timeout: 10000 }, async () => {
  reset(); const { req, response, target } = upload();
  req.write(JSON.stringify({ messages: [{ role: 'user', content: '{"model":"claude-sonnet-4-6"}', metadata: { model: SONNET } }] }).slice(0, -1));
  await pause(40); assert.deepEqual(admissions, []);
  finish(req, ',"model":"claude-opus-4-6","max_tokens":10}');
  assert.equal((await response).status, 503); assert.deepEqual(admissions, []); assert.deepEqual(requests, []);
  const row = await capture(target); assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 0);
});

test('cancelling a deferred unknown-model upload never admits any account', { timeout: 10000 }, async () => {
  reset(); const { req, response, target } = upload();
  const rejected = response.catch(error => error);
  req.write('{"messages":[{"role":"user","content":"unfinished');
  await pause(40); assert.deepEqual(admissions, []); req.destroy(); await rejected;
  const row = await capture(target); assert.equal(row.state, 'client_abort');
  assert.deepEqual(admissions, []); assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 0);
  await until(() => readdirSync(join(dir, 'proxy-replay')).length === 0, 'aborted deferred replay spool was not disposed');
});

test('ordinary known Sonnet model still streams to upstream before client EOF', { timeout: 10000 }, async () => {
  reset(); let received = '';
  onData = (_account, chunk) => { received += chunk.toString(); };
  const { req, response, target } = upload();
  const prefix = '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"live';
  const suffix = ' upload"}]}';
  req.write(prefix);
  try {
    await until(() => received === prefix, 'known-model request was buffered until EOF instead of streamed');
    assert.deepEqual(admissions, ['a']); assert.deepEqual(requests, [], 'upstream has not seen request EOF');
    finish(req, suffix);
    assert.deepEqual(await response, { status: 200, body: 'delayed model accepted' });
    assertForwarded(Buffer.from(prefix + suffix), target); await assertComplete(target);
  } finally { req.destroy(); }
});


test('deferred admission rejects oversized, invalid, or missing root model metadata without spending an account', { timeout: 45000 }, async () => {
  const oversized = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(1048576) }], model: SONNET, max_tokens: 10 });
  assert.ok(oversized.indexOf('"model"') > 1048576, 'root model is beyond the bounded metadata inspection limit');
  for (const [name, body] of [
    ['oversized metadata', oversized],
    ['invalid JSON', '{"messages":[],"model":"claude-sonnet-4-6","max_tokens":10} trailing-invalid-json'],
    ['missing root model', JSON.stringify({ messages: [{ role: 'user', content: '{"model":"claude-sonnet-4-6"}', metadata: { model: SONNET } }], max_tokens: 10 })],
    ['non-string root model', JSON.stringify({ messages: [], model: 42, max_tokens: 10 })],
  ]) {
    // Durable full capture of 1MiB can contend with parallel suite fsyncs;
    // this bounded negative-case fixture is not a latency benchmark.
    reset(); const { req, response, target } = upload(name === 'oversized metadata' ? { timeoutMs: 20000 } : undefined);
    req.write(body.slice(0, 8)); await pause(40);
    assert.deepEqual(admissions, [], name + ': unknown prefix must defer admission');
    finish(req, body.slice(8));
    const reply = await response; assert.equal(reply.status, 503, name);
    assert.deepEqual(admissions, [], name); assert.deepEqual(requests, [], name);
    const row = await capture(target);
    assert.equal(row.state, 'error', name);
    assert.equal(row.events.filter(event => event.type === 'attempt_start').length, 0, name);
    assert.equal(row.events.filter(event => event.type === 'response' && event.generated === true && event.status === 503).length, 1, name);
    assert.equal(row.events.filter(event => event.type === 'end').length, 1, name);
    assert.equal(row.events.filter(event => event.type === 'request_end').length, 1, name);
    const captured = Buffer.concat(row.events.filter(event => event.type === 'request_body').map(event => Buffer.from(event.data, 'base64')));
    assert.deepEqual(captured, Buffer.from(body), name + ': captured original request bytes');
    const downstream = Buffer.concat(row.events.filter(event => event.type === 'response_body').map(event => Buffer.from(event.data, 'base64'))).toString();
    assert.equal(downstream, reply.body, name + ': one generated downstream error');
    await until(() => readdirSync(join(dir, 'proxy-replay')).length === 0, name + ': rejected replay spool was not disposed');
  }
});
