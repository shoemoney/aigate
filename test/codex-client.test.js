// aigate-codex.sh / t3-codex.sh: select a Codex account, write auth.json, run the
// (fake) codex binary, sync rotated tokens back. Real bash scripts, mock aigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CODEX_SH = join(ROOT, 'clients', 'aigate-codex.sh');
const T3_CODEX = join(ROOT, 'clients', 't3-codex.sh');
const now = () => Math.floor(Date.now() / 1000);

import { BASH, PATH_ENV } from './helpers/bash32.js';

const pick = (name, rt, extra = {}) => ({
  account: name, kind: 'codex', plan: 'pro',
  auth_json: { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `id-${name}`, access_token: `at-${name}`, refresh_token: rt, account_id: `aid-${name}` },
    last_refresh: '2026-10-06T00:00:00Z' },
  token_exp: now() + 3600, five_hour_pct: 7, seven_day_pct: 16,
  five_hour_reset: now() + 3600, seven_day_reset: now() + 3 * 86400 + 4 * 3600 + 600, ...extra,
});

function startMock(handler, port = 0) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      const call = { method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body, auth: req.headers.authorization };
      calls.push(call);
      const [status, out, delay] = handler(call) ?? [200, {}];
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(typeof out === 'string' ? out : JSON.stringify(out));
      }, delay || 0);
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () =>
    r({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const FAKE = `#!/bin/bash
rt="$(python3 -c 'import json,os;print(json.load(open(os.environ["CODEX_HOME"]+"/auth.json"))["tokens"]["refresh_token"])' 2>/dev/null)"
echo "RUN rt=$rt" >> "$FAKE_LOG"
printf 'ARG %s\\n' "$@" >> "$FAKE_LOG"
if [ -n "\${FAKE_READ_STDIN:-}" ]; then echo "STDIN $(cat)" >> "$FAKE_LOG"; fi
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
      .map((r) => ({ rt: /rt=(.*)/.exec(r)[1], args: [...r.matchAll(/^ARG (.*)$/gm)].map((m) => m[1]), stdin: (/^STDIN (.*)$/m.exec(r) || [])[1] })),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(sb, script, args, env = {}, opts = {}) {
  return new Promise((res) => {
    const [cmd, argv] = opts.umask
      ? ['/bin/sh', ['-c', `umask ${opts.umask}; exec "$0" "$@"`, BASH, script, ...args]]
      : [BASH, [script, ...args]];
    const child = execFile(cmd, argv, {
      env: { PATH: PATH_ENV, HOME: sb.home, AIGATE_CODEX_HOME: sb.ch, CODEX_HOME: sb.ch, AIGATE_DIR: join(sb.home, '.claude', 'aigate'),
        AIGATE_CODEX_BIN: sb.bin, AIGATE_TOKEN: 'tok-secret', FAKE_LOG: sb.log, ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    opts.onChild?.(child);
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

test('interactive: auth.json ends 0600 under umask 022 even when a stale world-readable auth.json pre-exists', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  writeAuth(sb, 'local-old', 'someone-else'); chmodSync(sb.auth, 0o644);
  assert.equal(statSync(sb.auth).mode & 0o777, 0o644);
  const r = await run(sb, CODEX_SH, ['hello'], { AIGATE_URL: mock.url }, { umask: '022' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-1');
  assert.equal(statSync(sb.auth).mode & 0o777, 0o600, 'replaced file must not inherit the stale 0644');
  const bak = readdirSync(sb.ch).find((f) => f.startsWith('auth.json.bak-pre-aigate-'));
  assert.equal(statSync(join(sb.ch, bak)).mode & 0o777, 0o600, 'backup of the stale file is 0600 too');
  assert.ok(readdirSync(sb.ch).every((f) => !f.startsWith('.auth.json.')), 'no temp file left behind');
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
  assert.equal(r.stdout, 'aigate-account: acct1\n', 'machine-readable: the account actually written');
  assert.match(r.stderr, /codex account: acct1/);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-1');
  assert.ok(!existsSync(sb.log), 'codex was not run');

  const bad = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.notEqual(bad.code, 0); assert.ok(!existsSync(sb.log));
});

test('--write-only never launches codex even when it falls through to plain_codex (no aigate env) or aigate says 503/401', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuth(sb, 'rt-existing', 'aid-x');
  // no AIGATE_URL: the script reaches plain_codex(), whose write-only guard must exit 1 before exec
  const noenv = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: '' });
  assert.equal(noenv.code, 1, noenv.stderr);
  assert.match(noenv.stderr, /no aigate env → running plain codex/);
  assert.ok(!existsSync(sb.log), 'plain_codex must not exec codex in write-only mode');
  for (const [status, body] of [[503, { error: 'no available account', accounts: 1, parked: 1 }], [401, { error: 'unauthorized' }]]) {
    const m = await startMock(() => [status, body]); t.after(m.close);
    const r = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: m.url });
    assert.equal(r.code, 1, `${status}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.ok(!existsSync(sb.log), `${status}: codex must not run`);
  }
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-existing', 'auth.json untouched');
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

test('t3-codex.sh: fail-safe — wrapper missing, aigate down, aigate 503, wrapper crashing: real codex still runs, argv untouched', async (t) => {
  const argv = ['app-server', '--listen', 'stdio://', '-c', 'x=1'];
  const install = (sb, body) => {
    const w = join(sb.home, '.claude', 'aigate', 'aigate-codex.sh');
    writeFileSync(w, body ?? readFileSync(CODEX_SH)); chmodSync(w, 0o755);
  };
  const cases = {
    'wrapper missing': { setup: () => {}, env: { AIGATE_URL: 'http://127.0.0.1:1' } },
    'aigate down': { setup: (sb) => install(sb), env: { AIGATE_URL: 'http://127.0.0.1:1' } },
    'aigate 503': { setup: (sb) => install(sb), env: {}, mock: () => [503, { error: 'none', accounts: 1, parked: 1 }] },
    'aigate 401': { setup: (sb) => install(sb), env: {}, mock: () => [401, { error: 'unauthorized' }] },
    'wrapper crashes': { setup: (sb) => install(sb, '#!/bin/bash\nexit 99\n'), env: { AIGATE_URL: 'http://127.0.0.1:1' } },
  };
  for (const [name, c] of Object.entries(cases)) {
    const sb = sandbox(); t.after(sb.cleanup);
    writeAuth(sb, 'rt-keep', 'aid-k');
    c.setup(sb);
    const env = { ...c.env };
    if (c.mock) { const m = await startMock(c.mock); t.after(m.close); env.AIGATE_URL = m.url; }
    const r = await run(sb, T3_CODEX, argv, env);
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(sb.runs().length, 1, `${name}: real codex ran exactly once`);
    assert.deepEqual(sb.runs()[0].args, argv, `${name}: argv untouched`);
    assert.equal(sb.runs()[0].rt, 'rt-keep', `${name}: existing login untouched`);
    assert.equal(r.stdout, 'fake-codex-stdout\n', `${name}: wrapper chatter does not leak to stdout`);
    assert.ok(!/aigate/.test(r.stderr), `${name}: wrapper stderr suppressed (T3 owns the driver's stderr)`);
  }
});

// ── helpers for the keeper / sticky / signal tests ────────────────────────────
const vaultAuth = (name, rt, aid, lastRefresh, extra = {}) => ({
  account: name, kind: 'codex',
  auth_json: { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `id-${name}`, access_token: `at-${name}`, refresh_token: rt, account_id: aid },
    last_refresh: lastRefresh },
  last_refresh: lastRefresh, token_exp: now() + 86400, reauth_needed: 0, disabled: 0, ...extra,
});
const writeAuthAt = (sb, rt, acct, lastRefresh) => writeFileSync(sb.auth, JSON.stringify({
  auth_mode: 'chatgpt', last_refresh: lastRefresh, tokens: { refresh_token: rt, account_id: acct, id_token: 'x', access_token: 'y' } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(25); } return false; }

// a stand-in for a running codex: argv[0] is `codex`, env carries its CODEX_HOME
async function liveCodex(t, codexHome) {
  const c = spawn('/bin/bash', ['-c', 'exec -a codex sleep 120'], { env: { PATH: process.env.PATH, CODEX_HOME: codexHome }, stdio: 'ignore' });
  t.after(() => c.kill('SIGKILL'));
  await sleep(400);
  return c;
}

test('suites really run under /bin/bash 3.2 on macOS', (t) => {
  if (process.platform !== 'darwin' || !existsSync('/bin/bash')) return t.skip('not macOS');
  const v = execFileSync('/usr/bin/env', ['bash', '-c', 'echo $BASH_VERSION'], { env: { PATH: PATH_ENV }, encoding: 'utf8' });
  assert.match(v, /^3\.2\./, `env bash resolved to ${v}`);
  assert.match(execFileSync(BASH, ['-c', 'echo $BASH_VERSION'], { encoding: 'utf8' }), /^3\.2\./);
});

test('flag translation: print+continue, -c key=value, --config, --profile, bare -c', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
  const M = ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high'];
  const Y = '--dangerously-bypass-approvals-and-sandbox';
  const cases = [
    [['-p', '-c', 'hi'], ['exec', 'resume', ...M, '--last', 'hi', '--skip-git-repo-check', Y]],
    [['-c', '-p', 'hi'], ['exec', 'resume', ...M, '--last', 'hi', '--skip-git-repo-check', Y]],
    [['--continue', '-p', 'hi'], ['exec', 'resume', ...M, '--last', 'hi', '--skip-git-repo-check', Y]],
    [['-c', 'model_verbosity=low', 'hi'], [...M, '-c', 'model_verbosity=low', 'hi', Y]],
    [['--config', 'k=v', 'hi'], [...M, '--config', 'k=v', 'hi', Y]],
    [['--profile', 'work', 'hi'], [...M, '--profile', 'work', 'hi', Y]],
    [['-c'], ['resume', ...M, '--last', Y]],
    [['--continue'], ['resume', ...M, '--last', Y]],
    [['-p', 'hi'], ['exec', ...M, 'hi', '--skip-git-repo-check', Y]],
  ];
  const results = await Promise.all(cases.map(([argv]) => {
    const own = sandbox(); t.after(own.cleanup);
    return run(own, CODEX_SH, argv, { AIGATE_URL: mock.url }).then((r) => ({ r, own }));
  }));
  results.forEach(({ r, own }, i) => {
    assert.equal(r.code, 0, `${cases[i][0].join(' ')}: ${r.stderr}`);
    assert.deepEqual(own.runs()[0].args, cases[i][1], cases[i][0].join(' '));
  });
});

