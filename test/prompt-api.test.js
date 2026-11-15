// POST /api/prompt + GET /api/models: feature flag, admin-bearer auth, role -> model map, the
// spawned official-binary contract (argv, stdin prompt, env allowlist, private HOME), timeout kill,
// concurrency cap, and the codex auth.json round trip (rotation stored back or the account flagged).
// The real claude/codex are replaced by fake executables (AIGATE_CLAUDE_BIN / AIGATE_CODEX_BIN) that
// record argv + env + stdin and obey a config file; they print the secrets they were given on request.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { makeVault } from '../src/lib.js';
import { claudeArgs, codexArgs, codexSurface, parseClaude, parseCodex, promptParent } from '../src/prompt-runner.js';
import { validateModels } from '../src/models.js';

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const TMP = mkdtempSync(join(tmpdir(), 'aigate-prompt-test-'));
const DB = join(TMP, `aigate-prompt-${process.pid}.db`);
const RUNS = join(TMP, 'runs');            // AIGATE_PROMPT_TMPDIR; every run dir must be gone after each request
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
delete process.env.AIGATE_CODEX_REFRESH_AHEAD_S;

// alert receiver (the server reads AIGATE_ALERT_WEBHOOK once at import)
const alertPosts = [];
const alertSink = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => { try { alertPosts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { alertPosts.push({ bad: true }); } res.writeHead(200); res.end('ok'); });
});
await new Promise((r) => alertSink.listen(0, '127.0.0.1', r));
process.env.AIGATE_ALERT_WEBHOOK = `http://127.0.0.1:${alertSink.address().port}/hook`;

const { server, db, setShuttingDown, promptBootSweep, codexInflight, storeRotated, promptStats } = await import('../src/server.js');
const vault = makeVault(Buffer.from(ENC_KEY, 'hex'));
const H = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
let base;

// ---- the fake official binaries -----------------------------------------------------------------
// Written to disk as `#!node` scripts. Behaviour comes from <script>.cfg.json, every launch appends
// {argv, env, cwd, stdin, ...} to <script>.rec.jsonl. `codex features list` answers from cfg.features.
function fakeMain() {
  const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
  const self = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(self + '.cfg.json', 'utf8'));
  const isCodex = path.basename(self) === 'codex';
  const argv = process.argv.slice(2);
  // like the real codex: a CODEX_HOME that does not exist is a hard error, for every subcommand
  if (isCodex && !fs.existsSync(process.env.CODEX_HOME || '')) { console.error('Error: failed to resolve CODEX_HOME'); process.exit(1); }
  if (isCodex && argv.includes('features')) {
    const known = cfg.features || ['shell_tool', 'unified_exec', 'plugins', 'apps', 'daemon_auto_start', 'goals', 'agent_message_board'];
    const off = argv.flatMap((a, i) => (a === '--disable' ? [argv[i + 1]] : []));
    const sticky = cfg.sticky || ['unified_exec'];
    for (const k of known) console.log(k.padEnd(40) + 'stable'.padEnd(18) + String(k === 'agent_message_board' ? false : !(off.includes(k) && !sticky.includes(k))));
    process.exit(0);
  }
  const rec = { argv, env: process.env, cwd: process.cwd(), pid: process.pid, homeMode: fs.statSync(process.env.HOME).mode & 0o777 };
  const sysIdx = argv.indexOf('--system-prompt-file');
  if (sysIdx >= 0) { rec.systemFile = argv[sysIdx + 1]; rec.systemText = fs.readFileSync(rec.systemFile, 'utf8'); rec.systemMode = fs.statSync(rec.systemFile).mode & 0o777; }
  const authPath = isCodex && process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : null;
  let auth = null;
  if (authPath && fs.existsSync(authPath)) {
    rec.authMode = fs.statSync(authPath).mode & 0o777;
    rec.authSha = crypto.createHash('sha256').update(fs.readFileSync(authPath)).digest('hex');
    rec.codexHomeMode = fs.statSync(process.env.CODEX_HOME).mode & 0o777;
    auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  }
  const secretText = () => (isCodex ? [auth.tokens.refresh_token, auth.tokens.access_token, auth.tokens.id_token, cfg.rewriteAuth === 'rotate' ? 'rt-rotated-by-fake' : ''].join(' ') : process.env.CLAUDE_CODE_OAUTH_TOKEN);
  const finish = () => {
    if (cfg.grandchild) { rec.grandchild = cp.spawn('sleep', ['60'], { stdio: 'ignore' }).pid; }
    fs.appendFileSync(self + '.rec.jsonl', JSON.stringify(rec) + '\n');
    if (cfg.rewriteAuth && authPath) {
      const a = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (cfg.rewriteAuth === 'rotate') {
        a.tokens.refresh_token = 'rt-rotated-by-fake';
        a.last_refresh = new Date(Date.now() + 60000).toISOString();
        fs.writeFileSync(authPath, JSON.stringify(a));
      } else if (cfg.rewriteAuth === 'truncate') fs.writeFileSync(authPath, '{"tokens":{"refresh_token":"rt-half');
      else fs.writeFileSync(authPath, JSON.stringify(a, null, 2) + '\n');   // same tokens, new formatting
    }
    const text = cfg.echo ? 'echo: ' + secretText() : (cfg.text || 'pong');
    if (cfg.mode === 'hang') { if (cfg.ignoreTerm) process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
    const done = () => {
      if (cfg.mode === 'fail') { process.stderr.write('boom: something broke ' + (cfg.echo ? secretText() : '') + '\n'); process.exit(2); }
      if (cfg.mode === 'limit') {
        if (isCodex) { console.log(JSON.stringify({ type: 'error', message: "You've hit your usage limit" })); process.exit(1); }
        console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|123' })); process.exit(1);
      }
      if (cfg.flood) { const chunk = 'x'.repeat(1 << 20) + '\n'; for (let i = 0; i < cfg.flood; i++) process.stdout.write(chunk); setInterval(() => {}, 1000); return; }
      if (isCodex) {
        console.log('WARN noise line that is not json');
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 't1' }));
        if (cfg.item) console.log(JSON.stringify({ type: 'item.started', item: { id: 'i9', type: cfg.item, command: 'ls' } }));
        if (cfg.errorItem) console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i8', type: 'error', message: cfg.errorItem } }));
        console.log(JSON.stringify({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text } }));
        console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 0, output_tokens: 4 } }));
      } else {
        console.log('noise line before the result');
        console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, usage: { input_tokens: 11, output_tokens: 3 }, modelUsage: { 'claude-fake-9': { outputTokens: 3 } } }));
      }
      fs.appendFileSync(self + '.done', '1');
      process.exit(cfg.exit || 0);
    };
    if (cfg.mode === 'sleep') setTimeout(done, cfg.ms); else done();
  };
  // the prompt arrives on stdin; a stdin that never reaches EOF would stall here and show up as stdinEof=false
  let stdin = '', started = false;
  const go = () => { if (started) return; started = true; rec.stdin = stdin; finish(); };
  const t = setTimeout(() => { rec.stdinEof = false; go(); }, 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { stdin += c; });
  process.stdin.on('end', () => { clearTimeout(t); rec.stdinEof = true; go(); });
  process.stdin.on('error', () => { clearTimeout(t); rec.stdinEof = true; go(); });
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
const clearRecs = () => { for (const n of ['claude', 'codex']) rmSync(fake[n] + '.rec.jsonl', { force: true }); rmSync(fake.claude + '.done', { force: true }); rmSync(fake.codex + '.done', { force: true }); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(25); } return false; }
const killLeftovers = () => { for (const n of ['claude', 'codex']) for (const r of recsOf(n)) for (const pid of [r.pid, r.grandchild]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };

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
const PARENT = join(RUNS, `aigate-prompt-${process.getuid()}`);
const runDirs = () => { try { return readdirSync(PARENT); } catch { return []; } };
const flags = (a = 'cx1') => ({ ...db.prepare('SELECT refresh_unknown, reauth_needed FROM accounts WHERE account=?').get(a) });
const dump = () => JSON.stringify({ a: db.prepare('SELECT * FROM access_log').all(), r: db.prepare('SELECT * FROM request_log').all() });
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

// upstream for usage + token (AIGATE_CODEX_*_URL are read on every call)
const tokenHits = [];
const upstream = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/token')) {
      tokenHits.push(1);
      return res.end(JSON.stringify({ access_token: jwt({ exp: now() + 10 * 86400 }), refresh_token: 'rt-refreshed-' + tokenHits.length }));
    }
    res.end(JSON.stringify({ plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: now() + 1000 }, secondary_window: null }, credits: {} }));
  });
});

