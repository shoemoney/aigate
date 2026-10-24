import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  childEnvironment, createAttemptRoot, nativeHints, ownedArtifacts, parseArgs,
  prepareClipboard, PromptReader, removeAttemptRoot, requestJSON, runSetup, validateServerURL,
} from '../setupscripts/setup.mjs';

// Every credential in this file is synthetic. Tests launch only these fake
// executables and loopback HTTP listeners; no provider CLI or login is invoked.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(REPO, 'setupscripts', 'setup.mjs');
const ADMIN = 'synthetic-admin-private-value';
const KEY = 'unknown-format-private-provider-value';
const UNKNOWN = 'unknown-native-private-value-with-no-standard-prefix';
const AUTH = { auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access-value', refresh_token: 'synthetic-refresh-value', account_id: 'synthetic-account' } };
const CLAUDE = 'sk-ant-oat01-' + 'syntheticOnly_'.repeat(4);

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'aigate-setup-test-'));
  const home = path.join(root, 'home'); const temporary = path.join(root, 'temporary');
  await mkdir(home, { mode: 0o700 }); await mkdir(temporary, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(home, 'preserved.txt'), 'existing synthetic login remains unchanged\n');
  return { root, home, temporary, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, USER: 'synthetic-operator', LOGNAME: 'synthetic-operator', TMPDIR: temporary, AIGATE_TOKEN: ADMIN } };
}

async function loopback(t, behavior = {}) {
  const requests = []; const rows = { '/api/accounts': [], '/api/keys': [], '/api/proxy/credentials': [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const record = { method: req.method, endpoint: req.url, authorization: req.headers.authorization, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined };
      requests.push(record);
      const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (behavior.handle && await behavior.handle(record, res, reply)) return;
      if (record.authorization !== `Bearer ${ADMIN}`) return reply(401, { error: 'synthetic body must stay private' });
      if (!Object.hasOwn(rows, req.url)) return reply(404, {});
      if (req.method === 'GET') return reply(200, behavior.mismatch && requests.some(item => item.method === 'POST') ? [] : rows[req.url]);
      const payload = record.body;
      if (req.url === '/api/keys') {
        const hint = 'synthetic-hint-' + requests.length;
        rows[req.url].push({ id: requests.length, provider: payload.provider, key_hint: hint, label: payload.label });
        return reply(200, { ok: true, provider: payload.provider, hint });
      }
      if (req.url === '/api/accounts') {
        rows[req.url].push({ account: payload.account, kind: payload.kind, label: payload.label });
        return reply(200, { ok: true, account: payload.account, kind: payload.kind });
      }
      const row = { id: requests.length, provider: payload.provider, kind: payload.kind, label: payload.label, fields: Object.keys(payload.fields) };
      rows[req.url].push(row); return reply(201, row);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, rows };
}

function launch(args, env, input) {
  const child = spawn(process.execPath, [RUNNER, ...args], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('synthetic setup subprocess exceeded test deadline')); }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, output: stdout + stderr }); });
  });
  child.stdin.on('error', () => {});
  if (input !== undefined) child.stdin.end(input);
  return { child, result, readOutput: () => stdout + stderr };
}

async function fakeCLI(box, body) {
  const executable = path.join(box.root, 'fake-native-cli');
  await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}

async function waitFor(check, timeout = 5_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('synthetic test condition did not arrive');
}

async function rootsRemoved(box) {
  assert.deepEqual(await readdir(box.temporary), [], 'owned attempt directories must be removed');
  assert.equal(await readFile(path.join(box.home, 'preserved.txt'), 'utf8'), 'existing synthetic login remains unchanged\n');
  assert.deepEqual(await readdir(box.home), ['preserved.txt']);
}