test('--keep: vault newer + different token → auth.json rewritten 0600, same account, one stderr line', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => (c.path === '/api/codex/auth'
    ? [200, vaultAuth('acct1', 'rt-vault', 'aid-1', '2026-10-06T12:00:00Z')] : [200, {}])); t.after(mock.close);
  writeAuthAt(sb, 'rt-local', 'aid-1', '2026-10-01T00:00:00Z');
  const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-vault');
  assert.equal(readAuth(sb).tokens.account_id, 'aid-1');
  assert.equal(statSync(sb.auth).mode & 0o777, 0o600);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.ok(!r.stderr.includes('rt-vault') && !r.stderr.includes('tok-secret'), 'no secrets in output');
  const get = mock.calls.find((c) => c.path === '/api/codex/auth');
  assert.equal(get.method, 'GET'); assert.equal(get.q.account_id, 'aid-1'); assert.equal(get.auth, 'Bearer tok-secret');
  assert.ok(!mock.calls.some((c) => c.path === '/api/select'), 'keeper never picks');
  assert.ok(readdirSync(sb.ch).every((f) => !f.startsWith('.auth.json.')), 'no temp file left behind');
});

test('--keep: silent no-op when tokens match; vault for a DIFFERENT account never overwrites', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  let reply = vaultAuth('acct1', 'rt-same', 'aid-1', '2026-10-06T12:00:00Z');
  const mock = await startMock((c) => (c.path === '/api/codex/auth' ? [200, reply] : [200, {}])); t.after(mock.close);
  writeAuthAt(sb, 'rt-same', 'aid-1', '2026-10-01T00:00:00Z');
  const same = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(same.code, 0); assert.equal(same.stderr, ''); assert.equal(same.stdout, '');

  reply = vaultAuth('other', 'rt-other', 'aid-OTHER', '2026-10-06T12:00:00Z');
  const diff = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(diff.code, 0);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-same'); assert.equal(readAuth(sb).tokens.account_id, 'aid-1');
});