// every test gets a hard timeout, so one hung child can never stall the file
const t = (name, fn) => test(name, { timeout: 45000 }, fn);

before(async () => {
  installFake('claude'); installFake('codex');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const ub = `http://127.0.0.1:${upstream.address().port}`;
  process.env.AIGATE_CODEX_USAGE_URL = ub + '/usage';
  process.env.AIGATE_CODEX_TOKEN_URL = ub + '/token';
  process.env.AIGATE_CLAUDE_BIN = fake.claude;
  process.env.AIGATE_CODEX_BIN = fake.codex;
  process.env.AIGATE_PROMPT_API = '1';
});
after(() => {
  killLeftovers();
  server.close(); upstream.close(); alertSink.close();
  try { db.close(); } catch { /* already closed */ }
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.AIGATE_PROMPT_API = '1';
  process.env.AIGATE_CLAUDE_BIN = fake.claude;
  process.env.AIGATE_CODEX_BIN = fake.codex;
  delete process.env.AIGATE_PROMPT_CONCURRENCY;
  rmSync(join(TMP, 'models.json'), { force: true });
  db.exec(`DROP TRIGGER IF EXISTS no_sync; DELETE FROM accounts; DELETE FROM access_log; DELETE FROM request_log; DELETE FROM spend_sessions`);
  try { db.exec('ALTER TABLE request_log_x RENAME TO request_log'); } catch { /* not renamed */ }
  rmSync(PARENT, { recursive: true, force: true });
  assert.equal((await addAccount({ account: 'cl1', setup_token: CLAUDE_TOKEN })).status, 200);
  assert.equal((await addAccount({ account: 'cx1', kind: 'codex', auth_json: CODEX_AUTH })).status, 200);
  clearRecs(); cfgOf('claude'); cfgOf('codex');
  tokenHits.length = 0; alertPosts.length = 0;
});
afterEach(async () => {
  killLeftovers();                                   // a failed test must not leave a child behind
  assert.ok(await until(() => promptStats().active === 0, 8000), 'a prompt run is still in flight after the test');
  assert.deepEqual(promptStats().busy, [], 'a codex account was left busy');
});

// ---- flag + auth --------------------------------------------------------------------------------
t('flag off: both routes are plain 404s, even with the admin bearer, and nothing is spawned', async () => {
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

t('auth: no bearer 401, wrong bearer 401, x-api-key and dashboard cookie are not the administrator bearer', async () => {
  const body = JSON.stringify({ role: 'docs', prompt: 'hi' });
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body })).status, 401);
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body, headers: { authorization: 'Bearer nope-not-the-token' } })).status, 401);
  assert.equal((await fetch(base + '/api/models')).status, 401);
  const xk = await fetch(base + '/api/prompt', { method: 'POST', body, headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' } });
  assert.equal(xk.status, 401); assert.match((await xk.json()).error, /bearer/);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.AIGATE_DASHBOARD_PASSWORD }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/accounts', { headers: { cookie } })).status, 200);
  assert.equal((await fetch(base + '/api/prompt', { method: 'POST', body, headers: { cookie, 'content-type': 'application/json' } })).status, 401);
  assert.equal((await fetch(base + '/api/models', { headers: { cookie } })).status, 401);
  assert.equal(recsOf('claude').length, 0);
});