test('argument and URL validation do not accept secret CLI options, redirect origins, or public HTTP', () => {
  assert.deepEqual(parseArgs(['openrouter', '--once', '--url', 'https://vault.example', '--label', 'work']), { id: 'openrouter', once: true, clipboard: false, deviceAuth: false, auth: 'native', url: 'https://vault.example', label: 'work' });
  for (const args of [['openrouter', '--token', KEY], ['codex', '--account', 'name/other'], ['codex', '--auth', 'invented'], ['codex', '--url', '--once']]) assert.throws(() => parseArgs(args));
  for (const origin of ['http://example.com', 'http://169.254.1.2', 'http://user:pass@localhost', 'https://vault.example/path', 'https://vault.example?token=secret', 'file:///tmp/credential']) assert.throws(() => validateServerURL(origin));
  for (const origin of ['http://127.0.0.1:20200', 'http://localhost:20200', 'http://192.168.1.10:20200', 'http://10.2.3.4', 'http://172.16.2.3', 'http://[::1]:20200', 'https://vault.example']) assert.equal(validateServerURL(origin), new URL(origin).origin);
});

test('native environment preserves home identity while stripping credentials and loader/proxy hooks', () => {
  const env = childEnvironment({ PATH: '/usr/bin:/bin', HOME: '/synthetic/real-home', USERPROFILE: '/synthetic/profile', USER: 'operator', LOGNAME: 'operator', AIGATE_TOKEN: ADMIN, ANTHROPIC_AUTH_TOKEN: KEY, AWS_ACCESS_KEY_ID: KEY, SOMETHING_SECRET: KEY, CODEX_HOME: '/real/codex', XDG_CONFIG_HOME: '/real/config', NODE_OPTIONS: '--require=/outside/loader', HTTPS_PROXY: 'http://secret', AIGATE_SETUP_CODEX_BIN: '/fake/cli' }, '/owned/root');
  assert.equal(env.HOME, '/synthetic/real-home'); assert.equal(env.USERPROFILE, '/synthetic/profile');
  assert.equal(env.USER, 'operator'); assert.equal(env.LOGNAME, 'operator');
  assert.equal(env.XDG_CONFIG_HOME, '/owned/root/config'); assert.equal(env.TMPDIR, '/owned/root');
  for (const key of ['AIGATE_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'SOMETHING_SECRET', 'CODEX_HOME', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(env[key], undefined);
  assert.equal(env.AIGATE_SETUP_CODEX_BIN, '/fake/cli');
});

test('bounded owned readers reject traversal, symlinks, hard links, directories and oversized artifacts', async t => {
  const box = await sandbox(t); const root = await createAttemptRoot(box.temporary);
  await mkdir(path.join(root, 'codex')); await writeFile(path.join(root, 'codex/auth.json'), '{"synthetic":true}', { mode: 0o644 });
  const readers = await ownedArtifacts(root);
  assert.equal(await readers.readOwnedFile('codex/auth.json'), '{"synthetic":true}');
  assert.equal((await lstat(path.join(root, 'codex/auth.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readers.listOwnedFiles('codex'), ['codex/auth.json']);
  for (const relative of ['../home/preserved.txt', '/etc/passwd', 'codex/../auth.json', 'codex\\auth.json', 'codex//auth.json']) await assert.rejects(readers.readOwnedFile(relative));
  await symlink(path.join(box.home, 'preserved.txt'), path.join(root, 'codex/outside.json'));
  await assert.rejects(readers.readOwnedFile('codex/outside.json'));
  await assert.rejects(readers.listOwnedFiles('codex'));
  await link(path.join(box.home, 'preserved.txt'), path.join(root, 'hardlink.json'));
  await assert.rejects(readers.readOwnedFile('hardlink.json'));
  await writeFile(path.join(root, 'oversized.json'), 'x'.repeat(65_537));
  await assert.rejects(readers.readOwnedFile('oversized.json'));
  await assert.rejects(readers.readOwnedFile('codex'));
  await removeAttemptRoot(root); await rootsRemoved(box);
});

test('native output exposes only safe auth hints and blocks unknown secrets across chunks and JSON forms', () => {
  let result = ''; const hints = nativeHints({ write(value) { result += value; } });
  for (const chunk of ['unknown-native-', 'private-value-with-no-standard-prefix\n', '{"access_token":"', UNKNOWN, '"}\n', 'setup_token: ' + CLAUDE + '\n', 'Visit https://auth.openai.com/codex/device\n', 'User code: ABCD-EFGH\n', 'https://auth.openai.com/codex/device?access_token=' + UNKNOWN + '\n', 'arbitrary text never copied\n']) hints.write(chunk);
  hints.end();
  assert.match(result, /Verification page.*https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(result, /Verification code: ABCD-EFGH/);
  for (const secret of [UNKNOWN, CLAUDE, 'arbitrary text never copied', 'access_token']) assert.ok(!result.includes(secret));
});

const nativeDeviceFixtures = [
  {
    provider: 'Codex',
    text: '\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGH\n',
    codes: ['ABCD-EFGH'],
  },
  {
    provider: 'Grok',
    text: 'Confirm this code in your browser:\n\n  IJKL-MNOP\nThen enter this code:\n\n  QRST-UVWX\n',
    codes: ['IJKL-MNOP', 'QRST-UVWX'],
  },
  {
    provider: 'Kimi',
    text: 'Opening browser for Kimi device login: https://auth.kimi.com/device\nIf the browser did not open, paste the URL above and enter code: ABCD1234\n',
    codes: ['ABCD1234'],
    page: 'https://auth.kimi.com/device',
  },
  {
    provider: 'Muse',
    text: 'Open this page to sign in:\n  https://auth.meta.com/device\nConfirm this code matches:\n  YZ12-AB34\nEnter this code:\n  CD56-EF78\n\x1b[1mconfirm this code matches:\x1b[0m\n\n  \x1b[36mGH90-IJ12\x1b[0m\nand enter this code: KL34-MN56\n',
    codes: ['YZ12-AB34', 'CD56-EF78', 'GH90-IJ12', 'KL34-MN56'],
    page: 'https://auth.meta.com/device',
  },
];

for (const fixture of nativeDeviceFixtures) {
  test(`native hints preserve actual ${fixture.provider} device-code instructions across chunk boundaries`, () => {
    let output = ''; const hints = nativeHints({ write(value) { output += value; } });
    // Three-byte chunks split labels, codes, URL schemes, and ANSI sequences.
    for (let i = 0; i < fixture.text.length; i += 3) hints.write(fixture.text.slice(i, i + 3));
    hints.end();
    for (const code of fixture.codes) assert.ok(output.includes(`Verification code: ${code}\n`));
    if (fixture.page) assert.ok(output.includes(fixture.page));
    assert.equal((output.match(/Verification code:/g) || []).length, fixture.codes.length);
    assert.ok(!output.includes('expires in 15 minutes')); assert.ok(!output.includes('\x1b'));
  });
}

test('standalone device codes require fresh exact vendor context and reject secrets, JWTs, and expired windows', () => {
  const label = 'Then enter this code:';
  const jwt = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.signature';
  const rejected = [
    'ABCD-EFGH\n', // no preceding label
    'ABCD1234\n',
    'A label mentioning a code:\nABCD-EFGH\n',
    label + '\n\n\n\nABCD-EFGH\n', // three blank lines expire the window
    label + '\nUnrecognized native output\nABCD-EFGH\n',
    label + '\naccess_token=' + UNKNOWN + '\nABCD-EFGH\n',
    label + '\n{"access_token":"' + UNKNOWN + '"}\nABCD-EFGH\n',
    label + '\n' + CLAUDE + '\nABCD-EFGH\n',
    label + '\n' + jwt + '\nABCD-EFGH\n',
    label + '\n' + 'A'.repeat(64) + '\nABCD-EFGH\n',
    label + '\nABCD_EFGH\n',
    label + '\nabcd-efgh\n',
    label + '\nABCD-EFGH private-extra-output\n',
    label + ' ' + UNKNOWN + '\nABCD-EFGH\n',
  ];
  for (const text of rejected) {
    let output = ''; const hints = nativeHints({ write(value) { output += value; } });
    for (let i = 0; i < text.length; i += 5) hints.write(text.slice(i, i + 5));
    hints.end(); assert.equal(output, '', 'unknown or expired code context must stay private');
  }
  let output = ''; const hints = nativeHints({ write(value) { output += value; } });
  hints.write(label + '\n' + 'X'.repeat(16_385)); hints.write('\nABCD-EFGH\n'); hints.end();
  assert.equal(output, '', 'a discarded oversized line must also clear code context');
});

test('contextual device codes allow two blank lines and flush a final code without a newline', () => {
  let output = ''; const hints = nativeHints({ write(value) { output += value; } });
  hints.write('Then enter this code:\n\n\n  ABCD-EFGH'); hints.end();
  assert.equal(output, 'Verification code: ABCD-EFGH\n');
});

test('normal Codex and Claude OAuth authorization URLs remain usable for private-window account selection', () => {
  const urls = [
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_synthetic&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email+offline_access&code_challenge=' + 's'.repeat(43) + '&code_challenge_method=S256&codex_cli_simplified_flow=true&state=synthetic_state_value_123&originator=codex_cli_rs',
    'https://claude.ai/oauth/authorize?code=true&client_id=synthetic-client-id&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference+user%3Aprofile+user%3Asessions%3Aclaude_code&code_challenge=' + 'c'.repeat(43) + '&code_challenge_method=S256&state=synthetic_state_value_456',
  ];
  let output = ''; const hints = nativeHints({ write(value) { output += value; } });
  for (const url of urls) { hints.write(url.slice(0, 60)); hints.write(url.slice(60) + '\n'); }
  hints.write('api_key=' + UNKNOWN + '\n'); hints.write('secret=https://auth.openai.com/codex/device\n'); hints.end();
  for (const url of urls) assert.ok(output.includes(url));
  assert.match(output, /private\/incognito/); assert.ok(!output.includes(UNKNOWN)); assert.ok(!output.includes('secret='));
});

test('terminal secret input stays hidden and confirmations require input after the prompt', async () => {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  let output = ''; const prompts = new PromptReader(input, { write(value) { output += value; } });
  const secret = prompts.ask('Secret', { secret: true }); input.write(KEY + '\r\nyes\r\n');
  assert.equal(await secret, KEY); assert.ok(!output.includes(KEY));
  let resolved = false;
  const confirm = prompts.ask('Confirm', { fresh: true }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(resolved, false, 'pasted confirmation cannot silently authorize a save');
  input.write('yes\r'); assert.equal(await confirm, 'yes');
  prompts.close(); input.destroy();
});

test('TTY raw mode and pending secret state are active before the prompt becomes visible', async () => {
  const input = new PassThrough(); input.isTTY = true; let raw = false; let prompts;
  input.setRawMode = value => { raw = value; };
  let output = '';
  prompts = new PromptReader(input, { write(value) {
    output += value;
    if (value.includes('Secret: ')) {
      assert.equal(raw, true); assert.equal(prompts.pending.secret, true);
      input.write(KEY + '\r');
    }
  } });
  assert.equal(await prompts.ask('Secret', { secret: true }), KEY);
  assert.equal(raw, false); assert.ok(!output.includes(KEY)); prompts.close(); input.destroy();
});

test('HTTP transport never follows redirects and does not print error bodies', async t => {
  let followed = false;
  const api = await loopback(t, { handle(record, res, reply) {
    if (record.endpoint === '/redirect') { res.writeHead(302, { location: '/stolen' }); res.end(UNKNOWN); return true; }
    if (record.endpoint === '/stolen') followed = true;
    if (record.endpoint === '/slow') { setTimeout(() => { if (!res.destroyed) reply(200, []); }, 150); return true; }
  } });
  await assert.rejects(requestJSON(api.origin, ADMIN, '/redirect'), error => /HTTP 302/.test(error.message) && !error.message.includes(UNKNOWN));
  assert.equal(followed, false);
  await assert.rejects(requestJSON(api.origin, ADMIN, '/slow', { timeout: 20 }), /timed out/);
});

test('API-key setup sends the exact manual intake, reads metadata back and removes the private root', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const run = launch(['openrouter', '--once', '--url', api.origin, '--label', 'synthetic work key'], box.env, KEY + '\nyes\n');
  const result = await run.result;
  assert.equal(result.code, 0, result.output); assert.match(result.stdout, /Saved to AIGate/);
  assert.deepEqual(api.requests.map(row => row.method), ['GET', 'POST', 'GET']);
  assert.deepEqual(api.requests[1].body, { provider: 'openrouter', key: KEY, label: 'synthetic work key' });
  for (const secret of [KEY, ADMIN]) assert.ok(!result.output.includes(secret));
  await rootsRemoved(box);
});

test('AWS fields keep the access key, secret, session token and region in one typed bundle', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const values = ['synthetic-access-id', 'synthetic-aws-secret', '', 'synthetic-session-token', 'yes'];
  const result = await launch(['aws', '--once', '--url', api.origin, '--label', 'synthetic AWS'], box.env, values.join('\n') + '\n').result;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(api.requests[1].body, { provider: 'aws', kind: 'aws_sigv4', fields: { access_key_id: values[0], secret_access_key: values[1], region: 'us-east-1', session_token: values[3] }, label: 'synthetic AWS' });
  assert.match(result.stdout, /storage only/);
  for (const secret of values.slice(0, 2).concat(values[3])) assert.ok(!result.output.includes(secret));
  await rootsRemoved(box);
});

test('Codex repeated accounts use distinct roots, preserve HOME, strip secrets and send create_only', async t => {
  const box = await sandbox(t); const api = await loopback(t); const log = path.join(box.root, 'fake-log.jsonl');
  const fake = await fakeCLI(box, `const fs=require('node:fs'); const p=require('node:path');\nconst root=process.cwd();fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({root,home:process.env.HOME,uidMode:fs.statSync(root).mode&511,hasAdmin:!!process.env.AIGATE_TOKEN,hasProvider:!!process.env.ANTHROPIC_API_KEY,hasOther:!!process.env.PRIVATE_PROVIDER_KEY,hasNodeOptions:!!process.env.NODE_OPTIONS,globalCodex:process.env.CODEX_HOME,args:process.argv.slice(2)})+'\\n');\nfs.mkdirSync(process.env.CODEX_HOME,{recursive:true});fs.writeFileSync(p.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(AUTH))});process.stdout.write(${JSON.stringify(UNKNOWN + '\n')});`);
  const result = await launch(['codex', '--url', api.origin, '--account', 'first', '--label', 'first label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake, ANTHROPIC_API_KEY: KEY, PRIVATE_PROVIDER_KEY: KEY, CODEX_HOME: path.join(box.home, 'real-codex') }, 'yes\nyes\nsecond\nsecond label\nyes\nno\n').result;
  assert.equal(result.code, 0, result.output);
  const logs = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(logs.length, 2); assert.notEqual(logs[0].root, logs[1].root);
  for (const entry of logs) {
    assert.equal(entry.home, box.home); assert.equal(entry.uidMode, 0o700);
    assert.equal(entry.hasAdmin, false); assert.equal(entry.hasProvider, false); assert.equal(entry.hasOther, false); assert.equal(entry.hasNodeOptions, false);
    assert.equal(entry.globalCodex, path.join(entry.root, 'codex'));
    assert.ok(!JSON.stringify(entry.args).includes(ADMIN));
    await assert.rejects(lstat(entry.root), { code: 'ENOENT' });
  }
  const posts = api.requests.filter(row => row.method === 'POST');
  assert.deepEqual(posts.map(row => row.body), [
    { account: 'first', kind: 'codex', auth_json: AUTH, label: 'first label', create_only: true },
    { account: 'second', kind: 'codex', auth_json: AUTH, label: 'second label', create_only: true },
  ]);
  for (const secret of [UNKNOWN, AUTH.tokens.access_token, AUTH.tokens.refresh_token, ADMIN]) assert.ok(!result.output.includes(secret));
  await rootsRemoved(box);
});

test('Claude setup token printed across native chunks stays private and uses account intake', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const fake = await fakeCLI(box, `process.stdout.write(${JSON.stringify(UNKNOWN.slice(0, 18))});setTimeout(()=>{process.stdout.write(${JSON.stringify(UNKNOWN.slice(18) + '\n{"arbitrary":"' + UNKNOWN + '"}\n' + CLAUDE.slice(0, 16))});setTimeout(()=>{process.stdout.write(${JSON.stringify(CLAUDE.slice(16) + '\n')});},10);},10);`);
  const result = await launch(['claude-code', '--once', '--url', api.origin, '--account', 'claude-new', '--label', 'Claude label'], { ...box.env, AIGATE_SETUP_CLAUDE_BIN: fake }, 'yes\n').result;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(api.requests[1].body, { account: 'claude-new', kind: 'claude', setup_token: CLAUDE, label: 'Claude label', create_only: true });
  for (const secret of [CLAUDE, UNKNOWN, ADMIN]) assert.ok(!result.output.includes(secret));
  await rootsRemoved(box);
});

test('native OAuth bundles use the distinct provider ID and storage-only proxy-credential intake', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const bundle = { providers: { meta: { access_token: 'synthetic-meta-access', refresh_token: 'synthetic-meta-refresh', mechanism: 'oauth' } } };
  const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(p.dirname(process.env.MUSE_AUTH_PATH),{recursive:true});fs.writeFileSync(process.env.MUSE_AUTH_PATH,${JSON.stringify(JSON.stringify(bundle))});`);
  const result = await launch(['muse', '--once', '--url', api.origin, '--label', 'Muse native'], { ...box.env, AIGATE_SETUP_MUSE_BIN: fake }, 'yes\nyes\n').result;
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(api.requests.map(row => row.endpoint), ['/api/proxy/credentials', '/api/proxy/credentials', '/api/proxy/credentials']);
  assert.deepEqual(api.requests[1].body, { provider: 'muse-code', kind: 'bundle', fields: { auth_json: JSON.stringify(bundle) }, label: 'Muse native' });
  assert.match(result.stdout, /storage only/); assert.ok(!result.output.includes(bundle.providers.meta.access_token));
  await rootsRemoved(box);
});

test('failed preflight or duplicate account prevents native login and manual secret prompts', async t => {
  const box = await sandbox(t); const marker = path.join(box.root, 'should-not-run');
  const fake = await fakeCLI(box, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`);
  const api = await loopback(t, { handle(record, res, reply) { reply(502, { error: UNKNOWN }); return true; } });
  const failed = await launch(['codex', '--once', '--url', api.origin, '--account', 'new', '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, 'yes\n').result;
  assert.notEqual(failed.code, 0); assert.match(failed.output, /HTTP 502/); assert.ok(!failed.output.includes(UNKNOWN));
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  const duplicate = await loopback(t); duplicate.rows['/api/accounts'].push({ account: 'existing', kind: 'codex' });
  const result = await launch(['codex', '--once', '--url', duplicate.origin, '--account', 'existing', '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, 'yes\n').result;
  assert.notEqual(result.code, 0); assert.match(result.output, /already exists/); assert.equal(duplicate.requests.length, 1);
  await assert.rejects(lstat(marker), { code: 'ENOENT' }); await rootsRemoved(box);
});

test('failed POST and mismatched metadata never report a verified save and still clean up', async t => {
  const box = await sandbox(t);
  for (const mode of ['post', 'readback']) {
    const api = await loopback(t, { mismatch: mode === 'readback', handle(record, res, reply) { if (mode === 'post' && record.method === 'POST') { reply(503, { error: UNKNOWN, key: KEY }); return true; } } });
    const result = await launch(['openrouter', '--once', '--url', api.origin, '--label', 'label'], box.env, KEY + '\nyes\n').result;
    assert.notEqual(result.code, 0); assert.ok(!result.output.includes('Saved to AIGate')); assert.match(result.output, /no successful save was verified/);
    for (const secret of [UNKNOWN, KEY]) assert.ok(!result.output.includes(secret)); await rootsRemoved(box);
  }
});

test('declined save, EOF and native failure remove credentials and never POST', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  for (const mode of ['decline', 'eof', 'failure']) {
    const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});fs.writeFileSync(p.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(AUTH))});process.stderr.write(${JSON.stringify(UNKNOWN + '\n')});${mode === 'failure' ? 'process.exitCode=7;' : ''}`);
    const result = await launch(['codex', '--once', '--url', api.origin, '--account', 'new-' + mode, '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, mode === 'decline' ? 'no\n' : '').result;
    assert.notEqual(result.code, 0); assert.ok(!result.output.includes('Saved to AIGate')); assert.ok(!result.output.includes(UNKNOWN)); await rootsRemoved(box);
  }
  assert.ok(api.requests.every(row => row.method === 'GET'));
});

test('malformed, symlinked and oversized native artifacts are rejected without touching existing home', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  for (const mode of ['malformed', 'symlink', 'oversized']) {
    const artifact = mode === 'malformed' ? `fs.writeFileSync(target,'{invalid-json');` : mode === 'symlink' ? `fs.symlinkSync(${JSON.stringify(path.join(box.home, 'preserved.txt'))},target);` : `fs.writeFileSync(target,'x'.repeat(65537));`;
    const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});const target=p.join(process.env.CODEX_HOME,'auth.json');${artifact}`);
    const result = await launch(['codex', '--once', '--url', api.origin, '--account', 'new-' + mode, '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, 'yes\n').result;
    assert.notEqual(result.code, 0); assert.match(result.output, /supported, bounded credential artifacts/); await rootsRemoved(box);
  }
  assert.ok(api.requests.every(row => row.method === 'GET'));
});

test('a FIFO artifact left by an exited native login is rejected before the parent deadline', { skip: process.platform === 'win32' }, async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const log = path.join(box.root, 'fifo-native-exit.json');
  const unrelated = path.join(box.root, 'unrelated.txt');
  await writeFile(unrelated, 'unrelated synthetic file remains unchanged\n');
  const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});const target=p.join(process.env.CODEX_HOME,'auth.json');require('node:child_process').execFileSync('mkfifo',[target]);fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,root:process.cwd(),fifo:fs.lstatSync(target).isFIFO()}));`);
  const run = launch(['codex', '--once', '--url', api.origin, '--account', 'fifo-account', '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, 'yes\n');
  let forced = false;
  // A blocking open cannot be cancelled by the runner's signal handler. Keep
  // the deadline in this parent and force-kill so the regression cannot hang.
  const deadline = setTimeout(() => { forced = true; run.child.kill('SIGKILL'); }, 5_000);
  t.after(() => { clearTimeout(deadline); run.child.kill('SIGKILL'); });
  const result = await run.result.finally(() => clearTimeout(deadline));
  assert.equal(forced, false, 'FIFO collection must finish without the parent SIGKILL fallback');
  const details = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(details.fifo, true, 'the fake native login must create a real FIFO with no writer');
  assert.throws(() => process.kill(details.pid, 0), { code: 'ESRCH' });
  assert.notEqual(result.code, 0); assert.match(result.output, /supported, bounded credential artifacts/);
  assert.ok(!result.output.includes('Saved to AIGate'));
  assert.ok(api.requests.every(row => row.method === 'GET'));
  await assert.rejects(lstat(details.root), { code: 'ENOENT' });
  assert.equal(await readFile(unrelated, 'utf8'), 'unrelated synthetic file remains unchanged\n');
  await rootsRemoved(box);
});

test('SIGINT, SIGTERM and SIGHUP terminate and wait for the owned native process before cleanup', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const log = path.join(box.root, 'signal-' + signal + '.json');
    const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});fs.writeFileSync(p.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(AUTH))});fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,root:process.cwd()}));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),40));setInterval(()=>{},1000);`);
    const run = launch(['codex', '--once', '--url', api.origin, '--account', 'signal-' + signal, '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake });
    const details = await waitFor(async () => { try { return JSON.parse(await readFile(log, 'utf8')); } catch { return false; } });
    run.child.kill(signal); const result = await run.result;
    assert.equal(result.code, 130, result.output); assert.ok(!result.output.includes('Saved to AIGate'));
    assert.throws(() => process.kill(details.pid, 0), { code: 'ESRCH' });
    await assert.rejects(lstat(details.root), { code: 'ENOENT' }); await rootsRemoved(box);
  }
});