test('--keep: local newer + different token → POST /api/codex/sync', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => (c.path === '/api/codex/auth' ? [200, vaultAuth('acct1', 'rt-vault', 'aid-1', '2026-10-01T00:00:00Z')]
    : c.path === '/api/codex/sync' ? [200, { ok: true, applied: true, reason: 'applied' }] : [200, {}])); t.after(mock.close);
  writeAuthAt(sb, 'rt-local-new', 'aid-1', '2026-10-06T12:00:00.123456789Z');
  const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  const sync = mock.calls.find((c) => c.path === '/api/codex/sync');
  assert.equal(sync.body.auth_json.tokens.refresh_token, 'rt-local-new');
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-local-new', 'local file untouched');
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('--keep: fail-open (down / 404 / 401 / no env / no auth.json / reauth) always exits 0', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuthAt(sb, 'rt-local', 'aid-1', '2026-10-01T00:00:00Z');
  const down = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_KEEP_BACKOFF: '0 0' });
  assert.equal(down.code, 0); assert.match(down.stderr, /cannot reach/);
  const m404 = await startMock(() => [404, { error: 'no such codex account' }]); t.after(m404.close);
  const r404 = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: m404.url });
  assert.equal(r404.code, 0); assert.equal(r404.stderr, '');
  const m401 = await startMock(() => [401, { error: 'unauthorized' }]); t.after(m401.close);
  const r401 = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: m401.url });
  assert.equal(r401.code, 0); assert.match(r401.stderr, /rejected/);
  const noenv = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: '', AIGATE_TOKEN: '' });
  assert.equal(noenv.code, 0);
  const sb2 = sandbox(); t.after(sb2.cleanup);
  const mockOk = await startMock(() => [200, vaultAuth('a', 'rt-v', 'aid-1', '2026-10-06T00:00:00Z')]); t.after(mockOk.close);
  const noauth = await run(sb2, CODEX_SH, ['--keep'], { AIGATE_URL: mockOk.url });
  assert.equal(noauth.code, 0); assert.ok(!existsSync(sb2.auth), 'keeper never creates an auth.json');
  const mockRe = await startMock(() => [200, vaultAuth('a', 'rt-v', 'aid-1', '2026-10-06T00:00:00Z', { reauth_needed: 1 })]); t.after(mockRe.close);
  const re = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mockRe.url });
  assert.equal(re.code, 0); assert.equal(readAuth(sb).tokens.refresh_token, 'rt-local', 'a re-auth token is never written');
  assert.ok(!existsSync(sb.log), 'keeper never runs codex');
});

test('every invocation runs the keeper first: codex launches on the vault-rotated token', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/codex/auth') return [200, vaultAuth('acct1', 'rt-vault', 'aid-acct1', '2026-10-06T12:00:00Z')];
    if (c.path === '/api/select') return [200, pick('acct1', 'rt-vault')];
    return [200, { ok: true, applied: false }];
  }); t.after(mock.close);
  writeAuthAt(sb, 'rt-stale-local', 'aid-acct1', '2026-10-01T00:00:00Z');
  const r = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.runs()[0].rt, 'rt-vault');
  assert.ok(!mock.calls.some((c) => c.path === '/api/codex/sync'), 'the stale local token was NOT pushed over the vault');
  assert.match(r.stderr, /aigate-keeper: auth.json updated from the vault/);
});

test('STICKY: a live codex for this CODEX_HOME keeps its account; select is never called', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/codex/auth') return [200, vaultAuth('live', 'rt-live', 'aid-live', '2026-10-06T12:00:00Z')];
    if (c.path === '/api/accounts') return [200, [{ account: 'live', kind: 'codex', five_hour_pct: 10, seven_day_pct: 20, parked: 0, reauth_needed: 0, disabled: 0 }]];
    if (c.path === '/api/select') return [200, pick('better', 'rt-better')];
    return [200, {}];
  }); t.after(mock.close);
  writeAuthAt(sb, 'rt-live', 'aid-live', '2026-10-06T12:00:00Z');
  await liveCodex(t, sb.ch);
  const r = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.account_id, 'aid-live', 'account not switched');
  assert.equal(sb.runs()[0].rt, 'rt-live');
  assert.ok(!mock.calls.some((c) => c.path === '/api/select'), 'no select');
  assert.match(r.stderr, /kept: another codex is running/);

  // --write-only (what t3-codex.sh / ai-desktop use) is sticky too
  const w = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: mock.url });
  assert.equal(w.code, 0, w.stderr); assert.equal(readAuth(sb).tokens.account_id, 'aid-live');
  assert.ok(!mock.calls.some((c) => c.path === '/api/select'));
});