// ---- role -> engine/model/args ------------------------------------------------------------------
t('every claude role runs the official binary with its ALIAS, all tools off; the prompt is on stdin, never argv; system is a 0600 file', async () => {
  const want = { plan: 'fable', orchestrate: 'fable', review: 'opus', code: 'sonnet', docs: 'haiku' };
  for (const [role, alias] of Object.entries(want)) {
    clearRecs();
    const smuggle = '--agent-teams --dangerously-skip-permissions';
    const r = await prompt({ role, prompt: smuggle, system: 'be terse' });
    const j = await r.json();
    assert.equal(r.status, 200, role);
    assert.deepEqual({ ok: j.ok, role: j.role, engine: j.engine, model: j.model, account: j.account, text: j.text }, { ok: true, role, engine: 'claude', model: alias, account: 'cl1', text: 'pong' });
    assert.equal(j.served_model, 'claude-fake-9');
    assert.deepEqual(j.usage, { input_tokens: 11, output_tokens: 3 });
    assert.ok(Number.isInteger(j.duration_ms));
    const [rec] = recsOf('claude');
    assert.equal(recsOf('claude').length, 1);
    const a = rec.argv;
    assert.deepEqual(a, claudeArgs({ model: alias, systemFile: rec.systemFile }));
    assert.equal(a[a.indexOf('--model') + 1], alias);
    assert.deepEqual(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2), ['--tools', '']);
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(!a.includes('--system-prompt'));
    assert.equal(rec.systemText, 'be terse'); assert.equal(rec.systemMode, 0o600);
    assert.equal(rec.stdin, smuggle); assert.equal(rec.stdinEof, true);
    assert.ok(!a.some((x) => x.includes('agent-teams') || x.includes('be terse')), 'prompt or system text reached argv');
  }
  assert.equal(recsOf('codex').length, 0);
});

t('role gpt: codex, ALWAYS gpt-6.1-sol with service_tier="priority", read-only sandbox, prompt on stdin, never an approval bypass', async () => {
  const r = await prompt({ role: 'gpt', prompt: '--agent-teams hello', system: 'sys' });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual({ engine: j.engine, model: j.model, account: j.account, text: j.text, usage: j.usage, served: j.served_model }, { engine: 'codex', model: 'gpt-6.1-sol', account: 'cx1', text: 'pong', usage: { input_tokens: 21, output_tokens: 4 }, served: null });
  const [rec] = recsOf('codex');
  const a = rec.argv;
  assert.equal(a[0], 'exec');
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-6.1-sol');
  assert.equal(a.filter((x) => x === '-m').length, 1);
  assert.ok(a.includes('service_tier="priority"') && a[a.indexOf('service_tier="priority"') - 1] === '-c');
  assert.equal(a[a.indexOf('-s') + 1], 'read-only');
  assert.ok(a.includes('web_search="disabled"'));
  assert.ok(a.includes('--json') && a.includes('--skip-git-repo-check'));
  assert.ok(!a.some((x) => /dangerously|full-auto|danger-full-access/.test(x)));
  assert.equal(a.at(-1), '-');
  assert.equal(rec.stdin, 'sys\n\n--agent-teams hello'); assert.equal(rec.stdinEof, true);
  assert.ok(!a.some((x) => x.includes('agent-teams') || x === 'sys'));
  assert.equal(recsOf('claude').length, 0);
});

t('no way to pick another GPT model: raw model/service_tier fields and look-alike roles are refused before anything spawns', async () => {
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
  const { roles } = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.deepEqual(Object.entries(roles).filter(([, v]) => v.engine === 'codex'), [['gpt', { engine: 'codex', model: 'gpt-6.1-sol', service_tier: 'priority' }]]);
  assert.throws(() => validateModels({ roles: { gpt: { engine: 'codex', model: 'gpt-6.1-sol' }, gpt2: { engine: 'codex', model: 'gpt-4o' } } }), /only the role "gpt"/);
  assert.throws(() => validateModels({ roles: { code: { engine: 'codex', model: 'gpt-4o' } } }), /only the role "gpt"/);
  assert.throws(() => validateModels({ roles: { code: { engine: 'claude', model: '--dangerously-skip-permissions' } } }), /bad model/);
});

// ---- child environment ------------------------------------------------------------------------
t('child env is an allowlist: no admin token, encryption key, ANTHROPIC_*, OPENAI_* or AIGATE_*; claude gets only its OAuth token', async () => {
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 200);
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  const [c] = recsOf('claude'), [x] = recsOf('codex');
  const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CODEX_HOME',
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
  assert.ok(x.env.CODEX_HOME.startsWith(PARENT + '/r-'));
});

t('each run dir is a 0700 child of a private 0700 parent owned by the server; HOME = cwd for claude; removed afterwards', async () => {
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  const [rec] = recsOf('claude');
  assert.equal(join(realpathSync(dirname(rec.env.HOME)), basename(rec.env.HOME)), rec.cwd);
  assert.equal(realpathSync(dirname(rec.cwd)), realpathSync(PARENT));
  assert.equal(rec.homeMode, 0o700);
  const st = (await import('node:fs')).statSync(PARENT);
  assert.equal(st.mode & 0o777, 0o700); assert.equal(st.uid, process.getuid());
  assert.equal(rec.env.TMPDIR, rec.env.HOME);
  assert.deepEqual(runDirs(), []);
  // a parent that is not ours / not private is refused, a loose one is tightened
  chmodSync(PARENT, 0o755); assert.equal(promptParent(process.env), PARENT); assert.equal((await import('node:fs')).statSync(PARENT).mode & 0o777, 0o700);
  rmSync(PARENT, { recursive: true }); mkdirSync(join(TMP, 'elsewhere')); (await import('node:fs')).symlinkSync(join(TMP, 'elsewhere'), PARENT);
  assert.throws(() => promptParent(process.env), /not a private directory/);
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 500);
  rmSync(PARENT);
});

t('stdin carries the whole prompt and then EOF: a binary that reads stdin sees it at once instead of hanging', async () => {
  const t0 = Date.now();
  const big = 'é'.repeat(30000) + '\n' + 'line two';
  assert.equal((await prompt({ role: 'code', prompt: big })).status, 200);
  assert.equal((await prompt({ role: 'gpt', prompt: big })).status, 200);
  assert.ok(Date.now() - t0 < 2500, 'stdin never reached EOF');
  for (const rec of [recsOf('claude')[0], recsOf('codex')[0]]) { assert.equal(rec.stdinEof, true); assert.equal(rec.stdin, big); }
});

// ---- validation -------------------------------------------------------------------------------
t('request validation: clear 400s, nothing spawned; the stated boundaries pass', async () => {
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
  assert.equal(recsOf('claude').length, 0);
  const big = await fetch(base + '/api/prompt', { method: 'POST', headers: H, body: JSON.stringify({ role: 'docs', prompt: 'x'.repeat(1.1e6) }) });
  assert.equal(big.status, 413);
  assert.equal((await prompt({ role: 'docs', prompt: 'x'.repeat(100000), timeout_s: 5 })).status, 200);
  assert.equal((await prompt({ role: 'docs', prompt: '\u{1F600}'.repeat(50000), system: 'y'.repeat(20000), timeout_s: 600 })).status, 200);   // 200KB of stdin: no argv limit
  assert.equal(recsOf('claude')[1].stdin.length, 100000);
});

