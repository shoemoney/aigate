import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareNativeLogin } from '../setupscripts/native-login.mjs';

const runFile = promisify(execFile);
const vars = { codex: 'CODEX', 'claude-code': 'CLAUDE', muse: 'MUSE', 'kimi-code': 'KIMI', grok: 'GROK' };
const codexAuth = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { access_token: 'fake-access', refresh_token: 'fake-refresh', account_id: 'fake-account', id_token: '' }, native_metadata: { keep: true } };
const museAuth = { version: 1, providers: { meta: { api_key: 'fake-api', access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: 1900000000, native_metadata: { keep: true } } } };
const kimiConfig = 'default_model = "kimi-for-coding"\n\n[providers.kimi]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\n\n[providers.kimi.oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n';
const kimiToken = { access_token: 'fake-access', refresh_token: 'fake-refresh', expires_at: 1900000000, scope: 'kimi:code', token_type: 'Bearer', expires_in: 86400 };
const grokAuth = { 'https://auth.x.ai': { key: 'fake-key', auth_mode: 'oidc', create_time: '2026-10-24T00:00:00Z', user_id: 'fake-user', refresh_token: 'fake-refresh', expires_at: '2030-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'fake-client', native_metadata: { keep: true } } };

function fixture(t, id, source = '') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aigate-native-test-')));
  chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-cli.mjs');
  writeFileSync(binary, `#!${process.execPath}\nimport { mkdirSync, writeFileSync } from 'node:fs';\nimport { dirname, join } from 'node:path';\nconst save = (path, value) => { mkdirSync(dirname(path), {recursive:true,mode:0o700}); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), {mode:0o600}); };\n${source}\nsave(join(process.cwd(), 'observed.json'), {args:process.argv.slice(2),cwd:process.cwd(),env:process.env});\n`, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: '/fake-os-home', USER: 'fake-user', LOGNAME: 'fake-user',
    [`AIGATE_SETUP_${vars[id]}_BIN`]: binary,
    ANTHROPIC_API_KEY: 'parent-api-secret', ANTHROPIC_AUTH_TOKEN: 'parent-auth-secret',
    ANTHROPIC_BASE_URL: 'https://unexpected.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth-secret',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
    CODEX_HOME: '/parent/codex', META_API_KEY: 'parent-meta-secret', MUSE_AUTH_PATH: '/parent/muse',
    KIMI_CODE_HOME: '/parent/kimi', KIMI_SHARE_DIR: '/parent/legacy-kimi', GROK_AUTH_PATH: '/parent/grok',
    AWS_SHARED_CREDENTIALS_FILE: '/parent/aws', GOOGLE_APPLICATION_CREDENTIALS: '/parent/google',
    AIGATE_TOKEN: 'parent-vault-secret', AIGATE_ENCRYPTION_KEY: 'parent-key-secret',
  };
  return { root, binary, env };
}
function readers(root) {
  return {
    readOwnedFile: async path => readFileSync(join(root, path), 'utf8'),
    listOwnedFiles: async path => readdirSync(join(root, path), { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => `${path}/${entry.name}`).sort(),
  };
}
function materialReaders(files) {
  return {
    readOwnedFile: async path => {
      if (!Object.hasOwn(files, path)) throw new Error('missing private file');
      return files[path];
    },
    listOwnedFiles: async directory => Object.keys(files).filter(path => path.startsWith(directory + '/')),
  };
}

test('all native plans use isolated credential roots while preserving the child OS identity', async t => {
  for (const id of Object.keys(vars)) {
    const { root, env, binary } = fixture(t, id);
    const plan = prepareNativeLogin(id, { root, env });
    assert.equal(plan.command, binary);
    for (const key of ['HOME', 'USERPROFILE', 'USER', 'LOGNAME']) assert.equal(plan.env[key], env[key]);
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'GROK_HOME'].filter(key => plan.env[key])) {
      assert.ok(plan.env[key].startsWith(root + '/'));
      assert.ok(statSync(plan.env[key]).isDirectory());
      assert.equal(statSync(plan.env[key]).mode & 0o777, 0o700);
    }
    for (const value of Object.values(plan.env)) assert.ok(!String(value).includes('parent-') && !String(value).startsWith('/parent/'));
    assert.ok(!Object.keys(plan.env).some(key => key.startsWith('AIGATE_')));
    assert.ok(!JSON.stringify(plan.args).includes('fake-'));
    await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
    const observed = JSON.parse(readFileSync(join(root, 'observed.json'), 'utf8'));
    assert.equal(observed.cwd, root);
    assert.deepEqual(observed.args, plan.args);
  }
});

