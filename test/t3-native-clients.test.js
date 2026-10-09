// t3-qwen-code.sh / t3-muse-fb.sh: T3 Code runs the REAL qwen (ACP registry driver) and the
// REAL muse (native Muse driver) through these launchers. Real bash scripts, fake CLIs, mock aigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { BASH, PATH_ENV } from './helpers/bash32.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QWEN = join(ROOT, 'clients', 't3-qwen-code.sh');
const MUSE_FB = join(ROOT, 'clients', 't3-muse-fb.sh');

// stands in for qwen / muse: records argv plus the env the launchers are responsible for
const FAKE = `#!/bin/bash
printf 'ARG %s\\n' "$@" >> "$FAKE_LOG"
echo "OPENAI_API_KEY=\${OPENAI_API_KEY:-}" >> "$FAKE_LOG"
echo "OPENAI_BASE_URL=\${OPENAI_BASE_URL:-}" >> "$FAKE_LOG"
echo "META_API_KEY=\${META_API_KEY:-}" >> "$FAKE_LOG"
`;

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 't3native-'));
  mkdirSync(join(home, '.claude', 'aigate'), { recursive: true });
  const fake = join(home, 'fake-cli');
  writeFileSync(fake, FAKE); chmodSync(fake, 0o755);
  const log = join(home, 'fake.log');
  return {
    home, fake, log,
    lines: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    args: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('ARG ')) : []),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function run(sb, script, args, env = {}) {
  return new Promise((done) => {
    const p = spawn(BASH, [script, ...args], {
      cwd: sb.home,
      env: { PATH: PATH_ENV, HOME: sb.home, FAKE_LOG: sb.log, QWEN_BIN: sb.fake, MUSE_BIN: sb.fake, ...env },
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => done({ code, stderr }));
  });
}

function startMock(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization });
    const [status, body] = handler(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test('t3-qwen-code.sh: exports ~/.qwen/.env, then execs the real qwen with T3 args untouched', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  mkdirSync(join(sb.home, '.qwen'));
  writeFileSync(join(sb.home, '.qwen', '.env'), 'OPENAI_API_KEY=sk-home\nOPENAI_BASE_URL=https://dashscope.example/v1\n');
  const r = await run(sb, QWEN, ['--acp', '--experimental-skills'], { OPENAI_API_KEY: 'sk-inherited' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sb.args(), ['ARG --acp', 'ARG --experimental-skills']);
  // exported, so qwen's own dotenv loader (first .env walking up from cwd, never overriding
  // set vars) can't swap in a project's .env key
  assert.ok(sb.lines().includes('OPENAI_API_KEY=sk-home'));
  assert.ok(sb.lines().includes('OPENAI_BASE_URL=https://dashscope.example/v1'));
});

test('t3-qwen-code.sh: no ~/.qwen/.env still runs the real qwen', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const r = await run(sb, QWEN, ['--acp']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sb.args(), ['ARG --acp']);
});

test('t3-muse-fb.sh: META_API_KEY from the vault meta key, cached 0600, muse execs with args untouched', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock((url) => (url === '/api/keys/meta' ? [200, { key: 'meta-k1' }] : [404, {}])); t.after(mock.close);
  const r = await run(sb, MUSE_FB, ['serve', '--trust-workspace'], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mock.calls, [{ path: '/api/keys/meta', auth: 'Bearer tok' }]);
  assert.deepEqual(sb.args(), ['ARG serve', 'ARG --trust-workspace']);
  assert.ok(sb.lines().includes('META_API_KEY=meta-k1'));
  const cache = join(sb.home, '.claude', 'aigate', 'meta-key');
  assert.equal(readFileSync(cache, 'utf8'), 'meta-k1');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
});

test('t3-muse-fb.sh: vault down → cached key; no cache → exit 1 and muse never starts', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const down = { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok' };
  let r = await run(sb, MUSE_FB, ['serve'], down);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /add-key meta/);
  // keyless muse would quietly fall back to the `muse login` OAuth account
  assert.deepEqual(sb.lines(), []);
  writeFileSync(join(sb.home, '.claude', 'aigate', 'meta-key'), 'meta-cached');
  r = await run(sb, MUSE_FB, ['serve'], down);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /cached meta key/);
  assert.ok(sb.lines().includes('META_API_KEY=meta-cached'));
});

test('t3-muse-fb.sh: --version (T3 health probe) never waits on the vault', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(() => [200, { key: 'unused' }]); t.after(mock.close);
  const r = await run(sb, MUSE_FB, ['--version'], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(mock.calls.length, 0);
  assert.deepEqual(sb.args(), ['ARG --version']);
});
