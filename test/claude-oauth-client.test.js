import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BASH } from './helpers/bash32.js';
const exec = promisify(execFile);

for (const mode of ['0', '1']) for (const print of [false, true]) test(`client Code Mode=${mode}, print=${print}: requests full only when enabled and exports the right token`, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'aigate-claude-full-client-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.claude'));
  // Prove the existing MCP-preserving strip still works against a scratch home.
  writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'shadow' }, mcpOAuth: { keep: true } }));
  const binary = join(home, 'claude');
  writeFileSync(binary, '#!/bin/bash\nprintf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"\n', { mode: 0o700 });
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/select') ? { account: 'one', setup_token: 'setup-fixture', oauth_access_token: 'full-fixture' } : []));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const running = exec(BASH, [resolve('clients/aigate-run.sh'), ...(print ? ['-p', 'hello'] : [])], {
    env: { ...process.env, HOME: home, AIGATE_URL: `http://127.0.0.1:${server.address().port}`, AIGATE_TOKEN: 'fixture', AIGATE_CLAUDE_BIN: binary, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: mode }, timeout: 10000,
  });
  running.child.stdin.end();
  const result = await running;
  assert.equal(result.stdout.trim(), mode === '1' ? 'full-fixture' : 'setup-fixture');
  const url = new URL(calls.find((u) => u.startsWith('/api/select')), 'http://local');
  assert.equal(url.searchParams.get('full'), mode === '1' ? '1' : null);
  assert.ok(!result.stderr.includes('Code Mode will not start'));
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'))), { mcpOAuth: { keep: true } });
});

test('client missing full login falls back, warns once across retries, and preserves excludes/parking', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'aigate-claude-full-retry-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const binary = join(home, 'claude');
  writeFileSync(binary, '#!/bin/bash\nif [ "$AIGATE_ACCOUNT" = one ]; then echo "usage limit" >&2; exit 1; fi\nprintf "%s\\n" "$CLAUDE_CODE_OAUTH_TOKEN"\n', { mode: 0o700 });
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url); res.setHeader('content-type', 'application/json');
    const two = req.url.includes('exclude=one');
    res.end(JSON.stringify(req.url.startsWith('/api/select') ? { account: two ? 'two' : 'one', setup_token: two ? 'setup-two' : 'setup-one', full_unavailable: 'not_present' } : {}));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const running = exec(BASH, [resolve('clients/aigate-run.sh'), '-p', 'hello'], {
    env: { ...process.env, HOME: home, AIGATE_URL: `http://127.0.0.1:${server.address().port}`, AIGATE_TOKEN: 'fixture', AIGATE_CLAUDE_BIN: binary, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }, timeout: 10000,
  });
  running.child.stdin.end();
  const result = await running;
  assert.equal(result.stdout.trim(), 'setup-two');
  assert.equal(result.stderr.match(/Code Mode will not start/g)?.length, 1);
  assert.ok(calls.includes('/api/events/limit'));
  const picks = calls.filter((u) => u.startsWith('/api/select'));
  assert.equal(picks.length, 2); assert.ok(picks.every((u) => u.includes('full=1'))); assert.ok(picks[1].includes('exclude=one'));
});
