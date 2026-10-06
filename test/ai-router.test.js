// `ai` router + `ai usage` + installer + static hygiene for clients/.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { BASH, bash32Path } from './helpers/bash32.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENTS = join(ROOT, 'clients');
const AI = join(CLIENTS, 'ai');
const now = () => Math.floor(Date.now() / 1000);

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'airouter-'));
  const home = join(dir, 'home'); const ag = join(home, '.claude', 'aigate');
  mkdirSync(ag, { recursive: true }); mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const log = join(dir, 'calls.log');
  const stub = (path, name) => { writeFileSync(path, `#!/bin/bash\n{ echo "${name}"; printf 'ARG %s\\n' "$@"; echo "---"; } >> "${log}"\n`); chmodSync(path, 0o755); };
  for (const n of ['run', 'codex', 'kimi', 'muse']) stub(join(ag, `aigate-${n}.sh`), n);
  const desk = join(dir, 'ai-desktop-stub'); stub(desk, 'desktop');
  stub(join(home, '.local', 'bin', 'muse'), 'muse-cli');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '').split('---\n').filter(Boolean)
    .map((c) => { const l = c.trim().split('\n'); return { who: l[0], args: l.slice(1).map((x) => x.replace(/^ARG /, '')) }; });
  return { dir, home, ag, desk, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ai(sb, args, env = {}) {
  return new Promise((res) => execFile(BASH, [AI, ...args], {
    env: { PATH: bash32Path(`${join(sb.home, '.local', 'bin')}:${process.env.PATH}`), HOME: sb.home, AI_NO_RTK: '1', AI_DESKTOP_BIN: sb.desk,
      AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok', ...env },
    timeout: 20_000,
  }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
}

test('route table: each entry point dispatches to the right wrapper with the right args', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const table = [
    [['hello'], 'run', ['--chrome', 'hello']],
    [['claude', 'hello'], 'run', ['--chrome', 'hello']],
    [['--no-chrome', 'x'], 'run', ['--no-chrome', 'x']],
    [['-p', 'q'], 'run', ['--dangerously-skip-permissions', '--chrome', '-p', 'q']],
    [['--model', 'opus', 'x'], 'run', ['--chrome', '--model', 'opus', 'x']],
    [['codex', '-p', 'q'], 'codex', ['-p', 'q']],
    [['gpt', 'q'], 'codex', ['q']],
    [['--model', 'gpt', 'q'], 'codex', ['q']],
    [['-m', 'sol', 'q'], 'codex', ['q']],
    [['--model=gpt-5.5', 'q'], 'codex', ['-m', 'gpt-5.5', 'q']],
    [['kimi', 'q'], 'kimi', ['q']],
    [['--model', 'k3', 'q'], 'kimi', ['q']],
    [['--model=kimi-for-coding', 'q'], 'kimi', ['q']],
    [['muse', 'q'], 'muse', ['q']],
    [['--model', 'muse-spark', 'q'], 'muse', ['q']],
  ];
  for (const [argv, who, expect] of table) {
    const before = sb.calls().length;
    const r = await ai(sb, argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    const c = sb.calls();
    assert.equal(c.length, before + 1, `${argv.join(' ')} ran exactly one wrapper`);
    assert.equal(c[before].who, who, argv.join(' '));
    assert.deepEqual(c[before].args, expect, argv.join(' '));
  }
});

test('ai codex adopt → aigate-codex.sh --adopt; ai desktop → ai-desktop; ai muse cli → muse binary', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  await ai(sb, ['codex', 'adopt']);
  await ai(sb, ['desktop', 'codex']);
  await ai(sb, ['muse', 'cli', 'exec', 'hi']);
  await ai(sb, ['muse', 'cli', '--model', 'm1', 'hi']);
  const c = sb.calls();
  assert.deepEqual([c[0].who, c[0].args], ['codex', ['--adopt']]);
  assert.deepEqual([c[1].who, c[1].args], ['desktop', ['codex']]);
  assert.deepEqual([c[2].who, c[2].args], ['muse-cli', ['exec', '--yolo', '--model', 'muse-spark-1.2-contributor', 'hi']]);
  assert.deepEqual(c[3].args, ['--yolo', '--model', 'm1', 'hi'], 'caller --model wins');
});

function plainClaude(sb) {
  const cl = join(sb.home, '.local', 'bin', 'claude');
  writeFileSync(cl, `#!/bin/bash\n{ echo plain; printf 'ARG %s\\n' "$@"; echo ---; } >> "${join(sb.dir, 'calls.log')}"\n`); chmodSync(cl, 0o755);
}

test('guard 1 alone: aigate-run.sh missing (AIGATE_URL set) → plain claude, same posture; no claude → 127', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  rmSync(join(sb.ag, 'aigate-run.sh'));
  const none = await ai(sb, ['hi']);
  assert.equal(none.code, 127);
  assert.deepEqual(sb.calls(), [], 'nothing launched');
  plainClaude(sb);
  const r = await ai(sb, ['hi']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.calls().length, 1);
  assert.equal(sb.calls()[0].who, 'plain');
  assert.deepEqual(sb.calls()[0].args, ['--dangerously-skip-permissions', '--chrome', 'hi']);
});

test('guard 2 alone: aigate-run.sh present but AIGATE_URL blank → plain claude, wrapper NOT run; no claude → 127', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const bare = { AIGATE_URL: '' };
  const none = await ai(sb, ['hi'], bare);
  assert.equal(none.code, 127);
  assert.deepEqual(sb.calls(), [], 'wrapper must not run without AIGATE_URL');
  plainClaude(sb);
  const r = await ai(sb, ['hi'], bare);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(sb.calls().length, 1);
  assert.equal(sb.calls()[0].who, 'plain', 'plain claude, not the aigate-run stub');
  assert.deepEqual(sb.calls()[0].args, ['--dangerously-skip-permissions', '--chrome', 'hi']);
});

test('env file is sourced and CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS is unset', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeFileSync(join(sb.ag, 'aigate-run.sh'), `#!/bin/bash\necho "URL=$AIGATE_URL TEAMS=\${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS-unset}" > "${join(sb.dir, 'env.out')}"\n`);
  writeFileSync(join(sb.ag, 'env'), 'AIGATE_URL=http://from-envfile\nAIGATE_TOKEN=t\n');
  await ai(sb, ['hi'], { AIGATE_URL: '', AIGATE_TOKEN: '', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' });
  assert.equal(readFileSync(join(sb.dir, 'env.out'), 'utf8').trim(), 'URL=http://from-envfile TEAMS=unset');
});

function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization });
    const [st, body] = handler(u);
    res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}