test('STICKY: keeper refreshes the on-disk account while a codex is live', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/codex/auth') return [200, vaultAuth('live', 'rt-rotated', 'aid-live', '2026-10-06T12:00:00Z')];
    if (c.path === '/api/accounts') return [200, [{ account: 'live', five_hour_pct: 1, seven_day_pct: 1 }]];
    return [200, {}];
  }); t.after(mock.close);
  writeAuthAt(sb, 'rt-old', 'aid-live', '2026-10-01T00:00:00Z');
  await liveCodex(t, sb.ch);
  const r = await run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.runs()[0].rt, 'rt-rotated');
});

test('STICKY: exhausted / reauth / disabled on-disk account IS switched, with a stderr warning', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  await liveCodex(t, sb.ch);
  for (const [label, vaultExtra, acctRow] of [
    ['exhausted', {}, { account: 'live', five_hour_pct: 99, seven_day_pct: 40 }],
    ['parked', {}, { account: 'live', five_hour_pct: 10, seven_day_pct: 10, parked: 1 }],
    ['reauth', { reauth_needed: 1 }, { account: 'live' }],
    ['disabled', { disabled: 1 }, { account: 'live' }],
  ]) {
    const mock = await startMock((c) => {
      if (c.path === '/api/codex/auth') return [200, vaultAuth('live', 'rt-live', 'aid-live', '2026-10-06T12:00:00Z', vaultExtra)];
      if (c.path === '/api/accounts') return [200, [acctRow]];
      if (c.path === '/api/select') return [200, pick('better', 'rt-better')];
      return [200, { ok: true, applied: false }];
    }); t.after(mock.close);
    writeAuthAt(sb, 'rt-live', 'aid-live', '2026-10-06T12:00:00Z');
    const r = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: mock.url });
    assert.equal(r.code, 0, `${label}: ${r.stderr}`);
    assert.equal(readAuth(sb).tokens.account_id, 'aid-better', label);
    assert.match(r.stderr, new RegExp(`switching its login on disk`), label);
    assert.ok(mock.calls.some((c) => c.path === '/api/select'), label);
  }
});

test('STICKY off: AI_CODEX_FORCE=1, a codex under a DIFFERENT CODEX_HOME, or our own pid tree do not pin the account', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mk = () => startMock((c) => {
    if (c.path === '/api/codex/auth') return [200, vaultAuth('live', 'rt-live', 'aid-live', '2026-10-06T12:00:00Z')];
    if (c.path === '/api/accounts') return [200, [{ account: 'live', five_hour_pct: 1, seven_day_pct: 1 }]];
    if (c.path === '/api/select') return [200, pick('better', 'rt-better')];
    return [200, { ok: true, applied: false }];
  });
  const mock = await mk(); t.after(mock.close);
  const other = join(sb.dir, 'elsewhere'); mkdirSync(other);
  await liveCodex(t, other);              // someone else's CODEX_HOME
  writeAuthAt(sb, 'rt-live', 'aid-live', '2026-10-06T12:00:00Z');
  const diffHome = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: mock.url });
  assert.equal(readAuth(sb).tokens.account_id, 'aid-better', `different CODEX_HOME must not pin: ${diffHome.stderr}`);

  await liveCodex(t, sb.ch);
  writeAuthAt(sb, 'rt-live', 'aid-live', '2026-10-06T12:00:00Z');
  const forced = await run(sb, CODEX_SH, ['--write-only'], { AIGATE_URL: mock.url, AI_CODEX_FORCE: '1' });
  assert.equal(readAuth(sb).tokens.account_id, 'aid-better', `FORCE switches: ${forced.stderr}`);
});

test('t3-codex.sh is sticky: a live codex keeps its account and real codex still execs', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/codex/auth') return [200, vaultAuth('live', 'rt-live', 'aid-live', '2026-10-06T12:00:00Z')];
    if (c.path === '/api/accounts') return [200, [{ account: 'live', five_hour_pct: 1, seven_day_pct: 1 }]];
    if (c.path === '/api/select') return [200, pick('better', 'rt-better')];
    return [200, {}];
  }); t.after(mock.close);
  const dir = join(sb.home, '.claude', 'aigate');
  writeFileSync(join(dir, 'aigate-codex.sh'), readFileSync(CODEX_SH)); chmodSync(join(dir, 'aigate-codex.sh'), 0o755);
  writeAuthAt(sb, 'rt-live', 'aid-live', '2026-10-06T12:00:00Z');
  await liveCodex(t, sb.ch);
  const r = await run(sb, T3_CODEX, ['app-server'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.account_id, 'aid-live');
  assert.deepEqual(sb.runs()[0].args, ['app-server']);
  assert.ok(!/AI_CODEX_FORCE/.test(readFileSync(T3_CODEX, 'utf8').replace(/^#.*$/gm, '')), 't3-codex no longer forces');
});

test('signals before launch: TERM → 143, INT → 130, codex is never started', async (t) => {
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const sb = sandbox(); t.after(sb.cleanup);
    const mock = await startMock((c) => (c.path === '/api/select' ? [200, pick('acct1', 'rt-1'), 6000] : [200, {}])); t.after(mock.close);
    let child;
    const p = run(sb, CODEX_SH, ['hi'], { AIGATE_URL: mock.url }, { onChild: (c) => { child = c; } });
    assert.ok(await waitFor(() => mock.calls.some((c) => c.path === '/api/select')), 'select in flight');
    const t0 = Date.now();
    child.kill(sig);
    const r = await p;
    assert.equal(r.code, code, `${sig}: ${r.stderr}`);
    assert.ok(Date.now() - t0 < 4000, `${sig} exits promptly, not after the 6s select`);
    assert.ok(!existsSync(sb.log), `${sig}: codex must NOT have been launched`);
    assert.ok(!/plain codex/.test(r.stderr), `${sig} is not "aigate unreachable"`);
  }
});

test('print mode: a piped prompt is replayed to every retry attempt', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((call) => {
    if (call.path === '/api/select') return [200, (call.q.exclude || '').includes('a1') ? pick('a2', 'rt-2') : pick('a1', 'rt-1')];
    return [200, { ok: true, applied: false }];
  }); t.after(mock.close);
  const r = await run(sb, CODEX_SH, ['-p'], { AIGATE_URL: mock.url, FAKE_FAIL_RTS: 'rt-1', FAKE_READ_STDIN: '1' }, { stdin: 'summarise this please' });
  assert.equal(r.code, 0, r.stderr);
  const runs = sb.runs();
  assert.equal(runs.length, 2);
  assert.equal(runs[0].stdin, 'summarise this please');
  assert.equal(runs[1].stdin, 'summarise this please', 'attempt 2 got the same prompt');
});