t('missing binary is a 503 ONLY when it is really missing; an interpreter-less script that exists is a 502; run dirs cleaned up', async () => {
  process.env.AIGATE_CLAUDE_BIN = join(TMP, 'nope', 'claude');
  let r = await prompt({ role: 'docs', prompt: 'x' });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /not found/);
  process.env.AIGATE_CLAUDE_BIN = 'definitely-not-an-installed-binary-xyz';
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 503);
  process.env.AIGATE_CODEX_BIN = join(TMP, 'nope', 'codex');
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 503);
  // exists and is executable, but its shebang interpreter does not: the kernel says ENOENT, the binary is NOT missing
  const broken = join(BIN, 'broken'); writeFileSync(broken, '#!/nonexistent/interpreter\n'); chmodSync(broken, 0o755);
  process.env.AIGATE_CLAUDE_BIN = broken;
  r = await prompt({ role: 'docs', prompt: 'x' });
  assert.equal(r.status, 502); assert.doesNotMatch((await r.json()).error, /not found/);
  assert.deepEqual(runDirs(), []);
});

// ---- failure modes ----------------------------------------------------------------------------
t('timeout: 504, the whole process group (child + grandchild, even one that ignores SIGTERM) is really gone, run dir removed', async () => {
  cfgOf('claude', { mode: 'hang', ignoreTerm: true, grandchild: true });
  const t0 = Date.now();
  const r = await prompt({ role: 'docs', prompt: 'x', timeout_s: 5 });
  assert.equal(r.status, 504);
  const dt = Date.now() - t0;
  assert.ok(dt >= 4900 && dt < 9000, `took ${dt}ms`);
  const [rec] = recsOf('claude');
  assert.ok(await until(() => !alive(rec.pid) && !alive(rec.grandchild), 3000), 'child or grandchild survived the timeout');
  assert.deepEqual(runDirs(), []);
});

t('a SUCCESSFUL run leaves nothing behind either: the grandchild it forked is killed with the group', async () => {
  cfgOf('claude', { grandchild: true });
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  const [rec] = recsOf('claude');
  assert.ok(await until(() => !alive(rec.grandchild), 3000), 'grandchild of a successful run survived');
  assert.deepEqual(runDirs(), []);
});

t('claude client disconnect kills the child (and only that run)', async () => {
  cfgOf('claude', { mode: 'hang', grandchild: true });
  const req = http.request(base + '/api/prompt', { method: 'POST', headers: H }); req.on('error', () => {});
  req.end(JSON.stringify({ role: 'docs', prompt: 'x', timeout_s: 60 }));
  assert.ok(await until(() => recsOf('claude').length === 1), 'child never started');
  const [rec] = recsOf('claude');
  req.destroy();
  assert.ok(await until(() => !alive(rec.pid) && !alive(rec.grandchild), 4000), 'aborted run still alive');
  assert.ok(await until(() => runDirs().length === 0), 'run dir left behind');
});

t('codex client disconnect does NOT kill the run: it finishes, its rotated login is stored back, the answer is discarded', async () => {
  cfgOf('codex', { mode: 'sleep', ms: 700, rewriteAuth: 'rotate' });
  const req = http.request(base + '/api/prompt', { method: 'POST', headers: H }); req.on('error', () => {});
  req.end(JSON.stringify({ role: 'gpt', prompt: 'x' }));
  assert.ok(await until(() => recsOf('codex').length === 1));
  req.destroy();
  assert.ok(await until(() => promptStats().active === 0, 6000));
  assert.ok(existsSync(fake.codex + '.done'), 'the codex child was cut short by the disconnect');
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-rotated-by-fake');
  assert.deepEqual(runDirs(), []);
});

t('binary failure: 502, run dir removed, short redacted detail only', async () => {
  cfgOf('claude', { mode: 'fail' });
  const r = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.ok, false); assert.match(j.error, /exit 2/);
  assert.deepEqual(runDirs(), []);
});

t('usage-limit failure: 503, the account is parked like POST /api/events/limit would, audited', async () => {
  cfgOf('claude', { mode: 'limit' });
  const r = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r.status, 503); assert.match((await r.json()).error, /headroom/);
  assert.equal(db.prepare(`SELECT parked_until IS NOT NULL p FROM accounts WHERE account='cl1'`).get().p, 1);
  assert.ok(db.prepare(`SELECT 1 FROM access_log WHERE account='cl1' AND action='limit'`).get());
  clearRecs();
  const r2 = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r2.status, 503);
  assert.equal(recsOf('claude').length, 0);
  assert.deepEqual(runDirs(), []);
});

t('shutting down: a prompt arriving during the drain is a 503 and spawns nothing', async () => {
  setShuttingDown(true);
  try {
    const r = await prompt({ role: 'code', prompt: 'x' });
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { ok: false, error: 'shutting down' });
    assert.equal(recsOf('claude').length, 0);
    assert.equal(promptStats().active, 0);
  } finally { setShuttingDown(false); }
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 200);
});

t('a throw before handlePrompt\'s own try is a logged 500 JSON reply, not a hung socket', async () => {
  const orig = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function (code, ...a) {
    if (code === 400) { http.ServerResponse.prototype.writeHead = orig; throw new Error('boom before try'); }
    return orig.call(this, code, ...a);
  };
  try {
    const r = await fetch(base + '/api/prompt', { method: 'POST', headers: H, body: JSON.stringify({ role: 'nope', prompt: 'x' }), signal: AbortSignal.timeout(5000) });
    assert.equal(r.status, 500); assert.deepEqual(await r.json(), { error: 'internal error' });
  } finally { http.ServerResponse.prototype.writeHead = orig; }
});

