// POST /api/prompt + GET /api/models: feature flag, admin-bearer auth, role -> model map, the
// spawned official-binary contract (argv, env allowlist, closed stdin, private HOME), timeout kill,
// concurrency cap, codex auth.json round trip. The real claude/codex are replaced by fake
// executables (AIGATE_CLAUDE_BIN / AIGATE_CODEX_BIN) that record argv + env and obey a config file.
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { makeVault } from '../src/lib.js';
import { claudeArgs, codexArgs, parseClaude, parseCodex } from '../src/prompt-runner.js';
import { validateModels } from '../src/models.js';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const TMP = mkdtempSync(join(tmpdir(), 'aigate-prompt-test-'));
const DB = join(TMP, `aigate-prompt-${process.pid}.db`);
const RUNS = join(TMP, 'runs');            // AIGATE_PROMPT_TMPDIR: every run dir must be gone after each request
const BIN = join(TMP, 'bin');
const ENC_KEY = crypto.randomBytes(32).toString('hex');
const CANARY = 'canary-' + crypto.randomBytes(6).toString('hex');
mkdirSync(RUNS); mkdirSync(BIN);
process.env.AIGATE_TOKEN = TOKEN;
process.env.AIGATE_ENCRYPTION_KEY = ENC_KEY;
process.env.AIGATE_DB = DB;
process.env.AIGATE_POLL_MS = '0';
process.env.AIGATE_KEY_POLL_MS = '0';
process.env.HOST = '127.0.0.1';
process.env.AIGATE_DASHBOARD_PASSWORD = 'pw-' + crypto.randomBytes(6).toString('hex');
process.env.AIGATE_PROMPT_TMPDIR = RUNS;
process.env.AIGATE_PROMPT_KILL_GRACE_MS = '300';
// secrets that live in the server's environment and must never reach a child
process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-' + CANARY;
process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-auth-' + CANARY;
process.env.ANTHROPIC_BASE_URL = 'http://example.invalid/' + CANARY;
process.env.OPENAI_API_KEY = 'sk-openai-' + CANARY;
process.env.SOME_OTHER_SECRET = CANARY;
delete process.env.AIGATE_ALLOW_CIDR;
delete process.env.AIGATE_TRUST_PROXY;
delete process.env.AIGATE_PROMPT_API;
delete process.env.AIGATE_PROMPT_CONCURRENCY;

const { server, db } = await import('../src/server.js');
const vault = makeVault(Buffer.from(ENC_KEY, 'hex'));
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