test('install.sh writes the codex keeper launchd plist (scratch root: no launchctl)', async (t) => {
  if (process.platform !== 'darwin') return t.skip('launchd is macOS-only');
  const dir = mkdtempSync(join(tmpdir(), 'inst-k-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { spawnSync } = await import('node:child_process');
  const env = { PATH: PATH_ENV, HOME: dir, AIGATE_INSTALL_ROOT: dir, AIGATE_NO_LAUNCHD: '1', AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok', ZDOTDIR: dir };
  const r1 = spawnSync(BASH, [join(ROOT, 'clients', 'install.sh')], { env, encoding: 'utf8' });
  assert.equal(r1.status, 0, r1.stderr);
  const plist = join(dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-codex-keeper.plist');
  assert.ok(existsSync(plist));
  const x = readFileSync(plist, 'utf8');
  assert.match(x, /<string>ai\.shoemoney\.aigate-codex-keeper<\/string>/);
  assert.match(x, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(x, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(x, new RegExp(`<string>/bin/bash</string>\\s*<string>${join(dir, '.claude', 'aigate', 'aigate-codex.sh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>\\s*<string>--keep</string>`));
  assert.match(x, /codex-keeper\.log/);
  assert.equal(spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' }).status, 0, 'valid plist');
  assert.equal(spawnSync(BASH, [join(ROOT, 'clients', 'install.sh')], { env, encoding: 'utf8' }).status, 0, 'idempotent');
});

test('ai-desktop codex: only ChatGPT.app\'s app-server is stopped; keeper/select runs after; then the app is reopened', async (t) => {
  if (process.platform !== 'darwin') return t.skip('ai-desktop is macOS-only');
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/select') return [200, pick('acct1', 'rt-1')];
    return [200, { ok: true, applied: false }];
  }); t.after(mock.close);
  const dir = join(sb.home, '.claude', 'aigate');
  writeFileSync(join(dir, 'aigate-codex.sh'), readFileSync(CODEX_SH)); chmodSync(join(dir, 'aigate-codex.sh'), 0o755);
  const app = join(sb.dir, 'ChatGPT.app'); mkdirSync(join(app, 'Contents', 'Resources'), { recursive: true });
  const shim = join(sb.dir, 'shim'); mkdirSync(shim);
  const order = join(sb.dir, 'order.log');
  for (const [n, body] of [
    ['osascript', `echo osascript >> "${order}"`],
    ['open', `echo "open $*" >> "${order}"`],
    ['mdfind', 'exit 0'],
  ]) { writeFileSync(join(shim, n), `#!/bin/bash\n${body}\n`); chmodSync(join(shim, n), 0o755); }
  const mine = spawn('/bin/bash', ['-c', `exec -a "${app}/Contents/Resources/codex app-server" sleep 120`], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  const t3 = spawn('/bin/bash', ['-c', 'exec -a "/Users/x/t3/node_modules/codex app-server" sleep 120'], { stdio: 'ignore', env: { PATH: process.env.PATH } });
  t.after(() => { mine.kill('SIGKILL'); t3.kill('SIGKILL'); });
  await sleep(400);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const r = await new Promise((res) => {
    const c = execFile(BASH, [join(ROOT, 'clients', 'ai-desktop'), 'codex'], {
      env: { PATH: `${shim}:${PATH_ENV}`, HOME: sb.home, AIGATE_DIR: dir, AIGATE_CODEX_HOME: sb.ch, CODEX_HOME: sb.ch,
        AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok-secret', AIGATE_CODEX_BIN: sb.bin, FAKE_LOG: sb.log,
        AIGATE_CODEX_APP_PATH: app, AIGATE_DESKTOP_WAIT_S: '1', AIGATE_CODEX_BUNDLE_ID: 'com.openai.codex' },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    c.stdin.end('');
  });
  assert.equal(r.code, 0, r.stderr);
  await sleep(200);
  assert.ok(!alive(mine.pid), "ChatGPT.app's app-server was TERMed");
  assert.ok(alive(t3.pid), "T3's codex app-server was left alone");
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-1', 'auth.json written');
  const lines = readFileSync(order, 'utf8').trim().split('\n');
  assert.equal(lines[0], 'osascript'); assert.equal(lines[1], 'open -b com.openai.codex', 'open comes last, after the write');
});

// ── N1: keeper survives sleep/boot (retry), installers, N3 repair, N4 desktop, binary pick ──
import { spawnSync } from 'node:child_process';
import { utimesSync } from 'node:fs';

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('--keep: an UNREACHABLE aigate is retried with backoff until it comes up (boot/wake gap), then the vault token lands', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuthAt(sb, 'rt-local', 'aid-1', '2026-10-01T00:00:00Z');
  const port = await freePort();
  const child = run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: `http://127.0.0.1:${port}`, AIGATE_KEEP_BACKOFF: '1 1 1 1 1 1' });
  await sleep(1500);                                    // network "comes up" mid-backoff
  const mock = await startMock((c) => (c.path === '/api/codex/auth'
    ? [200, vaultAuth('acct1', 'rt-vault', 'aid-1', '2026-10-06T12:00:00Z')] : [200, {}]), port); t.after(mock.close);
  const r = await child;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-vault', 'a later retry reached the vault');
});

test('--keep: gives up fail-open after the backoff schedule when aigate never answers', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeAuthAt(sb, 'rt-local', 'aid-1', '2026-10-01T00:00:00Z');
  const t0 = Date.now();
  const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_KEEP_BACKOFF: '1 1' });
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 >= 1900, `waited out the 1s+1s schedule (${Date.now() - t0}ms)`);
  assert.match(r.stderr, /still unreachable after retries/);
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-local');
});

test('--keep: 401 / 404 / 503 are answers, never retried', async (t) => {
  for (const [status, body] of [[401, { error: 'unauthorized' }], [404, { error: 'no such codex account' }], [503, { error: 'busy' }]]) {
    const sb = sandbox(); t.after(sb.cleanup);
    writeAuthAt(sb, 'rt-local', 'aid-1', '2026-10-01T00:00:00Z');
    const m = await startMock(() => [status, body]); t.after(m.close);
    const t0 = Date.now();
    const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: m.url, AIGATE_KEEP_BACKOFF: '2 2 2' });
    assert.equal(r.code, 0, `${status}: ${r.stderr}`);
    assert.equal(m.calls.length, 1, `${status} asked exactly once`);
    assert.ok(Date.now() - t0 < 1800, `${status} did not sleep through the backoff`);
  }
});