test('Codex file-store login collects the entire OAuth auth.json and supports device auth', async t => {
  const { root, env } = fixture(t, 'codex', `if (!process.getBuiltinModule('node:fs').statSync(process.env.CODEX_HOME).isDirectory()) process.exit(42);\nsave(join(process.env.CODEX_HOME, 'auth.json'), ${JSON.stringify(codexAuth)});`);
  const plan = prepareNativeLogin('codex', { root, env, deviceAuth: true });
  assert.deepEqual(plan.args, ['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']);
  assert.equal(plan.env.CODEX_HOME, join(root, 'codex'));
  await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  assert.deepEqual(await plan.collect(readers(root)), { kind: 'codex', auth_json: codexAuth });
});

test('Codex rejects API-key-only, missing-refresh, unresolved-account, malformed and missing files', async t => {
  const { root, env } = fixture(t, 'codex');
  const plan = prepareNativeLogin('codex', { root, env });
  const bad = [
    { OPENAI_API_KEY: 'fake-api-key' }, { tokens: { access_token: 'a', account_id: 'id' } },
    { tokens: { access_token: 'a', refresh_token: 'r' } }, null, [],
  ];
  for (const value of bad) await assert.rejects(plan.collect(materialReaders({ 'codex/auth.json': JSON.stringify(value) })), /Codex/);
  for (const text of ['{invalid', '', ' '.repeat(65537), JSON.stringify({ token: 'sensitive-invalid-data' })]) {
    await assert.rejects(plan.collect(materialReaders({ 'codex/auth.json': text })), error => !error.message.includes('sensitive-invalid-data'));
  }
  await assert.rejects(plan.collect(materialReaders({})), /could not be read/);
});

test('Claude setup-token collects one printed token without a credential-file read', async t => {
  const token = 'sk-ant-oat01-' + 'fake_test_token_'.repeat(4);
  const { root, env } = fixture(t, 'claude-code', `process.stderr.write(${JSON.stringify('\u001b[32mYour OAuth token:\n' + token + '\u001b[0m\n')});`);
  const plan = prepareNativeLogin('claude-code', { root, env });
  assert.deepEqual(plan.args, ['setup-token']);
  assert.equal(plan.env.CLAUDE_CONFIG_DIR, join(root, 'claude'));
  assert.equal(plan.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, join(root, 'claude'));
  const output = await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  assert.deepEqual(await plan.collect({ ...output, readOwnedFile: () => assert.fail('setup-token must not read credentials') }), { kind: 'claude', setup_token: token });
  await assert.rejects(plan.collect({ stdout: 'browser-code#state' }), /exactly one complete/);
  await assert.rejects(plan.collect({ stdout: token + '\n' + token + 'different' }), /exactly one complete/);
  assert.deepEqual(await plan.collect({ stdout: token, stderr: token }), { kind: 'claude', setup_token: token });
});

test('Muse uses the native file backend and preserves all providers.meta fields', async t => {
  const { root, env } = fixture(t, 'muse', `save(join(process.env.XDG_CONFIG_HOME, 'muse', 'auth.json'), ${JSON.stringify(museAuth)});`);
  const plan = prepareNativeLogin('muse', { root, env });
  assert.deepEqual(plan.args, ['login']);
  assert.equal(plan.env.TBH_CREDENTIAL_BACKEND, 'file');
  assert.equal(plan.env.MUSE_NO_AUTO_UPDATE, '1');
  assert.equal(plan.env.MUSE_AUTH_PATH, join(root, 'config', 'muse', 'auth.json'));
  assert.equal(plan.env.META_API_KEY, undefined);
  await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  const result = await plan.collect(readers(root));
  assert.equal(result.kind, 'bundle');
  assert.deepEqual(JSON.parse(result.fields.auth_json), museAuth);
  const apiWithOptionalOAuth = { providers: { meta: { api_key: 'fake-api', access_token: 'fake-launcher-token', expires_at: 1900000000 } } };
  const apiMaterial = await plan.collect(materialReaders({ 'config/muse/auth.json': JSON.stringify(apiWithOptionalOAuth) }));
  assert.deepEqual(JSON.parse(apiMaterial.fields.auth_json), apiWithOptionalOAuth);
  for (const auth of [{ access_token: 'flat-format-is-unsupported' }, { providers: { meta: {} } }, { providers: { meta: { api_key: 'fake-api', access_token: 1 } } }]) await assert.rejects(plan.collect(materialReaders({ 'config/muse/auth.json': JSON.stringify(auth) })), /Muse/);
});