t('rate-limit wording in the ANSWER is never read as a rate limit: a failing run whose answer says "rate limit" is a 502 and parks nothing', async () => {
  cfgOf('claude', { exit: 2, text: 'my usage limit joke: 429 quota exceeded, rate limit reached' });
  const r = await prompt({ role: 'code', prompt: 'x' });
  assert.equal(r.status, 502);
  assert.equal(db.prepare(`SELECT parked_until IS NOT NULL p FROM accounts WHERE account='cl1'`).get().p, 0);
  cfgOf('codex', { exit: 2, text: 'rate limit usage limit quota 429' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 502);
  assert.equal(db.prepare(`SELECT parked_until IS NOT NULL p FROM accounts WHERE account='cx1'`).get().p, 0);
  cfgOf('codex', { mode: 'limit' });   // while a real error event still is one
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 503);
  assert.equal(db.prepare(`SELECT parked_until IS NOT NULL p FROM accounts WHERE account='cx1'`).get().p, 1);
});

t('outage alert from the prompt path says so, and clears on the next good claude run', async () => {
  db.prepare(`UPDATE accounts SET disabled=1 WHERE account='cl1'`).run();
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 503);
  assert.ok(await until(() => alertPosts.some((a) => /0 selectable/.test(a.text || '') && /POST \/api\/prompt/.test(a.text))), 'no labelled outage alert');
  db.prepare(`UPDATE accounts SET disabled=0 WHERE account='cl1'`).run();
  assert.equal((await prompt({ role: 'code', prompt: 'x' })).status, 200);
  assert.ok(await until(() => alertPosts.some((a) => /recovered/.test(a.text || ''))), 'outage latch never cleared');
});

t('concurrency cap: runs beyond AIGATE_PROMPT_CONCURRENCY get 429 + Retry-After immediately, no queue', async () => {
  cfgOf('claude', { mode: 'sleep', ms: 1200 });
  const rs = await Promise.all([1, 2, 3].map(() => prompt({ role: 'docs', prompt: 'x' })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 429]);
  const limited = rs.find((r) => r.status === 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(recsOf('claude').length, 2);
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  process.env.AIGATE_PROMPT_CONCURRENCY = '1';
  const rs2 = await Promise.all([1, 2].map(() => prompt({ role: 'docs', prompt: 'x' })));
  assert.deepEqual(rs2.map((r) => r.status).sort(), [200, 429]);
});

t('output flood: the 16MB cap stops buffering, kills the child, 502', async () => {
  cfgOf('claude', { flood: 40 });
  const r = await prompt({ role: 'docs', prompt: 'x' });
  assert.equal(r.status, 502); assert.match((await r.json()).error, /too large/);
  const [rec] = recsOf('claude');
  assert.ok(await until(() => !alive(rec.pid), 3000));
});

// ---- codex auth.json round trip ---------------------------------------------------------------
const leaseRows = () => db.prepare(`SELECT account, scope FROM spend_sessions WHERE via='prompt-api' ORDER BY id`).all().map((r) => ({ ...r }));

t('codex: auth.json lands 0600 in a private CODEX_HOME; unchanged by the run -> vault untouched; lease opened then released', async () => {
  const before = row('cx1').token_enc;
  const r = await prompt({ role: 'gpt', prompt: 'x' });
  assert.equal(r.status, 200);
  const [rec] = recsOf('codex');
  assert.equal(rec.authMode, 0o600);
  assert.equal(rec.codexHomeMode, 0o700);
  assert.equal(rec.authSha, sha(CODEX_AUTH));
  assert.ok(rec.env.CODEX_HOME !== rec.cwd);   // the model's cwd is not the dir holding the login
  assert.equal(row('cx1').token_enc, before, 'vault row rewritten although nothing changed');
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM access_log WHERE action='codex-sync'`).get().c, 0);
  const l = leaseRows();
  assert.deepEqual(l.map((x) => x.account), ['cx1', '']);
  assert.equal(l[0].scope, l[1].scope);
  assert.deepEqual(runDirs(), []);
});

t('codex: a reformatted-but-identical auth.json is not stored back and not even offered', async () => {
  cfgOf('codex', { rewriteAuth: 'same-format' });
  const before = row('cx1').token_enc;
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(row('cx1').token_enc, before);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM access_log WHERE action='codex-sync'`).get().c, 0, 'the runner offered an unchanged login to the sync path');
});

t('codex: a token the binary rotated mid-run is stored back through the /api/codex/sync path, and the next run gets it', async () => {
  cfgOf('codex', { rewriteAuth: 'rotate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  const a = stored('cx1');
  assert.equal(a.tokens.refresh_token, 'rt-rotated-by-fake');
  assert.equal(a.tokens.account_id, 'acct-prompt');
  assert.deepEqual(db.prepare(`SELECT result FROM access_log WHERE action='codex-sync'`).all().map((x) => x.result), ['applied']);
  assert.deepEqual(flags(), { refresh_unknown: 0, reauth_needed: 0 });
  assert.deepEqual(leaseRows().map((x) => x.account), ['cx1', '']);
  clearRecs(); cfgOf('codex');
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(recsOf('codex')[0].authSha, sha(stored('cx1')));
});

t('codex: a run that rotated the token and then FAILED still stores it back and still releases the lease', async () => {
  cfgOf('codex', { rewriteAuth: 'rotate', mode: 'fail' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 502);
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-rotated-by-fake');
  assert.deepEqual(leaseRows().map((x) => x.account), ['cx1', '']);
  assert.deepEqual(runDirs(), []);
});

t('codex: timeout releases the lease and the account; a TIMED-OUT run that rotated still stores the login', async () => {
  cfgOf('codex', { mode: 'hang', ignoreTerm: true, rewriteAuth: 'rotate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x', timeout_s: 5 })).status, 504);
  assert.equal(leaseRows().at(-1).account, '');
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-rotated-by-fake');
  assert.deepEqual(runDirs(), []);
});

t('codex: two simultaneous runs on the one account: exactly one spawns, the other gets 429 busy (no stagger)', async () => {
  cfgOf('codex', { mode: 'sleep', ms: 800 });
  // hold both requests inside account selection together (codexFresh waits for an inflight refresh), so they
  // resume in the same tick having both seen an empty busy set
  codexInflight.set('cx1', sleep(150).finally(() => codexInflight.delete('cx1')));
  const [r1, r2] = await Promise.all([prompt({ role: 'gpt', prompt: 'x' }), prompt({ role: 'gpt', prompt: 'y' })]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 429]);
  assert.match((await (r1.status === 429 ? r1 : r2).json()).error, /busy/);
  assert.equal(recsOf('codex').length, 1);
  cfgOf('codex');
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);   // released
});

// ---- the blocker: a rotated login must never be silently lost ----------------------------------
const leftoverDirs = () => runDirs().filter((d) => /^r-/.test(d));