test('an exited native leader escalates its TERM-ignoring helper before collecting and cleaning credentials', async t => {
  const box = await sandbox(t); const api = await loopback(t);
  const log = path.join(box.root, 'helper-ready.json');
  const helper = `const fs=require('node:fs');const p=require('node:path');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,root:process.cwd()}));setInterval(()=>fs.writeFileSync(p.join(process.cwd(),'helper-is-live'),'synthetic'),25);process.send('ready');`;
  const fake = await fakeCLI(box, `const fs=require('node:fs');const p=require('node:path');fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});fs.writeFileSync(p.join(process.env.CODEX_HOME,'auth.json'),${JSON.stringify(JSON.stringify(AUTH))});const helper=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit','ipc']});helper.once('message',()=>process.exit(0));`);
  const started = Date.now();
  const result = await launch(['codex', '--once', '--url', api.origin, '--account', 'helper-account', '--label', 'label'], { ...box.env, AIGATE_SETUP_CODEX_BIN: fake }, 'yes\n').result;
  assert.equal(result.code, 0, result.output);
  assert.ok(Date.now() - started < 8_000, 'helper pipes must close after the short termination grace, without waiting for the login deadline');
  assert.equal(api.requests.filter(row => row.method === 'POST').length, 1);
  const details = JSON.parse(await readFile(log, 'utf8'));
  await assert.rejects(lstat(details.root), { code: 'ENOENT' });
  await new Promise(resolve => setTimeout(resolve, 100));
  await rootsRemoved(box);
});

