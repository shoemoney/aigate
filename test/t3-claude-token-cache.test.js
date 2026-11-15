// t3-claude.sh: a select miss must not launch a token-less claude. The last good
// pick is cached 0600 and reused while aigate (or the proxy in front of it) is down.
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
const SCRIPT = join(ROOT, 'clients', 't3-claude.sh');
const DOWN = 'http://127.0.0.1:1';

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 't3claude-'));
  const dir = join(home, '.claude', 'aigate');
  mkdirSync(dir, { recursive: true });
  const fake = join(home, 'fake-claude');
  const log = join(home, 'fake.log');
  writeFileSync(fake, '#!/bin/bash\necho "TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}" >> "$FAKE_LOG"\necho "ACCOUNT=${AIGATE_ACCOUNT:-}" >> "$FAKE_LOG"\n');
  chmodSync(fake, 0o755);
  return {
    home, dir, fake, log,
    lines: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    reset: () => rmSync(log, { force: true }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
function run(sb, url) {
  return new Promise((done) => {
    const p = spawn(BASH, [SCRIPT, '-p', 'hi'], {
      cwd: sb.home,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: PATH_ENV, HOME: sb.home, FAKE_LOG: sb.log, CLAUDE_BIN: sb.fake, AIGATE_URL: url, AIGATE_TOKEN: 'tok' },
    });
    p.on('close', (code) => done(code));
  });
}
function startMock() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ account: 'a@example.com', setup_token: 'sk-ant-oat01-fresh' }));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () =>
    r({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

test('t3-claude.sh: select hit exports the token and caches it 0600', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(); t.after(mock.close);
  assert.equal(await run(sb, mock.url), 0);
  assert.deepEqual(sb.lines(), ['TOKEN=sk-ant-oat01-fresh', 'ACCOUNT=a@example.com']);
  const cache = join(sb.dir, 'last-token');
  assert.equal(readFileSync(cache, 'utf8'), 'sk-ant-oat01-fresh\na@example.com\n');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
});

test('t3-claude.sh: select miss reuses the cached token and logs via=t3code-cache', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await startMock(); t.after(mock.close);
  await run(sb, mock.url);
  sb.reset();
  assert.equal(await run(sb, DOWN), 0);
  assert.deepEqual(sb.lines(), ['TOKEN=sk-ant-oat01-fresh', 'ACCOUNT=a@example.com']);
  const last = readFileSync(join(sb.dir, 'last-select.log'), 'utf8');
  assert.match(last, /ok=0 .*via=t3code-cache/);
  const rows = readFileSync(join(sb.dir, 'last-selects.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.ok, r.via]), [[1, 't3code'], [0, 't3code-cache']]);
});

test('t3-claude.sh: select miss with no cache still launches claude, token-less', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  assert.equal(await run(sb, DOWN), 0);
  assert.deepEqual(sb.lines(), ['TOKEN=', 'ACCOUNT=']);
  assert.ok(!existsSync(join(sb.dir, 'last-token')));
});