// ---- the fake official binaries -----------------------------------------------------------------
// Written to disk as `#!node` scripts. Behaviour comes from <script>.cfg.json, every launch appends
// {argv, env, cwd, ...} to <script>.rec.jsonl.
function fakeMain() {
  const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
  const self = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(self + '.cfg.json', 'utf8'));
  const isCodex = path.basename(self) === 'codex';
  const rec = { argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid, homeMode: fs.statSync(process.env.HOME).mode & 0o777 };
  const authPath = isCodex && process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : null;
  if (authPath && fs.existsSync(authPath)) {
    rec.authMode = fs.statSync(authPath).mode & 0o777;
    rec.authSha = crypto.createHash('sha256').update(fs.readFileSync(authPath)).digest('hex');
    rec.codexHomeMode = fs.statSync(process.env.CODEX_HOME).mode & 0o777;
  }
  const finish = () => {
    if (cfg.grandchild) { rec.grandchild = cp.spawn('sleep', ['60'], { stdio: 'ignore' }).pid; }
    fs.appendFileSync(self + '.rec.jsonl', JSON.stringify(rec) + '\n');
    if (cfg.rewriteAuth && authPath) {
      const a = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (cfg.rewriteAuth === 'rotate') {
        a.tokens.refresh_token = 'rt-rotated-by-fake';
        a.last_refresh = new Date(Date.now() + 60000).toISOString();
        fs.writeFileSync(authPath, JSON.stringify(a));
      } else fs.writeFileSync(authPath, JSON.stringify(a, null, 2) + '\n');   // same tokens, new formatting
    }
    const text = cfg.text || 'pong';
    if (cfg.mode === 'hang') { if (cfg.ignoreTerm) process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
    const done = () => {
      if (cfg.mode === 'fail') { process.stderr.write('boom: something broke\n'); process.exit(2); }
      if (cfg.mode === 'limit') {
        if (isCodex) { console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit" })); process.exit(1); }
        console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|123' })); process.exit(1);
      }
      if (isCodex) {
        console.log('WARN noise line that is not json');
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 0, output_tokens: 4 } }));
      } else {
        console.log('noise line before the result');
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 11, output_tokens: 3 }, modelUsage: { 'claude-fake-9': { outputTokens: 3 } } }));
      }
      process.exit(cfg.exit || 0);
    };
    if (cfg.mode === 'sleep') setTimeout(done, cfg.ms); else done();
  };
  if (cfg.mode === 'stdin') {
    // a stdin that is not closed would leave us waiting here; 3s guard turns that into stdinEof=false
    let eof = false;
    const t = setTimeout(() => { rec.stdinEof = false; finish(); }, 3000);
    process.stdin.on('data', () => {});
    process.stdin.on('end', () => { eof = true; clearTimeout(t); rec.stdinEof = true; finish(); });
    process.stdin.on('error', () => { if (!eof) { clearTimeout(t); rec.stdinEof = true; finish(); } });
  } else finish();
}
const fake = {};
function installFake(name) {
  const f = join(BIN, name);
  writeFileSync(f, `#!${process.execPath}\n(${fakeMain.toString()})();\n`);
  chmodSync(f, 0o755);
  fake[name] = f;
}
const cfgOf = (name, cfg = {}) => writeFileSync(fake[name] + '.cfg.json', JSON.stringify(cfg));
const recsOf = (name) => { try { return readFileSync(fake[name] + '.rec.jsonl', 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const clearRecs = () => { for (const n of ['claude', 'codex']) rmSync(fake[n] + '.rec.jsonl', { force: true }); };

// ---- fixtures ---------------------------------------------------------------------------------
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `${b64u({ alg: 'none' })}.${b64u({ ...payload, jti: crypto.randomBytes(6).toString('hex') })}.sig`;
const now = () => Math.floor(Date.now() / 1000);
const CLAUDE_TOKEN = 'sk-ant-oat01-' + crypto.randomBytes(16).toString('hex');
const CODEX_AUTH = {
  auth_mode: 'chatgpt', OPENAI_API_KEY: null,
  tokens: { id_token: jwt({ email: 'cx@x.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acct-prompt' } }),
    access_token: jwt({ exp: now() + 6 * 86400 }), refresh_token: 'rt-original-' + crypto.randomBytes(6).toString('hex'), account_id: 'acct-prompt' },
  last_refresh: new Date().toISOString(),
};
const addAccount = (body) => fetch(base + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify(body) });
const row = (account) => db.prepare('SELECT * FROM accounts WHERE account=?').get(account);
const stored = (account) => JSON.parse(vault.decrypt(row(account).token_enc));
const prompt = (body, headers = H) => fetch(base + '/api/prompt', { method: 'POST', headers, body: JSON.stringify(body) });
const runDirs = () => readdirSync(RUNS);
const dump = () => JSON.stringify({ a: db.prepare('SELECT * FROM access_log').all(), r: db.prepare('SELECT * FROM request_log').all() });

before(async () => {
  installFake('claude'); installFake('codex');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.AIGATE_CLAUDE_BIN = fake.claude;
  process.env.AIGATE_CODEX_BIN = fake.codex;
  process.env.AIGATE_PROMPT_API = '1';
});
after(() => {
  server.close();
  try { db.close(); } catch { /* already closed */ }
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.AIGATE_PROMPT_API = '1';
  process.env.AIGATE_CLAUDE_BIN = fake.claude;
  process.env.AIGATE_CODEX_BIN = fake.codex;
  delete process.env.AIGATE_PROMPT_CONCURRENCY;
  rmSync(join(TMP, 'models.json'), { force: true });
  db.exec(`DELETE FROM accounts; DELETE FROM access_log; DELETE FROM request_log; DELETE FROM spend_sessions`);
  assert.equal((await addAccount({ account: 'cl1', setup_token: CLAUDE_TOKEN })).status, 200);
  assert.equal((await addAccount({ account: 'cx1', kind: 'codex', auth_json: CODEX_AUTH })).status, 200);
  clearRecs(); cfgOf('claude'); cfgOf('codex');
});

// ---- flag + auth --------------------------------------------------------------------------------
test('flag off: both routes are plain 404s, even with the admin bearer, and nothing is spawned', async () => {
  delete process.env.AIGATE_PROMPT_API;
  const probe = await fetch(base + '/api/definitely-not-a-route', { headers: H });
  const r1 = await prompt({ role: 'docs', prompt: 'hi' });
  const r2 = await fetch(base + '/api/models', { headers: H });
  assert.equal(r1.status, probe.status); assert.equal(r2.status, probe.status);
  assert.equal(probe.status, 404);
  assert.equal(recsOf('claude').length, 0);
  process.env.AIGATE_PROMPT_API = '0';   // only the exact value "1" turns it on
  assert.equal((await prompt({ role: 'docs', prompt: 'hi' })).status, 404);
});

test('auth: no bearer 401, wrong bearer 401, x-api-key and dashboard cookie are not the administrator bearer', async () => {
  const body = JSON.stringify({ role: 'docs', prompt: 'hi' });
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body })).status, 401);
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body, headers: { authorization: 'Bearer nope-not-the-token' } })).status, 401);
  assert.equal((await fetch(base + '/api/models')).status, 401);
  // the header the /v1 proxy path accepts, carrying a VALID token: still not the administrator bearer
  const xk = await fetch(base + '/api/prompt', { method: 'POST', body, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' } });
  assert.equal(xk.status, 401); assert.match((await xk.json()).error, /bearer/);
  // a logged-in dashboard session is authenticated for the vault routes but may not spend subscriptions here
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.AIGATE_DASHBOARD_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/accounts', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body, headers: { cookie, 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(base + '/api/models', { headers: { cookie } })).status, 401);
  assert.equal(recsOf('claude').length, 0);
});

