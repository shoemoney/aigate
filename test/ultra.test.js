// aigate-ultra.sh: qwen-ultra / kimi-ultra / amber-ultra run the real qwen, kimi and opencode
// CLIs on the Qwen token plan. One script dispatched on its name. Fake CLIs, mock aigate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { BASH, PATH_ENV } from './helpers/bash32.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ULTRA = join(ROOT, 'clients', 'aigate-ultra.sh');
const TP_URL = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

// stands in for qwen / kimi / opencode: records argv and the env the dispatcher sets
const FAKE = `#!/bin/bash
printf 'ARG %s\\n' "$@" >> "$FAKE_LOG"
for v in OPENAI_API_KEY OPENAI_BASE_URL QWEN_TOKENPLAN_KEY KIMI_CODE_HOME OPENCODE_CONFIG_CONTENT; do
  printf '%s=%s\\n' "$v" "$(printenv "$v")" >> "$FAKE_LOG"
done
`;

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'ultra-'));
  mkdirSync(join(home, '.claude', 'aigate'), { recursive: true });
  const fake = join(home, 'fake-cli');
  writeFileSync(fake, FAKE); chmodSync(fake, 0o755);
  const bin = join(home, 'bin'); mkdirSync(bin);
  for (const n of ['qwen-ultra', 'kimi-ultra', 'amber-ultra', 'mystery-ultra']) symlinkSync(ULTRA, join(bin, n));
  const log = join(home, 'fake.log');
  const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return {
    home, fake, bin, log, lines,
    args: () => lines().filter((l) => l.startsWith('ARG ')),
    env: (name) => lines().find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function run(sb, name, args, env = {}) {
  return new Promise((done) => {
    const p = spawn(BASH, [join(sb.bin, name), ...args], {
      cwd: sb.home,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: PATH_ENV, HOME: sb.home, FAKE_LOG: sb.log, QWEN_BIN: sb.fake, KIMI_BIN: sb.fake, OPENCODE_BIN: sb.fake, ...env },
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

const vault = () => startMock((url) => (url === '/api/keys/qwen-tokenplan' ? [200, { key: 'sk-sp-test' }] : [404, {}]));

test('qwen-ultra: real qwen on the token plan, yolo like the zsh fn, key cached 0600', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await vault(); t.after(mock.close);
  const r = await run(sb, 'qwen-ultra', ['-p', 'hi'], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok', OPENAI_BASE_URL: 'https://wrong.example' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(mock.calls, [{ path: '/api/keys/qwen-tokenplan', auth: 'Bearer tok' }]);
  assert.deepEqual(sb.args(), ['ARG --approval-mode', 'ARG yolo', 'ARG -p', 'ARG hi']);
  assert.equal(sb.env('OPENAI_API_KEY'), 'sk-sp-test');
  assert.equal(sb.env('OPENAI_BASE_URL'), TP_URL);
  const cache = join(sb.home, '.claude', 'aigate', 'qwen-tokenplan-key');
  assert.equal(readFileSync(cache, 'utf8'), 'sk-sp-test');
  assert.equal(statSync(cache).mode & 0o777, 0o600);
});

test('qwen-ultra: management subcommands get no yolo flag', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  writeFileSync(join(sb.home, '.claude', 'aigate', 'qwen-tokenplan-key'), 'sk-sp-cached');
  const r = await run(sb, 'qwen-ultra', ['mcp', 'list']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(sb.args(), ['ARG mcp', 'ARG list']);
});

test('kimi-ultra: own KIMI_CODE_HOME, token-plan provider reads the key from env, never from the file', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await vault(); t.after(mock.close);
  const r = await run(sb, 'kimi-ultra', ['-p', 'hi'], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok' });
  assert.equal(r.code, 0, r.stderr);
  const home = join(sb.home, '.kimi-code-ultra');
  assert.equal(sb.env('KIMI_CODE_HOME'), home);
  assert.equal(sb.env('QWEN_TOKENPLAN_KEY'), 'sk-sp-test');
  assert.deepEqual(sb.args(), ['ARG -p', 'ARG hi']);
  const cfg = readFileSync(join(home, 'config.toml'), 'utf8');
  assert.match(cfg, /default_model = "tokenplan\/qwen3\.8-max"/);
  assert.match(cfg, /api_key_env = "QWEN_TOKENPLAN_KEY"/);
  assert.ok(cfg.includes(`base_url = "${TP_URL}"`));
  assert.ok(!cfg.includes('sk-sp-test'), 'key must not be written into config.toml');
  assert.match(cfg, /\[models\."tokenplan\/qwen3\.8-max"\][^[]*max_context_size = 262144/);
});

test('amber-ultra: opencode sees ONLY the Amber Sinclair model, on the token plan, with room for the global context', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const mock = await vault(); t.after(mock.close);
  let r = await run(sb, 'amber-ultra', [], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok' });
  assert.equal(r.code, 0, r.stderr);
  let cfg = JSON.parse(sb.env('OPENCODE_CONFIG_CONTENT'));
  assert.deepEqual(cfg.enabled_providers, ['tokenplan']);
  const tp = cfg.provider.tokenplan;
  assert.equal(tp.options.baseURL, TP_URL);
  assert.equal(tp.options.apiKey, '{env:QWEN_TOKENPLAN_KEY}', 'key stays in env, not in the config text');
  assert.deepEqual(Object.keys(tp.models), ['AmberSinclair']);
  assert.equal(tp.models.AmberSinclair.id, 'qwen3.8-max');
  // global skills + MCP tools put turn one at ~128K; below that opencode compacts every reply
  assert.ok(tp.models.AmberSinclair.limit.context >= 200000);
  assert.equal(cfg.default_agent, 'amber');
  for (const a of ['amber', 'build', 'plan', 'grok']) assert.equal(cfg.agent[a].model, 'tokenplan/AmberSinclair', a);
  assert.equal(cfg.agent.amber.prompt, `{file:${join(sb.home, '.config', 'opencode', 'prompts', 'grok.md')}}`);
  rmSync(sb.log);
  r = await run(sb, 'amber-ultra', ['run', 'hi'], { AIGATE_URL: mock.url, AIGATE_TOKEN: 'tok', AMBER_MODEL: 'qwen3.7-plus' });
  cfg = JSON.parse(sb.env('OPENCODE_CONFIG_CONTENT'));
  assert.equal(cfg.provider.tokenplan.models.AmberSinclair.id, 'qwen3.7-plus');
  assert.deepEqual(sb.args(), ['ARG run', 'ARG hi']);
});

test('ultra: vault down → cached key; no cache → exit 1 and no CLI starts; unknown name → 64', async (t) => {
  const sb = sandbox(); t.after(sb.cleanup);
  const down = { AIGATE_URL: 'http://127.0.0.1:1', AIGATE_TOKEN: 'tok' };
  let r = await run(sb, 'qwen-ultra', ['-p', 'hi'], down);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /add-key qwen-tokenplan/);
  assert.deepEqual(sb.lines(), []);
  writeFileSync(join(sb.home, '.claude', 'aigate', 'qwen-tokenplan-key'), 'sk-sp-cached');
  r = await run(sb, 'kimi-ultra', [], down);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /cached qwen-tokenplan key/);
  assert.equal(sb.env('QWEN_TOKENPLAN_KEY'), 'sk-sp-cached');
  r = await run(sb, 'mystery-ultra', [], down);
  assert.equal(r.code, 64);
});
