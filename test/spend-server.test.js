import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync, readFileSync } from 'node:fs';

// Throwaway DB + token BEFORE importing server.js (same isolation idiom as http.test.js).
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const TMP = mkdtempSync(join(tmpdir(), 'aigate-spend-'));
const DB = join(TMP, `aigate-test-${process.pid}-${Date.now()}.db`);
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_DASHBOARD_PASSWORD = 'master-' + crypto.randomBytes(6).toString('hex');
process.env.AIGATE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;

const { server, db } = await import('../src/server.js');
const { ensureSchema, seedIfNeeded, pruneOld } = await import('../src/spend.js');
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* already closed */ }
  rmSync(TMP, { recursive: true, force: true });
});

const post = (path, body, method = 'POST') => fetch(base + path, { method, headers: H, body: JSON.stringify(body) });
const get = (path) => fetch(base + path, { headers: H });
const count = (where = '1=1', ...a) => db.prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE ${where}`).get(...a).n;
const rowOf = (id) => db.prepare(`SELECT * FROM usage_events WHERE source_event_id=?`).get(id);

const ev = (id, o = {}) => ({ source_event_id: id, ts: '2026-10-06T16:33:21.989Z', provider: 'anthropic', model: 'claude-opus-5-5',
  input_tokens: 2, output_tokens: 304, cache_read_tokens: 20132, cache_write_tokens: 62010, cache_write_1h_tokens: 62010,
  cache_tokens_in_prompt: false, status: 'success', project: 'aigate', session_id: 's-' + id, scope: '', ...o });
const batch = (host, events, o = {}) => ({ source: 'claude_code', host, collector_version: '1.0.0', events, ...o });

test('every /api/spend route is behind the auth gate', async () => {
  for (const [method, path] of [['GET', '/api/spend'], ['POST', '/api/spend/events'], ['POST', '/api/spend/sessions'],
    ['GET', '/api/spend/prices'], ['PUT', '/api/spend/prices'], ['POST', '/api/spend/reprice'], ['GET', '/api/spend/collectors']]) {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 401, `${method} ${path}`);
  }
});

test('boot seeds the price table once and an operator row survives a re-run', () => {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM spend_prices`).get().n;
  assert.ok(n >= 70, `seeded ${n} rows`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM spend_prices WHERE provider='moonshot'`).get().n, 0, 'kimi stays unpriced');
  db.prepare(`INSERT INTO spend_prices(provider, model, effective_from, input_micros, output_micros, note) VALUES('t','keepme','2026-01-01',1,1,'operator')`).run();
  assert.equal(seedIfNeeded(db), 0);
  ensureSchema(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM spend_prices`).get().n, n + 1);
});

test('space-bunny-alpha is priced at exactly 1/5 of claude-opus-5-5 on every meter', async () => {
  const rows = await (await get('/api/spend/prices')).json();
  const pick = (provider, model) => rows.find((r) => r.provider === provider && r.model === model);
  const opus = pick('anthropic', 'claude-opus-5-5');
  assert.ok(opus);
  const fifth = (v) => (Number(v) / 5).toFixed(2);
  for (const r of [pick('openrouter', 'stealth/space-bunny-alpha'), pick('*', 'space-bunny-alpha'), pick('*', 'space-bunny-free')]) {
    assert.ok(r, 'space-bunny row present');
    for (const f of ['input_usd', 'output_usd', 'cache_read_usd', 'cache_write_usd', 'cache_write_1h_usd'])
      assert.equal(Number(r[f]).toFixed(2), fifth(opus[f]), `${r.model} ${f}`);
  }
  // end to end: the same usage on opus costs exactly 5x what it costs on space-bunny-alpha
  const out = await (await post('/api/spend/events', batch('bunny', [
    ev('bun-opus', { session_id: 'x1' }),
    ev('bun-alpha', { provider: 'openrouter', model: 'stealth/space-bunny-alpha', session_id: 'x2' }),
  ]))).json();
  assert.equal(out.unpriced, 0);
  const a = rowOf('bun-opus').cost_micros, b = rowOf('bun-alpha').cost_micros;
  assert.ok(Math.abs(a - 5 * b) <= 3, `opus ${a} vs 5x alpha ${5 * b}`);
});