// ---- role -> engine/model/args ------------------------------------------------------------------
test('every claude role runs the official binary with its ALIAS, all tools off, prompt after "--"', async () => {
  const want = { plan: 'fable', orchestrate: 'fable', review: 'opus', code: 'sonnet', docs: 'haiku' };
  for (const [role, alias] of Object.entries(want)) {
    clearRecs();
    const r = await prompt({ role, prompt: '--dangerously-skip-permissions please', system: 'be terse' });
    const j = await r.json();
    assert.equal(r.status, 200, role);
    assert.deepEqual({ ok: j.ok, role: j.role, engine: j.engine, model: j.model, account: j.account, text: j.text }, { ok: true, role, engine: 'claude', model: alias, account: 'cl1', text: 'pong' });
    assert.equal(j.served_model, 'claude-fake-9');
    assert.deepEqual(j.usage, { input_tokens: 11, output_tokens: 3 });
    assert.ok(Number.isInteger(j.duration_ms));
    const [rec] = recsOf('claude');
    assert.equal(recsOf('claude').length, 1);
    assert.deepEqual(rec.argv, claudeArgs({ model: alias, system: 'be terse', prompt: '--dangerously-skip-permissions please' }));
    const a = rec.argv;
    assert.equal(a[a.indexOf('--model') + 1], alias);
    assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(a[a.indexOf('--system-prompt') + 1], 'be terse');
    assert.deepEqual(a.slice(-2), ['--', '--dangerously-skip-permissions please']);   // a flag-shaped prompt stays a prompt
    assert.ok(!a.includes('--dangerously-skip-permissions'));
  }
  assert.equal(recsOf('codex').length, 0);
});

