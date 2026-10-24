import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../src/providers.js';
import { SETUP_PROVIDERS, getSetupProvider } from '../setupscripts/providers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'setupscripts');
const SUFFIX = '_aigate_setup_script';
const ALIASES = { claude: 'claude-code', claude_code: 'claude-code', kimi_code: 'kimi-code' };

function sandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aigate setup catalog ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'empty home');
  const bin = join(root, 'test binaries');
  const cwd = join(root, 'unrelated working directory');
  for (const path of [home, bin, cwd]) mkdirSync(path);
  // Exercise the actual macOS system Bash 3.2 through each launcher's shebang.
  symlinkSync('/bin/bash', join(bin, 'bash'));
  return { root, home, bin, cwd, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, TMPDIR: root } };
}

test('setup catalog covers the server registry and existing client vault IDs', () => {
  const ids = new Set(SETUP_PROVIDERS.map(({ id }) => id));
  assert.equal(ids.size, SETUP_PROVIDERS.length, 'duplicate setup provider ID');
  for (const { id } of PROVIDERS) assert.ok(ids.has(id), `server registry provider ${id}`);

  // Discover literal vault lookups, hydration pairs and the documented worker
  // provider list so an existing client ID cannot silently lose its launcher.
  const clientDir = join(ROOT, 'clients');
  const clientIds = new Set();
  for (const name of readdirSync(clientDir).filter((name) => !name.includes('test'))) {
    const path = join(clientDir, name);
    if (!lstatSync(path).isFile()) continue;
    const source = readFileSync(path, 'utf8');
    for (const pattern of [
      /\/api\/keys\/([a-z0-9][a-z0-9_-]*)/g,
      /\bvault_key\s+([a-z0-9][a-z0-9_-]*)/g,
      /\bPROVIDER=([a-z0-9][a-z0-9_-]*)/g,
    ]) {
      for (const match of source.matchAll(pattern)) clientIds.add(match[1]);
    }
    for (const match of source.matchAll(/^PAIRS="([^"]+)"/gm)) {
      for (const pair of match[1].split(/\s+/)) clientIds.add(pair.split(':')[0]);
    }
    for (const match of source.matchAll(/Providers: ([a-z0-9 -]+)\. Full live list:/g)) {
      for (const id of match[1].split(/\s+/)) clientIds.add(id);
    }
  }
  // t3-aigate uses the server bearer directly and explicitly skips vault lookup.
  clientIds.delete('aigate');
  assert.ok(clientIds.has('qwen-tokenplan'), 'client ID discovery must cover plan-specific vault IDs');
  assert.ok(clientIds.has('gmail'), 'client ID discovery must cover documented app credentials');
  for (const id of clientIds) assert.ok(ids.has(id), `existing client provider ${id}`);
  assert.equal(getSetupProvider('aigate'), undefined);
  assert.equal(getSetupProvider('unknown-provider'), undefined);
  assert.equal(getSetupProvider('../codex'), undefined);
});

