import { accessSync, chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { normalizeCodexAuth } from '../src/lib.js';

const FIELD_LIMIT = 65536;
const BIN_VARS = {
  codex: 'AIGATE_SETUP_CODEX_BIN',
  'claude-code': 'AIGATE_SETUP_CLAUDE_BIN',
  muse: 'AIGATE_SETUP_MUSE_BIN',
  'kimi-code': 'AIGATE_SETUP_KIMI_BIN',
  grok: 'AIGATE_SETUP_GROK_BIN',
};
const BIN_NAMES = { codex: 'codex', 'claude-code': 'claude', muse: 'muse', 'kimi-code': 'kimi', grok: 'grok' };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Only executable files are inspected here. Credential readers are supplied by
// the runner and are confined to the fresh private login directory.
function executable(path) {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}
function executableHeader(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(8192);
    const count = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, count);
  } catch { return Buffer.alloc(0); } finally { if (fd !== undefined) closeSync(fd); }
}
const scriptHeader = path => executableHeader(path).toString('utf8');
function nativeExecutable(path) {
  if (!executable(path)) return false;
  const header = executableHeader(path);
  return header.length >= 4 && ([0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE(0)) || header.subarray(0, 2).toString('ascii') === 'MZ');
}
function pathCandidates(name, path) {
  return String(path || '/usr/bin:/bin').split(delimiter).filter(dir => dir && isAbsolute(dir)).map(dir => join(dir, name));
}
function resolveExecutable(id, env) {
  const variable = BIN_VARS[id];
  const override = env[variable] ?? process.env[variable];
  if (override !== undefined) {
    if (!nonempty(override) || /[\0\r\n]/.test(override)) throw new Error(`${variable} must name an existing executable`);
    const candidates = isAbsolute(override) ? [override] : pathCandidates(override, env.PATH);
    const selected = candidates.find(executable);
    if (!selected) throw new Error(`${variable} must name an existing executable`);
    return selected;
  }
  for (const candidate of pathCandidates(BIN_NAMES[id], env.PATH)) {
    if (!executable(candidate)) continue;
    const real = realpathSync(candidate);
    const header = scriptHeader(real);
    // cmux shims install hooks and launch metadata outside the isolated home.
    // Continue along PATH to the existing provider CLI behind them.
    if (/(?:cmux.*wrapper|cmux-cli-shims|CMUX_AGENT_LAUNCH_)/i.test(header) || /[/\\]\.cmuxterm[/\\]/.test(candidate)) continue;
    if (id === 'grok' && /grok-bootstrap\.js|bootstrapCanonical\(/.test(header)) {
      // The official npm bootstrap installs/decompresses when GROK_HOME is empty.
      // Resolve an already installed native binary instead; never run bootstrap.
      const native = [join(dirname(real), 'grok-native'), join(homedir(), '.grok', 'bin', 'grok')];
      const packageRoot = resolve(dirname(real), '..', '..');
      native.push(join(packageRoot, `grok-${process.platform}-${process.arch}`, 'bin', 'grok'));
      const selected = native.find(nativeExecutable);
      if (!selected) throw new Error('an existing native Grok executable is required; set AIGATE_SETUP_GROK_BIN');
      return realpathSync(selected);
    }
    if (id === 'muse' && (/MUSE_NO_AUTO_UPDATE/.test(header) || (header.includes('https://api.meta.ai/muse-code/channels/') && header.includes('https://api.meta.ai/muse-launcher.sh')))) {
      // The no-update branch occurs beyond the bounded header in current
      // launchers; their channel/launcher URLs identify them near the beginning.
      // Always bypass bootstrap and require an existing installed native binary.
      let version = '';
      try {
        const marker = join(dirname(real), '.muse-version');
        const metadata = lstatSync(marker);
        if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 128) version = readFileSync(marker, 'utf8').trim();
      } catch { /* missing or unreadable installed-version metadata fails below */ }
      if (/^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(version)) {
        const native = join(dirname(real), `muse-bin-${version}`);
        if (nativeExecutable(native)) return realpathSync(native);
      }
      throw new Error('an existing native Muse executable is required; set AIGATE_SETUP_MUSE_BIN');
    }
    return real;
  }
  throw new Error(`${BIN_NAMES[id]} is not installed on PATH; install the official CLI separately`);
}