const ACCTS = [
  { account: 'shoemoney', label: 'main', plan: 'max', five_hour_pct: 7, seven_day_pct: 16, five_hour_reset: now() + 7200, seven_day_reset: now() + 3 * 86400 + 4 * 3600 + 300, usage_age_s: 60, disabled: false, reauth_needed: false, parked: false },
  { account: 'work', label: 'work@x.com', plan: 'pro', five_hour_pct: 92, seven_day_pct: 70, five_hour_reset: now() + 600, seven_day_reset: now() + 86400, usage_age_s: 60, parked: true },
  { account: 'old', kind: 'claude', plan: 'pro', five_hour_pct: 10, seven_day_pct: 10, usage_age_s: 4000, reauth_needed: true },
  { account: 'cx1', kind: 'codex', label: 'a@b.com', plan: 'plus', five_hour_pct: null, seven_day_pct: 41, seven_day_reset: now() + 2 * 86400, usage_age_s: 30 },
  { account: 'cx2', kind: 'codex', label: 'c@d.com', plan: 'pro', five_hour_pct: 12, seven_day_pct: 5, five_hour_reset: now() + 3600, seven_day_reset: now() + 5 * 86400, usage_age_s: 30, disabled: true },
];

test('ai usage: table grouped Claude/Codex, ★ on each dry pick, flags, countdowns, no secrets', async (t) => {
  const mock = await startMock((u) => {
    if (u.pathname === '/api/accounts') return [200, ACCTS];
    if (u.pathname === '/api/select') return [200, u.searchParams.get('kind') === 'codex' ? { account: 'cx1', kind: 'codex' } : { account: 'shoemoney' }];
    return [404, {}];
  }); t.after(mock.close);
  const sb = sandbox(); t.after(sb.cleanup);
  const r = await ai(sb, ['usage'], { AIGATE_URL: mock.url });
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout;
  assert.ok(out.indexOf('Claude') < out.indexOf('Codex'));
  const line = (name) => out.split('\n').find((l) => l.includes(name));
  assert.match(line('shoemoney'), /★/); assert.ok(!/★/.test(line('work')));
  assert.match(line('cx1'), /★/); assert.ok(!/★/.test(line('cx2')));
  assert.match(line('shoemoney'), /5h .* 7%.*resets in 1h\d+m|5h .* 7%.*resets in 2h0m/);
  assert.match(line('shoemoney'), /7d .* 16% resets in 3d4h/);
  assert.match(line('work'), /parked/); assert.match(line('old'), /re-auth/); assert.match(line('old'), /stale 66m/);
  assert.match(line('cx2'), /off/);
  assert.ok(!/5h/.test(line('cx1')), 'codex without a 5h reset shows no 5h column');
  assert.match(line('cx2'), /5h/);
  assert.ok(!/\x1b\[/.test(out), 'no colors when stdout is not a TTY');
  assert.ok(mock.calls.every((c) => c.auth === 'Bearer tok'));
  assert.ok(mock.calls.some((c) => c.path === '/api/select' && c.q.kind === 'codex' && c.q.dry === '1'));
  assert.ok(mock.calls.some((c) => c.path === '/api/select' && !c.q.kind && c.q.dry === '1'));
  assert.ok(!r.stdout.includes('tok'));
});

test('ai usage --json: raw combined JSON', async (t) => {
  const mock = await startMock((u) => (u.pathname === '/api/accounts' ? [200, ACCTS]
    : u.pathname === '/api/select' ? (u.searchParams.get('kind') === 'codex' ? [200, { account: 'cx1' }] : [503, { error: 'none', accounts: 3 }]) : [404, {}]));
  t.after(mock.close);
  const sb = sandbox(); t.after(sb.cleanup);
  const r = await ai(sb, ['usage', '--json'], { AIGATE_URL: mock.url });
  const j = JSON.parse(r.stdout);
  assert.equal(j.accounts.length, ACCTS.length);
  assert.equal(j.next.codex.account, 'cx1'); assert.equal(j.next.claude, null);
});

test('ai usage: unreachable server fails loud', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const r = await ai(sb, ['usage'], { AIGATE_URL: 'http://127.0.0.1:1' });
  assert.notEqual(r.code, 0); assert.match(r.stderr, /cannot read/);
});