test('Kimi uses current KIMI_CODE_HOME and preserves config plus OAuth files as one bundle', async t => {
  const { root, env } = fixture(t, 'kimi-code', `save(join(process.env.KIMI_CODE_HOME, 'config.toml'), ${JSON.stringify(kimiConfig)});\nsave(join(process.env.KIMI_CODE_HOME, 'credentials', 'kimi-code.json'), ${JSON.stringify(kimiToken)});`);
  const plan = prepareNativeLogin('kimi-code', { root, env });
  assert.deepEqual(plan.args, ['login']);
  assert.equal(plan.env.KIMI_CODE_HOME, join(root, 'kimi'));
  assert.equal(plan.env.KIMI_CODE_NO_AUTO_UPDATE, '1');
  assert.equal(plan.env.KIMI_SHARE_DIR, plan.env.KIMI_CODE_HOME);
  await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  const result = await plan.collect(readers(root));
  assert.equal(result.kind, 'bundle');
  const stored = JSON.parse(result.fields.auth_bundle_json);
  assert.equal(stored.files['config.toml'], kimiConfig);
  assert.deepEqual(JSON.parse(stored.files['credentials/kimi-code.json']), kimiToken);
});

test('Kimi fails closed on missing, malformed, unsupported, oversized or escaped credential material', async t => {
  const { root, env } = fixture(t, 'kimi-code');
  const plan = prepareNativeLogin('kimi-code', { root, env });
  const valid = { 'kimi/config.toml': kimiConfig, 'kimi/credentials/kimi-code.json': JSON.stringify(kimiToken) };
  for (const config of ['invalid toml', '[providers.kimi.oauth\nstorage="file"', 'oauth = {storage="file", key="x"\n', 'default_model="x"', kimiConfig + 'broken = [arbitrary unquoted text]\n', kimiConfig + 'broken = {missing = }\n', kimiConfig + 'key = "different-file"\n']) await assert.rejects(plan.collect(materialReaders({ ...valid, 'kimi/config.toml': config })), /Kimi/);
  for (const token of ['invalid-json', '[]', '{}', '{"access_token":"a"}']) await assert.rejects(plan.collect(materialReaders({ ...valid, 'kimi/credentials/kimi-code.json': token })), /Kimi/);
  await assert.rejects(plan.collect(materialReaders({ 'kimi/config.toml': kimiConfig })), /Kimi/);
  await assert.rejects(plan.collect({ ...materialReaders(valid), listOwnedFiles: async () => ['kimi/credentials/../../outside.json'] }), /supported OAuth/);
  await assert.rejects(plan.collect(materialReaders({ ...valid, 'kimi/credentials/kimi-code.json': JSON.stringify({ ...kimiToken, excess: 'x'.repeat(65536) }) })), /too large/);
});

test('Grok preserves the native scope map and key field, with optional device auth', async t => {
  const { root, env } = fixture(t, 'grok', `save(process.env.GROK_AUTH_PATH, ${JSON.stringify(grokAuth)});`);
  const plan = prepareNativeLogin('grok', { root, env, deviceAuth: true });
  assert.deepEqual(plan.args, ['login', '--device-auth']);
  assert.equal(plan.env.GROK_HOME, join(root, 'grok'));
  assert.equal(plan.env.GROK_AUTH_PATH, join(root, 'grok', 'auth.json'));
  await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  const result = await plan.collect(readers(root));
  assert.equal(result.kind, 'bundle');
  assert.deepEqual(JSON.parse(result.fields.auth_json), grokAuth);
  for (const auth of [{}, { access_token: 'incorrect-flat-shape' }, { scope: { access_token: 'not-key', auth_mode: 'oidc' } }, { scope: { key: 'x', auth_mode: 'unknown' } }]) await assert.rejects(plan.collect(materialReaders({ 'grok/auth.json': JSON.stringify(auth) })), /Grok/);
});

test('missing native executables and unsupported native ids fail before login', t => {
  const { root, env } = fixture(t, 'codex');
  assert.throws(() => prepareNativeLogin('codex', { root, env: { PATH: root } }), /not installed/);
  assert.throws(() => prepareNativeLogin('codex', { root, env: { ...env, AIGATE_SETUP_CODEX_BIN: join(root, 'missing') } }), /existing executable/);
  assert.throws(() => prepareNativeLogin('codex', { root: '/', env }), /private absolute/);
  assert.throws(() => prepareNativeLogin('unknown', { root, env }), /unsupported/);
});