t('codex: rotated login the vault REJECTS (vault is ahead) -> account flagged refresh_unknown, alert raised, file kept; boot sweep re-offers then deletes', async () => {
  const future = { ...CODEX_AUTH, tokens: { ...CODEX_AUTH.tokens, refresh_token: 'rt-vault-future' }, last_refresh: new Date(Date.now() + 86400e3).toISOString() };
  assert.equal((await (await fetch(base + '/api/codex/sync', { method: 'POST', headers: H, body: JSON.stringify({ auth_json: future }) })).json()).applied, true);
  cfgOf('codex', { rewriteAuth: 'rotate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-vault-future');
  assert.deepEqual(flags(), { refresh_unknown: 1, reauth_needed: 0 });
  assert.ok(await until(() => alertPosts.some((a) => /cx1/.test(a.text || '') && /refresh outcome unknown/.test(a.text || ''))), 'no alert raised');
  assert.equal(leftoverDirs().length, 1, 'the only copy of the rotated login was deleted');
  const kept = JSON.parse(readFileSync(join(PARENT, leftoverDirs()[0], 'codex', 'auth.json'), 'utf8'));
  assert.equal(kept.tokens.refresh_token, 'rt-rotated-by-fake');
  assert.equal(JSON.parse(readFileSync(join(PARENT, leftoverDirs()[0], 'account'), 'utf8')).account, 'cx1');
  const sweep = await promptBootSweep();
  assert.deepEqual(sweep, { offered: 1, flagged: 1, removed: 1 });
  assert.deepEqual(runDirs(), []);
  assert.deepEqual(flags(), { refresh_unknown: 1, reauth_needed: 0 });
});

t('codex: a truncated auth.json (killed mid-write) flags the account and keeps the file; an unreadable leftover found at boot flags it too', async () => {
  cfgOf('codex', { rewriteAuth: 'truncate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.deepEqual(flags(), { refresh_unknown: 1, reauth_needed: 0 });
  assert.equal(leftoverDirs().length, 1);
  assert.ok(alertPosts.length >= 0 && await until(() => alertPosts.some((a) => /cx1/.test(a.text || ''))));
  db.prepare(`UPDATE accounts SET refresh_unknown=0 WHERE account='cx1'`).run();
  const sweep = await promptBootSweep();
  assert.equal(sweep.flagged, 1); assert.deepEqual(runDirs(), []);
  assert.deepEqual(flags(), { refresh_unknown: 1, reauth_needed: 0 });
});

t('codex: a sync that THROWS flags the account and keeps the file', async () => {
  db.exec(`CREATE TRIGGER no_sync BEFORE UPDATE OF token_enc ON accounts BEGIN SELECT RAISE(ABORT, 'nope'); END`);
  cfgOf('codex', { rewriteAuth: 'rotate' });
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  db.exec('DROP TRIGGER no_sync');
  assert.deepEqual(flags(), { refresh_unknown: 1, reauth_needed: 0 });
  assert.equal(leftoverDirs().length, 1);
  assert.equal(stored('cx1').tokens.refresh_token, CODEX_AUTH.tokens.refresh_token);
});

t('codex: boot sweep stores a leftover login the vault does not have yet (crash after rotation), then deletes it; no sidecar needed', async () => {
  const dir = join(PARENT.replace(/\/$/, ''), 'r-crashed'); mkdirSync(join(dir, 'codex'), { recursive: true });
  const rotated = { ...CODEX_AUTH, tokens: { ...CODEX_AUTH.tokens, refresh_token: 'rt-after-crash' }, last_refresh: new Date(Date.now() + 5000).toISOString() };
  writeFileSync(join(dir, 'codex', 'auth.json'), JSON.stringify(rotated));
  mkdirSync(join(PARENT, 'r-empty'), { recursive: true });
  assert.deepEqual(await promptBootSweep(), { offered: 1, flagged: 0, removed: 2 });
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-after-crash');
  assert.deepEqual(flags(), { refresh_unknown: 0, reauth_needed: 0 });
  assert.deepEqual(runDirs(), []);
});

t('codex: "refresh in flight" is awaited and retried once, not treated as a failure', async () => {
  const rotated = { ...CODEX_AUTH, tokens: { ...CODEX_AUTH.tokens, refresh_token: 'rt-after-inflight' }, last_refresh: new Date(Date.now() + 5000).toISOString() };
  const p = new Promise((r) => setTimeout(r, 150)).finally(() => codexInflight.delete('cx1'));
  codexInflight.set('cx1', p);
  const out = await storeRotated(rotated, '127.0.0.1', 'cx1');
  assert.deepEqual(out, { ok: true });
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-after-inflight');
  assert.deepEqual(flags(), { refresh_unknown: 0, reauth_needed: 0 });
  // a refresh that FAILED (rejected promise) still lets the retry go ahead
  const rotated2 = { ...rotated, tokens: { ...rotated.tokens, refresh_token: 'rt-after-failed-refresh' }, last_refresh: new Date(Date.now() + 9000).toISOString() };
  codexInflight.set('cx1', Promise.reject(new Error('refresh blew up')).finally(() => codexInflight.delete('cx1')));
  assert.deepEqual(await storeRotated(rotated2, '127.0.0.1', 'cx1'), { ok: true });
  assert.equal(stored('cx1').tokens.refresh_token, 'rt-after-failed-refresh');
});

t('codex: SIGTERM of the server aborts in-flight runs and waits for their cleanup: the rotated login reaches the vault before exit', async () => {
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const cdb = join(TMP, 'child.db');
  const kid = spawn(process.execPath, [join(import.meta.dirname, '..', 'src', 'server.js')], {
    env: { PATH: process.env.PATH, HOME: TMP, PORT: String(port), HOST: '127.0.0.1', AIGATE_TOKEN: TOKEN, AIGATE_ENCRYPTION_KEY: ENC_KEY, AIGATE_DB: cdb, AIGATE_POLL_MS: '0', AIGATE_KEY_POLL_MS: '0', AIGATE_WATCHDOG_MS: '0',
      AIGATE_PROMPT_API: '1', AIGATE_CODEX_BIN: fake.codex, AIGATE_CLAUDE_BIN: fake.claude, AIGATE_PROMPT_TMPDIR: RUNS, AIGATE_PROMPT_KILL_GRACE_MS: '300' },
    stdio: 'ignore' });
  const exited = new Promise((r) => kid.on('exit', (code) => r(code)));
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.ok(await until(async () => { try { return (await fetch(url + '/health')).ok; } catch { return false; } }, 15000), 'child server never came up');
    assert.equal((await fetch(url + '/api/accounts', { method: 'POST', headers: H, body: JSON.stringify({ account: 'cx9', kind: 'codex', auth_json: CODEX_AUTH }) })).status, 200);
    clearRecs(); cfgOf('codex', { mode: 'hang', rewriteAuth: 'rotate' });
    const inflight = fetch(url + '/api/prompt', { method: 'POST', headers: H, body: JSON.stringify({ role: 'gpt', prompt: 'x', timeout_s: 60 }) }).then((r) => r.status, () => 'dropped');
    assert.ok(await until(() => recsOf('codex').length === 1, 8000), 'codex child never started');
    const [rec] = recsOf('codex');
    process.kill(kid.pid, 'SIGTERM');
    assert.equal(await exited, 0);
    assert.equal(alive(rec.pid), false, 'the codex child outlived the server');
    await inflight;
    const d = new DatabaseSync(cdb);
    const a = JSON.parse(vault.decrypt(d.prepare(`SELECT token_enc FROM accounts WHERE account='cx9'`).get().token_enc));
    d.close();
    assert.equal(a.tokens.refresh_token, 'rt-rotated-by-fake', 'the rotated login was lost at shutdown');
    assert.deepEqual(runDirs(), []);
  } finally { try { kid.kill('SIGKILL'); } catch { /* gone */ } killLeftovers(); await exited; }
});

// ---- aigate's own refresh vs a running child --------------------------------------------------
t('codex: a token that clears the 4d refresh window but not window + run is refreshed BEFORE the child is spawned, and the child gets the fresh login', async () => {
  db.prepare(`UPDATE accounts SET token_exp=? WHERE account='cx1'`).run(now() + 345600 + 60);   // aigate itself would not refresh this; the run (120s + grace) would outlive the window
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal(tokenHits.length, 1);
  const now_ = stored('cx1');
  assert.match(now_.tokens.refresh_token, /^rt-refreshed-/);
  assert.equal(recsOf('codex')[0].authSha, sha(now_), 'the child was handed the pre-refresh login');
});

t('codex: aigate\'s own refresh (poll/refresh route) skips an account while a prompt run holds it, and resumes afterwards', async () => {
  cfgOf('codex', { mode: 'sleep', ms: 1200 });
  const run = prompt({ role: 'gpt', prompt: 'x' });
  assert.ok(await until(() => recsOf('codex').length === 1));
  db.prepare(`UPDATE accounts SET token_exp=? WHERE account='cx1'`).run(now() + 86400);   // inside the refresh window
  const poll = await fetch(base + '/api/accounts/cx1/refresh', { method: 'POST', headers: H });
  assert.equal(poll.status, 200);
  assert.equal(tokenHits.length, 0, 'aigate rotated the refresh token under a running child');
  assert.equal((await run).status, 200);
  await fetch(base + '/api/accounts/cx1/refresh', { method: 'POST', headers: H });
  assert.equal(tokenHits.length, 1, 'refresh never resumed once the run ended');
});

// ---- codex tool surface -----------------------------------------------------------------------
t('codex: only features this binary knows are disabled (an unknown name is a hard error), requested-off ones still on are reported, in /api/models too', async () => {
  cfgOf('codex', { features: ['shell_tool', 'unified_exec', 'apps', 'goals', 'agent_message_board'], sticky: ['unified_exec'] });
  const s = await codexSurface(process.env, { force: true });
  assert.deepEqual(s.disable, ['shell_tool', 'unified_exec', 'apps']);
  assert.deepEqual(s.still_on, ['unified_exec']);
  const m = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.deepEqual(m.codex_surface.disable, ['shell_tool', 'unified_exec', 'apps']);
  assert.deepEqual(m.codex_surface.still_on, ['unified_exec']);
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  const a = recsOf('codex')[0].argv;
  const dis = a.flatMap((x, i) => (x === '--disable' ? [a[i + 1]] : []));
  assert.deepEqual(dis, ['shell_tool', 'unified_exec', 'apps']);
  assert.deepEqual(codexArgs({ model: 'm', cwd: '/w', disable: ['a', 'b'] }).filter((x) => x === '--disable').length, 2);
  await codexSurface(process.env, { force: true }).catch(() => {});
});

t('codex: the default surface disables every candidate the binary lists, daemon_auto_start included', async () => {
  cfgOf('codex');
  const s = await codexSurface(process.env, { force: true });
  assert.deepEqual(s.disable, ['shell_tool', 'unified_exec', 'apps', 'plugins', 'daemon_auto_start']);
  assert.ok(s.disable.includes('daemon_auto_start'));
});

t('codex: ANY non-text item in the event stream (command, MCP, file change, search) is a 502 "tool use detected" and the text is not returned', async () => {
  for (const item of ['command_execution', 'mcp_tool_call', 'file_change', 'web_search']) {
    cfgOf('codex', { item, text: 'SECRET-ANSWER-' + item, rewriteAuth: 'rotate' });
    const r = await prompt({ role: 'gpt', prompt: 'x' });
    const body = await r.text();
    assert.equal(r.status, 502, item); assert.match(body, /tool use detected/);
    assert.ok(!body.includes('SECRET-ANSWER'), 'text of a tool-using run was returned');
    assert.equal(stored('cx1').tokens.refresh_token, 'rt-rotated-by-fake');   // the rotation is still stored
    assert.equal((await addAccount({ account: 'cx1', kind: 'codex', auth_json: CODEX_AUTH })).status, 200);   // back to the original login
  }
  cfgOf('codex', { errorItem: 'warning: something non fatal', text: 'fine' });   // error items alone are fine
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
});

// ---- secrets never leave --------------------------------------------------------------------
t('redaction by exact value on the SUCCESS path: a binary that echoes every credential it was given gets them cut from text', async () => {
  cfgOf('claude', { echo: true });
  let j = await (await prompt({ role: 'code', prompt: 'x' })).json();
  assert.ok(j.text.includes('[redacted]') && !j.text.includes(CLAUDE_TOKEN), j.text);
  cfgOf('codex', { echo: true, rewriteAuth: 'rotate' });
  const r = await prompt({ role: 'gpt', prompt: 'x' });
  const raw = await r.text(); j = JSON.parse(raw);
  assert.equal(r.status, 200);
  for (const s of [CODEX_AUTH.tokens.refresh_token, CODEX_AUTH.tokens.access_token, CODEX_AUTH.tokens.id_token, 'rt-rotated-by-fake']) assert.ok(!raw.includes(s), 'secret in the success body: ' + s.slice(0, 16));
  assert.ok(j.text.includes('[redacted]'));
});

t('redaction on the ERROR path, both engines', async () => {
  cfgOf('claude', { mode: 'fail', echo: true });
  let raw = await (await prompt({ role: 'code', prompt: 'x' })).text();
  assert.ok(!raw.includes(CLAUDE_TOKEN) && raw.includes('redacted'), raw);
  cfgOf('codex', { mode: 'fail', echo: true });
  raw = await (await prompt({ role: 'gpt', prompt: 'x' })).text();
  assert.ok(!raw.includes(CODEX_AUTH.tokens.refresh_token) && !raw.includes(CODEX_AUTH.tokens.access_token) && raw.includes('redacted'), raw);
});

t('responses and audit trail never contain a token, auth.json, the prompt tail, the system prompt or the answer', async () => {
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
  assert.equal(logged[0].prompt, 'P'.repeat(400));
  assert.equal(logged[0].account, 'cl1');
  assert.ok(db.prepare(`SELECT 1 FROM access_log WHERE action='prompt' AND account='cl1' AND result LIKE 'ok code claude:sonnet%'`).get());
});

t('a DB failure between picking the account and spawning releases the codex account (no stuck busy flag)', async () => {
  db.exec('ALTER TABLE request_log RENAME TO request_log_x');
  const r1 = await prompt({ role: 'gpt', prompt: 'x' });
  db.exec('ALTER TABLE request_log_x RENAME TO request_log');
  assert.equal(r1.status, 500);
  assert.deepEqual(promptStats().busy, []);
  assert.equal(recsOf('codex').length, 0);
  assert.equal((await prompt({ role: 'gpt', prompt: 'x' })).status, 200);
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
});

// ---- models.json ------------------------------------------------------------------------------
t('GET /api/models: the active map and where it came from', async () => {
  const j = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.equal(j.ok, true); assert.equal(j.source, 'bundled'); assert.match(j.path, /src[\\/]models\.json$/);
  assert.equal(j.roles.review.model, 'opus');
  assert.ok(Array.isArray(j.codex_surface.disable) && Array.isArray(j.codex_surface.still_on));
});

t('models.json next to the DB overrides the bundled map without a restart; an invalid one logs once and falls back', async () => {
  const f = join(TMP, 'models.json');
  writeFileSync(f, JSON.stringify({ roles: { plan: { engine: 'claude', model: 'sonnet' }, extra: { engine: 'claude', model: 'claude-fake-1' }, gpt: { engine: 'codex', model: 'gpt-6.2-terra', service_tier: 'flex' } } }));
  let j = await (await fetch(base + '/api/models', { headers: H })).json();
  assert.equal(j.source, 'override'); assert.equal(j.path, f);
  assert.deepEqual(Object.keys(j.roles).sort(), ['extra', 'gpt', 'plan']);
  assert.equal((await prompt({ role: 'plan', prompt: 'x' })).status, 200);
  assert.equal(recsOf('claude')[0].argv[recsOf('claude')[0].argv.indexOf('--model') + 1], 'sonnet');
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 400);
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
      await fetch(base + '/api/models', { headers: H });
    }
  } finally { console.error = orig; }
  assert.equal(warnings.filter((w) => w.includes('[models]')).length, 5);
  assert.equal((await prompt({ role: 'docs', prompt: 'x' })).status, 200);
  rmSync(f);
  assert.equal((await (await fetch(base + '/api/models', { headers: H })).json()).source, 'bundled');
});