test('role gpt: codex, ALWAYS gpt-6.1-sol with service_tier="priority", read-only sandbox, never an approval bypass', async () => {
  const r = await prompt({ role: 'gpt', prompt: 'hello', system: 'sys' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual({ engine: j.engine, model: j.model, account: j.account, text: j.text, usage: j.usage }, { engine: 'codex', model: 'gpt-6.1-sol', account: 'cx1', text: 'pong', usage: { input_tokens: 21, output_tokens: 4 } });
  const [rec] = recsOf('codex');
  const a = rec.argv;
  assert.equal(a[0], 'exec');
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.equal(a.filter((x) => x === '-m').length, 1);
  assert.equal(a[a.indexOf('-c') + 1], 'service_tier="priority"');
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.ok(a.includes('--json') && a.includes('--skip-git-repo-check'));
  assert.ok(!a.some((x) => /dangerously|full-auto|danger-full-access/.test(x)));
  assert.equal(a[a.length - 2], '--'); assert.equal(a[a.length - 1], 'sys\n\nhello');
  assert.equal(recsOf('claude').length, 0);
});

test('no way to pick another GPT model: raw model/service_tier fields and look-alike roles are refused before anything spawns', async () => {
  for (const extra of [{ model: 'gpt-4o' }, { model: 'gpt-6.1-sol' }, { service_tier: 'flex' }, { engine: 'codex' }, { effort: 'low' }]) {
    const r = await prompt({ role: 'gpt', prompt: 'x', ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match((await r.json()).error, /unknown field/);
  }
  for (const role of ['gpt-5', 'GPT', 'gpt ', 'gpt-4o', 'codex', '__proto__', 'constructor', 'toString']) {
    const r = await prompt({ role, prompt: 'x' });
    assert.equal(r.status, 400, role);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.deepEqual(j.valid_roles.sort(), ['code', 'docs', 'gpt', 'orchestrate', 'plan', 'review']);
  }
  assert.equal(recsOf('codex').length + recsOf('claude').length, 0);
  // the shipped map has exactly one codex entry and it is Sol
  const { roles } = await (await fetch(base + '/api/models', { headers: H })).json();
  const codexRoles = Object.entries(roles).filter(([, v]) => v.engine === 'codex');
  assert.deepEqual(codexRoles, [['gpt', { engine: 'codex', model: 'gpt-6.1-sol', service_tier: 'priority' }]]);
  // and a map that tries to add a second GPT model is not a valid map
  assert.throws(() => validateModels({ roles: { gpt: { engine: 'codex', model: 'gpt-6.1-sol' }, gpt2: { engine: 'codex', model: 'gpt-4o' } } }), /only the role "gpt"/);
  assert.throws(() => validateModels({ roles: { code: { engine: 'codex', model: 'gpt-4o' } } }), /only the role "gpt"/);
  assert.throws(() => validateModels({ roles: { code: { engine: 'claude', model: '--dangerously-skip-permissions' } } }), /bad model/);
});

// ---- child environment ------------------------------------------------------------------------
test('child env is an allowlist: no admin token, encryption key, ANTHROPIC_*, OPENAI_* or AIGATE_*; claude gets only its OAuth token', async () => {
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 200);
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  const [c] = recsOf('claude'), [x] = recsOf('codex');
  const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'CODEX_HOME',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    '__CF_USER_TEXT_ENCODING']);   // the last one is added by macOS itself to every process
  for (const [name, rec] of [['claude', c], ['codex', x]]) {
    const vals = Object.values(rec.env);
    assert.ok(!vals.some((v) => v === TOKEN || v === ENC_KEY || String(v).includes(CANARY) || String(v).includes(TOKEN) || String(v).includes(ENC_KEY)), name + ' leaked a server secret');
    assert.deepEqual(Object.keys(rec.env).filter((k) => !allowed.has(k)), [], name + ' has non-allowlisted env');
    assert.ok(!Object.keys(rec.env).some((k) => /^(ANTHROPIC_|AIGATE_|OPENAI_)/.test(k)));
  }
  assert.equal(c.env.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN);
  assert.equal(x.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(x.env.CODEX_HOME.startsWith(RUNS));
});

test('each run gets a private 0700 dir as HOME and cwd, removed afterwards', async () => {
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  const [rec] = recsOf('claude');
  assert.ok(rec.cwd.startsWith(realpathSync(RUNS) + '/aigate-prompt-'));
  assert.equal(join(realpathSync(dirname(rec.env.HOME)), basename(rec.env.HOME)), rec.cwd);   // HOME and cwd are the same dir (it is gone by now)
  assert.equal(rec.homeMode, 0o700);
  assert.equal(rec.env.TMPDIR, rec.env.HOME);
  assert.deepEqual(runDirs(), []);
});

test('stdin is closed: a binary that reads stdin sees EOF at once instead of hanging', async () => {
  cfgOf('claude', { mode: 'stdin' }); cfgOf('codex', { mode: 'stdin' });
  const t0 = Date.now();
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 200);
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.ok(Date.now() - t0 < 2500, 'stdin looked open');
  assert.equal(recsOf('claude')[0].stdinEof, true);
  assert.equal(recsOf('codex')[0].stdinEof, true);
});

// ---- validation -------------------------------------------------------------------------------
test('request validation: clear 400s, nothing spawned', async () => {
  const bad = async (body, rx) => { const r = await prompt(body); assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80)); const j = await r.json(); assert.equal(j.ok, false); assert.match(j.error, rx); };
  await bad({ prompt: 'x' }, /role/);
  await bad({ role: 7, prompt: 'x' }, /role/);
  await bad({ role: 'docs' }, /prompt/);
  await bad({ role: 'docs', prompt: '' }, /prompt/);
  await bad({ role: 'docs', prompt: 42 }, /prompt/);
  await bad({ role: 'docs', prompt: 'x'.repeat(100001) }, /prompt/);
  await bad({ role: 'docs', prompt: 'x', system: 5 }, /system/);
  await bad({ role: 'docs', prompt: 'x', system: 'y'.repeat(20001) }, /system/);
  await bad({ role: 'docs', prompt: 'x', timeout_s: 4 }, /timeout_s/);
  await bad({ role: 'docs', prompt: 'x', timeout_s: 601 }, /timeout_s/);
  await bad({ role: 'docs', prompt: 'x', timeout_s: '60' }, /timeout_s/);
  await bad({ role: 'docs', prompt: '\u{1F600}'.repeat(40000) }, /bytes/);   // 40k chars but 160KB: would not fit one argv string
  assert.equal(recsOf('claude').length, 0);
  const big = await fetch(base + '/api/prompt', { method: 'POST', headers: H, body: JSON.stringify({ role: 'docs', prompt: 'x'.repeat(1.1e6) }) });
  assert.equal(big.status, 413);
  assert.equal((await prompt({ role: 'docs', prompt: 'x'.repeat(100000), timeout_s: 5 })).status, 200);   // the boundaries themselves are fine
});

