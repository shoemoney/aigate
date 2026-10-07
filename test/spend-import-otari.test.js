import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdtempSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const TMP = mkdtempSync(join(tmpdir(), 'aigate-import-'));
const DB = join(TMP, `aigate-test-${process.pid}-${Date.now()}.db`);
const OTARI = join(TMP, 'otari.db');
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_DASHBOARD_PASSWORD = 'master-' + crypto.randomBytes(6).toString('hex');
process.env.AIGATE_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;

const { server, db } = await import('../src/server.js');
const H = { authorization: 'Bearer ' + TOKEN };
let base;

const SCRIPT = new URL('../scripts/spend-import-otari.js', import.meta.url).pathname;

const o = new DatabaseSync(OTARI);
o.exec(`CREATE TABLE usage_logs (
  id VARCHAR NOT NULL PRIMARY KEY, timestamp DATETIME NOT NULL, model VARCHAR NOT NULL, provider VARCHAR,
  endpoint VARCHAR NOT NULL DEFAULT 'x', prompt_tokens INTEGER, completion_tokens INTEGER, status VARCHAR NOT NULL,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER, latency_ms INTEGER, cache_write_1h_tokens INTEGER,
  source VARCHAR DEFAULT 'gateway' NOT NULL, source_event_id VARCHAR, source_label VARCHAR, cache_tokens_in_prompt BOOLEAN,
  UNIQUE (source, source_event_id))`);
