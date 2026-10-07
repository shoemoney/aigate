// clients/aigate-spend.js against a mock aigate: readers, dedupe, cursor, backfill, exit codes.
// Everything runs in temp dirs with HOME pointed at them; the only network is 127.0.0.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTOR = join(ROOT, 'clients', 'aigate-spend.js');
const FIX = join(ROOT, 'test', 'fixtures', 'spend');
const EXPECTED = JSON.parse(readFileSync(join(FIX, 'expected.json'), 'utf8'));
const FORBIDDEN = ['prompt', 'completion', 'content', 'messages', 'text', 'input', 'output', 'tool_input',
  'tool_output', 'tool_result', 'transcript', 'response', 'system', 'thinking'];
const TC_UUID = '00000000-0000-4000-8000-000000000002';
const TUR_UUID = '00000000-0000-4000-8000-000000000003';
const SUMMARY_RE = /^aigate-spend: host=\S+ files=[\d,]+ changed=[\d,]+ scanned=[\d.]+k? claude=[\d,]+ codex=[\d,]+ posted=[\d,]+ accepted=[\d,]+ duplicate=[\d,]+ rejected=[\d,]+ unpriced=[\d,]+ unattributed=[\d,]+ sessions=[\d,]+ errors=[\d,]+ took=[\d.]+s$/;