test('missing binary: 503 with a clear message, run dir cleaned up', async () => {
  process.env.AIGATE_CLAUDE_BIN = join(TMP, 'nope', 'claude');
  let r = await prompt({ role: 'docs', prompt: 'x' });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /not found/);
  process.env.AIGATE_CLAUDE_BIN = 'definitely-not-an-installed-binary-xyz';
  r = await prompt({ role: 'docs', prompt: 'x' });
  assert.equal(r.status, 503);
  process.env.AIGATE_CODEX_BIN = join(TMP, 'nope', 'codex');
  r = await prompt({ role: 'gpt', prompt: 'x' });
  assert.equal(r.status, 503);
  assert.deepEqual(runDirs(), []);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM spend_sessions WHERE account=''`).get().c, 1);   // codex lease still closed
});

// ---- failure modes ----------------------------------------------------------------------------
test('timeout: 504, the whole process group (child + grandchild, even one that ignores SIGTERM) is really gone, run dir removed', async () => {
  cfgOf('claude', { mode: 'hang', ignoreTerm: true, grandchild: true });
  const t0 = Date.now();
  const r = await prompt({ role: 'docs', prompt: 'x', timeout_s: 5 });
  assert.equal(r.status, 504);
  const dt = Date.now() - t0;
  assert.ok(dt >= 4900 && dt < 9000, `took ${dt}ms`);
  const [rec] = recsOf('claude');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  for (let i = 0; i < 40 && (alive(rec.pid) || alive(rec.grandchild)); i++) await new Promise((s) => setTimeout(s, 50));
  assert.equal(alive(rec.pid), false, 'child survived the timeout');
  assert.equal(alive(rec.grandchild), false, 'grandchild survived the timeout');
  assert.deepEqual(runDirs(), []);
});

test('client disconnect kills the child', async () => {
  cfgOf('claude', { mode: 'hang', grandchild: true });
  const ac = new AbortController();
  const p = prompt({ role: 'docs', prompt: 'x', timeout_s: 60 }, { ...H }).catch(() => {});
  const p2 = fetch(base + '/api/prompt', { method: 'POST', headers: H, body: JSON.stringify({ role: 'docs', prompt: 'x', timeout_s: 60 }), signal: ac.signal }).catch(() => {});
  for (let i = 0; i < 60 && recsOf('claude').length < 2; i++) await new Promise((s) => setTimeout(s, 50));
  assert.equal(recsOf('claude').length, 2);
  ac.abort();
  const [, rec2] = recsOf('claude');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  for (let i = 0; i < 100 && alive(rec2.pid); i++) await new Promise((s) => setTimeout(s, 50));
  assert.equal(alive(rec2.pid), false, 'aborted run still alive');
  assert.equal(alive(recsOf('claude')[0].pid), true, 'the other run was disturbed');
  // clean up the survivor: kill it, then its request finishes (502/…)
  process.kill(recsOf('claude')[0].pid, 'SIGKILL');
  await p; await p2;
  for (const r of recsOf('claude')) { try { process.kill(r.grandchild, 'SIGKILL'); } catch { /* gone */ } }
  for (let i = 0; i < 40 && runDirs().length; i++) await new Promise((s) => setTimeout(s, 50));
  assert.deepEqual(runDirs(), []);
});

test('binary failure: 502, run dir removed, and no stderr detail beyond a short redacted snippet', async () => {
  cfgOf('claude', { mode: 'fail' });
  const r = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.ok, false); assert.match(j.error, /exit 2/);
  assert.deepEqual(runDirs(), []);
});

test('usage-limit failure: 503, the account is parked like POST /api/events/limit would, audited', async () => {
  cfgOf('claude', { mode: 'limit' });
  const r = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /headroom/);
  assert.equal(db.prepare(`SELECT parked_until IS NOT NULL p FROM accounts WHERE account='cl1'`).get().p, 1);
  assert.ok(db.prepare(`SELECT 1 FROM access_log WHERE account='cl1' AND action='limit'`).get());
  // and now nothing has headroom: a reasoned 503, no spawn
  clearRecs();
  const r2 = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r2.status, 503);
  assert.equal(recsOf('claude').length, 0);
  assert.deepEqual(runDirs(), []);
});

test('concurrency cap: runs beyond AIGATE_PROMPT_CONCURRENCY get 429 + Retry-After immediately, no queue', async () => {
  cfgOf('claude', { mode: 'sleep', ms: 1200 });
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3].map(() => prompt({ role: 'docs', prompt: 'x' })));
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 429]);
  const limited = rs.find((r) => r.status === 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(recsOf('claude').length, 2);
  // the slot frees up again
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  process.env.AIGATE_PROMPT_CONCURRENCY = '1';
  const rs2 = await Promise.all([1, 2].map(() => prompt({ role: 'docs', prompt: 'x' })));
  assert.deepEqual(rs2.map((r) => r.status).sort(), [200, 429]);
  assert.ok(Date.now() - t0 < 6000);
});

// ---- codex auth.json round trip ---------------------------------------------------------------
const leaseRows = () => db.prepare(`SELECT account, scope FROM spend_sessions WHERE via='prompt-api' ORDER BY id`).all().map((r) => ({ ...r }));

test('codex: auth.json lands 0600 in a private CODEX_HOME; unchanged by the run -> vault untouched; lease opened then released', async () => {
  const before = row('cx1').token_enc;
  const r = await prompt({ role: 'gpt', prompt: 'x' });
  assert.equal(r.status, 200);
  const [rec] = recsOf('codex');
  assert.equal(rec.authMode, 0o600);
  assert.equal(rec.codexHomeMode, 0o700);
  assert.equal(rec.authSha, crypto.createHash('sha256').update(JSON.stringify(CODEX_AUTH)).digest('hex'));
  assert.ok(rec.env.CODEX_HOME.startsWith(RUNS) && rec.env.CODEX_HOME !== rec.cwd);   // the model's cwd is not the dir holding the login
  assert.equal(row('cx1').token_enc, before, 'vault row rewritten although nothing changed');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM access_log WHERE action='codex-sync'`).get().c, 0);
  const l = leaseRows();
  assert.deepEqual(l.map((x) => x.account), ['cx1', '']);
  assert.equal(l[0].scope, l[1].scope);
  assert.deepEqual(runDirs(), []);
});

