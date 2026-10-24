import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aigate-claude-relay-'));
const ADMIN = randomBytes(24).toString('hex'), GATEWAY = 'gateway-stays-the-same';
const tokens = { a: 'sk-ant-oat01-manually-added-account-a', b: 'sk-ant-oat01-manually-added-account-b' };
Object.assign(process.env, { AIGATE_DB: join(dir, 'vault.db'), AIGATE_TOKEN: ADMIN,
  AIGATE_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AIGATE_PROXY_TOKEN: GATEWAY,
  AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0' });
delete process.env.AIGATE_ALLOW_CIDR;
const { server, db, claudePool } = await import('../src/server.js');
const requests = [], admissions = []; let handler, earlyHandler;
const quotas = (used = .2, weeklyOffset = 100000) => ({
  'anthropic-ratelimit-unified-5h-utilization': String(used),
  'anthropic-ratelimit-unified-7d-utilization': '.25',
  'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 10000),
  'anthropic-ratelimit-unified-7d-reset': String(Math.floor(Date.now() / 1000) + weeklyOffset),
});
const raw = object => Object.entries(object).flat();
const upstream = http.createServer((req, res) => {
  const account = Object.keys(tokens).find(key => req.headers.authorization === 'Bearer ' + tokens[key]);
  admissions.push(account); req.on('error', () => {});
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const bytes = Buffer.concat(chunks); let body; try { body = JSON.parse(bytes); } catch {}
    requests.push({ account, bytes, headers: req.headers, rawHeaders: req.rawHeaders, target: req.url, trailers: req.rawTrailers });
    if (body?.max_tokens === 1) { res.writeHead(200, { ...quotas(.2, account === 'a' ? 100000 : 200000), 'content-type': 'application/json' }); res.end('{"type":"message","usage":{"input_tokens":1,"output_tokens":1}}'); }
    else if (!early) handler(req, res, { account, body, bytes });
  });
  const early = earlyHandler?.(req, res, account);
});
let base, upstreamBase;
const admin = (path, method = 'GET', body) => fetch(base + path, { method, headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const request = (bytes = Buffer.from('{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[]}'), headers = []) => new Promise((resolve, reject) => {
  const req = http.request(base + '/proxy/claude-code/v1/messages?beta=true', { method: 'POST', headers: ['Host', new URL(base).host, 'Authorization', 'Bearer ' + GATEWAY, 'Content-Type', 'application/json', ...headers] }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
  }); req.on('error', reject); req.end(bytes);
});
const reset = () => {
  db.prepare('DELETE FROM claude_pool_blocks').run();
  claudePool.observeHeaders('a', raw(quotas(.2, 100000)), { status: 200, model: 'claude-sonnet-4-6' });
  claudePool.observeHeaders('b', raw(quotas(.3, 200000)), { status: 200, model: 'claude-sonnet-4-6' });
  requests.length = 0;
  admissions.length = 0; earlyHandler = null;
};
const latestCapture = async () => {
  for (let i = 0; i < 200; i++) {
    const rows = await (await admin('/api/proxy/traffic')).json(); const row = rows.find(row => row.provider === 'claude-code');
    if (row && row.state !== 'running') return (await admin(`/api/proxy/traffic/${row.id}?limit=1000`)).json();
    await new Promise(resolve => setTimeout(resolve, 5));
  } throw new Error('capture unfinished');
};
const success = (res, body = 'SUCCESS') => { res.writeHead(200, { ...quotas(.4), 'content-type': 'text/plain', 'x-winning-account': 'b' }); res.end(body); };
const refusal = res => { res.writeHead(429, { ...quotas(1), 'content-type': 'application/json', 'retry-after': '17' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"session exhausted"}}'); };

before(async () => {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  process.env.AIGATE_TRANSPARENT_UPSTREAM_CLAUDE_CODE = upstreamBase;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  for (const account of ['a', 'b']) assert.equal((await admin('/api/accounts', 'POST', { account, setup_token: tokens[account] })).status, 200);
});
after(async () => { await claudePool.stop(); server.closeAllConnections(); server.close(); upstream.closeAllConnections(); upstream.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('admin pool APIs use captured native probes; proxy token cannot administer or add credentials', async () => {
  assert.equal((await fetch(base + '/api/proxy/claude-code/status', { headers: { authorization: 'Bearer ' + GATEWAY } })).status, 401);
  const response = await admin('/api/proxy/claude-code/refresh', 'POST', {}); assert.equal(response.status, 200);
  const state = await response.json(); assert.equal(state.next_account, 'a'); assert.equal(state.poll_interval_ms, 0);
  assert.equal(state.accounts[0].five_hour.remaining_pct, 80); assert.ok(!JSON.stringify(state).includes(tokens.a));
  assert.equal((await admin('/api/proxy/claude-code/accounts/a/metadata', 'POST', { quota_scope: 'shared-manual' })).status, 200);
  assert.equal((await admin('/api/proxy/claude-code/accounts/a/metadata', 'POST', { quota_scope: null })).status, 200);
  const rows = await (await admin('/api/proxy/traffic')).json(); assert.equal(rows.filter(row => row.provider === 'anthropic').length, 2);
});

test('authoritative quota refusal fails over with exact bytes, headers/model and one downstream response', async () => {
  reset(); handler = (_req, res, { account }) => account === 'a' ? refusal(res) : success(res);
  const bytes = Buffer.from(' { "messages": [{"role":"user","content":"nested model stays"}], "model":"claude-sonnet-4-6", "max_tokens":10, "context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]} }\n');
  const response = await request(bytes, ['Anthropic-Beta', 'custom,oauth-2025-04-20', 'User-Agent', 'actual-client', 'X-Duplicate', 'one', 'X-Duplicate', 'two']);
  assert.equal(response.status, 200); assert.equal(response.body.toString(), 'SUCCESS');
  assert.deepEqual(requests.map(row => row.account), ['a', 'b']);
  for (const row of requests) { assert.deepEqual(row.bytes, bytes); assert.equal(row.target, '/v1/messages?beta=true'); assert.equal(row.headers['anthropic-beta'], 'custom,oauth-2025-04-20'); assert.equal(row.headers['user-agent'], 'actual-client'); }
  const capture = await latestCapture(); assert.equal(capture.state, 'complete');
  assert.equal(capture.events.filter(event => event.type === 'attempt_start').length, 2);
  assert.equal(capture.events.filter(event => event.type === 'end').length, 1);
  const downstream = Buffer.concat(capture.events.filter(event => event.type === 'response_body').map(event => Buffer.from(event.data, 'base64'))).toString();
  assert.equal(downstream, 'SUCCESS');
  assert.ok(capture.events.some(event => event.type === 'attempt_response_body' && Buffer.from(event.data, 'base64').toString().includes('session exhausted')));
  assert.equal(readdirSync(join(dir, 'proxy-replay')).length, 0);
  const files = readdirSync(join(dir, 'proxy-traffic')).map(file => readFileSync(join(dir, 'proxy-traffic', file), 'utf8')).join('');
  assert.equal(files.includes(tokens.a), false); assert.equal(files.includes('nested model stays'), false);
});

test('bare429,529 and ambiguous5xx pass through without exhausting or rotating', async () => {
  for (const status of [429, 529, 503]) {
    reset(); handler = (_req, res) => { res.writeHead(status, { 'content-type': 'text/plain', 'retry-after': '3' }); res.end('original error'); };
    const response = await request(); assert.equal(response.status, status); assert.equal(response.body.toString(), 'original error');
    assert.equal(requests.length, 1); assert.equal(claudePool.status().accounts.find(row => row.account === 'a').eligible, true);
    await latestCapture();
  }
});

test('partial SSE errors are never spliced with another account', async () => {
  reset(); handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","model":"claude-sonnet-4-6","usage":{"input_tokens":3,"output_tokens":0}}}\n\n'); res.end('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n'); };
  const response = await request(); assert.equal(response.status, 200); assert.ok(response.body.toString().includes('event: error')); assert.equal(requests.length, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM usage_events WHERE source_event_id='msg_partial'").get().n, 0);
  await latestCapture();
});

test('completed SSE usage goes to the existing subscription ledger once using message ID', async () => {
  reset(); handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_complete","model":"claude-sonnet-4-6","usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":2}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4},"delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); };
  assert.equal((await request()).status, 200); await latestCapture();
  const row = db.prepare("SELECT * FROM usage_events WHERE source_event_id='msg_complete'").get(); assert.equal(row.source, 'claude_code'); assert.equal(row.account, 'a'); assert.equal(row.billing, 'subscription'); assert.equal(row.input_tokens, 7); assert.equal(row.output_tokens, 4);
  assert.equal((await request()).status, 200); await latestCapture(); assert.equal(db.prepare("SELECT count(*) n FROM usage_events WHERE source_event_id='msg_complete'").get().n, 1);
});

test('resource references cannot fail over to a different account scope', async () => {
  reset(); handler = (_req, res, { account }) => account === 'a' ? refusal(res) : success(res);
  const response = await request(Buffer.from('{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"file","file_id":"file_owned_by_a"}}]}]}'));
  assert.equal(response.status, 429); assert.equal(requests.length, 1); await latestCapture();
});

test('an explicit Anthropic workspace header pins quota failover to the selected account scope', async () => {
  reset(); handler = (_req, res, { account }) => account === 'a' ? refusal(res) : success(res);
  const bytes = Buffer.from('{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[]}');
  const response = await request(bytes, ['Anthropic-Workspace-Id', 'workspace-owned-by-a']);
  assert.equal(response.status, 429); assert.ok(response.body.toString().includes('session exhausted'));
  assert.deepEqual(admissions, ['a']); assert.equal(requests[0].headers['anthropic-workspace-id'], 'workspace-owned-by-a');
  assert.notEqual(claudePool.status().accounts.find(row => row.account === 'a').quota_scope,
    claudePool.status().accounts.find(row => row.account === 'b').quota_scope);
  assert.equal(claudePool.status().accounts.find(row => row.account === 'b').eligible, true, 'B has allowance but belongs to an incompatible workspace scope');
  const capture = await latestCapture();
  assert.equal(capture.events.filter(event => event.type === 'attempt_start').length, 1);
  assert.ok(capture.events.some(event => event.type === 'attempt_decision' && event.decision === 'try_eligible_account' && event.affinity === 'a'));
  assert.ok(capture.events.some(event => event.type === 'attempt_decision' && event.decision === 'return_quota_response' && event.reason === 'no_compatible_eligible_account'));
});

test('unknown or exhausted allowance returns503 without an upstream admission', async () => {
  reset(); claudePool.observeHeaders('a', raw(quotas(1))); claudePool.observeHeaders('b', raw(quotas(1)));
  const response = await request(); assert.equal(response.status, 503); assert.equal(requests.length, 0); await latestCapture();
});

test('early quota refusal waits for durable full upload and replays exact trailers to B', async () => {
  reset(); let sawA; const admittedA = new Promise(resolve => { sawA = resolve; });
  earlyHandler = (_req, res, account) => { if (account === 'a') { refusal(res); sawA(); return true; } return false; };
  handler = (_req, res) => success(res);
  const prefix = '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"';
  const suffix = 'fully replayed after the client completes"}]}';
  const reply = new Promise((resolve, reject) => {
    const req = http.request(base + '/proxy/claude-code/v1/messages', { method: 'POST', headers: {
      authorization: 'Bearer ' + GATEWAY, 'content-type': 'application/json', Trailer: 'X-Finish',
    } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.write(prefix);
    void (async () => { await admittedA; await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(admissions, ['a']); req.addTrailers({ 'X-Finish': 'exact trailer' }); req.end(suffix); })().catch(reject);
  });
  const response = await reply; assert.equal(response.status, 200); assert.equal(response.body, 'SUCCESS'); assert.deepEqual(admissions, ['a', 'b']);
  assert.equal(requests.at(-1).bytes.toString(), prefix + suffix); assert.deepEqual(requests.at(-1).trailers, ['X-Finish', 'exact trailer']);
  const capture = await latestCapture(); assert.equal(capture.state, 'complete');
});

test('cancelling an incomplete upload after quota refusal never admits B or replays after restart', async () => {
  reset(); let sawA; const admittedA = new Promise(resolve => { sawA = resolve; });
  earlyHandler = (_req, res, account) => { if (account === 'a') { refusal(res); sawA(); return true; } return false; };
  const req = http.request(base + '/proxy/claude-code/v1/messages', { method: 'POST', headers: {
    authorization: 'Bearer ' + GATEWAY, 'content-type': 'application/json',
  } }); req.on('error', () => {});
  req.write('{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"unfinished');
  await admittedA; req.destroy();
  const capture = await latestCapture(); assert.equal(capture.state, 'client_abort'); assert.deepEqual(admissions, ['a']);
  for (let i = 0; i < 100 && readdirSync(join(dir, 'proxy-replay')).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(readdirSync(join(dir, 'proxy-replay')), []);
});

test('model-family quota blocks only the matching model; unknown claims and unrelated families are not replayed', async () => {
  for (const [claim, expected] of [['seven_day_sonnet', 2], ['seven_day_opus', 1], ['new_unknown_claim', 1]]) {
    reset(); handler = (_req, res, { account }) => {
      if (account === 'a') { res.writeHead(429, { ...quotas(.2), 'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': claim, 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 500) }); res.end('family allowance exhausted'); }
      else success(res);
    };
    const response = await request(); assert.equal(response.status, expected === 2 ? 200 : 429); assert.equal(admissions.length, expected); await latestCapture();
    if (expected === 2) {
      assert.equal(claudePool.status({ model: 'claude-sonnet-4-6' }).accounts.find(row => row.account === 'a').reason, 'model_cooldown');
      assert.equal(claudePool.status({ model: 'claude-opus-4-6' }).accounts.find(row => row.account === 'a').eligible, true);
    }
  }
});

test('explicit authentication403 requires manual replacement while permission403 is preserved', async () => {
  for (const errorType of ['permission_error', 'authentication_error']) {
    reset(); handler = (_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: errorType } })); };
    const response = await request(); assert.equal(response.status, 403); assert.equal(admissions.length, 1); await latestCapture();
    assert.equal(db.prepare("SELECT reauth_needed FROM accounts WHERE account='a'").get().reauth_needed, errorType === 'authentication_error' ? 1 : 0);
  }
});
