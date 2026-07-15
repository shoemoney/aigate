// Client-side switching behavior: continuous (per-turn) account re-evaluation and
// automatic (no-prompt) switching. Exercises the shell clients directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const AIGATE_RUN = join(ROOT, 'clients', 'aigate-run.sh');
const PROMPT_HOOK = join(ROOT, 'clients', 'prompt-hook.sh');

// ── static guards: switch is automatic, hook re-evaluates per turn, work is detached ──
test('aigate-run.sh: interactive switch auto-continues — no [Y/n] prompt remains', () => {
  const src = readFileSync(AIGATE_RUN, 'utf8');
  assert.ok(!/resume this conversation on another account/i.test(src), 'the interactive [Y/n] resume prompt must be gone');
  assert.ok(!/\bread -r ans\b/.test(src), 'no interactive read left in the account-switch path');
  assert.match(src, /auto-switch/i, 'auto-switch behavior should be present/documented');
});

test('prompt-hook.sh: re-evaluates the current account every turn, parks on exhaustion, never blocks', () => {
  const src = readFileSync(PROMPT_HOOK, 'utf8');
  assert.match(src, /\/api\/accounts/, 'checks the current account headroom each turn');
  assert.match(src, /\/api\/events\/limit/, 'parks the exhausted account server-side');
  assert.match(src, /<\s*85/, 'gates the expensive live refresh behind the 85% threshold');
  // both backgrounded pythons must detach stdio so a hook runner that waits on stdio-EOF
  // can't be blocked by the HTTP calls (else up to ~24s of turn latency).
  const detached = src.match(/\/dev\/null 2>&1 <<'PY'/g) || [];
  assert.equal(detached.length, 2, 'both backgrounded blocks must redirect stdio to /dev/null');
});

// ── behavioral: drive prompt-hook.sh against a mock aigate ──────────────────────
function startMock(handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url.split('?')[0], body });
      const h = handlers[`${req.method} ${req.url.split('?')[0]}`] ?? {};
      res.writeHead(h.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(h.body ?? {}));
    });
  });
  return new Promise((res) =>
    server.listen(0, '127.0.0.1', () => res({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

// The hook detaches its backgrounded work (>/dev/null 2>&1), so it returns almost
// immediately — the HTTP calls land shortly AFTER. Poll the mock, don't assume ordering.
function runHook(url, account, payload) {
  return new Promise((res, rej) => {
    const child = execFile('bash', [PROMPT_HOOK], {
      env: { ...process.env, AIGATE_URL: url, AIGATE_TOKEN: 'test-token', AIGATE_ACCOUNT: account },
      timeout: 10_000,
    }, (err) => (err ? rej(err) : res()));
    child.stdin.end(JSON.stringify(payload));
  });
}

const hit = (calls, path, method = 'POST') => calls.some((c) => c.path === path && c.method === method);
function waitFor(pred, ms = 8000) {
  const start = Date.now();
  return new Promise((res) => {
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(true); }
      else if (Date.now() - start > ms) { clearInterval(iv); res(false); }
    }, 20);
  });
}
const grace = (ms) => new Promise((r) => setTimeout(r, ms));

test('prompt-hook.sh: parks the CURRENT account when it is exhausted', async (t) => {
  const mock = await startMock({
    'GET /api/accounts': { body: [{ account: 'acctA', five_hour_pct: 95, seven_day_pct: 40 }] },
    'POST /api/accounts/acctA/refresh': { body: { maxed: '1' } },
    'POST /api/events/limit': { body: {} },
    'POST /api/events/prompt': { body: {} },
  });
  t.after(() => mock.server.close());

  await runHook(mock.url, 'acctA', { prompt: 'hello', cwd: '/tmp' });
  const parked = await waitFor(() => hit(mock.calls, '/api/events/limit'));

  assert.ok(parked, 'must park the exhausted account via /api/events/limit');
  assert.ok(hit(mock.calls, '/api/accounts', 'GET'), 'must re-check current headroom');
  assert.ok(hit(mock.calls, '/api/accounts/acctA/refresh'), 'must confirm via a live refresh at ≥85%');
  assert.match(mock.calls.find((c) => c.path === '/api/events/limit').body, /acctA/, 'parks the account that is actually exhausted');
});

test('prompt-hook.sh: leaves an account with headroom alone (no park, no costly refresh)', async (t) => {
  const mock = await startMock({
    'GET /api/accounts': { body: [{ account: 'acctB', five_hour_pct: 12, seven_day_pct: 20 }] },
    'POST /api/events/prompt': { body: {} },
  });
  t.after(() => mock.server.close());

  await runHook(mock.url, 'acctB', { prompt: 'hello', cwd: '/tmp' });
  await waitFor(() => hit(mock.calls, '/api/accounts', 'GET')); // the per-turn check ran
  await grace(300);                                            // let any (unwanted) follow-up land

  assert.ok(!hit(mock.calls, '/api/events/limit'), 'must NOT park an account that still has headroom');
  assert.ok(!mock.calls.some((c) => c.path.includes('/refresh')), 'must NOT pay for a live refresh under 85%');
});

test('prompt-hook.sh: non-cc session (no AIGATE_ACCOUNT) never parks anything', async (t) => {
  const mock = await startMock({
    'GET /api/accounts': { body: [{ account: 'acctA', five_hour_pct: 99, seven_day_pct: 99 }] },
    'POST /api/events/prompt': { body: {} },
  });
  t.after(() => mock.server.close());

  await runHook(mock.url, '', { prompt: 'hello', cwd: '/tmp' }); // empty AIGATE_ACCOUNT
  await waitFor(() => hit(mock.calls, '/api/events/prompt'));    // hook still fired (telemetry)
  await grace(300);

  assert.ok(!hit(mock.calls, '/api/accounts', 'GET'), 'no account set → skip the per-turn check entirely');
  assert.ok(!hit(mock.calls, '/api/events/limit'), 'fail-open: no account set → no selection side effects');
});