// ---- parsers + args ---------------------------------------------------------------------------
t('output parsers tolerate noise lines, pick the last answer, and flag tool use', () => {
  const claude = 'warming up\n' + JSON.stringify({ type: 'result', is_error: false, result: 'hi', usage: { input_tokens: 5, output_tokens: 2 }, modelUsage: { 'claude-haiku-x': { outputTokens: 1 }, 'claude-opus-y': { outputTokens: 9 } } }) + '\ntrailing noise';
  assert.deepEqual(parseClaude(claude), { isError: false, text: 'hi', served_model: 'claude-opus-y', usage: { input_tokens: 5, output_tokens: 2 } });
  assert.equal(parseClaude('not json at all'), null);
  assert.equal(parseClaude(JSON.stringify([{ type: 'system' }, { type: 'result', result: 'arr', usage: {} }])).text, 'arr');
  const codex = ['Reading prompt from stdin...', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{broken',
    '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}', '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}'].join('\n');
  assert.deepEqual(parseCodex(codex), { isError: false, text: 'final', error: '', toolUse: false, served_model: null, usage: { input_tokens: 7, output_tokens: 3 } });
  assert.equal(parseCodex('{"type":"turn.failed","error":{"message":"nope"}}').isError, true);
  assert.equal(parseCodex('{"type":"item.completed","item":{"type":"error","message":"bad"}}').error, 'bad');
  for (const ty of ['command_execution', 'mcp_tool_call', 'file_change', 'web_search', 'something_new']) assert.equal(parseCodex(`{"type":"item.started","item":{"type":"${ty}"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"x"}}`).toolUse, true, ty);
});

t('argument arrays are what the report says they are', () => {
  assert.deepEqual(claudeArgs({ model: 'opus', systemFile: '/r/system.txt' }), ['-p', '--output-format', 'json', '--model', 'opus', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--system-prompt-file', '/r/system.txt']);
  assert.deepEqual(claudeArgs({ model: 'opus' }).includes('--system-prompt-file'), false);
  assert.deepEqual(codexArgs({ model: 'gpt-6.1-sol', serviceTier: 'priority', cwd: '/w', disable: ['shell_tool', 'plugins'] }), ['exec', '--json', '-m', 'gpt-6.1-sol', '-c', 'service_tier="priority"',
    '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-c', 'web_search="disabled"', '--disable', 'shell_tool', '--disable', 'plugins', '--color', 'never', '-C', '/w', '-']);
});