test('install.sh into a scratch root: ai, ai-desktop, wrappers, t3 symlinks; retires aigate-gpt.sh; old cc handled', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'inst-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, '.local', 'bin'); const ag = join(dir, '.claude', 'aigate');
  mkdirSync(bin, { recursive: true }); mkdirSync(ag, { recursive: true });
  writeFileSync(join(ag, 'aigate-gpt.sh'), '#!/bin/bash\n# old\n');
  writeFileSync(join(bin, 'cc'), '#!/usr/bin/env bash\n# cc — run claude through aigate (account picked by the warden)\n');
  const env = { PATH: bash32Path(), HOME: dir, AIGATE_INSTALL_ROOT: dir, AIGATE_NO_LAUNCHD: '1', AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok', ZDOTDIR: dir };
  const r = spawnSync(BASH, [join(CLIENTS, 'install.sh')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['ai', 'ai-desktop']) assert.ok(existsSync(join(bin, f)), f);
  for (const f of ['aigate-run.sh', 'aigate-codex.sh', 'aigate-kimi.sh', 'aigate-muse.sh', 't3-claude.sh', 't3-codex.sh', 't3-opencode.sh', 't3-anthropic-compat.sh', 'cmux-claude.sh', 'version'])
    assert.ok(existsSync(join(ag, f)), f);
  for (const n of ['kimi', 'muse', 'facebook', 'qwen', 'openrouter', 'aigate']) {
    const p = join(ag, `t3-${n}.sh`);
    assert.ok(lstatSync(p).isSymbolicLink(), p); assert.equal(readlinkSync(p), 't3-anthropic-compat.sh');
  }
  assert.ok(!existsSync(join(ag, 'aigate-gpt.sh')));
  assert.ok(readdirSync(ag).some((f) => f.startsWith('aigate-gpt.sh.bak-removed-')), 'moved, not deleted');
  assert.ok(!existsSync(join(bin, 'cc')), "installer's own old cc removed");
  // a foreign cc is left alone
  writeFileSync(join(bin, 'cc'), '#!/bin/sh\necho my compiler\n');
  assert.equal(spawnSync(BASH, [join(CLIENTS, 'install.sh')], { env, encoding: 'utf8' }).status, 0);
  assert.match(readFileSync(join(bin, 'cc'), 'utf8'), /my compiler/);
  const st = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  const cmds = (st.hooks?.UserPromptSubmit ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  assert.deepEqual(cmds, ['bash ~/.claude/aigate/prompt-hook.sh'], 'UserPromptSubmit hook wired exactly once (idempotent across 2 installs)');
  assert.deepEqual(st.statusLine, { type: 'command', command: 'bash ~/.claude/aigate/statusline-feed.sh' });
  if (process.platform === 'darwin') {
    const plist = readFileSync(join(dir, 'Library', 'LaunchAgents', 'ai.shoemoney.aigate-codex-keeper.plist'), 'utf8');
    assert.match(plist, /<key>Label<\/key><string>ai\.shoemoney\.aigate-codex-keeper<\/string>/);
    assert.match(plist, new RegExp(`<string>/bin/bash</string>\\s*<string>${ag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/aigate-codex\\.sh</string>\\s*<string>--keep</string>`));
    assert.match(plist, /<key>StartInterval<\/key><integer>3600<\/integer>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  }
});

// ── static hygiene ────────────────────────────────────────────────────────────
const scripts = readdirSync(CLIENTS).filter((f) => !f.includes('.bak')).map((f) => join(CLIENTS, f));

test('clients/ has no CLIProxyAPI references', () => {
  const bad = [];
  for (const f of scripts) {
    const s = readFileSync(f, 'utf8');
    if (/8317|\/\.claude\/cpa|CC_CPA|CPA_API_KEY|\bCPA_|\/v1\/models/.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, []);
  assert.ok(!existsSync(join(CLIENTS, 'aigate-gpt.sh')), 'aigate-gpt.sh must not live in the repo');
});

test('every clients/ shell script passes bash -n', () => {
  for (const f of scripts) {
    const first = readFileSync(f, 'utf8').split('\n')[0];
    if (!/bash|sh/.test(first)) continue;
    const r = spawnSync(BASH, ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('shellcheck (errors only) on the new/changed scripts, if installed', (t) => {
  const has = spawnSync('shellcheck', ['--version']);
  if (has.error) return t.skip('shellcheck not installed');
  const files = ['ai', 'ai-desktop', 'aigate-codex.sh', 't3-codex.sh', 'install.sh', 'aigate-run.sh'].map((f) => join(CLIENTS, f));
  const r = spawnSync('shellcheck', ['-S', 'error', '-s', 'bash', ...files], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
});

test('bash 3.2 hygiene: no associative arrays / mapfile in new scripts', () => {
  for (const f of ['ai', 'ai-desktop', 'aigate-codex.sh', 't3-codex.sh']) {
    const s = readFileSync(join(CLIENTS, f), 'utf8');
    assert.ok(!/declare -A|\bmapfile\b|\breadarray\b/.test(s), f);
  }
});

test('bash 3.2: every "${arr[@]}" in clients/ is guarded (${a[@]+"${a[@]}"}) or provably non-empty', () => {
  // arrays non-empty at their expansion site: AUTH (always -H @file), filtered (length-checked)
  const allow = new Set(['AUTH', 'filtered']);
  const bad = [];
  for (const f of scripts) {
    const src = readFileSync(f, 'utf8');
    if (!/bash|sh/.test(src.split('\n')[0])) continue;
    src.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const m of line.matchAll(/"\$\{(\w+)\[@\]\}"/g)) {
        const pre = line.slice(0, m.index);
        if (pre.endsWith(`\${${m[1]}[@]+`) || allow.has(m[1])) continue;
        bad.push(`${f}:${i + 1} ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});
