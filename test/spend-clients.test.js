// Spend ATTRIBUTION from the client side: the Claude hook posts session→account, the codex
// launcher/keeper leases its CODEX_HOME to an account, and the installer ships + schedules the
// collector. Real scripts, mock aigate, scratch install roots — never the real ~/.claude/aigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { BASH, PATH_ENV, bash32Path } from './helpers/bash32.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = join(ROOT, 'clients');
const PROMPT_HOOK = join(CLIENTS, 'prompt-hook.sh');
const CODEX_SH = join(CLIENTS, 'aigate-codex.sh');
const INSTALL_SH = join(CLIENTS, 'install.sh');
const now = () => Math.floor(Date.now() / 1000);

// ── mock aigate (records every call, answers from a handler) ─────────────────
function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      let body = null; try { body = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
      calls.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body, raw });
      const [status, out] = handler({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), body }) ?? [200, {}];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const leases = (mock) => mock.calls.filter((c) => c.method === 'POST' && c.path === '/api/spend/sessions');
function waitFor(pred, ms = 8000) {
  const t0 = Date.now();
  return new Promise((res) => {
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(true); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); }
    }, 20);
  });
}
const grace = (ms) => new Promise((r) => setTimeout(r, ms));
const sidecar = (dir) => (existsSync(join(dir, 'spend-sessions.jsonl'))
  ? readFileSync(join(dir, 'spend-sessions.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

// ── prompt-hook.sh: the only component that sees session_id AND the account ──
function hookSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'spendhook-'));
  const ag = join(dir, '.claude', 'aigate');
  mkdirSync(ag, { recursive: true });
  return { dir, ag, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runHook(sb, url, account, payload) {
  return new Promise((res, rej) => {
    const child = execFile(BASH, [PROMPT_HOOK], {
      env: { PATH: bash32Path(), HOME: sb.dir, AIGATE_DIR: sb.ag, AIGATE_URL: url, AIGATE_TOKEN: 'tok', AIGATE_ACCOUNT: account },
      timeout: 10_000,
    }, (err) => (err ? rej(err) : res()));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('prompt-hook.sh: posts the claude session→account mapping and appends the same line to the sidecar', async (t) => {
  const sb = hookSandbox(); t.after(sb.cleanup);
  const mock = await startMock(() => [200, {}]); t.after(mock.close);

  await runHook(sb, mock.url, 'acctA', { session_id: '88e73ba2-5a27-4f61-8c0e-5361f28ded00', prompt: 'secret words', cwd: '/tmp', model: 'opus' });
  assert.ok(await waitFor(() => leases(mock).length === 1), 'a /api/spend/sessions POST must arrive');

  const posted = leases(mock)[0];
  assert.equal(posted.body.source, 'claude_code');
  assert.equal(posted.body.session_id, '88e73ba2-5a27-4f61-8c0e-5361f28ded00');
  assert.equal(posted.body.account, 'acctA');
  assert.equal(posted.body.kind, 'claude');
  assert.equal(posted.body.via, 'hook');
  assert.equal(posted.body.scope, '');
  assert.match(posted.body.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(posted.body.host, 'carries the host');
  assert.ok(!/secret words/.test(posted.raw), 'the mapping never carries prompt text');

  const lines = sidecar(sb.ag);
  assert.equal(lines.length, 1, 'exactly one sidecar line');
  assert.deepEqual(lines[0], posted.body, 'sidecar line is byte-identical to the POST body');
  assert.equal(statSync(join(sb.ag, 'spend-sessions.jsonl')).mode & 0o777, 0o600, 'sidecar is 0600');
  // the prompt event still fires: the mapping is additive, not a replacement
  assert.ok(await waitFor(() => mock.calls.some((c) => c.path === '/api/events/prompt')), 'prompt telemetry still posts');
});

test('prompt-hook.sh: no AIGATE_ACCOUNT (bare claude) and no session_id → no mapping, no sidecar', async (t) => {
  const noAcct = hookSandbox(); t.after(noAcct.cleanup);
  const noSid = hookSandbox(); t.after(noSid.cleanup);
  const mock = await startMock(() => [200, {}]); t.after(mock.close);

  await runHook(noAcct, mock.url, '', { session_id: 'abc-123', prompt: 'hi' });
  await runHook(noSid, mock.url, 'acctA', { prompt: 'hi' });        // hook payload without session_id
  await waitFor(() => mock.calls.filter((c) => c.path === '/api/events/prompt').length === 2);
  await grace(300);                                                 // let any (unwanted) POST land

  assert.equal(leases(mock).length, 0, 'never guess an attribution we were not told');
  assert.equal(sidecar(noAcct.ag).length, 0);
  assert.equal(sidecar(noSid.ag).length, 0);
});

test('prompt-hook.sh: still exactly two stdio-detached blocks (zero added turn latency)', () => {
  const src = readFileSync(PROMPT_HOOK, 'utf8');
  assert.equal((src.match(/\/dev\/null 2>&1 <<'PY'/g) || []).length, 2, 'the mapping rides along, it does not add a third block');
  assert.match(src, /\/api\/spend\/sessions/);
  assert.match(src, /spend-sessions\.jsonl/);
});

// ── aigate-codex.sh: leases a CODEX_HOME to the account it put on disk ───────
const FAKE_CODEX = `#!/bin/bash
echo "RUN" >> "$FAKE_LOG"
exit 0
`;
function codexSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'spendcodex-'));
  const home = join(dir, 'home'); const ch = join(dir, 'codexhome'); const ag = join(home, '.claude', 'aigate');
  mkdirSync(ag, { recursive: true }); mkdirSync(ch, { recursive: true });
  const bin = join(dir, 'codex-fake'); writeFileSync(bin, FAKE_CODEX); chmodSync(bin, 0o755);
  return { dir, home, ch, ag, bin, log: join(dir, 'fake.log'), auth: join(ch, 'auth.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function runCodex(sb, args, env = {}) {
  return new Promise((res) => {
    const child = execFile(BASH, [CODEX_SH, ...args], {
      env: { PATH: PATH_ENV, HOME: sb.home, AIGATE_CODEX_HOME: sb.ch, CODEX_HOME: sb.ch, AIGATE_DIR: sb.ag,
        AIGATE_CODEX_BIN: sb.bin, AIGATE_TOKEN: 'tok', FAKE_LOG: sb.log, ...env },
      timeout: 30_000,
    }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
    child.stdin.end('');
  });
}
const pick = (name, rt) => ({
  account: name, kind: 'codex', plan: 'pro',
  auth_json: { auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: `id-${name}`, access_token: `at-${name}`, refresh_token: rt, account_id: `aid-${name}` },
    last_refresh: '2026-10-06T00:00:00Z' },
  token_exp: now() + 3600, five_hour_pct: 7, seven_day_pct: 16,
  five_hour_reset: now() + 3600, seven_day_reset: now() + 3 * 86400,
});

test('aigate-codex.sh --write-only: leases realpath(CODEX_HOME) to the account it wrote', async (t) => {
  const sb = codexSandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => (c.path === '/api/select' ? [200, pick('acct1', 'rt-1')] : [200, { ok: true }]));
  t.after(mock.close);

  const r = await runCodex(sb, ['--write-only'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await waitFor(() => leases(mock).length >= 1), 'a lease must be posted');

  const l = leases(mock)[0].body;
  assert.equal(l.source, 'codex');
  assert.equal(l.session_id, null, 'codex leases carry no session id');
  assert.equal(l.scope, realpathSync(sb.ch), 'scope is the resolved CODEX_HOME');
  assert.equal(l.account, 'acct1');
  assert.equal(l.kind, 'codex');
  assert.equal(l.via, 'ai-codex');
  assert.match(l.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(!leases(mock)[0].raw.includes('rt-1'), 'a lease never carries a token');
  assert.ok(await waitFor(() => sidecar(sb.ag).length >= 1), 'sidecar written too');
  assert.deepEqual(sidecar(sb.ag)[0], l);
  assert.equal(statSync(join(sb.ag, 'spend-sessions.jsonl')).mode & 0o777, 0o600);
});

test('aigate-codex.sh --keep: a login the vault does not know closes the lease with account:""', async (t) => {
  const sb = codexSandbox(); t.after(sb.cleanup);
  const mock = await startMock((c) => (c.path === '/api/codex/auth' ? [404, { error: 'unknown account' }] : [200, { ok: true }]));
  t.after(mock.close);
  writeFileSync(sb.auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-hand', account_id: 'aid-hand' } }));

  const r = await runCodex(sb, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await waitFor(() => leases(mock).length >= 1), 'the keeper must state the lease every tick');

  const l = leases(mock)[0].body;
  assert.equal(l.account, '', 'a hand-rolled codex login is unknown, not the last aigate account');
  assert.equal(l.via, 'keeper');
  assert.equal(l.scope, realpathSync(sb.ch));
  assert.ok(!existsSync(sb.log), 'the keeper never runs codex');
});

test('aigate-codex.sh --keep: an aigate-managed login leases that account by name', async (t) => {
  const sb = codexSandbox(); t.after(sb.cleanup);
  const vault = { account: 'acct2', auth_json: { auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-same', account_id: 'aid-2' } }, last_refresh: '2026-10-06T00:00:00Z' };
  const mock = await startMock((c) => (c.path === '/api/codex/auth' ? [200, vault] : [200, { ok: true }]));
  t.after(mock.close);
  writeFileSync(sb.auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: 'rt-same', account_id: 'aid-2' }, last_refresh: '2026-10-06T00:00:00Z' }));

  const r = await runCodex(sb, ['--keep'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(await waitFor(() => leases(mock).length >= 1));
  assert.equal(leases(mock)[0].body.account, 'acct2');
  assert.equal(leases(mock)[0].body.via, 'keeper');
});

test('aigate-codex.sh: the shared aigate-codex-bin block is untouched', () => {
  const block = (p) => {
    const m = /^# >>> aigate-codex-bin[\s\S]*?^# <<< aigate-codex-bin$/m.exec(readFileSync(p, 'utf8'));
    assert.ok(m, `${p} must still carry the shared block`);
    return m[0];
  };
  assert.equal(block(CODEX_SH), block(join(CLIENTS, 'ai')), 'byte-identical with clients/ai');
});

// ── install.sh: ships + schedules the collector (scratch roots only) ─────────
// SRC is a COPY of clients/ so the collector stub exists here even before WP3 lands,
// and so nothing ever installs from (or into) a real home.
function installSrc(t) {
  const src = mkdtempSync(join(tmpdir(), 'spendsrc-'));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  cpSync(CLIENTS, src, { recursive: true });
  writeFileSync(join(src, 'aigate-spend.js'), '#!/usr/bin/env node\nprocess.exit(0);\n');
  return src;
}
const shim = (dir, name, body) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
// One scratch install root + one scratch source copy; `node` may be a function of the
// shim dir so a test can point NODE_BIN at a fake old node it just created there.
function installer(t, { os, node = () => process.execPath, shims = () => {}, extra = {} }) {
  const src = installSrc(t);
  const dir = mkdtempSync(join(tmpdir(), 'spendinst-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sh = join(dir, 'shim'); mkdirSync(sh, { recursive: true });
  shims(dir, sh);
  const env = { PATH: `${sh}:${PATH_ENV}`, HOME: dir, AIGATE_INSTALL_ROOT: dir, ZDOTDIR: dir,
    AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok', AIGATE_INSTALL_OS: os,
    AIGATE_NODE_BIN: node(sh), AIGATE_NO_LAUNCHD: '1', ...extra };
  const run = () => spawnSync(BASH, [join(src, 'install.sh')], { encoding: 'utf8', env });
  return { dir, sh, src, run, r: run(), ag: join(dir, '.claude', 'aigate') };
}

test('install.sh: installs aigate-spend.js 0755 and writes the launchd agent (macOS shape)', (t) => {
  const i = installer(t, { os: 'Darwin' });
  assert.equal(i.r.status, 0, i.r.stderr);
  const js = join(i.ag, 'aigate-spend.js');
  assert.ok(existsSync(js), 'collector installed');
  assert.equal(statSync(js).mode & 0o777, 0o755);

  const plist = join(i.dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-spend.plist');
  assert.ok(existsSync(plist), 'launchd agent written');
  const x = readFileSync(plist, 'utf8');
  assert.match(x, /<key>Label<\/key><string>ai\.shoemoney\.aigate-spend<\/string>/);
  assert.match(x, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.match(x, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(x.includes(`<string>${process.execPath}</string>`), 'runs the resolved node >= 24');
  assert.ok(x.includes(`<string>${js}</string>`));
  assert.match(x, /spend\.log/);
  if (process.platform === 'darwin') assert.equal(spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' }).status, 0, 'valid plist');
  assert.ok(existsSync(join(i.dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-codex-keeper.plist')), 'the keeper agent still ships');
  assert.equal(i.run().status, 0, 'idempotent');
});

test('install.sh (linux): systemd user timer every 15 min, Persistent, enabled via systemctl', (t) => {
  const i = installer(t, {
    os: 'Linux',
    extra: { AIGATE_TEST_ACTIVATE: '1' },
    shims: (dir, sh) => shim(sh, 'systemctl', `echo "systemctl $*" >> "${dir}/sc.log"; exit 0`),
  });
  assert.equal(i.r.status, 0, i.r.stderr);
  const u = join(i.dir, '.config', 'systemd', 'user');
  const timer = readFileSync(join(u, 'aigate-spend.timer'), 'utf8');
  assert.match(timer, /^OnUnitActiveSec=15min$/m);
  assert.match(timer, /^Persistent=true$/m);
  const svc = readFileSync(join(u, 'aigate-spend.service'), 'utf8');
  assert.ok(svc.includes(`ExecStart=${process.execPath} ${join(i.ag, 'aigate-spend.js')}`), svc);
  assert.match(readFileSync(join(i.dir, 'sc.log'), 'utf8'), /systemctl --user enable --now aigate-spend\.timer/);
});

test('install.sh (linux): no systemd → one idempotent */15 crontab line, keeper and foreign lines kept', (t) => {
  const i = installer(t, {
    os: 'Linux',
    extra: { AIGATE_TEST_ACTIVATE: '1' },
    shims: (dir, sh) => {
      writeFileSync(join(dir, 'cron.txt'), '0 1 * * * /usr/bin/backup\n');
      shim(sh, 'systemctl', 'exit 1');
      shim(sh, 'crontab', `if [ "$1" = "-l" ]; then cat "${dir}/cron.txt"; else cat > "${dir}/cron.txt"; fi`);
    },
  });
  assert.equal(i.r.status, 0, i.r.stderr);
  const cronText = () => readFileSync(join(i.dir, 'cron.txt'), 'utf8');
  const count = () => cronText().split('\n').filter((l) => / # aigate-spend$/.test(l)).length;
  assert.equal(count(), 1);
  assert.match(cronText(), /^\*\/15 \* \* \* \* .*aigate-spend\.js >> .*spend\.log 2>&1 # aigate-spend$/m);
  assert.match(cronText(), /aigate-codex\.sh --keep/, 'the keeper line survives');
  assert.match(cronText(), /0 1 \* \* \* \/usr\/bin\/backup/, 'foreign lines survive');
  assert.equal(i.run().status, 0);
  assert.equal(count(), 1, 'no duplicate on re-run');
});

test('install.sh: node < 24 → collector installed, nothing scheduled, and it says so', (t) => {
  const i = installer(t, {
    os: 'Darwin',
    node: (sh) => join(sh, 'oldnode'),
    shims: (dir, sh) => shim(sh, 'oldnode', 'printf 20'),
  });
  assert.equal(i.r.status, 0, i.r.stderr);
  assert.match(i.r.stderr, /NOTE: spend collector not scheduled — node >= 24 not found/);
  assert.ok(existsSync(join(i.ag, 'aigate-spend.js')), 'the script is still installed');
  assert.ok(!existsSync(join(i.dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-spend.plist')), 'nothing scheduled');
});

test('the three touched scripts still parse on bash 3.2', () => {
  for (const f of [PROMPT_HOOK, CODEX_SH, INSTALL_SH]) {
    const r = spawnSync(BASH, ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