test('ingest: accepted, then the identical batch is all duplicates and the row count does not move', async () => {
  const events = [ev('m1'), ev('m2'), ev('m3')];
  let r = await post('/api/spend/events', batch('hostA', events));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { accepted: 3, duplicate: 0, rejected: 0, unpriced: 0, unattributed: 3, unpriced_models: [], errors: [] });
  const before = count();
  const sameId = rowOf('m1');
  r = await post('/api/spend/events', batch('hostA', [ev('m1', { output_tokens: 999999 }), ev('m2'), ev('m3')]));
  const j = await r.json();
  assert.equal(j.accepted, 0);
  assert.equal(j.duplicate, 3);
  assert.equal(count(), before);
  assert.deepEqual({ ...rowOf('m1') }, { ...sameId }, 're-ingest never updates a row');
});

test('ingest: a duplicate id inside one batch counts once', async () => {
  const j = await (await post('/api/spend/events', batch('hostDup', [ev('d1'), ev('d1')]))).json();
  assert.equal(j.accepted, 1);
  assert.equal(j.duplicate, 1);
});

test('ingest validation: whole batch is rejected and nothing is written', async () => {
  const n0 = count();
  let r = await post('/api/spend/events', batch('hostV', Array.from({ length: 1001 }, (_, i) => ev('big' + i))));
  assert.equal(r.status, 400);

  r = await post('/api/spend/events', batch('hostV', [ev('v1'), ev('v2', { prompt: 'secret text' })]));
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'content fields are not accepted', field: 'events[1].prompt', index: 1 });

  r = await post('/api/spend/events', { ...batch('hostV', [ev('v3')]), messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.error, 'content fields are not accepted');
  assert.equal(j.field, 'messages');

  for (const bad of [{ ts: 'yesterday' }, { ts: '2019-12-31T00:00:00Z' }, { ts: '2099-01-01T00:00:00Z' }, { input_tokens: -1 },
    { output_tokens: 1.5 }, { cache_read_tokens: 2 ** 31 }, { model: 'bad model!' }, { source_event_id: '' }, { provider: 'a b' }]) {
    r = await post('/api/spend/events', batch('hostV', [ev('ok1'), ev('bad1', bad)]));
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal((await r.json()).index, 1);
  }
  r = await post('/api/spend/events', { ...batch('hostV', [ev('v4')]), source: 'nope' });
  assert.equal(r.status, 400);
  r = await post('/api/spend/events', batch('hostV', []));
  assert.equal(r.status, 400);
  r = await post('/api/spend/events', { ...batch('', [ev('v5')]) });
  assert.equal(r.status, 400);
  r = await post('/api/spend/events', batch('hostV', [ev('v6')], { summary: { files: 1, transcript: 'x' } }));
  assert.equal(r.status, 400);
  assert.equal(count(), n0, 'zero rows written by any rejected batch');
  assert.equal(count(`host='hostV'`), 0);
});

test('ingest: cache_write_1h is clamped to cache_write, not rejected', async () => {
  const r = await post('/api/spend/events', batch('hostC', [ev('clamp1', { cache_write_tokens: 100, cache_write_1h_tokens: 500 })]));
  assert.equal(r.status, 200);
  const row = rowOf('clamp1');
  assert.equal(row.cache_write_tokens, 100);
  assert.equal(row.cache_write_1h_tokens, 100);
});

test('pricing at ingest: cost and price_id stored, unknown models counted in unpriced_models', async () => {
  const j = await (await post('/api/spend/events', batch('hostP', [
    ev('p1'),
    ev('p2', { provider: 'moonshot', model: 'kimi-k3', session_id: 'k1' }),
    ev('p3', { provider: 'moonshot', model: 'kimi-k3', session_id: 'k2' }),
    ev('p4', { model: 'claude-haiku-4-5-20251001', session_id: 'h1' }),
  ]))).json();
  assert.equal(j.accepted, 4);
  assert.equal(j.unpriced, 2);
  assert.deepEqual(j.unpriced_models, [{ provider: 'moonshot', model: 'kimi-k3', events: 2 }]);
  const priced = rowOf('p1');
  assert.equal(priced.cost_micros, 506194);   // 2*4 + 304*20 + 20132*0.2 + 62010*8 micro-dollars
  assert.ok(priced.price_id > 0);
  assert.ok(priced.priced_at);
  assert.equal(rowOf('p2').cost_micros, null);
  assert.equal(rowOf('p2').price_id, null);
  assert.ok(rowOf('p4').cost_micros > 0, 'dated model name falls back to the base rate');
});

