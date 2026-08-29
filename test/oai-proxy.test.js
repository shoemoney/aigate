// POST /v1/chat/completions — the OpenAI-scheme proxy (codex, opencode, any OAI
// client). Mirror of proxy.test.js on the other wire shape: one fake upstream
// stands in for every provider (AIGATE_OAI_UPSTREAM_* overrides), per-test behavior
// comes from swapping `currentHandler`, and routing tests prove WHICH provider
// answered by which vaulted key authorized the hit — never by running two servers.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { makeVault } from '../src/lib.js';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const DB = join(tmpdir(), `aigate-oai-test-${process.pid}-${Date.now()}.db`);
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
  for (const p of ['OPENAI', 'OPENROUTER', 'QWENCLOUD', 'GROQ', 'DEEPSEEK', 'XAI', 'TOGETHER', 'FIREWORKS', 'VENICE', 'PERPLEXITY'])
    process.env['AIGATE_OAI_UPSTREAM_' + p] = upstreamBase;
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
const chat = (model, extra = {}) => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const ok200 = (req, res, { bodyJson }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl-t', object: 'chat.completion', model: bodyJson.model, choices: [] })); };
// last upstream hit authorized with THIS exact key → the route used that provider's vault
const authedAs = (key) => hits.at(-1).headers.authorization === 'Bearer ' + key;

test('no auth -> 401 in the OpenAI envelope, never the Anthropic one', async () => {
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.type, 'authentication_error');
  assert.equal(j.type, undefined);            // Anthropic shape would carry {type:'error'}
});

test('wrong bearer -> 401, same OpenAI shape', async () => {
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.type, 'authentication_error');
});

test('x-api-key header authenticates exactly like Authorization: Bearer on this route too', async () => {
  await postKey('openrouter', 'sk-or-oai-xapikey-0001');
  currentHandler = ok200;
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
    body: chat('moonshotai/kimi-k2'),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).object, 'chat.completion');
});

test('unparseable body -> 400 OpenAI envelope', async () => {
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: '{not json' });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error.type, 'invalid_request_error');
  assert.equal(j.type, undefined);
});

test('missing / non-string model -> 400', async () => {
  const r1 = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ messages: [] }) });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).error.message, /model is required/);
  const r2 = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model: 42, messages: [] }) });
  assert.equal(r2.status, 400);
  assert.match((await r2.json()).error.message, /non-empty string/);
});

test('upstream URL is <base>/chat/completions — the base override must NOT carry the path', async () => {
  currentHandler = ok200;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('moonshotai/kimi-k2') });
  assert.equal(r.status, 200);
  assert.equal(hits.at(-1).path, '/chat/completions');
});

test('explicit provider:model strips the prefix and uses that provider\'s key', async () => {
  await postKey('openai', 'sk-openai-test-AAAA');
  currentHandler = ok200;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('openai:gpt-5-turbo') });
  assert.equal(r.status, 200);
  assert.equal(hits.at(-1).bodyJson.model, 'gpt-5-turbo');
  assert.ok(authedAs('sk-openai-test-AAAA'));
});

test('bare gpt-* / oN / codex-* names route to openai', async () => {
  currentHandler = ok200;
  for (const m of ['gpt-5-codex', 'o3-deep-research', 'codex-mini-latest']) {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat(m) });
    assert.equal(r.status, 200, m);
    assert.equal(hits.at(-1).bodyJson.model, m);
    assert.ok(authedAs('sk-openai-test-AAAA'), m + ' must use the openai vault key');
  }
});

test('bare qwen* routes to qwencloud; the slash form qwen/... stays on openrouter', async () => {
  await postKey('qwencloud', 'sk-dashscope-oai-BBBB');
  currentHandler = ok200;
  const r1 = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('qwen3.8-flash-next') });
  assert.equal(r1.status, 200);
  assert.equal(hits.at(-1).bodyJson.model, 'qwen3.8-flash-next');
  assert.ok(authedAs('sk-dashscope-oai-BBBB'));
  const r2 = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('qwen/qwen3-coder-plus') });
  assert.equal(r2.status, 200);
  assert.equal(hits.at(-1).bodyJson.model, 'qwen/qwen3-coder-plus');
  assert.match(hits.at(-1).headers.authorization, /^Bearer sk-or-/);
});

test('bare deepseek* / grok* / sonar* route to their own vaults', async () => {
  await postKey('deepseek', 'sk-deepseek-test-CCCC');
  await postKey('xai', 'xai-test-DDDD');
  await postKey('perplexity', 'pplx-test-EEEE');
  currentHandler = ok200;
  const cases = [['deepseek-chat', 'sk-deepseek-test-CCCC'], ['grok-4-fast', 'xai-test-DDDD'], ['sonar-pro', 'pplx-test-EEEE']];
  for (const [m, key] of cases) {
    const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat(m) });
    assert.equal(r.status, 200, m);
    assert.ok(authedAs(key), m + ' must use its own provider key');
  }
});

test('unknown bare model falls back to openrouter, model unchanged', async () => {
  currentHandler = ok200;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('llama-3.3-70b-instruct') });
  assert.equal(r.status, 200);
  assert.equal(hits.at(-1).bodyJson.model, 'llama-3.3-70b-instruct');
  assert.match(hits.at(-1).headers.authorization, /^Bearer sk-or-/);
});

test('extra body fields (stream_options, temperature, tools) pass through untouched', async () => {
  currentHandler = ok200;
  const tools = [{ type: 'function', function: { name: 'f', parameters: {} } }];
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H,
    body: chat('gpt-5', { temperature: 0.2, stream_options: { include_usage: true }, tools }) });
  assert.equal(r.status, 200);
  const b = hits.at(-1).bodyJson;
  assert.equal(b.temperature, 0.2);
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.deepEqual(b.tools, tools);
});