const ins = o.prepare(`INSERT INTO usage_logs(id, timestamp, model, provider, prompt_tokens, completion_tokens, status, cache_read_tokens,
  cache_write_tokens, latency_ms, cache_write_1h_tokens, source, source_event_id, source_label, cache_tokens_in_prompt)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
let n = 0;
const row = (source, eid, ts, label, model, provider, tok, status = 'success', cip = 0) =>
  ins.run(`r${++n}`, ts, model, provider, tok[0], tok[1], status, tok[2], tok[3], 100, tok[4], source, eid, label, cip);
// 3 claude on mbp (one before the cutoff), 1 claude on laptop2, 2 codex, 1 empty id, 1 gateway row, 1 error
row('claude_code', 'msg_a', '2026-09-01 10:00:00.123456', 'mbp:resume', 'claude-opus-5', 'anthropic', [10, 20, 300, 400, 400]);
row('claude_code', 'msg_b', '2026-09-02 10:00:00.000000', 'mbp:air rank', 'claude-sonnet-5', 'anthropic', [1, 2, 3, 4, 99]);
row('claude_code', 'msg_c', '2026-10-01 10:00:00.000000', 'mbp:resume', 'claude-opus-5', 'anthropic', [5, 6, 7, 8, 0], 'error');
row('claude_code', 'msg_d', '2026-09-03 10:00:00.000000', 'lap2:ops', 'muse-spark-1.2', 'meta', [100, 200, 0, 0, 0]);
row('codex', 'rid-1:tc:1', '2026-09-04 10:00:00.000000', 'mbp:tr8r', 'gpt-6-astra', 'openai', [1000, 50, 600, 0, 0], 'success', 1);
row('codex', 'rid-1:tc:2', '2026-10-02 10:00:00.000000', 'mbp:tr8r', 'gpt-6-astra', 'openai', [2000, 70, 900, 0, 0], 'success', 1);
row('claude_code', '', '2026-09-05 10:00:00.000000', 'mbp:resume', 'claude-opus-5', 'anthropic', [1, 1, 1, 1, 1]);
row('gateway', 'gw-1', '2026-09-05 10:00:00.000000', 'x:y', 'gpt-x', 'openai', [9, 9, 9, 9, 9]);
o.close();

// async: the server lives in this process, so a blocking spawn would deadlock it
const imp = (args = [], env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, '--db', OTARI, ...args], {
    env: { ...process.env, HOME: TMP, AIGATE_URL: base, AIGATE_TOKEN: TOKEN, ...env }, encoding: 'utf8',
  }, (error, out, err) => resolve({ code: error ? error.code : 0, out, err }));
});
const num = (s, key) => Number(new RegExp(`${key}=(\\d+)`).exec(s)[1]);
const count = () => db.prepare(`SELECT COUNT(*) AS n FROM usage_events`).get().n;
const rowOf = (id) => db.prepare(`SELECT * FROM usage_events WHERE source_event_id=?`).get(id);

before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  try { db.close(); } catch { /* already closed */ }
  rmSync(TMP, { recursive: true, force: true });
});

test('--help prints usage and exits 0', async () => {
  const r = await imp(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /--dry-run/);
});

test('--dry-run counts but posts nothing', async () => {
  const r = await imp(['--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would post 3 claude_code events for host=mbp/);
  assert.match(r.out, /would post 1 claude_code events for host=lap2/);
  assert.match(r.out, /would post 2 codex events for host=mbp/);
  assert.equal(num(r.out, 'accepted'), 0);
  assert.equal(count(), 0);
});

test('--before and --source filter what is read', async () => {
  const r = await imp(['--dry-run', '--source', 'claude_code', '--before', '2026-09-30T00:00:00Z']);
  assert.match(r.out, /claude_code\[read=4 skipped=1 posted=3 /);
  assert.match(r.out, /codex\[read=0 /);
  const s = await imp(['--dry-run', '--since', '2026-10-01T00:00:00Z']);
  assert.match(s.out, /rows read=2 /);
});

test('import posts every valid row; ids, tokens, host and project round-trip', async () => {
  const r = await imp(['--batch', '2']);
  assert.equal(r.code, 0, r.err);
  assert.equal(num(r.out, 'accepted'), 6);
  assert.equal(num(r.out, 'duplicate'), 0);
  assert.equal(num(r.out, 'skipped'), 1);
  assert.equal(count(), 6);

  const a = rowOf('msg_a');
  assert.equal(a.source, 'claude_code');
  assert.equal(a.host, 'mbp');
  assert.equal(a.project, 'resume');
  assert.equal(a.ts, '2026-09-01T10:00:00.123Z');
  assert.equal(a.provider, 'anthropic');
  assert.equal([a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens, a.cache_write_1h_tokens].join(','), '10,20,300,400,400');
  assert.equal(a.cache_tokens_in_prompt, 0);
  assert.equal(a.session_id, null);

  const b = rowOf('msg_b');
  assert.equal(b.project, 'air_rank');
  assert.equal(b.cache_write_1h_tokens, 4, '1h cache clamped to cache_write');
  assert.equal(rowOf('msg_c').status, 'error');
  assert.equal(rowOf('msg_d').host, 'lap2');
  assert.equal(rowOf('msg_d').provider, 'meta');

  const c = rowOf('rid-1:tc:1');
  assert.equal(c.source, 'codex');
  assert.equal(c.project, 'tr8r');
  assert.equal(c.cache_tokens_in_prompt, 1);
  assert.equal(c.scope, '');
  assert.equal(rowOf('gw-1'), undefined);
});

test('imported token totals show up in GET /api/spend', async () => {
  const res = await fetch(`${base}/api/spend?from=2026-01-01&to=2026-12-31`, { headers: H });
  assert.equal(res.status, 200);
  const j = await res.json();
  const sum = db.prepare(`SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_events`).get();
  assert.equal(sum.i, 10 + 1 + 5 + 100 + 1000 + 2000);
  assert.equal(sum.o, 20 + 2 + 6 + 200 + 50 + 70);
  const flat = JSON.stringify(j);
  assert.ok(flat.includes(String(sum.i)), 'input total appears in the read model');
  assert.ok(flat.includes(String(sum.o)), 'output total appears in the read model');
});

test('a re-run is all duplicates and changes nothing', async () => {
  const r = await imp([]);
  assert.equal(r.code, 0, r.err);
  assert.equal(num(r.out, 'accepted'), 0);
  assert.equal(num(r.out, 'duplicate'), 6);
  assert.equal(count(), 6);
});

test('a failed post exits 2 and reports progress; missing creds exit 1', async () => {
  const bad = await imp([], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.equal(bad.code, 2);
  assert.match(bad.out, /accepted=0/);
  const none = await imp([], { AIGATE_URL: '', AIGATE_TOKEN: '' });
  assert.equal(none.code, 1);
});