function isolatedEnv(root, source) {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (/^(?:AIGATE_|ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|CLAUDE_SECURESTORAGE_CONFIG_DIR$|OPENAI_|CODEX_|META_|MUSE_|TBH_|KIMI_|GROK_|XAI_|AWS_|GOOGLE_|GCLOUD_|CLOUDSDK_|AZURE_|VERTEX_|BEDROCK_)/.test(name)) delete env[name];
  }
  return {
    ...env,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  };
}
function privateDirectory(root, relative) {
  let path = root;
  for (const component of relative.split('/')) {
    path = join(path, component);
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new Error('could not prepare an isolated credential directory'); }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('isolated credential directory must not be a symlink or file');
    chmodSync(path, 0o700);
  }
  return path;
}
function ownedText(raw, label) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${label} is missing or empty`);
  if (text.includes('\0') || Buffer.byteLength(text, 'utf8') > FIELD_LIMIT) throw new Error(`${label} is invalid or too large`);
  return text;
}
async function readText(readOwnedFile, path, label) {
  let raw;
  try { raw = await readOwnedFile(path); } catch { throw new Error(`${label} could not be read from the isolated login`); }
  return ownedText(raw, label);
}
function jsonObject(text, label) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); }
  if (!record(value)) throw new Error(`${label} must contain a JSON object`);
  return value;
}
function bundle(field, value) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > FIELD_LIMIT) throw new Error('native credential bundle is too large');
  return { kind: 'bundle', fields: { [field]: text } };
}

// Parse the regular TOML subset emitted for a fresh native login. Multiline
// strings and future syntax fail closed; no configuration is executed or changed.
// The original bytes, including unknown native fields, remain in the bundle.
function validateKimiConfig(text) {
  const invalid = () => { throw new Error('Kimi config.toml has invalid or unsupported TOML syntax'); };
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) invalid();
  let quote = '', escaped = false, stack = [], line = '', lines = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      line += char;
      if (quote === '"' && escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (char === quote) quote = '';
      else if (char === '\n' || char === '\r') invalid();
      continue;
    }
    if (char === '"' || char === "'") { quote = char; line += char; continue; }
    if (char === '#') { while (i < text.length && text[i] !== '\n') i++; }
    const next = text[i];
    if (next === '\n' || i === text.length) {
      if (stack.length === 0) { if (line.trim()) lines.push(line.trim()); line = ''; } else line += ' ';
      continue;
    }
    if (next === '[' || next === '{') stack.push(next);
    if (next === ']' || next === '}') { if (stack.pop() !== (next === ']' ? '[' : '{')) invalid(); }
    if (stack.length > 16) invalid();
    line += next;
  }
  if (quote || stack.length !== 0) invalid();
  if (line.trim()) lines.push(line.trim());
  const parse = input => {
    let at = 0;
    const space = () => { while (/\s/.test(input[at] || '') && at < input.length) at++; };
    const string = () => {
      const start = at, mark = input[at++];
      while (at < input.length) {
        const char = input[at++];
        if (char === mark) {
          const raw = input.slice(start, at);
          if (mark === "'") return raw.slice(1, -1);
          try { return JSON.parse(raw); } catch { invalid(); }
        }
        if (char === '\\' && mark === '"') at++;
      }
      invalid();
    };
    const key = () => {
      const parts = [];
      for (;;) {
        space();
        if (input[at] === '"' || input[at] === "'") parts.push(string());
        else {
          const match = /^[A-Za-z0-9_-]+/.exec(input.slice(at));
          if (!match) invalid();
          parts.push(match[0]); at += match[0].length;
        }
        space();
        if (input[at] !== '.') break;
        at++;
      }
      return parts;
    };
    const assign = (obj, parts, value) => {
      for (const part of parts.slice(0, -1)) {
        if (!Object.hasOwn(obj, part)) obj[part] = Object.create(null);
        if (!record(obj[part])) invalid();
        obj = obj[part];
      }
      const last = parts.at(-1);
      if (Object.hasOwn(obj, last)) invalid();
      obj[last] = value;
    };
    const value = (depth = 0) => {
      if (depth > 16) invalid();
      space();
      if (input[at] === '"' || input[at] === "'") return string();
      const open = input[at];
      if (open === '[' || open === '{') {
        at++;
        const output = open === '[' ? [] : Object.create(null), end = open === '[' ? ']' : '}';
        space();
        while (input[at] !== end) {
          if (open === '[') output.push(value(depth + 1));
          else { const parts = key(); if (input[at++] !== '=') invalid(); assign(output, parts, value(depth + 1)); }
          space();
          if (input[at] === end) break;
          if (input[at++] !== ',') invalid();
          space();
          if (input[at] === end && open === '{') invalid();
        }
        at++;
        return output;
      }
      const raw = /^[^\s,\]}]+/.exec(input.slice(at))?.[0];
      if (!raw) invalid();
      at += raw.length;
      if (raw === 'true' || raw === 'false') return raw === 'true';
      if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(raw) || /^0(?:x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(raw) || /^[+-]?(?:inf|nan)$/.test(raw)) return raw;
      invalid();
    };
    return { key, value, assign, space, next: () => input[at], skip: () => at++, done: () => at === input.length };
  };
  const config = Object.create(null), definedTables = new Set();
  let current = config;
  for (const item of lines) {
    const arrayTable = item.startsWith('[['), table = item.startsWith('[');
    const statement = parse(table ? item.slice(arrayTable ? 2 : 1, arrayTable ? -2 : -1) : item);
    const parts = statement.key();
    if (table) {
      if (!(arrayTable ? item.endsWith(']]') : item.endsWith(']')) || !statement.done()) invalid();
      const tableKey = JSON.stringify(parts);
      if (!arrayTable && definedTables.has(tableKey)) invalid();
      definedTables.add(tableKey);
      current = config;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i], array = arrayTable && i === parts.length - 1;
        if (!Object.hasOwn(current, part)) current[part] = array ? [] : Object.create(null);
        if (array) {
          if (!Array.isArray(current[part])) invalid();
          const next = Object.create(null); current[part].push(next); current = next;
        } else {
          const next = current[part];
          current = Array.isArray(next) ? next.at(-1) : next;
          if (!record(current)) invalid();
        }
      }
    } else {
      if (statement.next() !== '=') invalid();
      statement.skip();
      statement.assign(current, parts, statement.value());
      statement.space();
      if (!statement.done()) invalid();
    }
  }
  const refs = record(config.providers) ? Object.values(config.providers).filter(record).map(provider => provider.oauth).filter(record) : [];
  if (!refs.length || refs.some(ref => ref.storage !== 'file' || !nonempty(ref.key))) throw new Error('Kimi config.toml has no supported file-based OAuth reference');
  return refs.map(ref => {
    const name = ref.key.startsWith('oauth/') ? ref.key.slice(6) : ref.key;
    if (!/^[^./\\][^/\\]*$/.test(name)) throw new Error('Kimi config.toml has an invalid OAuth credential reference');
    return `kimi/credentials/${name}.json`;
  });
}

/** Prepare an official native login; the caller owns execution and cleanup. */
export function prepareNativeLogin(id, { root, env = {}, deviceAuth = false } = {}) {
  if (!Object.hasOwn(BIN_NAMES, id)) throw new Error('unsupported native login');
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) === resolve('/')) throw new Error('a private absolute login directory is required');
  if (typeof deviceAuth !== 'boolean') throw new Error('deviceAuth must be boolean');
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('a private login directory without symlinks is required');
  const command = resolveExecutable(id, env);
  const childEnv = isolatedEnv(root, env);
  for (const directory of ['config', 'data', 'cache', 'state']) privateDirectory(root, directory);
  if (id === 'codex') {
    childEnv.CODEX_HOME = privateDirectory(root, 'codex');
    return {
      command, args: ['-c', 'cli_auth_credentials_store="file"', 'login', ...(deviceAuth ? ['--device-auth'] : [])], env: childEnv,
      collect: async ({ readOwnedFile }) => {
        const auth = jsonObject(await readText(readOwnedFile, 'codex/auth.json', 'Codex auth.json'), 'Codex auth.json');
        const result = normalizeCodexAuth(auth);
        if (result.error) throw new Error(`Codex login did not produce reusable OAuth credentials: ${result.error}`);
        return { kind: 'codex', auth_json: auth };
      },
    };
  }
  if (id === 'claude-code') {
    childEnv.CLAUDE_CONFIG_DIR = privateDirectory(root, 'claude');
    childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = childEnv.CLAUDE_CONFIG_DIR;
    childEnv.DISABLE_AUTOUPDATER = '1';
    // Official setup-token prints the long-lived token and does not save it
    // anywhere: https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
    // Do not use auth login/logout or access/remove the user's Keychain entries.
    return {
      command, args: ['setup-token'], env: childEnv,
      collect: async ({ stdout = '', stderr = '' }) => {
        const printed = `${stdout}\n${stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const tokens = [...new Set([...printed.matchAll(/(?:^|[^A-Za-z0-9_-])(sk-ant-oat01-[A-Za-z0-9_-]{16,})(?![A-Za-z0-9_-])/g)].map(match => match[1]))];
        if (tokens.length !== 1) throw new Error('Claude setup-token did not print exactly one complete setup token');
        return { kind: 'claude', setup_token: tokens[0] };
      },
    };
  }
  if (id === 'muse') {
    privateDirectory(root, 'config/muse');
    Object.assign(childEnv, { TBH_CREDENTIAL_BACKEND: 'file', TBH_DISABLE_TELEMETRY: '1', MUSE_NO_AUTO_UPDATE: '1', MUSE_AUTH_PATH: join(root, 'config', 'muse', 'auth.json') });
    return {
      command, args: ['login'], env: childEnv,
      collect: async ({ readOwnedFile }) => {
        const auth = jsonObject(await readText(readOwnedFile, 'config/muse/auth.json', 'Muse auth.json'), 'Muse auth.json');
        const meta = auth.providers?.meta;
        if (!record(meta)) throw new Error('Muse auth.json has no Meta provider credentials');
        if ((!nonempty(meta.api_key) && !nonempty(meta.access_token)) || ['api_key', 'access_token', 'refresh_token'].some(name => meta[name] != null && !nonempty(meta[name]))) throw new Error('Muse auth.json has incomplete Meta credentials');
        return bundle('auth_json', auth);
      },
    };
  }
  if (id === 'kimi-code') {
    // The legacy Python CLI uses KIMI_SHARE_DIR. Isolate that path as well if
    // an older executable is on PATH; collection still requires current format.
    Object.assign(childEnv, { KIMI_CODE_HOME: privateDirectory(root, 'kimi'), KIMI_SHARE_DIR: join(root, 'kimi'), KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' });
    return {
      command, args: ['login'], env: childEnv,
      collect: async ({ readOwnedFile, listOwnedFiles }) => {
        const config = await readText(readOwnedFile, 'kimi/config.toml', 'Kimi config.toml');
        const referenced = validateKimiConfig(config);
        let paths;
        try { paths = await listOwnedFiles('kimi/credentials'); } catch { throw new Error('Kimi OAuth credential files could not be listed'); }
        if (!Array.isArray(paths) || paths.length === 0 || paths.length > 32 || paths.some(path => typeof path !== 'string' || !/^kimi\/credentials\/[^/.][^/\\]*\.json$/.test(path))) throw new Error('Kimi login did not produce supported OAuth credential files');
        if (referenced.some(path => !paths.includes(path))) throw new Error('Kimi login is missing a referenced OAuth credential file');
        const files = { 'config.toml': config };
        for (const path of [...paths].sort()) {
          const text = await readText(readOwnedFile, path, 'Kimi OAuth credential file');
          const token = jsonObject(text, 'Kimi OAuth credential file');
          if (!nonempty(token.access_token) || !nonempty(token.refresh_token)) throw new Error('Kimi OAuth credential file has incomplete tokens');
          files[path.slice('kimi/'.length)] = text;
        }
        return bundle('auth_bundle_json', { files });
      },
    };
  }
  Object.assign(childEnv, { GROK_HOME: privateDirectory(root, 'grok'), GROK_AUTH_PATH: join(root, 'grok', 'auth.json') });
  return {
    command, args: ['login', ...(deviceAuth ? ['--device-auth'] : [])], env: childEnv,
    collect: async ({ readOwnedFile }) => {
      const auth = jsonObject(await readText(readOwnedFile, 'grok/auth.json', 'Grok auth.json'), 'Grok auth.json');
      const scopes = Object.entries(auth);
      if (!scopes.length || scopes.some(([scope, token]) => !scope.trim() || !record(token) || !nonempty(token.key) || !['web_login', 'grok', 'oidc', 'external', 'api_key'].includes(token.auth_mode)
        || ['refresh_token', 'oidc_issuer', 'oidc_client_id'].some(key => token[key] != null && !nonempty(token[key]))
        || (token.expires_at != null && (typeof token.expires_at !== 'string' || !Number.isFinite(Date.parse(token.expires_at)))))) throw new Error('Grok auth.json has invalid scope credentials');
      return bundle('auth_json', auth);
    },
  };
}