test('N3 --keep: vault flagged reauth_needed/refresh_unknown + a NEWER different local login on the same account → POST /sync (re-login repairs the vault); never writes the vault token to disk', async (t) => {
  for (const flag of ['reauth_needed', 'refresh_unknown']) {
    const sb = sandbox(); t.after(sb.cleanup);
    const mock = await startMock((c) => (c.path === '/api/codex/auth'
      ? [200, vaultAuth('acct1', 'rt-dead', 'aid-1', '2026-10-01T00:00:00Z', { [flag]: 1 })]
      : c.path === '/api/codex/sync' ? [200, { ok: true, applied: true, reason: 'applied' }] : [200, {}])); t.after(mock.close);
    writeAuthAt(sb, 'rt-relogin', 'aid-1', '2026-10-06T12:00:00Z');
    const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: mock.url });
    assert.equal(r.code, 0, `${flag}: ${r.stderr}`);
    const sync = mock.calls.find((c) => c.path === '/api/codex/sync');
    assert.ok(sync, `${flag}: local re-login was pushed`);
    assert.equal(sync.body.auth_json.tokens.refresh_token, 'rt-relogin');
    assert.equal(readAuth(sb).tokens.refresh_token, 'rt-relogin', `${flag}: local untouched`);
    assert.doesNotMatch(r.stderr, /needs re-auth/, `${flag}: repaired → no reauth complaint`);
    assert.match(r.stderr, /repaired the vault/);
  }
});

test('N3 --keep: reauth + server declines the sync → reports re-auth; reauth + OLDER local or other account → no sync, vault token never written', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const declined = await startMock((c) => (c.path === '/api/codex/auth'
    ? [200, vaultAuth('acct1', 'rt-dead', 'aid-1', '2026-10-01T00:00:00Z', { reauth_needed: 1 })]
    : [200, { ok: true, applied: false, reason: 'refresh in flight' }])); t.after(declined.close);
  writeAuthAt(sb, 'rt-relogin', 'aid-1', '2026-10-06T12:00:00Z');
  const r = await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: declined.url });
  assert.equal(r.code, 0);
  assert.ok(declined.calls.some((c) => c.path === '/api/codex/sync'), 'tried to sync');
  assert.match(r.stderr, /needs re-auth/);

  const older = await startMock((c) => (c.path === '/api/codex/auth'
    ? [200, vaultAuth('acct1', 'rt-dead', 'aid-1', '2026-10-09T00:00:00Z', { reauth_needed: 1 })] : [200, {}])); t.after(older.close);
  await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: older.url });
  assert.ok(!older.calls.some((c) => c.path === '/api/codex/sync'), 'local older than vault → no sync');
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-relogin', 'dead vault token never written to disk');

  const other = await startMock((c) => (c.path === '/api/codex/auth'
    ? [200, vaultAuth('acct2', 'rt-dead', 'aid-OTHER', '2026-10-01T00:00:00Z', { reauth_needed: 1 })] : [200, {}])); t.after(other.close);
  await run(sb, CODEX_SH, ['--keep'], { AIGATE_URL: other.url });
  assert.ok(!other.calls.some((c) => c.path === '/api/codex/sync'), 'vault row for a different account → no sync');
  assert.equal(readAuth(sb).tokens.refresh_token, 'rt-relogin');
});