test('catalog descriptors distinguish API keys, field bundles and native logins', () => {
  const kinds = new Set(['api_key', 'aws_sigv4', 'bundle', 'codex', 'claude', 'native']);
  const nativeIds = new Set(['codex', 'claude-code', 'muse', 'kimi-code', 'grok']);
  for (const descriptor of SETUP_PROVIDERS) {
    const { id, name, kind, provider, fields, docs } = descriptor;
    assert.match(id, /^[a-z0-9][a-z0-9_-]*$/, `safe launcher ID: ${id}`);
    assert.ok(name.trim(), `${id}: display name`);
    assert.ok(kinds.has(kind), `${id}: supported setup kind`);
    assert.match(provider, /^[a-z0-9][a-z0-9_-]*$/, `${id}: storage provider`);
    if (docs) assert.equal(new URL(docs).protocol, 'https:', `${id}: documentation URL`);
    if (fields) {
      assert.ok(fields.length > 0, `${id}: nonempty field list`);
      assert.equal(new Set(fields.map(({ name }) => name)).size, fields.length, `${id}: unique fields`);
      for (const field of fields) {
        assert.match(field.name, /^[a-z][a-z0-9_]*$/, `${id}: safe field name`);
        assert.ok(field.label.trim(), `${id}/${field.name}: prompt label`);
        assert.equal(typeof field.secret, 'boolean', `${id}/${field.name}: explicit visibility`);
        assert.equal(typeof field.required, 'boolean', `${id}/${field.name}: explicit requirement`);
        if (field.default !== undefined) assert.equal(typeof field.default, 'string');
      }
    }
    if (kind === 'bundle') {
      assert.equal(descriptor.storageOnly, true, `${id}: bundle does not imply an execution adapter`);
      assert.ok(fields?.length > 1, `${id}: preserve structured credentials`);
    }
    if (['codex', 'claude', 'native'].includes(kind)) {
      assert.ok(nativeIds.has(descriptor.nativeId), `${id}: explicit native dispatch`);
      assert.ok(SETUP_PROVIDERS.some((entry) => entry.kind === 'api_key' && entry.provider === descriptor.apiKeyProvider), `${id}: distinct API-key target`);
    }
  }

  for (const id of ['aws', 'aws-bedrock']) {
    const descriptor = getSetupProvider(id);
    assert.equal(descriptor.kind, 'aws_sigv4');
    assert.equal(descriptor.storageOnly, true, `${id}: SigV4 execution is unsupported`);
    assert.deepEqual(descriptor.fields.map(({ name }) => name), ['access_key_id', 'secret_access_key', 'region', 'session_token']);
    assert.equal(descriptor.fields.find(({ name }) => name === 'region').required, true);
    assert.equal(descriptor.fields.find(({ name }) => name === 'session_token').required, false);
    assert.ok(descriptor.fields.find(({ name }) => name === 'secret_access_key').secret);
  }
  const bundleFields = {
    'azure-openai': ['endpoint', 'api_key', 'deployment'],
    cloudflare: ['api_token', 'account_id'],
    'vertex-ai': ['service_account', 'project', 'location'],
    modal: ['token_id', 'token_secret'],
    gmail: ['email', 'app_password'],
  };
  for (const [id, expected] of Object.entries(bundleFields)) {
    const descriptor = getSetupProvider(id);
    assert.equal(descriptor.kind, 'bundle', id);
    assert.deepEqual(descriptor.fields.map(({ name }) => name), expected, id);
  }
  assert.equal(getSetupProvider('azure-openai').fields.find(({ name }) => name === 'deployment').required, false);
  assert.equal(getSetupProvider('muse').kind, 'native');
  assert.equal(getSetupProvider('muse').provider, 'muse-code', 'native bundle must not replace the Muse API key');
  assert.equal(getSetupProvider('muse-api-key').provider, 'muse');
  assert.equal(getSetupProvider('muse-api-key').kind, 'api_key');
  assert.equal(getSetupProvider('kimi').kind, 'api_key');
  assert.equal(getSetupProvider('moonshot').kind, 'api_key');
  assert.notEqual(getSetupProvider('kimi').provider, getSetupProvider('moonshot').provider);
  for (const [alias, id] of Object.entries(ALIASES)) {
    assert.deepEqual(getSetupProvider(alias), { ...getSetupProvider(id), id: alias }, `${alias}: complete alias dispatch`);
  }
});

test('every exact-name launcher is executable and parses with system Bash', () => {
  const expected = SETUP_PROVIDERS.map(({ id }) => `${id}${SUFFIX}`).sort();
  assert.deepEqual(readdirSync(SCRIPTS).filter((name) => name.endsWith(SUFFIX)).sort(), expected);
  for (const name of expected) {
    const path = join(SCRIPTS, name);
    const stat = lstatSync(path);
    assert.ok(stat.isFile(), `${name}: regular launcher file`);
    assert.equal(stat.mode & 0o111, 0o111, `${name}: executable by its installed mode`);
    const result = spawnSync('/bin/bash', ['-n', path], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, `${name}: ${result.error || result.stderr}`);
  }
});

test('all launchers preserve provider routing, argv, cwd and exit status from paths with spaces', (t) => {
  const sb = sandbox(t);
  const scripts = join(sb.root, 'provider setup scripts');
  mkdirSync(scripts);
  const fakeNode = join(sb.bin, 'node');
  writeFileSync(fakeNode, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.exit(73);\n`);
  chmodSync(fakeNode, 0o755);
  const argv = ['--help', '--', 'argument with spaces', '', 'literal-$(false)', 'semi;colon', 'quote"value', '-n'];
  for (const { id } of SETUP_PROVIDERS) {
    const name = `${id}${SUFFIX}`;
    const path = join(scripts, name);
    copyFileSync(join(SCRIPTS, name), path);
    const result = spawnSync(path, argv, {
      cwd: sb.cwd,
      env: { ...sb.env, CDPATH: join(sb.root, 'unused CDPATH') },
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 73, `${id}: ${result.error || result.stderr}`);
    assert.equal(result.stderr, '', `${id}: unexpected launcher output`);
    assert.deepEqual(JSON.parse(result.stdout), { argv: [join(scripts, 'setup.mjs'), id, ...argv], cwd: sb.cwd }, id);
  }
});

test('every provider and alias offers real help without credentials or login side effects', (t) => {
  const sb = sandbox(t);
  symlinkSync(process.execPath, join(sb.bin, 'node'));
  for (const { id } of SETUP_PROVIDERS) {
    const result = spawnSync(join(SCRIPTS, `${id}${SUFFIX}`), ['--help'], {
      cwd: sb.cwd,
      env: { ...sb.env, AIGATE_URL: 'http://127.0.0.1:1' },
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, `${id}: ${result.error || result.stderr}`);
    assert.match(result.stdout, /usage/i, `${id}: help text`);
    assert.ok(result.stdout.includes(`${id}${SUFFIX}`), `${id}: help must show the invoked provider or alias`);
  }
  assert.deepEqual(readdirSync(sb.home), [], 'help must not create native auth/config files');
  assert.deepEqual(readdirSync(sb.cwd), [], 'help must not write into the caller working directory');
});