test('attribution: a session posted BEFORE its events attributes them on ingest', async () => {
  let r = await post('/api/spend/sessions', { source: 'claude_code', host: 'hostS', session_id: 'sess-before', scope: '', account: 'shoemoney',
    kind: 'claude', via: 'hook', ts: '2026-10-06T16:00:00.000Z' });
  assert.deepEqual(await r.json(), { upserted: 1, resolved: 0 });
  const j = await (await post('/api/spend/events', batch('hostS', [ev('sb1', { session_id: 'sess-before' })]))).json();
  assert.equal(j.unattributed, 0);
  const row = rowOf('sb1');
  assert.equal(row.account, 'shoemoney');
  assert.equal(row.account_kind, 'claude');
  assert.equal(row.attributed_by, 'hook');
  assert.equal(row.billing, 'subscription');
});

test('attribution: a session posted AFTER its events re-resolves them and fixes billing', async () => {
  const j = await (await post('/api/spend/events', batch('hostS', [ev('sa1', { session_id: 'sess-after' }), ev('sa2', { session_id: 'sess-after' }),
    ev('sa3', { session_id: 'other-sess' })]))).json();
  assert.equal(j.unattributed, 3);
  assert.equal(rowOf('sa1').billing, 'unknown');
  const r = await (await post('/api/spend/sessions', { sessions: [{ source: 'claude_code', host: 'hostS', session_id: 'sess-after', scope: '',
    account: 'work', kind: 'claude', via: 'hook', ts: '2026-10-06T16:30:00.000Z' }] })).json();
  assert.deepEqual(r, { upserted: 1, resolved: 2 });
  assert.equal(rowOf('sa1').account, 'work');
  assert.equal(rowOf('sa1').billing, 'subscription');
  assert.equal(rowOf('sa3').account, null, 'a different session is untouched');
  assert.equal(rowOf('sa3').billing, 'unknown');
});

test('attribution: two accounts on one Claude session follow the time rule', async () => {
  await post('/api/spend/sessions', { sessions: [
    { source: 'claude_code', host: 'hostT', session_id: 'sess-two', scope: '', account: 'acct-a', kind: 'claude', via: 'hook', ts: '2026-10-06T10:00:00.000Z' },
    { source: 'claude_code', host: 'hostT', session_id: 'sess-two', scope: '', account: 'acct-b', kind: 'claude', via: 'hook', ts: '2026-10-06T12:00:00.000Z' },
  ] });
  await post('/api/spend/events', batch('hostT', [
    ev('t-early', { session_id: 'sess-two', ts: '2026-10-06T11:00:00.000Z' }),
    ev('t-edge', { session_id: 'sess-two', ts: '2026-10-06T11:58:30.000Z' }),   // inside the 120 s tolerance of acct-b's start
    ev('t-late', { session_id: 'sess-two', ts: '2026-10-06T13:00:00.000Z' }),
    ev('t-before', { session_id: 'sess-two', ts: '2026-10-06T09:00:00.000Z' }),   // before any row: earliest
  ]));
  assert.equal(rowOf('t-early').account, 'acct-a');
  assert.equal(rowOf('t-edge').account, 'acct-b');
  assert.equal(rowOf('t-late').account, 'acct-b');
  assert.equal(rowOf('t-before').account, 'acct-a');
});