test('codex: a reformatted-but-identical auth.json is not stored back', async () => {
  cfgOf('codex', { rewriteAuth: 'same-format' });
  const before = row('cx1').token_enc;
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(row('cx1').token_enc, before);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM access_log WHERE action='codex-sync'`).get().c, 0, 'the runner offered an unchanged login to the sync path');
});

test('codex: a token the binary rotated mid-run is stored back through the /api/codex/sync path', async () => {
  cfgOf('codex', { rewriteAuth: 'rotate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  const a = stored('cx1');
  assert.equal(a.tokens.refresh_token, 'rt-rotated-by-fake');
  assert.equal(a.tokens.account_id, 'acct-prompt');
  assert.deepEqual(db.prepare(`SELECT result FROM access_log WHERE action='codex-sync'`).all().map((x) => x.result), ['applied']);
  assert.deepEqual(leaseRows().map((x) => x.account), ['cx1', '']);
  // and the vault now hands the NEXT run the rotated login
  clearRecs(); cfgOf('codex');
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(recsOf('codex')[0].authSha, crypto.createHash('sha256').update(JSON.stringify(stored('cx1'))).digest('hex'));
});

test('codex: a run that rotated the token and then FAILED still stores it back and still releases the lease', async () => {
  cfgOf('codex', { rewriteAuth: 'rotate', mode: 'fail' });
  const r = await prompt({ role: 'gpt', prompt: 'x' });
  assert.equal(r.status, 502);
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-rotated-by-fake');
  assert.deepEqual(leaseRows().map((x) => x.account), ['cx1', '']);
  assert.deepEqual(runDirs(), []);
});

test('codex: lease released and dir removed after a timeout too; a second run on the same account is refused while one is in flight', async () => {
  cfgOf('codex', { mode: 'sleep', ms: 800 });
  const [r1, r2] = await Promise.all([prompt({ role: 'gpt', prompt: 'x' }), new Promise((s) => setTimeout(s, 150)).then(() => prompt({ role: 'gpt', prompt: 'y' }))]);
  assert.deepEqual([r1.status, r2.status], [200, 429]);
  assert.match((await r2.json()).error, /busy/);
  assert.equal(recsOf('codex').length, 1);
  clearRecs();
  cfgOf('codex', { mode: 'hang', ignoreTerm: true });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x', timeout_s: 5 })).status, 504);
  assert.equal(leaseRows().at(-1).account, '');
  assert.deepEqual(runDirs(), []);
  // busy flag released: the account can be used again
  cfgOf('codex');
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
});

// ---- secrets never leave --------------------------------------------------------------------
test('responses and audit trail never contain a token, auth.json, the prompt tail, the system prompt or the answer', async () => {
  const longPrompt = 'P'.repeat(450) + 'PROMPT-TAIL-MARKER';
  cfgOf('claude', { text: 'ANSWER-MARKER-' + CANARY }); cfgOf('codex', { text: 'ANSWER-MARKER-' + CANARY, rewriteAuth: 'rotate' });
  const bodies = [];
  for (const role of ['code', 'gpt']) {
    const r = await prompt({ role, prompt: longPrompt, system: 'SYSTEM-MARKER' });
    assert.equal(r.status, 200); bodies.push(await r.text());
  }
  cfgOf('claude', { mode: 'fail' });
  bodies.push(await (await prompt({ role: 'code', prompt: 'x' })).text());
  bodies.push(await (await fetch(base + '/api/models', { headers: H })).text());
  const secrets = [CLAUDE_TOKEN, CODEX_AUTH.tokens.refresh_token, CODEX_AUTH.tokens.access_token, CODEX_AUTH.tokens.id_token, 'rt-rotated-by-fake', TOKEN, ENC_KEY];
  for (const b of bodies) for (const s of secrets) assert.ok(!b.includes(s), 'response leaked a secret');
  const trail = dump() + JSON.stringify(await (await fetch(base + '/api/access?limit=1000', { headers: H })).json()) + JSON.stringify(await (await fetch(base + '/api/logs?limit=1000', { headers: H })).json());
  for (const s of secrets) assert.ok(!trail.includes(s), 'audit trail leaked a secret');
  for (const m of ['PROMPT-TAIL-MARKER', 'SYSTEM-MARKER', 'ANSWER-MARKER']) assert.ok(!trail.includes(m), m + ' was logged');
  const logged = db.prepare(`SELECT account, cwd, model, prompt FROM request_log ORDER BY id`).all();
  assert.equal(logged.length, 3);
  assert.equal(logged[0].prompt, 'P'.repeat(400));   // the dashboard shows the first 400 chars, exactly like /api/events/prompt
  assert.equal(logged[0].account, 'cl1');
  assert.ok(db.prepare(`SELECT 1 FROM access_log WHERE action='prompt' AND account='cl1' AND result LIKE 'ok code claude:sonnet%'`).get());
});

// ---- models.json ------------------------------------------------------------------------------
test('GET /api/models: the active map and where it came from', async () => {
  const j = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.equal(j.ok, true); assert.equal(j.source, 'bundled'); assert.match(j.path, /src[\\/]models\.json$/);
  assert.equal(j.roles.review.model, 'opus');
});

test('models.json next to the DB overrides the bundled map without a restart; an invalid one logs once and falls back', async () => {
  const f = join(TMP, 'models.json');
  writeFileSync(f, JSON.stringify({ roles: { plan: { engine: 'claude', model: 'sonnet' }, extra: { engine: 'claude', model: 'claude-fake-1' }, gpt: { engine: 'codex', model: 'gpt-6.2-terra', service_tier: 'flex' } } }));
  let j = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.equal(j.source, 'override'); assert.equal(j.path, f);
  assert.deepEqual(Object.keys(j.roles).sort(), ['extra', 'gpt', 'plan']);
  assert.equal((await prompt({ role: 'plan', prompt: 'x' })).status, 200);
  assert.equal(recsOf('claude')[0].argv[recsOf('claude')[0].argv.indexOf('--model') + 1], 'sonnet');
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 400);   // not in the override
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(recsOf('codex')[0].argv[recsOf('codex')[0].argv.indexOf('-m') + 1], 'gpt-6.2-terra');

  const warnings = [];
  const orig = console.error; console.error = (...a) => { warnings.push(a.join(' ')); };
  try {
    for (const bad of ['{not json', JSON.stringify({ roles: {} }), JSON.stringify({ roles: { x: { engine: 'claude', model: '--bad' } } }),
      JSON.stringify({ roles: { gpt: { engine: 'codex', model: 'gpt-6.1-sol' }, gpt2: { engine: 'codex', model: 'gpt-4o' } } }), JSON.stringify({ roles: { x: { engine: 'claude', model: 'm', extra: 1 } } })]) {
      writeFileSync(f, bad);
      j = await (await fetch(base + '/api/models', { headers: H })).json();
      assert.equal(j.source, 'bundled', bad); assert.equal(j.override_invalid, true);
      assert.equal(j.roles.gpt.model, 'gpt-6.1-sol');
      await fetch(base + '/api/models', { headers: H });   // same bad text again: no second log line
    }
  } finally { console.error = orig; }
  assert.equal(warnings.filter((w) => w.includes('[models]')).length, 5);
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);   // bundled map is back in force
  rmSync(f);
  assert.equal((await (await fetch(base + '/api/models', { headers: H })).json()).source, 'bundled');
});

// ---- parsers ----------------------------------------------------------------------------------
test('output parsers tolerate noise lines and pick the last answer', () => {
  const claude = 'warming up\n' + JSON.stringify({ type: 'result', is_error: false, result: 'hi', usage: { input_tokens: 5, output_tokens: 2 }, modelUsage: { 'claude-haiku-x': { outputTokens: 1 }, 'claude-opus-y': { outputTokens: 9 } } }) + '\ntrailing noise';
  assert.deepEqual(parseClaude(claude), { isError: false, text: 'hi', served_model: 'claude-opus-y', usage: { input_tokens: 5, output_tokens: 2 } });
  assert.equal(parseClaude('not json at all'), null);
  assert.equal(parseClaude(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'arr', usage: {} }])).text, 'arr');
  const codex = ['Reading prompt from stdin...', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{broken',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}', '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'].join('\n');
  assert.deepEqual(parseCodex(codex), { isError: false, text: 'final', error: '', served_model: null, usage: { input_tokens: 7, output_tokens: 3 } });
  assert.equal(parseCodex('{"type":"turn.failed","error":{"message":"nope"}}').isError, true);
});

test('argument arrays are what the report says they are', () => {
  assert.deepEqual(claudeArgs({ model: 'opus', prompt: 'P' }), ['-p', '--output-format', 'json', '--model', 'opus', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--', 'P']);
  assert.deepEqual(codexArgs({ model: 'gpt-6.1-sol', serviceTier: 'priority', prompt: 'P', cwd: '/w' }), ['exec', '--json', '-m', 'gpt-6.1-sol', '-c', 'service_tier="priority"',
    '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', 'shell_tool', '--disable', 'unified_exec', '--color', 'never', '-C', '/w', '--', 'P']);
});