test('clipboard mode needs no admin token, accepts literal saved only and clears only its own value', async t => {
  for (const acknowledgement of ['saved', 'yes']) {
    const input = new PassThrough(); input.end(KEY + '\nyes\n' + acknowledgement + '\n');
    let output = ''; let copied; let clears = 0;
    const action = runSetup(['openrouter', '--once', '--clipboard', '--label', 'label'], { env: {}, input, output: { write(value) { output += value; } }, error: { write(value) { output += value; } }, clipboardFactory: async () => ({ copy: async value => { copied = value; }, read: async () => copied, clear: async () => { clears++; } }) });
    if (acknowledgement === 'saved') await action; else await assert.rejects(action, /not acknowledged/);
    assert.equal(copied, KEY); assert.equal(clears, 1); assert.ok(!output.includes(KEY)); assert.ok(!output.includes('administrator token')); assert.ok(!output.includes('Saved to AIGate'));
    if (acknowledgement === 'saved') assert.match(output, /Operator confirmed/);
  }
  const input = new PassThrough(); input.end(KEY + '\nyes\nsaved\n'); let clears = 0;
  await runSetup(['openrouter', '--once', '--clipboard', '--label', 'label'], { env: {}, input, output: { write() {} }, clipboardFactory: async () => ({ copy: async () => {}, read: async () => 'someone else changed this', clear: async () => { clears++; } }) });
  assert.equal(clears, 0);
});

test('missing clipboard support fails before prompts or native login and never falls back silently', async () => {
  let output = ''; let nativeCalls = 0;
  await assert.rejects(runSetup(['codex', '--clipboard', '--once'], { env: {}, input: new PassThrough(), output: { write(value) { output += value; } }, native: () => { nativeCalls++; }, clipboardFactory: async () => { throw new Error('synthetic missing clipboard'); } }));
  assert.equal(output, ''); assert.equal(nativeCalls, 0);
});

test('clipboard preflight rejects an executable directory before any login', { skip: process.platform !== 'darwin' }, async t => {
  const box = await sandbox(t);
  await assert.rejects(prepareClipboard({ PATH: '/usr/bin:/bin', AIGATE_SETUP_PBCOPY_BIN: box.root, AIGATE_SETUP_PBPASTE_BIN: '/usr/bin/pbpaste' }), /requires both clipboard/);
});