test('attribution: session upserts are idempotent and replaying old lines does not split rows', async () => {
  const lines = [
    { source: 'claude_code', host: 'hostR', session_id: 'sess-r', scope: '', account: 'a', kind: 'claude', via: 'hook', ts: '2026-10-06T10:00:00.000Z' },
    { source: 'claude_code', host: 'hostR', session_id: 'sess-r', scope: '', account: 'b', kind: 'claude', via: 'hook', ts: '2026-10-06T11:00:00.000Z' },
    { source: 'claude_code', host: 'hostR', session_id: 'sess-r', scope: '', account: 'a', kind: 'claude', via: 'hook', ts: '2026-10-06T12:00:00.000Z' },
  ];
  for (let i = 0; i < 3; i++) await post('/api/spend/sessions', { sessions: lines });
  const rows = db.prepare(`SELECT account, first_seen FROM spend_sessions WHERE host='hostR' ORDER BY first_seen`).all();
  assert.deepEqual(rows.map((r) => r.account), ['a', 'b', 'a']);
  // a later ping of the same account only extends last_seen
  await post('/api/spend/sessions', { ...lines[2], ts: '2026-10-06T12:30:00.000Z' });
  const last = db.prepare(`SELECT last_seen FROM spend_sessions WHERE host='hostR' ORDER BY first_seen DESC LIMIT 1`).get();
  assert.equal(last.last_seen, '2026-10-06T12:30:00.000Z');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM spend_sessions WHERE host='hostR'`).get().n, 3);
  const list = await (await get('/api/spend/sessions?limit=5')).json();
  assert.ok(Array.isArray(list) && list.length >= 1 && list.length <= 5);
});

test('attribution: codex lease by session_started_at, and an account "" lease closes it', async () => {
  const scope = '/Users/test/.codex';
  await post('/api/spend/sessions', { sessions: [
    { source: 'codex', host: 'hostX', session_id: null, scope, account: 'codex-one', kind: 'codex', via: 'ai-codex', ts: '2026-10-06T08:00:00.000Z' },
    { source: 'codex', host: 'hostX', session_id: null, scope, account: '', kind: 'codex', via: 'keeper', ts: '2026-10-06T20:00:00.000Z' },
  ] });
  const mk = (id, started, o = {}) => ev(id, { provider: 'openai', model: 'gpt-6-sol', scope, session_id: 'rollout-' + id, session_started_at: started,
    cache_tokens_in_prompt: true, input_tokens: 1000, cache_read_tokens: 500, cache_write_tokens: 0, cache_write_1h_tokens: 0, ...o });
  const j = await (await post('/api/spend/events', { source: 'codex', host: 'hostX', events: [
    mk('cx-live', '2026-10-06T09:00:00.000Z'),
    mk('cx-closed', '2026-10-06T21:00:00.000Z'),
    mk('cx-before', '2026-10-06T07:00:00.000Z'),
    mk('cx-otherscope', '2026-10-06T09:00:00.000Z', { scope: '/elsewhere/.codex' }),
  ] })).json();
  assert.equal(j.accepted, 4);
  assert.equal(rowOf('cx-live').account, 'codex-one');
  assert.equal(rowOf('cx-live').attributed_by, 'lease');
  assert.equal(rowOf('cx-live').account_kind, 'codex');
  assert.equal(rowOf('cx-live').billing, 'subscription');
  assert.equal(rowOf('cx-closed').account, null, 'the account "" lease marks it not aigate-managed');
  assert.equal(rowOf('cx-before').account, null, 'no lease existed yet');
  assert.equal(rowOf('cx-otherscope').account, null);
});

test('billing classes: subscription / unknown / api', async () => {
  await post('/api/spend/sessions', { source: 'claude_code', host: 'hostB', session_id: 'b-sub', scope: '', account: 'acct', kind: 'claude', via: 'hook', ts: '2026-10-06T10:00:00.000Z' });
  await post('/api/spend/events', batch('hostB', [
    ev('bill-sub', { session_id: 'b-sub' }),
    ev('bill-unknown', { session_id: 'b-none' }),
    ev('bill-api', { provider: 'openrouter', model: 'stealth/space-bunny-alpha', session_id: 'b-none2' }),
    ev('bill-api-attr', { provider: 'openrouter', model: 'stealth/space-bunny-alpha', session_id: 'b-sub' }),
  ]));
  assert.equal(rowOf('bill-sub').billing, 'subscription');
  assert.equal(rowOf('bill-unknown').billing, 'unknown');
  assert.equal(rowOf('bill-api').billing, 'api');
  assert.equal(rowOf('bill-api-attr').billing, 'api', 'only anthropic/openai count as subscription value');
});

const walk = (o, f, path = '') => {
  if (Array.isArray(o)) o.forEach((x, i) => walk(x, f, `${path}[${i}]`));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { f(k, `${path}.${k}`); walk(v, f, `${path}.${k}`); }
};

test('GET /api/spend: totals equal the sum of groups (other included), series, collectors, no "tokens" key', async () => {
  const host = 'hostG';
  const accts = ['g1', 'g2', 'g3', 'g4'];
  for (const [i, a] of accts.entries())
    await post('/api/spend/sessions', { source: 'claude_code', host, session_id: 'gs' + i, scope: '', account: a, kind: 'claude', via: 'hook', ts: '2026-10-01T00:00:00.000Z' });
  const events = [];
  for (const [i] of accts.entries()) for (let n = 0; n <= i; n++)
    events.push(ev(`g-${i}-${n}`, { session_id: 'gs' + i, ts: `2026-10-0${2 + (n % 2)}T12:00:00.000Z`, output_tokens: 1000 * (i + 1) }));
  events.push(ev('g-unk', { session_id: 'nobody', ts: '2026-10-02T09:00:00.000Z' }));
  events.push(ev('g-unpriced', { provider: 'moonshot', model: 'kimi-k3', session_id: 'nobody2', ts: '2026-10-03T09:00:00.000Z' }));
  const ing = await (await post('/api/spend/events', batch(host, events, { summary: { files: 12, scanned: 40, errors: 0 } }))).json();
  assert.equal(ing.accepted, events.length);

  const r = await get(`/api/spend?from=2026-10-01&to=2026-10-07&host=${host}&group=account&top=2`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.range.bucket, 'day');
  assert.equal(j.range.group, 'account');
  assert.equal(j.totals.events, events.length);
  assert.equal(j.totals.unpriced_events, 1);
  assert.equal(j.totals.priced_events, events.length - 1);
  assert.equal(j.totals.unattributed_events, 2);
  assert.deepEqual(j.totals.unpriced_models, [{ provider: 'moonshot', model: 'kimi-k3', events: 1 }]);

  assert.equal(j.groups.length, 3);
  assert.equal(j.groups.filter((g) => g.is_other).length, 1);
  assert.match(j.groups.find((g) => g.is_other).label, /^other \(\d+\)$/);
  for (const f of ['events', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens', 'unpriced_events']) {
    assert.equal(j.groups.reduce((n, g) => n + g[f], 0), j.totals[f], `groups reconcile on ${f}`);
    assert.equal(j.series.reduce((n, s) => n + s[f], 0), j.totals[f], `series reconcile on ${f}`);
  }
  for (const f of ['value_usd', 'spend_usd', 'unknown_usd'])
    assert.ok(Math.abs(j.groups.reduce((n, g) => n + g[f], 0) - j.totals[f]) < 1e-9, `groups reconcile on ${f}`);
  // dollars stay in three separate fields: subscription value, api spend, unknown-plan value
  assert.ok(j.totals.value_usd > 0);
  assert.equal(j.totals.spend_usd, 0);
  assert.ok(j.totals.unknown_usd > 0);
  assert.deepEqual([...new Set(j.series.map((s) => s.bucket))].sort(), ['2026-10-02', '2026-10-03']);
  assert.ok(j.series.every((s) => s.bucket && 'key' in s && 'is_other' in s));

  const c = j.collectors.find((x) => x.host === host && x.source === 'claude_code');
  assert.ok(c, 'collector freshness row');
  assert.equal(c.files, 12);
  assert.equal(c.scanned, 40);
  assert.equal(c.accepted, events.length);
  assert.ok(c.age_s >= 0 && c.age_s < 60);
  assert.equal(c.last_event_ts, '2026-10-03T12:00:00.000Z');
  assert.ok(j.prices_count >= 70);

  const keys = [];
  walk(j, (k) => keys.push(k));
  assert.ok(!keys.includes('tokens'), 'no key named "tokens" anywhere in the read model');

  const byHost = await (await get(`/api/spend?from=2026-10-01&to=2026-10-07&host=${host}&group=model&top=20&bucket=hour`)).json();
  assert.equal(byHost.range.bucket, 'hour');
  assert.ok(byHost.series.every((s) => /^2026-10-0\dT12:00:00\.000Z$|^2026-10-0\dT09:00:00\.000Z$/.test(s.bucket)));
  const unk = await (await get(`/api/spend?from=2026-10-01&to=2026-10-07&host=${host}&group=account&top=20`)).json();
  assert.ok(unk.groups.some((g) => g.key === null && g.label === 'unknown' && !g.is_other));
});

test('GET /api/spend: bad parameters are 400s, empty ranges are honest zeros', async () => {
  for (const qs of ['from=nope', 'from=2026-10-07&to=2026-10-01', 'from=2024-01-01&to=2026-10-07', 'bucket=week', 'group=prompt', 'top=0', 'top=21',
    'bucket=hour&from=2026-09-01&to=2026-10-07']) {
    const r = await get('/api/spend?' + qs);
    assert.equal(r.status, 400, qs);
  }
  const j = await (await get('/api/spend?from=2021-01-01&to=2021-01-02&host=nobody-at-all')).json();
  assert.equal(j.totals.events, 0);
  assert.deepEqual(j.groups, []);
  assert.deepEqual(j.series, []);
});

test('prices: GET lists, PUT adds a dated row (409 on repeat), reprice only_unpriced fills the gap and leaves priced rows alone', async () => {
  const host = 'hostRP';
  await post('/api/spend/events', batch(host, [
    ev('rp-priced', { session_id: 'q1' }),
    ev('rp-new1', { provider: 'acme', model: 'acme-1', session_id: 'q2', input_tokens: 1000000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 }),
    ev('rp-new2', { provider: 'acme', model: 'acme-1', session_id: 'q3', input_tokens: 500000, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0 }),
  ]));
  assert.equal(rowOf('rp-new1').cost_micros, null);
  const pricedBefore = { ...rowOf('rp-priced') };

  let r = await post('/api/spend/prices', { provider: 'acme', model: 'acme-1', effective_from: '2026-01-01', input_usd: '3.00', output_usd: 9, note: 'test' }, 'PUT');
  assert.equal(r.status, 201);
  const made = await r.json();
  assert.equal(made.input_usd, '3.00');
  assert.equal(made.output_usd, '9.00');
  assert.equal(made.cache_read_usd, null);
  r = await post('/api/spend/prices', { provider: 'acme', model: 'acme-1', effective_from: '2026-01-01T00:00:00Z', input_usd: 1, output_usd: 1 }, 'PUT');
  assert.equal(r.status, 409);
  r = await post('/api/spend/prices', { provider: 'acme', model: 'acme-1', effective_from: '2026-01-01', input_usd: 'abc', output_usd: 1 }, 'PUT');
  assert.equal(r.status, 400);
  r = await post('/api/spend/prices', { provider: 'acme', model: 'acme-1', effective_from: '2026-01-01', input_usd: 1, output_usd: 1, secret: 'x' }, 'PUT');
  assert.equal(r.status, 400);
  const list = await (await get('/api/spend/prices')).json();
  assert.ok(list.find((x) => x.id === made.id));

  r = await post('/api/spend/reprice', { only_unpriced: true });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.repriced >= 2);
  assert.equal(rowOf('rp-new1').cost_micros, 3_000_000);
  assert.equal(rowOf('rp-new2').cost_micros, 1_500_000);
  assert.ok(rowOf('rp-new1').price_id > 0);
  assert.deepEqual({ ...rowOf('rp-priced') }, pricedBefore, 'priced rows are untouched');
  const again = await (await post('/api/spend/reprice', { only_unpriced: true, provider: 'acme' })).json();
  assert.deepEqual(again, { scanned: 0, repriced: 0, still_unpriced: 0 });

  r = await post('/api/spend/reprice', { nonsense: 1 });
  assert.equal(r.status, 400);
});

test('retention prune removes old rows only, and 0 keeps everything', async () => {
  const host = 'hostK';
  await post('/api/spend/events', batch(host, [ev('old1', { ts: '2021-03-01T00:00:00.000Z' }), ev('new1', { ts: new Date().toISOString() })]));
  assert.equal(pruneOld(db, 0), 0);
  assert.equal(count(`host=?`, host), 2);
  assert.equal(pruneOld(db, 400), 1);
  assert.equal(count(`host=?`, host), 1);
  assert.ok(rowOf('new1'));
  assert.equal(rowOf('old1'), undefined);
});

test('ingest audit rows carry counts only, never event content', async () => {
  await post('/api/spend/events', batch('hostAud', [ev('aud1')]));
  const row = db.prepare(`SELECT account, host, action, result FROM access_log WHERE action='spend-ingest' AND host='hostAud'`).get();
  assert.deepEqual({ ...row }, { account: 'spend', host: 'hostAud', action: 'spend-ingest', result: 'accepted 1 · dup 0 · unpriced 0' });
});

test('request_log is untouched and the server.js hook stays small', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const lines = src.split('\n').filter((l) => /spend\.js|handleSpend|pruneOld|ensureSchema|seedIfNeeded/.test(l));
  assert.ok(lines.length <= 5, `server.js spend hook is ${lines.length} lines`);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM request_log`).get().n, 0);
});