// ── mock aigate ─────────────────────────────────────────────────────────────────────────────────
async function mockServer() {
  const m = { requests: [], status: 200, seen: new Set() };
  m.server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(raw); } catch { /* recorded as null */ }
      m.requests.push({ url: req.url, auth: req.headers.authorization, body });
      res.setHeader('content-type', 'application/json');
      if (m.status !== 200) { res.statusCode = m.status; res.end(JSON.stringify({ error: 'nope' })); return; }
      if (req.url === '/api/spend/events') {
        let accepted = 0; let duplicate = 0;
        for (const e of body.events) {
          const k = `${body.source}|${e.source_event_id}`;
          if (m.seen.has(k)) duplicate++; else { m.seen.add(k); accepted++; }
        }
        res.end(JSON.stringify({ accepted, duplicate, rejected: 0, unpriced: 1, unattributed: accepted, errors: [] }));
      } else if (req.url === '/api/spend/sessions') {
        res.end(JSON.stringify({ upserted: body.sessions.length, resolved: 0 }));
      } else { res.statusCode = 404; res.end('{}'); }
    });
  });
  await new Promise((r) => m.server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${m.server.address().port}`;
  m.events = (source) => m.requests.filter((r) => r.url === '/api/spend/events' && (!source || r.body.source === source)).flatMap((r) => r.body.events);
  m.reset = () => { m.requests.length = 0; };
  m.close = () => new Promise((r) => { m.server.closeAllConnections?.(); m.server.close(r); });
  return m;
}

// ── world: a throwaway HOME with fixture roots ──────────────────────────────────────────────────
function world({ claude = true, codex = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'spend-test-'));
  const w = {
    home,
    claudeRoot: join(home, 'projects'),
    codexHome: join(home, 'codex'),
    state: join(home, 'state', 'cursor.json'),
    aigateDir: join(home, '.claude', 'aigate'),
  };
  mkdirSync(w.aigateDir, { recursive: true });
  if (claude) cpSync(join(FIX, 'claude'), w.claudeRoot, { recursive: true });
  if (codex) cpSync(join(FIX, 'codex'), w.codexHome, { recursive: true });
  w.claudeFile = join(w.claudeRoot, '-home-dev-proj-a', 'cfb4bccb9617ff77.jsonl');
  w.tcFile = join(w.codexHome, 'sessions', '2026', '10', '04', `rollout-2026-10-04T14-58-02-${TC_UUID}.jsonl`);
  w.turFile = join(w.codexHome, 'sessions', '2026', '10', '04', `rollout-2026-10-04T14-58-02-${TUR_UUID}.jsonl`);
  w.touch = (file, ageDays = 0) => { const t = new Date(Date.now() - ageDays * 86_400_000); utimesSync(file, t, t); };
  w.touchAll = (ageDays = 0) => {
    const all = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
    for (const root of [w.claudeRoot, w.codexHome]) if (existsSync(root)) for (const f of all(root)) w.touch(f, ageDays);
  };
  w.cleanup = () => rmSync(home, { recursive: true, force: true });
  w.touchAll(0);
  return w;
}

function run(w, mock, args = [], extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: w.home,
    AIGATE_SPEND_CLAUDE_ROOT: w.claudeRoot,
    AIGATE_SPEND_CODEX_HOMES: w.codexHome,
    AIGATE_SPEND_HOST: 'testhost',
    AIGATE_SPEND_RETRY_MS: '10',
    ...(mock ? { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok-test' } : {}),
    ...extraEnv,
  };
  return new Promise((res) => {
    const p = spawn(process.execPath, [COLLECTOR, '--state', w.state, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (c) => { stdout += c; });
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('close', (code) => {
      if (mock) assertNoContent(mock);
      res({ code, stdout, stderr, line: stdout.trim().split('\n').pop() });
    });
  });
}

function walkKeys(v, path, out) {
  if (Array.isArray(v)) v.forEach((x, i) => walkKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); walkKeys(x, `${path}.${k}`, out); }
}

// R6: no body ever carries a content-ish key, and every token field is a plain integer.
function assertNoContent(mock) {
  for (const r of mock.requests) {
    const keys = [];
    walkKeys(r.body, '', keys);
    for (const k of keys) assert.ok(!FORBIDDEN.includes(k), `forbidden key "${k}" posted to ${r.url}`);
    assert.equal(r.auth, 'Bearer tok-test');
  }
}

const sum = (events, k) => events.reduce((a, e) => a + e[k], 0);
const totals = (events) => ({
  events: events.length,
  input: sum(events, 'input_tokens'),
  output: sum(events, 'output_tokens'),
  cache_read: sum(events, 'cache_read_tokens'),
  cache_write: sum(events, 'cache_write_tokens'),
  cache_write_1h: sum(events, 'cache_write_1h_tokens'),
});
const line = (o) => `${JSON.stringify(o)}\n`;
const claudeMsg = (id, ts, usage, extra = {}) => line({
  type: 'assistant', timestamp: ts, cwd: '/home/dev/proj-a', sessionId: 'sess-x',
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'SECRET-BODY' }], usage },
  ...extra,
});
const U = (i, o, cr = 0, cw = 0, h = 0) => ({
  input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw,
  cache_creation: { ephemeral_1h_input_tokens: h, ephemeral_5m_input_tokens: cw - h },
});
const tcLine = (ts, total) => line({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total[0], cached_input_tokens: total[1], cache_write_input_tokens: 0, output_tokens: total[2] } } } });

// ── parity with the reference importer (otari expected.json) ───────────────────────────────────
test('parity: Claude fixture equals expected.json events and totals exactly', async () => {
  const w = world({ codex: false }); const mock = await mockServer();
  try {
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('claude_code');
    assert.deepEqual(totals(ev), { events: EXPECTED.totals['claude-session'].events, input: EXPECTED.totals['claude-session'].input,
      output: EXPECTED.totals['claude-session'].output, cache_read: EXPECTED.totals['claude-session'].cache_read,
      cache_write: EXPECTED.totals['claude-session'].cache_write, cache_write_1h: EXPECTED.totals['claude-session'].cache_write_1h });
    assert.deepEqual(ev.map((e) => e.source_event_id).sort(), EXPECTED.claude.map((e) => e.source_event_id).sort());
    for (const exp of EXPECTED.claude) {
      const got = ev.find((e) => e.source_event_id === exp.source_event_id);
      for (const k of ['model', 'provider', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens', 'cache_tokens_in_prompt']) {
        assert.equal(got[k], exp[k], `${exp.source_event_id}.${k}`);
      }
      assert.equal(new Date(got.ts).getTime(), new Date(exp.timestamp).getTime());
      assert.equal(got.session_id, 'cfb4bccb9617ff77');
      assert.equal(got.project, 'proj-a');
    }
  } finally { await mock.close(); w.cleanup(); }
});

test('parity: Codex token_count rollout equals expected.json (cumulative deltas, :tc:n ids)', async () => {
  const w = world({ claude: false }); const mock = await mockServer();
  try {
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('codex').filter((e) => e.session_id === TC_UUID);
    const t = EXPECTED.totals['codex-rollout'];
    assert.deepEqual(totals(ev), { events: t.events, input: t.input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write, cache_write_1h: t.cache_write_1h });
    assert.deepEqual(ev.map((e) => e.source_event_id), EXPECTED.codex.map((e) => e.source_event_id));
    EXPECTED.codex.forEach((exp, i) => {
      for (const k of ['model', 'provider', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) assert.equal(ev[i][k], exp[k], `${exp.source_event_id}.${k}`);
      assert.equal(ev[i].cache_tokens_in_prompt, true);
      assert.ok(ev[i].scope.endsWith('/codex'));
    });
    assert.ok(ev.every((e) => e.session_started_at === '2026-10-04T19:58:02.661Z'));
    assert.ok(ev.every((e) => e.project === 'proj-a'));
  } finally { await mock.close(); w.cleanup(); }
});

test('parity: Codex token_usage_record rollout equals expected.json (response_id ids)', async () => {
  const w = world({ claude: false }); const mock = await mockServer();
  try {
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('codex').filter((e) => e.session_id === TUR_UUID);
    const t = EXPECTED.totals['codex-rollout-usage-record'];
    assert.deepEqual(totals(ev), { events: t.events, input: t.input, output: t.output, cache_read: t.cache_read, cache_write: t.cache_write, cache_write_1h: t.cache_write_1h });
    assert.deepEqual(ev.map((e) => e.source_event_id), EXPECTED.codex_usage_record.map((e) => e.source_event_id));
  } finally { await mock.close(); w.cleanup(); }
});

// ── Claude reader ──────────────────────────────────────────────────────────────────────────────
test('claude: repeated message.id, <synthetic>, null id and a subagent file under the parent session', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    const dir = join(w.claudeRoot, '-home-dev-proj-a');
    mkdirSync(join(dir, 'sess-x', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sess-x.jsonl'),
      claudeMsg('msg_A', '2026-10-06T10:00:00.000Z', U(2, 304, 20132, 62010, 62010)).repeat(3)
      + claudeMsg('msg_syn', '2026-10-06T10:00:01.000Z', U(5, 5), {}).replace('claude-opus-5-5', '<synthetic>')
      + claudeMsg(null, '2026-10-06T10:00:02.000Z', U(7, 7))
      + line({ type: 'user', message: { role: 'user', content: 'hello, no usage here' } }));
    writeFileSync(join(dir, 'sess-x', 'subagents', 'agent-1.jsonl'), claudeMsg('msg_SUB', '2026-10-06T10:01:00.000Z', U(1, 2, 3, 4, 9)));
    w.touchAll(0);
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('claude_code');
    assert.deepEqual(ev.map((e) => e.source_event_id).sort(), ['msg_A', 'msg_SUB']);
    const a = ev.find((e) => e.source_event_id === 'msg_A');
    assert.deepEqual([a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens, a.cache_write_1h_tokens], [2, 304, 20132, 62010, 62010]);
    const sub = ev.find((e) => e.source_event_id === 'msg_SUB');
    assert.equal(sub.session_id, 'sess-x', 'subagent attributes to the parent session');
    assert.equal(sub.cache_write_1h_tokens, 4, '1h subset is clamped to the cache-write total');
    assert.equal(sub.project, 'proj-a');
    assert.equal(a.cache_tokens_in_prompt, false);
    assert.equal(a.scope, '');
  } finally { await mock.close(); w.cleanup(); }
});

test('claude: a half-written trailing line is left for the next run, then read once complete', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    const dir = join(w.claudeRoot, '-home-dev-proj-a');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'sess-x.jsonl');
    const second = claudeMsg('msg_2', '2026-10-06T10:00:05.000Z', U(1, 1));
    writeFileSync(f, claudeMsg('msg_1', '2026-10-06T10:00:00.000Z', U(1, 1)) + second.slice(0, 60));
    w.touchAll(0);
    assert.equal((await run(w, mock)).code, 0);
    assert.deepEqual(mock.events().map((e) => e.source_event_id), ['msg_1']);
    appendFileSync(f, second.slice(60));
    w.touchAll(0);
    mock.reset();
    assert.equal((await run(w, mock)).code, 0);
    assert.deepEqual(mock.events().map((e) => e.source_event_id), ['msg_2']);
  } finally { await mock.close(); w.cleanup(); }
});

// ── Codex reader ───────────────────────────────────────────────────────────────────────────────
test('codex tc: restart and zero-delta lines — deltas sum to the cumulative total, ids are :tc:1..n', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    const dir = join(w.codexHome, 'sessions', '2026', '10', '07');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'rollout-2026-10-07T01-02-03-11111111-2222-4333-8444-555555555555.jsonl');
    writeFileSync(f,
      line({ timestamp: '2026-10-07T01:02:03.000Z', type: 'session_meta', payload: { model_provider: 'openai', cwd: '/x/proj-b', timestamp: '2026-10-07T01:02:03.000Z' } })
      + line({ timestamp: '2026-10-07T01:02:04.000Z', type: 'turn_context', payload: { model: 'gpt-6-sol' } })
      + line({ timestamp: '2026-10-07T01:02:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: null } })
      + tcLine('2026-10-07T01:02:06.000Z', [100, 40, 10])
      + tcLine('2026-10-07T01:02:07.000Z', [250, 90, 30])
      + tcLine('2026-10-07T01:02:08.000Z', [250, 90, 30])
      + tcLine('2026-10-07T01:02:09.000Z', [40, 0, 5])
      + tcLine('2026-10-07T01:02:10.000Z', [90, 20, 9]));
    w.touchAll(0);
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('codex');
    assert.deepEqual(ev.map((e) => e.source_event_id), ['11111111-2222-4333-8444-555555555555:tc:1', '11111111-2222-4333-8444-555555555555:tc:2', '11111111-2222-4333-8444-555555555555:tc:3', '11111111-2222-4333-8444-555555555555:tc:4']);
    assert.deepEqual(ev.map((e) => [e.input_tokens, e.output_tokens, e.cache_read_tokens]), [[100, 10, 40], [150, 20, 50], [40, 5, 0], [50, 4, 20]]);
    assert.equal(sum(ev, 'input_tokens'), 340);
    assert.ok(ev.every((e) => e.model === 'gpt-6-sol' && e.provider === 'openai' && e.project === 'proj-b'));
    // appending one more cumulative line later posts exactly its delta as tc:5
    appendFileSync(f, tcLine('2026-10-07T01:02:11.000Z', [190, 20, 12]));
    w.touchAll(0);
    mock.reset();
    assert.equal((await run(w, mock)).code, 0);
    const more = mock.events('codex');
    assert.deepEqual(more.map((e) => [e.source_event_id.split(':').slice(1).join(':'), e.input_tokens, e.output_tokens]), [['tc:5', 100, 3]]);
  } finally { await mock.close(); w.cleanup(); }
});

test('codex: a rollout copied into archived_sessions and sessions is read once; scope is the CODEX_HOME', async () => {
  const w = world({ claude: false }); const mock = await mockServer();
  try {
    const arch = join(w.codexHome, 'archived_sessions');
    mkdirSync(arch, { recursive: true });
    const other = join(arch, `rollout-2026-10-04T14-58-02-${TUR_UUID}.jsonl`);
    cpSync(w.turFile, other);
    w.touchAll(0);
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    // distinct files with the same thread id and the same response_ids collapse server-side by id
    const ids = new Set(mock.events('codex').map((e) => e.source_event_id));
    assert.equal(ids.size, 10, 'tc 5 + tur 5 unique ids; the archived copy repeats the same ids');
    assert.ok(mock.events('codex').every((e) => typeof e.scope === 'string' && e.scope.endsWith('/codex')));
  } finally { await mock.close(); w.cleanup(); }
});

// ── cursor ─────────────────────────────────────────────────────────────────────────────────────
test('cursor: second run reads nothing; appended lines post only themselves; truncation re-reads from 0', async () => {
  const w = world(); const mock = await mockServer();
  try {
    let r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 15);
    assert.match(r.line, /posted=15 accepted=15/);
    assert.equal(statSync(w.state).mode & 0o777, 0o600);

    mock.reset();
    r = await run(w, mock);
    assert.equal(r.code, 0);
    assert.equal(mock.events().length, 0);
    assert.match(r.line, /changed=0 /);
    assert.match(r.line, /posted=0 /);

    appendFileSync(w.claudeFile, claudeMsg('msg_new1', '2026-10-07T01:00:00.000Z', U(3, 4)) + claudeMsg('msg_new2', '2026-10-07T01:00:01.000Z', U(5, 6)));
    w.touchAll(0);
    mock.reset();
    r = await run(w, mock);
    assert.deepEqual(mock.events().map((e) => e.source_event_id), ['msg_new1', 'msg_new2']);
    assert.match(r.line, /changed=1 /);

    writeFileSync(w.claudeFile, claudeMsg('msg_after_trunc', '2026-10-07T02:00:00.000Z', U(1, 1)));
    w.touchAll(0);
    mock.reset();
    r = await run(w, mock);
    assert.deepEqual(mock.events().map((e) => e.source_event_id), ['msg_after_trunc']);
  } finally { await mock.close(); w.cleanup(); }
});


test('--backfill re-reads every file from byte 0 regardless of the cursor (server dedupes)', async () => {
  const w = world(); const mock = await mockServer();
  try {
    assert.equal((await run(w, mock)).code, 0);
    mock.reset();
    const r = await run(w, mock, ['--backfill']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 15);
    assert.match(r.line, /accepted=0 duplicate=15/);
  } finally { await mock.close(); w.cleanup(); }
});

test('first run skips files older than 7 days (reads only what is appended later); --backfill reads them', async () => {
  const w = world(); const mock = await mockServer();
  try {
    w.touchAll(30);
    let r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 0, 'old files are skipped on the very first run');
    assert.match(r.line, /files=3 changed=0/);

    appendFileSync(w.claudeFile, claudeMsg('msg_fresh', '2026-10-07T03:00:00.000Z', U(9, 9)));
    // codex resumes after being skipped: only the growth since the skipped history is billed
    appendFileSync(w.tcFile, tcLine('2026-10-04T20:05:00.000Z', [255979 + 10, 201344, 614 + 7]));
    appendFileSync(w.tcFile, tcLine('2026-10-04T20:06:00.000Z', [255979 + 30, 201344, 614 + 9]));
    w.touch(w.claudeFile, 0); w.touch(w.tcFile, 0);
    mock.reset();
    r = await run(w, mock);
    assert.deepEqual(mock.events('claude_code').map((e) => e.source_event_id), ['msg_fresh']);
    const cx = mock.events('codex');
    assert.equal(cx.length, 2, 'each appended counter line is a real delta against the true cumulative total');
    assert.deepEqual(cx.map((e) => [e.input_tokens, e.output_tokens]), [[10, 7], [20, 2]]);
    assert.deepEqual(cx.map((e) => e.source_event_id.split(':').slice(1).join(':')), ['tc:6', 'tc:7']);
    assert.equal(cx[0].project, 'proj-a', 'session metadata is primed from the rollout header');

    const w2 = world(); const mock2 = await mockServer();
    try {
      w2.touchAll(30);
      const rb = await run(w2, mock2, ['--backfill']);
      assert.equal(rb.code, 0);
      assert.equal(mock2.events().length, 15);
    } finally { await mock2.close(); w2.cleanup(); }
  } finally { await mock.close(); w.cleanup(); }
});

test('--since bounds a backfill by file mtime', async () => {
  const w = world(); const mock = await mockServer();
  try {
    w.touchAll(30);
    w.touch(w.claudeFile, 1);
    const r = await run(w, mock, ['--backfill', '--since', '3']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 5);
    assert.ok(mock.events().every((e) => e.session_id === 'cfb4bccb9617ff77'));
  } finally { await mock.close(); w.cleanup(); }
});

test('baseline rollout that later grows: a following --backfill accepts exactly the ids a clean backfill would', async () => {
  const w = world(); const mock = await mockServer();
  const w2 = world(); const mock2 = await mockServer();
  try {
    w.touchAll(30);
    assert.equal((await run(w, mock)).code, 0);
    appendFileSync(w.tcFile, tcLine('2026-10-04T20:05:00.000Z', [255979 + 10, 201344, 614 + 7]));
    appendFileSync(w.tcFile, tcLine('2026-10-04T20:06:00.000Z', [255979 + 30, 201344, 614 + 9]));
    w.touch(w.tcFile, 0);
    assert.equal((await run(w, mock)).code, 0);
    assert.equal(mock.events('codex').length, 2);
    assert.equal((await run(w, mock, ['--backfill'])).code, 0);
    const accepted = mock.events('codex').map((e) => e.source_event_id);
    const unique = [...new Set(accepted)];

    writeFileSync(w2.tcFile, readFileSync(w.tcFile));
    assert.equal((await run(w2, mock2, ['--backfill', '--source', 'codex'])).code, 0);
    const clean = mock2.events('codex').filter((e) => e.source_event_id.startsWith(TC_UUID));
    const mine = unique.filter((id) => id.startsWith(TC_UUID));
    assert.deepEqual(mine.sort(), clean.map((e) => e.source_event_id).sort(), 'same id set as a clean backfill, no :tc:H+n strays');
    assert.equal(mine.length, clean.length);
    const billed = mock.events('codex').filter((e) => e.source_event_id.startsWith(TC_UUID));
    const byId = new Map(billed.map((e) => [e.source_event_id, e]));
    assert.equal([...byId.values()].reduce((a, e) => a + e.input_tokens, 0), 255979 + 30, 'summed input equals the final cumulative total');
    assert.equal([...byId.values()].reduce((a, e) => a + e.output_tokens, 0), 614 + 9);
  } finally { await mock.close(); await mock2.close(); w.cleanup(); w2.cleanup(); }
});

test('a failed first run keeps the 7-day rule: the next run does not turn into a full backfill', async () => {
  const w = world(); const mock = await mockServer();
  try {
    w.touchAll(30);
    w.touch(w.claudeFile, 0);
    mock.status = 503;
    let r = await run(w, mock);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    mock.status = 200; mock.reset();
    r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events();
    assert.equal(ev.length, 5, 'only the recent file is posted');
    assert.ok(ev.every((e) => e.session_id === 'cfb4bccb9617ff77'));
    assert.equal(JSON.parse(readFileSync(w.state, 'utf8')).bootstrapped, true);
  } finally { await mock.close(); w.cleanup(); }
});

test('--backfill keeps the mode an earlier run fixed for a rollout', async () => {
  const w = world({ claude: false }); const mock = await mockServer();
  try {
    assert.equal((await run(w, mock)).code, 0);
    const turMode = () => Object.entries(JSON.parse(readFileSync(w.state, 'utf8')).files).find(([k]) => k.endsWith(`${TUR_UUID}.jsonl`))[1].mode;
    assert.equal(turMode(), 'tur');
    assert.equal((await run(w, mock, ['--backfill'])).code, 0);
    assert.equal(turMode(), 'tur');
  } finally { await mock.close(); w.cleanup(); }
});

// ── failure handling ───────────────────────────────────────────────────────────────────────────
test('aigate 503 -> exit 2, cursor not advanced; the next good run posts everything', async () => {
  const w = world(); const mock = await mockServer();
  try {
    mock.status = 503;
    let r = await run(w, mock);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.line, SUMMARY_RE, 'the summary line is printed even on failure');
    assert.match(r.line, /posted=0 accepted=0/);
    const st = existsSync(w.state) ? JSON.parse(readFileSync(w.state, 'utf8')) : { files: {} };
    assert.ok(Object.values(st.files).every((f) => f.offset === 0 || f.offset === undefined) || Object.keys(st.files).length === 0, 'no file offset advanced');
    mock.status = 200; mock.reset();
    r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 15);
  } finally { await mock.close(); w.cleanup(); }
});

test('401 is exit 2 as well, and an unreachable server is exit 2 after the one retry', async () => {
  const w = world({ codex: false }); const mock = await mockServer();
  try {
    mock.status = 401;
    assert.equal((await run(w, mock)).code, 2);
    const dead = await mockServer(); const url = dead.url; await dead.close();
    const r = await run(w, null, [], { AIGATE_URL: url, AIGATE_TOKEN: 'tok-test' });
    assert.equal(r.code, 2);
    assert.match(r.line, SUMMARY_RE);
  } finally { await mock.close(); w.cleanup(); }
});

test('missing credentials and a corrupt state file are fatal (exit 1); --dry-run needs neither credentials', async () => {
  const w = world({ codex: false }); const mock = await mockServer();
  try {
    assert.equal((await run(w, null)).code, 1);
    mkdirSync(dirname(w.state), { recursive: true });
    writeFileSync(w.state, '{not json');
    const r = await run(w, mock);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(mock.requests.length, 0);
    rmSync(w.state);
    const d = await run(w, null, ['--dry-run']);
    assert.equal(d.code, 0, d.stderr);
  } finally { await mock.close(); w.cleanup(); }
});

// ── flags ──────────────────────────────────────────────────────────────────────────────────────
test('--dry-run parses and counts but posts nothing and writes no cursor', async () => {
  const w = world(); const mock = await mockServer();
  try {
    const r = await run(w, mock, ['--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.requests.length, 0);
    assert.equal(existsSync(w.state), false);
    assert.match(r.line, SUMMARY_RE);
    assert.match(r.line, /claude=5 codex=10 posted=0 /);
  } finally { await mock.close(); w.cleanup(); }
});

test('summary line format, --json, --source filter, --help and bad args', async () => {
  const w = world(); const mock = await mockServer();
  try {
    let r = await run(w, mock);
    assert.match(r.line, SUMMARY_RE);
    assert.match(r.line, /host=testhost files=3 changed=3 /);
    assert.match(r.line, /claude=5 codex=10 posted=15 accepted=15 duplicate=0 rejected=0 unpriced=\d+ unattributed=15 /);

    const w2 = world(); mock.reset(); mock.seen.clear();
    r = await run(w2, mock, ['--json', '--source', 'codex']);
    const j = JSON.parse(r.stdout);
    assert.equal(j.host, 'testhost');
    assert.equal(j.codex, 10);
    assert.equal(j.claude, 0);
    assert.equal(j.posted, 10);
    assert.ok(mock.events().every((e) => e.scope));
    w2.cleanup();

    r = await run(w, null, ['--help']);
    assert.equal(r.code, 0);
    for (const f of ['--backfill', '--dry-run', '--since', '--json']) assert.ok(r.stdout.includes(f), f);
    r = await run(w, null, ['--bogus']);
    assert.equal(r.code, 1);
    r = await run(w, null, ['--since', 'abc']);
    assert.equal(r.code, 1);
  } finally { await mock.close(); w.cleanup(); }
});

// ── batching ───────────────────────────────────────────────────────────────────────────────────
test('events are posted in batches of AIGATE_SPEND_BATCH, one source per batch', async () => {
  const w = world(); const mock = await mockServer();
  try {
    const r = await run(w, mock, [], { AIGATE_SPEND_BATCH: '4' });
    assert.equal(r.code, 0, r.stderr);
    const posts = mock.requests.filter((q) => q.url === '/api/spend/events');
    assert.ok(posts.length >= 4);
    for (const p of posts) {
      assert.ok(p.body.events.length <= 4);
      assert.ok(['claude_code', 'codex'].includes(p.body.source));
      assert.equal(p.body.host, 'testhost');
      assert.match(p.body.collector_version, /^\d+\.\d+\.\d+$/);
      for (const e of p.body.events) assert.deepEqual(Object.keys(e).filter((k) => FORBIDDEN.includes(k)), []);
    }
    assert.equal(mock.events().length, 15);
  } finally { await mock.close(); w.cleanup(); }
});

// ── sidecar replay ─────────────────────────────────────────────────────────────────────────────
test('sidecar replay posts new session lines, advances sessions_sidecar_offset, and is not repeated', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    const sidecar = join(w.aigateDir, 'spend-sessions.jsonl');
    const a = { source: 'claude_code', host: 'testhost', session_id: 'sess-1', scope: '', account: 'shoemoney', kind: 'claude', via: 'hook', ts: '2026-10-07T17:02:12.345Z' };
    const b = { source: 'codex', host: 'testhost', session_id: null, scope: '/Users/x/.codex', account: '', kind: 'codex', via: 'keeper', ts: '2026-10-07T17:03:00Z' };
    writeFileSync(sidecar, `${JSON.stringify(a)}\nnot json\n${JSON.stringify(b)}\n`);
    let r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const posts = mock.requests.filter((q) => q.url === '/api/spend/sessions');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.sessions, [a, b]);
    assert.match(r.line, /sessions=2 /);
    const st = JSON.parse(readFileSync(w.state, 'utf8'));
    assert.equal(st.sessions_sidecar_offset, readFileSync(sidecar).length);

    mock.reset();
    r = await run(w, mock);
    assert.equal(mock.requests.length, 0);
    appendFileSync(sidecar, `${JSON.stringify({ ...a, session_id: 'sess-2' })}\n`);
    r = await run(w, mock);
    assert.deepEqual(mock.requests.filter((q) => q.url === '/api/spend/sessions').map((q) => q.body.sessions.map((s) => s.session_id)), [['sess-2']]);
  } finally { await mock.close(); w.cleanup(); }
});

test('prompt and tool text in the transcripts never reaches the wire', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    const dir = join(w.claudeRoot, '-home-dev-proj-a');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-x.jsonl'), claudeMsg('msg_S', '2026-10-06T10:00:00.000Z', U(2, 3)));
    w.touchAll(0);
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.events().length, 1);
    assert.ok(!JSON.stringify(mock.requests.map((q) => q.body)).includes('SECRET-BODY'));
  } finally { await mock.close(); w.cleanup(); }
});

test('codex tc: a cumulative counter past 2^31 is not clamped — per-event deltas stay exact on very long sessions', async () => {
  const w = world({ claude: false, codex: false }); const mock = await mockServer();
  try {
    cpSync(join(FIX, 'codex-large'), w.codexHome, { recursive: true });
    w.touchAll(0);
    const r = await run(w, mock);
    assert.equal(r.code, 0, r.stderr);
    const ev = mock.events('codex');
    assert.equal(ev.length, 6);
    assert.ok(ev.every((e) => e.input_tokens === 600_000_000));
    assert.equal(sum(ev, 'input_tokens'), 3_600_000_000);
    assert.equal(sum(ev, 'cache_read_tokens'), 3_561_500_000);
    assert.equal(sum(ev, 'output_tokens'), 11_300);
  } finally { await mock.close(); w.cleanup(); }
});
