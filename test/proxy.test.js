// POST /v1/messages + GET /v1/models — the Anthropic Messages-protocol proxy for
// API-key providers only. Every upstream override (AIGATE_PROXY_UPSTREAM_*) points at
// one fake HTTP server for the whole file; per-test behavior comes from swapping
// `currentHandler`, never a second real server, so ordering stays cheap to reason about.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { makeVault } from '../src/lib.js';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const DB = join(tmpdir(), `aigate-proxy-test-${process.pid}-${Date.now()}.db`);
const ENC_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_ENCRYPTION_KEY = ENC_KEY;
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.AIGATE_KEY_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;
delete process.env.AIGATE_PROXY_MAIN;
delete process.env.AIGATE_PROXY_SMALL;

const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(ENC_KEY, 'hex'));
const BACKUPS = join(tmpdir(), 'backups');
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

// fake upstream: records every hit, dispatches to whatever the current test set as
// its handler. Swapped per-test rather than spinning N servers.
let currentHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
const hits = [];
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    let bodyJson; try { bodyJson = JSON.parse(bodyText); } catch { bodyJson = null; }
    hits.push({ method: req.method, path: req.url, headers: req.headers, bodyJson });
    currentHandler(req, res, { bodyText, bodyJson });
  });
});

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  // one fake stands in for all three upstreams — the routing tests below prove which
  // provider's override actually got read, not whether two servers can coexist.
  process.env.AIGATE_PROXY_UPSTREAM_OPENROUTER = upstreamBase;
  process.env.AIGATE_PROXY_UPSTREAM_KIMI = upstreamBase;
  process.env.AIGATE_PROXY_UPSTREAM_ANTHROPIC = upstreamBase;
});
after(() => {
  server.close();
  upstream.close();
  try { db.close(); } catch { /* already closed */ }
  for (const f of [DB, DB + '-wal', DB + '-shm']) { try { rmSync(f); } catch { /* gone */ } }
  rmSync(BACKUPS, { recursive: true, force: true });
});

const postKey = (provider, key) => fetch(base + '/api/keys', { method: 'POST', headers: H, body: JSON.stringify({ provider, key }) });
const keyStatus = async (provider, hintFrag) => {
  const list = await (await fetch(base + '/api/keys', { headers: H })).json();
  return list.find((k) => k.provider === provider && k.key_hint.includes(hintFrag))?.status;
};
const messages = (model, extra = {}) => JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }], ...extra });

test('POST /v1/messages: no auth -> 401 Anthropic error envelope', async () => {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'authentication_error');
});

test('POST /v1/messages: wrong bearer -> 401 envelope (same shape, not aigate\'s plain {error})', async () => {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'authentication_error');
});

test('POST /v1/messages: x-api-key header authenticates exactly like Authorization: Bearer', async () => {
  await postKey('openrouter', 'sk-or-xapikeytest-EEEE');
  currentHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); };
  const r = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
    body: messages('moonshotai/kimi-k2'),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
});

test('static branch does not shadow /v1/*: unauthenticated GET /v1/models still hits the auth gate', async () => {
  const r = await fetch(base + '/v1/models');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).type, 'error');
});

test('POST /v1/messages: unparseable body -> 400 invalid_request_error', async () => {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: '{not json' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'invalid_request_error');
});

test('POST /v1/messages: missing model -> 400 invalid_request_error', async () => {
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: JSON.stringify({ max_tokens: 5 }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
});

test('tier alias: claude-*haiku* routes via AIGATE_PROXY_SMALL, rewrites the model, uses the vaulted key', async () => {
  await postKey('openrouter', 'sk-or-aliassmall-0001');
  process.env.AIGATE_PROXY_SMALL = 'openrouter:moonshotai/kimi-k2';
  currentHandler = (req, res, { bodyJson }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_alias', role: 'assistant', model: bodyJson.model, content: [{ type: 'text', text: 'hi from alias' }] }));
  };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('claude-3-haiku-x') });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'moonshotai/kimi-k2');       // response round-trips
  assert.equal(j.content[0].text, 'hi from alias');
  const last = hits.at(-1);
  assert.equal(last.bodyJson.model, 'moonshotai/kimi-k2');   // upstream got the REWRITTEN model
  assert.equal(last.headers.authorization, 'Bearer sk-or-aliassmall-0001');
  delete process.env.AIGATE_PROXY_SMALL;
});

test('tier alias: a haiku-shaped model with NO AIGATE_PROXY_SMALL set falls back to anthropic, not a 500', async () => {
  assert.equal(process.env.AIGATE_PROXY_SMALL, undefined, 'sanity: no small alias configured');
  await postKey('anthropic', 'sk-ant-api03-haikufallback01');
  currentHandler = (req, res, { bodyJson }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, model: bodyJson.model })); };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('claude-3-5-haiku-nosmallenv') });
  assert.equal(r.status, 200);   // regression: used to throw on undefined.trim() and 500
  assert.equal((await r.json()).model, 'claude-3-5-haiku-nosmallenv');
  assert.equal(hits.at(-1).headers['x-api-key'], 'sk-ant-api03-haikufallback01');
});

test('explicit provider:model routes to that provider and strips the prefix from the forwarded model', async () => {
  await postKey('kimi', 'sk-kimi-explicit-0001');
  currentHandler = (req, res, { bodyJson }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, model: bodyJson.model })); };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('kimi:kimi-k3') });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).model, 'kimi-k3');
  const last = hits.at(-1);
  assert.equal(last.bodyJson.model, 'kimi-k3');
  assert.equal(last.headers.authorization, 'Bearer sk-kimi-explicit-0001');
});