test('otari-only sources (muse, opencode, …) are accepted, never attributed, and never borrow a codex lease', async () => {
  const scope = '/home/dev/.codex-otari-src';
  // a live codex lease on the same host + scope: a codex event here WOULD be attributed
  let r = await post('/api/spend/sessions', { source: 'codex', host: 'srcA', session_id: null, scope, account: 'cx-lease',
    kind: 'codex', via: 'ai-codex', ts: '2026-10-06T16:00:00.000Z' });
  assert.equal(r.status, 200);
  r = await post('/api/spend/events', batch('srcA', [ev('muse-evt-1', { provider: 'meta', model: 'muse-spark-1.3', scope })], { source: 'muse' }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).accepted, 1);
  const row = rowOf('muse-evt-1');
  assert.equal(row.source, 'muse');
  assert.equal(row.account, null, 'an imported tool must never inherit a codex lease');
  assert.equal(row.billing, 'api');
  r = await post('/api/spend/events', batch('srcA', [ev('opencode-evt-1', { provider: 'openrouter', model: 'z-ai/glm-5.3' })], { source: 'opencode' }));
  assert.equal((await r.json()).accepted, 1);
  r = await post('/api/spend/events', batch('srcA', [ev('bogus-evt-1')], { source: 'not-a-tool' }));
  assert.equal(r.status, 400);
  assert.equal(count("source_event_id='bogus-evt-1'"), 0);
  // session mappings stay limited to the launcher-backed sources
  r = await post('/api/spend/sessions', { source: 'muse', host: 'srcA', session_id: 'x', scope: '', account: 'a', kind: 'claude', via: 'hook', ts: '2026-10-06T16:00:00.000Z' });
  assert.equal(r.status, 400);
});

test('ingest accepts imported tool sources but never attributes them, and rejects unknown sources', async () => {
  const scope = '/Users/imp/.codex';
  const lease = await post('/api/spend/sessions', { source: 'codex', host: 'imp-host', session_id: null, scope, account: 'imp-acct',
    kind: 'codex', via: 'test', ts: new Date(Date.now() - 3600e3).toISOString() });
  assert.equal(lease.status, 200);
  const ev = (id) => ({ source_event_id: id, ts: new Date(Date.now() - 60e3).toISOString(), provider: 'meta', model: 'muse-spark-1.3',
    input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0,
    cache_tokens_in_prompt: true, status: 'success', project: 'p', session_id: null, session_started_at: null, scope });
  let r = await post('/api/spend/events', { source: 'muse', host: 'imp-host', events: [ev('muse-imp-1')] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.accepted, 1);
  assert.equal(j.unattributed, 1, 'an imported muse event must not borrow the codex lease on the same scope');
  r = await post('/api/spend/events', { source: 'not-a-tool', host: 'imp-host', events: [ev('x-1')] });
  assert.equal(r.status, 400);
});