// ── installer: keeper units ──
const INSTALL_SH = join(ROOT, 'clients', 'install.sh');
const shimBin = (shim, name, body) => { writeFileSync(join(shim, name), `#!/bin/bash\n${body}\n`); chmodSync(join(shim, name), 0o755); };
function installEnv(dir, shim, extra) {
  return { PATH: `${shim}:${PATH_ENV}`, HOME: dir, AIGATE_INSTALL_ROOT: dir, AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok', ZDOTDIR: dir, ...extra };
}
function install(prep, tag) {
  const dir = mkdtempSync(join(tmpdir(), `inst-${tag}-`));
  const shim = join(dir, 'shim'); mkdirSync(shim);
  const extra = prep(dir, shim);
  const r = spawnSync(BASH, [INSTALL_SH], { encoding: 'utf8', env: installEnv(dir, shim, extra) });
  return { dir, shim, extra, r };
}

test('install.sh (darwin plist): passes AIGATE_CODEX_HOME / CODEX_HOME through EnvironmentVariables only when set', async (t) => {
  const withEnv = install(() => ({ AIGATE_NO_LAUNCHD: '1', AIGATE_INSTALL_OS: 'Darwin', AIGATE_CODEX_HOME: '/tmp/a&b/codex', CODEX_HOME: '/tmp/ch' }), 'pe');
  t.after(() => rmSync(withEnv.dir, { recursive: true, force: true }));
  assert.equal(withEnv.r.status, 0, withEnv.r.stderr);
  const pl = join(withEnv.dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-codex-keeper.plist');
  const x = readFileSync(pl, 'utf8');
  assert.match(x, /<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*<key>AIGATE_CODEX_HOME<\/key><string>\/tmp\/a&amp;b\/codex<\/string>[\s\S]*<key>CODEX_HOME<\/key><string>\/tmp\/ch<\/string>/);
  assert.match(x, /<key>StartInterval<\/key><integer>300<\/integer>/);
  if (spawnSync('which', ['plutil']).status === 0) assert.equal(spawnSync('plutil', ['-lint', pl]).status, 0, 'valid plist');
  const none = install(() => ({ AIGATE_NO_LAUNCHD: '1', AIGATE_INSTALL_OS: 'Darwin', AIGATE_CODEX_HOME: '', CODEX_HOME: '' }), 'pn');
  t.after(() => rmSync(none.dir, { recursive: true, force: true }));
  assert.doesNotMatch(readFileSync(join(none.dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-codex-keeper.plist'), 'utf8'), /EnvironmentVariables/);
});

test('install.sh (linux): systemd --user timer+service (boot 60s, every 300s, Persistent) enabled via systemctl', async (t) => {
  const i = install((dir, shim) => {
    shimBin(shim, 'systemctl', `echo "systemctl $*" >> "${dir}/sc.log"; exit 0`);
    return { AIGATE_INSTALL_OS: 'Linux', AIGATE_TEST_ACTIVATE: '1', CODEX_HOME: '/srv/ch', AIGATE_CODEX_HOME: '' };
  }, 'ls');
  t.after(() => rmSync(i.dir, { recursive: true, force: true }));
  assert.equal(i.r.status, 0, i.r.stderr);
  const u = join(i.dir, '.config', 'systemd', 'user');
  const timer = readFileSync(join(u, 'aigate-codex-keeper.timer'), 'utf8');
  assert.match(timer, /^OnBootSec=60$/m); assert.match(timer, /^OnUnitActiveSec=300$/m); assert.match(timer, /Persistent=true/);
  const svc = readFileSync(join(u, 'aigate-codex-keeper.service'), 'utf8');
  assert.match(svc, new RegExp(`ExecStart=/bin/bash ${join(i.dir, '.claude', 'aigate', 'aigate-codex.sh').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --keep`));
  assert.match(svc, /Environment="CODEX_HOME=\/srv\/ch"/);
  assert.doesNotMatch(svc, /AIGATE_CODEX_HOME/);
  assert.match(readFileSync(join(i.dir, 'sc.log'), 'utf8'), /systemctl --user enable --now aigate-codex-keeper\.timer/);
});

test('install.sh (linux): no systemd → idempotent crontab line */5 (re-run never duplicates; other lines kept); AIGATE_NO_CRON skips', async (t) => {
  const dirs = [];
  t.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const mk = (extra) => {
    const i = install((dir, shim) => {
      writeFileSync(join(dir, 'cron.txt'), '0 1 * * * /usr/bin/backup\n');
      shimBin(shim, 'systemctl', 'exit 1');
      shimBin(shim, 'crontab', `if [ "$1" = "-l" ]; then cat "${dir}/cron.txt"; else cat > "${dir}/cron.txt"; fi`);
      return { AIGATE_INSTALL_OS: 'Linux', AIGATE_TEST_ACTIVATE: '1', ...extra };
    }, 'cr');
    dirs.push(i.dir); return i;
  };
  const count = (i) => readFileSync(join(i.dir, 'cron.txt'), 'utf8').split('\n').filter((l) => l.includes('aigate-codex-keeper')).length;
  const first = mk({});
  assert.equal(first.r.status, 0, first.r.stderr);
  assert.equal(count(first), 1);
  const cron = readFileSync(join(first.dir, 'cron.txt'), 'utf8');
  assert.match(cron, /^\*\/5 \* \* \* \* \/bin\/bash .*aigate-codex\.sh --keep/m);
  assert.match(cron, /0 1 \* \* \* \/usr\/bin\/backup/);
  const again = spawnSync(BASH, [INSTALL_SH], { encoding: 'utf8', env: installEnv(first.dir, first.shim, first.extra) });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(count(first), 1, 'no duplicate on re-run');
  const skip = mk({ AIGATE_NO_CRON: '1' });
  assert.equal(count(skip), 0, 'AIGATE_NO_CRON respected');
});

// ── N4: ai-desktop ──
async function desktop(t, { writeFails, dryAccount }) {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => {
    if (c.path === '/api/select') return writeFails ? [503, { error: 'none', accounts: 1 }]
      : [200, c.q.dry ? { account: dryAccount, plan: 'pro' } : pick('acct1', 'rt-1')];
    return [200, { ok: true, applied: false }];
  }); t.after(mock.close);
  const dir = join(sb.home, '.claude', 'aigate');
  writeFileSync(join(dir, 'aigate-codex.sh'), readFileSync(CODEX_SH)); chmodSync(join(dir, 'aigate-codex.sh'), 0o755);
  const app = join(sb.dir, 'ChatGPT.app'); mkdirSync(join(app, 'Contents'), { recursive: true });
  const shim = join(sb.dir, 'shim'); mkdirSync(shim);
  const order = join(sb.dir, 'order.log');
  for (const [n, body] of [['osascript', `echo osascript >> "${order}"`], ['open', `echo "open $*" >> "${order}"`], ['mdfind', 'exit 0']]) shimBin(shim, n, body);
  const r = await new Promise((res) => {
    const c = execFile(BASH, [join(ROOT, 'clients', 'ai-desktop'), 'codex'], {
      env: { PATH: `${shim}:${PATH_ENV}`, HOME: sb.home, AIGATE_DIR: dir, AIGATE_CODEX_HOME: sb.ch, CODEX_HOME: sb.ch, AIGATE_URL: mock.url,
        AIGATE_TOKEN: 'tok-secret', AIGATE_CODEX_BIN: sb.bin, FAKE_LOG: sb.log, AIGATE_CODEX_APP_PATH: app, AIGATE_DESKTOP_WAIT_S: '1' }, timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    c.stdin.end('');
  });
  return { r, order: existsSync(order) ? readFileSync(order, 'utf8').trim().split('\n') : [] };
}

test('N4 ai-desktop codex: --write-only failure AFTER the app was quit reopens ChatGPT on its existing login and says so', async (t) => {
  if (process.platform !== 'darwin') return t.skip('ai-desktop is macOS-only');
  const { r, order } = await desktop(t, { writeFails: true });
  assert.notEqual(r.code, 0);
  assert.deepEqual(order, ['osascript', 'open -b com.openai.codex'], 'quit then reopened');
  assert.match(r.stderr, /reopening ChatGPT on its existing login/);
});

test('N4 ai-desktop codex: success message names the account actually written, not a fresh dry pick', async (t) => {
  if (process.platform !== 'darwin') return t.skip('ai-desktop is macOS-only');
  const { r } = await desktop(t, { writeFails: false, dryAccount: 'DRY-PICK-DIFFERENT' });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /relaunched on acct1/);
  assert.doesNotMatch(r.stdout, /DRY-PICK-DIFFERENT/);
});

// ── binary resolution ──
function fakeBins(sb, specs) {
  const d = join(sb.dir, 'cands'); mkdirSync(d, { recursive: true });
  const vlog = join(sb.dir, 'version.log');
  const paths = specs.map(([name, ver, sub]) => {
    const dd = sub ? join(d, sub) : d; mkdirSync(dd, { recursive: true });
    const p = join(dd, name);
    writeFileSync(p, `#!/bin/bash\nif [ "$1" = --version ]; then echo "v:${name}" >> "${vlog}"; echo "codex-cli ${ver}"; exit 0; fi\nprintf 'RUN rt=\\nARG %s\\n' "${name}" >> "$FAKE_LOG"\n`);
    chmodSync(p, 0o755); return p;
  });
  return { paths, versionCalls: () => (existsSync(vlog) ? readFileSync(vlog, 'utf8').trim().split('\n').filter(Boolean) : []) };
}
const ranName = (sb) => (existsSync(sb.log) ? /^ARG (.*)$/m.exec(readFileSync(sb.log, 'utf8'))?.[1] : undefined);

test('codex binary: highest --version wins (numeric, not lexical), cmux shims excluded, AIGATE_CODEX_BIN wins, 1h cache keyed by mtimes', async (t) => {
  for (const script of [CODEX_SH, T3_CODEX]) {
    const sb = sandbox(); t.after(sb.cleanup);
    const mock = await startMock(defaultHandler(pick('acct1', 'rt-1'))); t.after(mock.close);
    const fb = fakeBins(sb, [['old', '0.147.0'], ['new', '0.160.1'], ['nine', '0.9.9'], ['shim', '9.9.9', 'cmux-cli-shims']]);
    const env = { AIGATE_URL: mock.url, AIGATE_CODEX_BIN: '', AIGATE_CODEX_CANDIDATES: fb.paths.join(':') };
    const r1 = await run(sb, script, ['x'], env);
    assert.equal(r1.code, 0, `${script}: ${r1.stderr}`);
    assert.equal(ranName(sb), 'new', `${script}: 0.160.1 beats 0.147.0 and 0.9.9; cmux shim ignored`);
    assert.deepEqual(fb.versionCalls().sort(), ['v:new', 'v:nine', 'v:old'], 'shim never probed');
    assert.ok(existsSync(join(sb.home, '.claude', 'aigate', 'codex-bin.cache')), 'decision cached');
    const n = fb.versionCalls().length;
    await run(sb, script, ['y'], env);
    assert.equal(fb.versionCalls().length, n, `${script}: second launch pays no version calls`);
    const future = new Date(Date.now() + 5000);
    utimesSync(fb.paths[0], future, future);
    await run(sb, script, ['z'], env);
    assert.ok(fb.versionCalls().length > n, `${script}: mtime change re-probes`);
    writeFileSync(sb.log, '');
    await run(sb, script, ['w'], { ...env, AIGATE_CODEX_BIN: fb.paths[0] });
    assert.equal(ranName(sb), 'old', `${script}: AIGATE_CODEX_BIN wins`);
  }
});

test('codex binary: the resolver block is byte-identical in aigate-codex.sh, t3-codex.sh and ai', () => {
  const blk = (f) => /# >>> aigate-codex-bin[\s\S]*?# <<< aigate-codex-bin/.exec(readFileSync(join(ROOT, 'clients', f), 'utf8'))?.[0];
  assert.ok(blk('aigate-codex.sh'));
  assert.equal(blk('t3-codex.sh'), blk('aigate-codex.sh'));
  assert.equal(blk('ai'), blk('aigate-codex.sh'));
});

test('E2E note: -p stdin buffering is documented in both wrappers', () => {
  for (const f of ['aigate-run.sh', 'aigate-codex.sh'])
    assert.match(readFileSync(join(ROOT, 'clients', f), 'utf8'), /never-closing stdin pipe waits for EOF here AND in the raw claude\/codex/, f);
});
