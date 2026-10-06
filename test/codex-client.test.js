// aigate-codex.sh / t3-codex.sh: select a Codex account, write auth.json, run the
// (fake) codex binary, sync rotated tokens back. Real bash scripts, mock aigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_SH = join(ROOT, 'clients', 'aigate-codex.sh');
const T3_CODEX = join(ROOT, 'clients', 't3-codex.sh');
const now = () => Math.floor(Date.now() / 1000);

const pick = (name, rt, extra = {}) => ({
  account: name, kind: 'codex', plan: 'pro',
  auth_json: { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `id-${name}`, access_token: `at-${name}`, refresh_token: rt, account_id: `aid-${name}` },
    last_refresh: '2026-10-06T00:00:00Z' },
  token_exp: now() + 3600, five_hour_pct: 7, seven_day_pct: 16,
  five_hour_reset: now() + 3600, seven_day_reset: now() + 3 * 86400 + 4 * 3600 + 600, ...extra,
});

function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      const call = { method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization };
      calls.push(call);
      const [status, out] = handler(call) ?? [200, {}];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const FAKE = `#!/bin/bash
rt="$(python3 -c 'import json,os;print(json.load(open(os.environ["CODEX_HOME"]+"/auth.json"))["tokens"]["refresh_token"])' 2>/dev/null)"
echo "RUN rt=$rt" >> "$FAKE_LOG"
printf 'ARG %s\\n' "$@" >> "$FAKE_LOG"
case ",\${FAKE_FAIL_RTS:-}," in *",$rt,"*) echo "ERROR: usage limit reached" >&2; exit 1;; esac
if [ -n "\${FAKE_ROTATE:-}" ]; then
  python3 - "$CODEX_HOME/auth.json" "$FAKE_ROTATE" <<'PY'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); d["tokens"]["refresh_token"]=sys.argv[2]; json.dump(d,open(p,"w"))
PY
fi
echo "\${FAKE_OUT:-fake-codex-stdout}"
echo "fake-codex-stderr" >&2
exit "\${FAKE_RC:-0}"
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'codexc-'));
  const home = join(dir, 'home'); const ch = join(dir, 'codexhome');
  mkdirSync(join(home, '.claude', 'aigate'), { recursive: true }); mkdirSync(ch, { recursive: true });
  const bin = join(dir, 'codex-fake'); writeFileSync(bin, FAKE); chmodSync(bin, 0o755);
  const log = join(dir, 'fake.log');
  return { dir, home, ch, bin, log, auth: join(ch, 'auth.json'),
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('RUN ').slice(1)
      .map((r) => ({ rt: /rt=(.*)/.exec(r)[1], args: [...r.matchAll(/^ARG (.*)$/gm)].map((m) => m[1]) })),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(sb, script, args, env = {}, opts = {}) {
  return new Promise((res) => {
    const child = execFile('bash', [script, ...args], {
      env: { PATH: process.env.PATH, HOME: sb.home, AIGATE_CODEX_HOME: sb.ch, CODEX_HOME: sb.ch, AIGATE_DIR: join(sb.home, '.claude', 'aigate'),
        AIGATE_CODEX_BIN: sb.bin, AIGATE_TOKEN: 'tok-secret', FAKE_LOG: sb.log, ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end(opts.stdin ?? '');
  });
}

const writeAuth = (sb, rt, acct) => writeFileSync(sb.auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: rt, account_id: acct, id_token: 'x', access_token: 'y' } }));
const readAuth = (sb) => JSON.parse(readFileSync(sb.auth, 'utf8'));
const defaultHandler = (p) => (call) => {
  if (call.path === '/api/select') return [200, p];
  if (call.path === '/api/codex/sync') return [200, { ok: true, applied: false, reason: 'unknown account' }];
  return [200, { ok: true }];
};

test('interactive: writes auth.json 0600 with the picked tokens, banner on stderr, backup once', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  writeAuth(sb, 'local-old', 'someone-else');

  const r = await run(sb, CODEX_SH, ['hello'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /aigate → codex account: acct1 \(pro · 5h 7% · 7d 16% · resets in 3d4h\)/);
  assert.ok(!r.stdout.includes('aigate →'), 'banner must not hit stdout');
  const a = readAuth(sb);
  assert.equal(a.tokens.refresh_token, 'rt-1'); assert.equal(a.tokens.access_token, 'at-acct1');
  assert.equal(statSync(sb.auth).mode & 0o777, 0o600);
  assert.equal(mock.calls.find((c) => c.path === '/api/select').q.kind, 'codex');
  assert.equal(mock.calls.find((c) => c.path === '/api/select').auth, 'Bearer tok-secret');
  const baks = () => readdirSync(sb.ch).filter((f) => f.startsWith('auth.json.bak-pre-aigate-'));
  assert.equal(baks().length, 1);
  assert.equal(statSync(join(sb.ch, baks()[0])).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(sb.ch, baks()[0]), 'utf8')).tokens.refresh_token, 'local-old');

  await run(sb, CODEX_SH, ['again'], { AIGATE_URL: mock.url });
  assert.equal(baks().length, 1, 'backup is one-time');
  const args = sb.runs()[0].args;
  assert.deepEqual(args, ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', 'hello', '--dangerously-bypass-approvals-and-sandbox']);
  assert.ok(!existsSync(join(sb.ch)) || readdirSync(sb.ch).every((f) => !f.startsWith('.auth.json.')), 'no temp file left behind');
});

test('print mode: flag translation and clean stdout', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);

  const r = await run(sb, CODEX_SH, ['-p', 'say hi', '--dangerously-skip-permissions'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'fake-codex-stdout\n', 'stdout is ONLY codex stdout');
  assert.match(r.stderr, /aigate → codex account: acct1/);
  assert.deepEqual(sb.runs()[0].args, ['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high', 'say hi', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']);

  const c = await run(sb, CODEX_SH, ['--continue'], { AIGATE_URL: mock.url });
  assert.equal(c.code, 0);
  assert.deepEqual(sb.runs()[1].args.slice(0, 3), ['resume', '-m', 'gpt-6.1-sol']);
  assert.ok(sb.runs()[1].args.includes('--last'));

  const s = await run(sb, CODEX_SH, ['-s', 'read-only', '--model', 'gpt-x', 'q'], { AIGATE_URL: mock.url });
  assert.equal(s.code, 0);
  const a = sb.runs()[2].args;
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'), 'caller owns sandbox');
  assert.ok(!a.includes('model_reasoning_effort=high') && !a.includes('gpt-6.1-sol'), 'caller owns model');

  const y = await run(sb, CODEX_SH, ['q'], { AIGATE_URL: mock.url, AI_GPT_YOLO: '0', AI_GPT_MODEL: 'm2', AI_GPT_EFFORT: 'low' });
  assert.equal(y.code, 0);
  assert.deepEqual(sb.runs()[3].args, ['-m', 'm2', '-c', 'model_reasoning_effort=low', 'q']);
});

test('print mode: usage limit parks the account, re-selects with exclude, retries', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((call) => {
    if (call.path === '/api/select') return [200, (call.q.exclude || '').includes('a1') ? pick('a2', 'rt-2') : pick('a1', 'rt-1')];
    return [200, { ok: true, applied: false }];
  }); t.after(mock.close);

  const r = await run(sb, CODEX_SH, ['-p', 'go'], { AIGATE_URL: mock.url, FAKE_FAIL_RTS: 'rt-1' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'fake-codex-stdout\n');
  assert.match(r.stderr, /over limit/);
  const park = mock.calls.find((c) => c.path === '/api/events/limit');
  assert.equal(park.method, 'POST'); assert.equal(park.body.account, 'a1');
  const sel = mock.calls.filter((c) => c.path === '/api/select');
  assert.equal(sel.length, 2); assert.equal(sel[1].q.exclude, 'a1');
  assert.deepEqual(sb.runs().map((x) => x.rt), ['rt-1', 'rt-2']);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-2');
});

test('print mode: three exhausted accounts → gives up, nothing printed on stdout', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const names = ['a1', 'a2', 'a3', 'a4'];
  const mock = await startMock((call) => {
    if (call.path !== '/api/select') return [200, { ok: true }];
    const ex = (call.q.exclude || '').split(',');
    const n = names.find((x) => !ex.includes(x));
    return [200, pick(n, `rt-${n}`)];
  }); t.after(mock.close);
  const r = await run(sb, CODEX_SH, ['-p', 'go'], { AIGATE_URL: mock.url, FAKE_FAIL_RTS: 'rt-a1,rt-a2,rt-a3,rt-a4' });
  assert.notEqual(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(sb.runs().length, 3, 'max 3 attempts');
  assert.match(r.stderr, /all codex accounts exhausted/);
});

test('pre-sync: a locally rotated token is POSTed first and the pick re-fetched', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  let synced = false;
  const mock = await startMock((call) => {
    if (call.path === '/api/codex/sync') { synced = true; return [200, { ok: true, applied: true, reason: 'applied' }]; }
    if (call.path === '/api/select') return [200, pick('acct1', synced ? 'rt-rotated' : 'rt-stale')];
    return [200, {}];
  }); t.after(mock.close);
  writeAuth(sb, 'rt-rotated', 'aid-acct1');

  const r = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  const sync = mock.calls.find((c) => c.path === '/api/codex/sync');
  assert.equal(sync.body.auth_json.tokens.refresh_token, 'rt-rotated');
  assert.equal(mock.calls.filter((c) => c.path === '/api/select').length, 2, 're-selected after applied:true');
  assert.equal(sb.runs()[0].rt, 'rt-rotated', 'codex ran on the freshly synced token, not the stale one');
});

test('pre-sync: identical refresh token → no sync POST', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-same'))); t.after(mock.close);
  writeAuth(sb, 'rt-same', 'aid-acct1');
  await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url });
  assert.ok(!mock.calls.some((c) => c.path === '/api/codex/sync'));
});

test('post-sync: codex rotating the token mid-run is synced back on exit', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  const r = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url, FAKE_ROTATE: 'rt-new' });
  assert.equal(r.code, 0, r.stderr);
  const syncs = mock.calls.filter((c) => c.path === '/api/codex/sync');
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0].body.auth_json.tokens.refresh_token, 'rt-new');

  // untouched auth.json → no post-sync
  const sb2 = sandbox(); t.after(sb2.cleanup);
  const mock2 = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock2.close);
  await run(sb2, CODEX_SH, ['hi'], { AIGATE_URL: mock2.url });
  assert.ok(!mock2.calls.some((c) => c.path === '/api/codex/sync'));
});

test('exit code of codex is preserved (interactive and print)', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  assert.equal((await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url, FAKE_RC: '7' })).code, 7);
  const p = await run(sb, CODEX_SH, ['-p', 'hi'], { AIGATE_URL: mock.url, FAKE_RC: '5' });
  assert.equal(p.code, 5); assert.equal(p.stdout, 'fake-codex-stdout\n');
});

test('unreachable / 401 / 503: says why on stderr and runs plain codex on the existing auth.json', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuth(sb, 'rt-existing', 'aid-x');
  const down = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.equal(down.code, 0, down.stderr);
  assert.match(down.stderr, /cannot reach the server/);
  assert.equal(sb.runs()[0].rt, 'rt-existing');
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-existing', 'auth.json untouched');
  assert.ok(sb.runs()[0].args.includes('hi'));

  const m401 = await startMock(() => [401, { error: 'unauthorized' }]); t.after(m401.close);
  const r401 = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: m401.url });
  assert.match(r401.stderr, /rejected \(401\)/); assert.equal(sb.runs().length, 2);

  const m503 = await startMock(() => [503, { error: 'no available account', accounts: 2, parked: 2, reauth: 0, disabled: 0 }]); t.after(m503.close);
  const r503 = await run(sb, CODEX_SH, ['-p', 'hi'], { AIGATE_URL: m503.url });
  assert.match(r503.stderr, /no codex account available — 2 accts \(2 parked/);
  assert.equal(r503.stdout, 'fake-codex-stdout\n'); assert.equal(sb.runs().length, 3);
});

test('--write-only: selects + writes + banner, never launches codex', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  const r = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /codex account: acct1/);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-1');
  assert.ok(!existsSync(sb.log), 'codex was not run');

  const bad = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.notEqual(bad.code, 0); assert.ok(!existsSync(sb.log));
});

test('--adopt: POSTs the local auth.json to /api/codex/sync', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => (c.path === '/api/codex/sync' ? [200, { ok: true, applied: true, reason: 'adopted' }] : [200, {}])); t.after(mock.close);
  writeAuth(sb, 'rt-local', 'aid-l');
  const r = await run(sb, CODEX_SH, ['--adopt'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.calls[0].body.auth_json.tokens.refresh_token, 'rt-local');
});

test('t3-codex.sh: writes the pick then execs real codex with args untouched', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  const dir = join(sb.home, '.claude', 'aigate');
  writeFileSync(join(dir, 'aigate-codex.sh'), readFileSync(CODEX_SH)); chmodSync(join(dir, 'aigate-codex.sh'), 0o755);
  const r = await run(sb, T3_CODEX, ['app-server', '--listen', 'stdio://'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-1');
  assert.deepEqual(sb.runs()[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(sb.runs().length, 1, 'real codex ran exactly once');
});

test('t3-codex.sh: fail-safe — aigate down or wrapper missing still execs codex', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuth(sb, 'rt-keep', 'aid-k');
  const r = await run(sb, T3_CODEX, ['app-server'], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sb.runs()[0].args, ['app-server']);
  assert.equal(sb.runs()[0].rt, 'rt-keep');
});