test('an explicit Muse command receives the no-update flag before any invocation', async t => {
  const { root, env } = fixture(t, 'muse');
  const launcher = join(root, 'muse');
  writeFileSync(launcher, `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.env.MUSE_NO_AUTO_UPDATE !== '1') { fs.writeFileSync('unexpected-install', 'bad'); process.exit(2); }\nfs.writeFileSync('launcher-args.json', JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const safeEnv = { PATH: root, HOME: env.HOME, AIGATE_SETUP_MUSE_BIN: launcher };
  const plan = prepareNativeLogin('muse', { root, env: safeEnv });
  assert.equal(plan.command, launcher);
  await runFile(plan.command, plan.args, { cwd: root, env: plan.env });
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'launcher-args.json'), 'utf8')), ['login']);
  assert.ok(!readdirSync(root).includes('unexpected-install'));
});

test('default Muse bypasses a realistic long bootstrap using its bounded header and installed version', t => {
  const { root, env } = fixture(t, 'muse');
  const launcher = join(root, 'muse');
  const header = '#!/usr/bin/env bash\nchannel="${MUSE_CHANNEL:-muse-stable}"\nchannel_url="https://api.meta.ai/muse-code/channels/$channel"\nupdate_interval="${MUSE_UPDATE_INTERVAL_SECONDS:-3600}"\nlauncher_url="https://api.meta.ai/muse-launcher.sh"\n';
  const source = header + '# bounded-header-padding\n'.repeat(500) + 'if [[ "${MUSE_NO_AUTO_UPDATE:-0}" == 1 ]]; then exit 1; fi\n';
  assert.ok(source.indexOf('MUSE_NO_AUTO_UPDATE') > 8192);
  writeFileSync(launcher, source, { mode: 0o700 });
  const version = '1.4.10-R6427.1';
  writeFileSync(join(root, '.muse-version'), version + '\n', { mode: 0o600 });
  const native = join(root, `muse-bin-${version}`);
  writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), { mode: 0o700 });
  const plan = prepareNativeLogin('muse', { root, env: { PATH: root, HOME: env.HOME } });
  assert.equal(plan.command, native);
  assert.equal(plan.env.MUSE_NO_AUTO_UPDATE, '1');
  assert.deepEqual(plan.args, ['login']);

  rmSync(native);
  assert.throws(() => prepareNativeLogin('muse', { root, env: { PATH: root, HOME: env.HOME } }), /existing native Muse.*AIGATE_SETUP_MUSE_BIN/);
  for (const badVersion of ['', 'invalid', '../../outside']) {
    writeFileSync(join(root, '.muse-version'), badVersion);
    assert.throws(() => prepareNativeLogin('muse', { root, env: { PATH: root, HOME: env.HOME } }), /existing native Muse.*AIGATE_SETUP_MUSE_BIN/);
  }
  rmSync(join(root, '.muse-version'));
  assert.throws(() => prepareNativeLogin('muse', { root, env: { PATH: root, HOME: env.HOME } }), /existing native Muse.*AIGATE_SETUP_MUSE_BIN/);
});

test('default Grok resolves an existing native sibling without executing the npm bootstrap', t => {
  const { root, env } = fixture(t, 'grok');
  const bin = join(root, 'bin');
  process.getBuiltinModule('node:fs').mkdirSync(bin);
  writeFileSync(join(bin, 'grok'), '#!/usr/bin/env node\nrequire("./grok-bootstrap.js");\n', { mode: 0o700 });
  const native = join(bin, 'grok-native');
  writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]), { mode: 0o700 });
  const plan = prepareNativeLogin('grok', { root, env: { PATH: bin, HOME: env.HOME } });
  assert.equal(plan.command, native);
  assert.equal(plan.env.GROK_HOME, join(root, 'grok'));
  assert.deepEqual(plan.args, ['login']);
});

test('credential directory preparation rejects an owned-root symlink collision', t => {
  const { root, env } = fixture(t, 'codex');
  const outside = mkdtempSync(join(tmpdir(), 'aigate-native-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, 'codex'));
  assert.throws(() => prepareNativeLogin('codex', { root, env }), /must not be a symlink/);
  assert.deepEqual(readdirSync(outside), []);
});