test('unmapped claude-* model with no alias env falls back to anthropic passthrough, model unchanged', async () => {
  assert.equal(process.env.AIGATE_PROXY_MAIN, undefined, 'sanity: no main alias configured');
  await postKey('anthropic', 'sk-ant-api03-realkeyxxxx');
  currentHandler = (req, res, { bodyJson }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, model: bodyJson.model })); };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('claude-opus-5-unmapped') });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).model, 'claude-opus-5-unmapped');   // unchanged, not rewritten
  const last = hits.at(-1);
  assert.equal(last.headers['x-api-key'], 'sk-ant-api03-realkeyxxxx');   // anthropic auth shape
  assert.equal(last.headers.authorization, undefined);                  // never Bearer for anthropic
});

test('oat-guard: POST /api/keys refuses a Claude Code setup-token for provider anthropic', async () => {
  const r = await fetch(base + '/api/keys', { method: 'POST', headers: H,
    body: JSON.stringify({ provider: 'anthropic', key: 'sk-ant-oat01-shouldneverbeankey' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /OAuth token/);
});

test('oat-guard: a pre-seeded oat row in provider_keys is skipped by the proxy — the OTHER key serves', async () => {
  await postKey('anthropic', 'sk-ant-api03-goodfallback01');
  // bypass the store-time guard directly (simulates a row from before the guard existed)
  db.prepare(`INSERT INTO provider_keys(provider,key_enc,key_hint,status) VALUES(?,?,?, 'working')`)
    .run('anthropic', vault.encrypt('sk-ant-oat01-poisonedrow'), 'oat…poison#seed');
  currentHandler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true })); };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('claude-opus-5-unmapped-2') });
  assert.equal(r.status, 200);
  assert.equal(hits.at(-1).headers['x-api-key'], 'sk-ant-api03-goodfallback01');   // never the oat token
});

test('failover: 401 on the newest openrouter key flips it dead, the older key serves the request', async () => {
  await postKey('openrouter', 'sk-or-failover-OLDERAAAA');
  await postKey('openrouter', 'sk-or-failover-NEWERBBBB');
  currentHandler = (req, res) => {
    if (req.headers.authorization === 'Bearer sk-or-failover-NEWERBBBB') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, servedBy: 'older' }));
  };
  const before = hits.length;
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('moonshotai/kimi-k2') });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).servedBy, 'older');
  assert.equal(hits.length, before + 2, 'tried the newest key, then failed over to the older one');
  assert.equal(await keyStatus('openrouter', 'BBBB'), 'dead');      // 401'd key flipped
  assert.equal(await keyStatus('openrouter', 'AAAA'), 'working');   // the one that actually served
});

test('429 passthrough: status + retry-after forwarded verbatim, no retry against a second key', async () => {
  await postKey('openrouter', 'sk-or-ratelimited-CCCC');
  currentHandler = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }));
  };
  const before = hits.length;
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('moonshotai/kimi-k2') });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '17');
  assert.equal((await r.json()).error.type, 'rate_limit_error');
  assert.equal(hits.length, before + 1, '429 is passed through, never retried');
});

test('SSE: chunks stream incrementally to the client, content-type passthrough, full content arrives', async () => {
  await postKey('openrouter', 'sk-or-sse-DDDD');
  const CHUNKS = ['event: a\ndata: 1\n\n', 'event: b\ndata: 2\n\n', 'event: c\ndata: 3\n\n'];
  currentHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = () => {
      res.write(CHUNKS[i++]);
      if (i < CHUNKS.length) setTimeout(tick, 30); else res.end();
    };
    tick();
  };
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('moonshotai/kimi-k2', { stream: true }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const arrivals = [];
  let text = '';
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Date.now());
    text += decoder.decode(value, { stream: true });
  }
  assert.equal(text, CHUNKS.join(''));
  assert.ok(arrivals.length >= 2, 'expected multiple incremental reads, not one buffered blob');
  assert.ok(arrivals.at(-1) - arrivals[0] >= 20, 'reads should be spread over time, proving no full-body buffering');
});

test('no working key for the routed provider -> 529 overloaded_error naming the provider', async () => {
  // kimi got one working key from the earlier explicit-route test and nothing after
  // this needs it — clear it so the provider is genuinely keyless for this assertion.
  db.prepare(`DELETE FROM provider_keys WHERE provider='kimi'`).run();
  const r = await fetch(base + '/v1/messages', { method: 'POST', headers: H, body: messages('kimi:no-such-key-vaulted') });
  assert.equal(r.status, 529);
  const j = await r.json();
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'overloaded_error');
  assert.match(j.error.message, /kimi/);
});

test('GET /v1/models returns the Anthropic list shape', async () => {
  process.env.AIGATE_PROXY_MAIN = 'openrouter:some/main-model';
  process.env.AIGATE_PROXY_SMALL = 'openrouter:some/small-model';
  const r = await fetch(base + '/v1/models', { headers: H });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.has_more, false);
  assert.ok(Array.isArray(j.data));
  for (const m of j.data) { assert.equal(m.type, 'model'); assert.ok(m.id); assert.ok(m.display_name); }
  assert.ok(j.data.some((m) => m.id === 'openrouter:some/main-model'));
  assert.ok(j.data.some((m) => m.id === 'openrouter:some/small-model'));
  assert.ok(j.data.some((m) => m.id.startsWith('openrouter:') && m.display_name.includes('vaulted')), 'a provider with a working key is listed');
  delete process.env.AIGATE_PROXY_MAIN; delete process.env.AIGATE_PROXY_SMALL;
});