test('failover: 401 on the newest openrouter key flips it dead, the older key serves', async () => {
  await postKey('openrouter', 'sk-or-oaifail-OLDERAAAA');
  await postKey('openrouter', 'sk-or-oaifail-NEWERBBBB');
  currentHandler = (req, res) => {
    if (req.headers.authorization === 'Bearer sk-or-oaifail-NEWERBBBB') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key', type: 'authentication_error', code: '401' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'chat.completion', servedBy: 'older' }));
  };
  const before = hits.length;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('moonshotai/kimi-k2') });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).servedBy, 'older');
  assert.equal(hits.length, before + 2, 'tried the newest key, then failed over');
  assert.equal(await keyStatus('openrouter', 'BBBB'), 'dead');
  assert.equal(await keyStatus('openrouter', 'AAAA'), 'working');
});

test('429 passthrough: status + retry-after forwarded verbatim, never retried', async () => {
  currentHandler = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '23' });
    res.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error', code: '429' } }));
  };
  const before = hits.length;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('gpt-5') });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '23');
  assert.equal((await r.json()).error.type, 'rate_limit_error');
  assert.equal(hits.length, before + 1);
});

test('SSE: stream chunks arrive incrementally with the event-stream content type', async () => {
  const CHUNKS = ['data: {"choices":[{"delta":{"content":"he"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"y"}}]}\n\n', 'data: [DONE]\n\n'];
  currentHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let i = 0;
    const tick = () => {
      res.write(CHUNKS[i++]);
      if (i < CHUNKS.length) setTimeout(tick, 30); else res.end();
    };
    tick();
  };
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('gpt-5', { stream: true }) });
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
  assert.ok(arrivals.length >= 2, 'incremental reads, not one buffered blob');
  assert.ok(arrivals.at(-1) - arrivals[0] >= 20, 'spread over time proves no full-body buffering');
});

test('SSE: client abort mid-stream tears down the upstream request (billing stops, daemon survives)', async () => {
  const upstreamClosed = new Promise((resolve) => {
    currentHandler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
      const t = setInterval(() => res.write('data: {"tick":1}\n\n'), 50);
      res.on('close', () => { clearInterval(t); resolve(); });
    };
  });
  const ac = new AbortController();
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('gpt-5', { stream: true }), signal: ac.signal });
  assert.equal(r.status, 200);
  await r.body.getReader().read();
  ac.abort();
  await upstreamClosed;   // hangs until test timeout if the abort does not propagate
  const h = await fetch(base + '/health');
  assert.equal(h.status, 200, 'daemon must survive a mid-stream disconnect');
});

test('no working key for the routed provider -> 529 OpenAI envelope naming the provider', async () => {
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: H, body: chat('groq:llama-3.3-70b-versatile') });
  assert.equal(r.status, 529);
  const j = await r.json();
  assert.equal(j.error.type, 'overloaded_error');
  assert.match(j.error.message, /groq/);
  assert.equal(j.type, undefined);
});

test('GET /v1/models entries are the superset shape: Anthropic AND OpenAI fields on every row', async () => {
  const r = await fetch(base + '/v1/models', { headers: H });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.has_more, false);
  assert.ok(j.data.length > 0);
  const ids = j.data.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'a provider vaulted for both schemes appears exactly once');
  for (const m of j.data) {
    assert.equal(m.type, 'model');            // Anthropic scheme reads this
    assert.equal(m.object, 'model');          // OpenAI scheme reads this
    assert.ok(m.id);
    assert.ok(m.display_name);
    assert.equal(m.owned_by, 'aigate');
    assert.equal(typeof m.created, 'number');
  }
  assert.ok(ids.some((id) => id.startsWith('deepseek:')), 'oai-only provider with a vaulted key is listed');
  assert.ok(ids.some((id) => id.startsWith('openrouter:')), 'shared provider listed once via either loop');
});

// --- /v1/responses: same machinery, codex's wire (chat support was removed in codex ≥0.96) ---
test('POST /v1/responses: no auth -> 401 OpenAI envelope', async () => {
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.type, 'authentication_error');
  assert.equal(j.type, undefined);
});

test('POST /v1/responses forwards to <base>/responses with the routed model and key', async () => {
  currentHandler = (req, res, { bodyJson }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'resp_t', object: 'response', model: bodyJson.model, output: [] }));
  };
  const r = await fetch(base + '/v1/responses', { method: 'POST', headers: H,
    body: JSON.stringify({ model: 'openai:gpt-5-codex', input: 'say pong' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).object, 'response');
  assert.equal(hits.at(-1).path, '/responses');
  assert.equal(hits.at(-1).bodyJson.model, 'gpt-5-codex');
  assert.ok(authedAs('sk-openai-test-AAAA'));
});

test('POST /v1/responses: slash model rides openrouter, keyless provider 529s in the OpenAI shape', async () => {
  currentHandler = (req, res, { bodyJson }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ object: 'response', model: bodyJson.model })); };
  const r1 = await fetch(base + '/v1/responses', { method: 'POST', headers: H, body: JSON.stringify({ model: 'openai/o4-mini', input: 'hi' }) });
  assert.equal(r1.status, 200);
  assert.equal(hits.at(-1).bodyJson.model, 'openai/o4-mini');
  assert.match(hits.at(-1).headers.authorization, /^Bearer sk-or-/);
  const r2 = await fetch(base + '/v1/responses', { method: 'POST', headers: H, body: JSON.stringify({ model: 'groq:whatever', input: 'hi' }) });
  assert.equal(r2.status, 529);
  assert.equal((await r2.json()).error.type, 'overloaded_error');
});
