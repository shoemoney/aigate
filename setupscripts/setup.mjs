#!/usr/bin/env node
// Operator-run credential intake. No existing login, shell configuration, or key
// file is discovered. Native artifacts are read only from a fresh owned root.
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { SETUP_PROVIDERS, getSetupProvider } from './providers.mjs';
import { prepareNativeLogin } from './native-login.mjs';

const MAX_FIELD = 65_536;
const MAX_OUTPUT = 1_048_576;
const MAX_HTTP = 1_048_576;
const HTTP_TIMEOUT = 15_000;
const LOGIN_TIMEOUT = 15 * 60_000;
const SAFE_ERROR = Symbol('safe setup error');

function fail(message, code = 1) {
  const error = new Error(message);
  error[SAFE_ERROR] = true;
  error.exitCode = code;
  return error;
}

function cancelled(signal) {
  if (signal?.aborted) throw fail('Setup cancelled; local temporary credentials will be removed.', 130);
}

export function parseArgs(argv) {
  const options = { once: false, clipboard: false, deviceAuth: false, auth: 'native' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (!argument.startsWith('-') && options.id === undefined) { options.id = argument; continue; }
    const boolean = { '--once': 'once', '--clipboard': 'clipboard', '--device-auth': 'deviceAuth', '--help': 'help', '-h': 'help', '--list': 'list' }[argument];
    if (boolean) { options[boolean] = true; continue; }
    const name = { '--account': 'account', '--label': 'label', '--url': 'url', '--auth': 'auth' }[argument];
    if (!name || seen.has(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw fail('Unknown, repeated, or incomplete option. Use --help.');
    seen.add(name);
    options[name] = argv[++i];
  }
  if (!['native', 'api-key'].includes(options.auth)) throw fail('--auth must be native or api-key.');
  if (options.account !== undefined) validateAccount(options.account);
  if (options.label !== undefined) validateLabel(options.label);
  return options;
}

function validateAccount(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._@+-]{1,120}$/.test(value)) throw fail('Use an account name with letters, numbers, dot, underscore, @, + or hyphen (maximum 120 characters).');
  return value;
}

function validateLabel(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw fail('Label must be at most 200 characters without control characters.');
  return value;
}

export function validateServerURL(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('Enter an absolute https:// AIGate URL, or http:// with a loopback/private LAN address.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw fail('AIGate URL must be an HTTP(S) origin without credentials, path, query, or fragment.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const octets = host.split('.').map(Number);
  const privateV4 = isIP(host) === 4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  const privateV6 = isIP(host) === 6 && (host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host));
  if (url.protocol === 'http:' && host !== 'localhost' && !privateV4 && !privateV6) throw fail('Plain HTTP is limited to an explicit loopback or private LAN IP address. Use HTTPS for other hosts.');
  return url.origin;
}

// Deliberate allowlist: administrator/provider credentials, inherited CLI auth,
// NODE_OPTIONS, proxies, and loader hooks must never reach a native login.
export function childEnvironment(env, root) {
  const safe = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (typeof env[name] === 'string') safe[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^AIGATE_SETUP_[A-Z0-9_]+_BIN$/.test(name) && typeof value === 'string') safe[name] = value;
  }
  return { ...safe, NO_COLOR: '1', CLICOLOR: '0', TMPDIR: root, TMP: root, TEMP: root, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state') };
}

export class PromptReader {
  constructor(input, output, signal) {
    this.input = input; this.output = output; this.signal = signal;
    this.lines = []; this.partial = ''; this.pending = null; this.ended = false;
    this.decoder = new StringDecoder('utf8'); this.suspended = false;
    this.onData = chunk => this.receive(this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    this.onEnd = () => {
      if (!input.isTTY && this.partial) {
        const last = this.partial; this.partial = '';
        if (this.pending) this.resolve(last); else this.lines.push(last);
      }
      this.ended = true; if (this.pending) this.rejectEOF();
    };
    this.onAbort = () => { if (this.pending) { const pending = this.pending; this.pending = null; this.restoreTerminal(); pending.reject(fail('Setup cancelled; local temporary credentials will be removed.', 130)); } };
    input.on('data', this.onData); input.on('end', this.onEnd); signal?.addEventListener('abort', this.onAbort);
    input.resume();
  }
  restoreTerminal() {
    if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(false);
  }
  rejectEOF() {
    const pending = this.pending; this.pending = null; this.restoreTerminal();
    pending.reject(fail('Input ended before setup finished; local temporary credentials will be removed.'));
  }
  receive(text) {
    if (!this.input.isTTY) {
      this.partial += text;
      if (Buffer.byteLength(this.partial) > MAX_FIELD * 2) { if (this.pending) this.rejectEOF(); this.ended = true; return; }
      let index;
      while ((index = this.partial.indexOf('\n')) !== -1) {
        const line = this.partial.slice(0, index).replace(/\r$/, ''); this.partial = this.partial.slice(index + 1);
        if (this.pending) this.resolve(line); else this.lines.push(line);
      }
      return;
    }
    // Escape sequences are editing keys, never input. Bracketed paste itself is
    // accepted, while terminal control sequences are not echoed back.
    if (this.lastCR && text.startsWith('\n')) text = text.slice(1);
    this.lastCR = text.endsWith('\r');
    text = text.replace(/\r\n/g, '\n').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[^\x1b]?/g, '');
    for (const character of text) {
      if (!this.pending) {
        if (character === '\r' || character === '\n') { this.lines.push(this.partial); this.partial = ''; }
        else if (!/[\x00-\x1f\x7f]/.test(character) && Buffer.byteLength(this.partial + character) <= MAX_FIELD) this.partial += character;
        continue;
      }
      if (character === '\x03') { this.pending.reject(fail('Setup cancelled; local temporary credentials will be removed.', 130)); this.pending = null; this.restoreTerminal(); break; }
      if (character === '\x04') { this.rejectEOF(); break; }
      if (character === '\r' || character === '\n') { this.output.write('\n'); this.resolve(this.pending.value); continue; }
      if (character === '\x7f' || character === '\b') {
        if (this.pending.value) { this.pending.value = Array.from(this.pending.value).slice(0, -1).join(''); if (!this.pending.secret) this.output.write('\b \b'); }
      } else if (character === '\x15') {
        if (!this.pending.secret) this.output.write('\b \b'.repeat(Array.from(this.pending.value).length)); this.pending.value = '';
      } else if (!/[\x00-\x1f\x7f]/.test(character)) {
        if (Buffer.byteLength(this.pending.value + character) > MAX_FIELD) continue;
        this.pending.value += character;
        if (!this.pending.secret) this.output.write(character);
      }
    }
  }
  resolve(value) {
    const pending = this.pending; this.pending = null; this.restoreTerminal(); pending.resolve(value);
  }
  async ask(message, { secret = false, defaultValue, fresh = false } = {}) {
    cancelled(this.signal);
    if (fresh && this.input.isTTY) { this.lines = []; this.partial = ''; }
    let value; let answer;
    if (this.lines.length) value = this.lines.shift();
    else if (this.ended) throw fail('Input ended before setup finished; local temporary credentials will be removed.');
    else answer = new Promise((resolve, reject) => {
      this.pending = { resolve, reject, secret, value: this.input.isTTY ? this.partial : '' };
      if (this.input.isTTY) this.partial = '';
      if (this.input.isTTY && this.input.setRawMode) this.input.setRawMode(true);
    });
    // Install the pending input state and turn echo off before the prompt is
    // visible. A fast paste immediately after seeing it must stay private.
    this.output.write(message + (defaultValue !== undefined && !secret ? ` [${defaultValue}]` : '') + ': ');
    if (answer) {
      if (!secret && this.pending?.value) this.output.write(this.pending.value);
      value = await answer;
    }
    if (Buffer.byteLength(value) > MAX_FIELD || /\x00/.test(value)) throw fail('Input exceeds the supported size or contains a NUL character.');
    return value === '' && defaultValue !== undefined ? String(defaultValue) : value;
  }
  suspend() { this.suspended = true; this.restoreTerminal(); this.input.off('data', this.onData); this.input.pause(); }
  resume() { if (this.suspended) { this.suspended = false; this.input.on('data', this.onData); this.input.resume(); } }
  close() { this.restoreTerminal(); this.input.off('data', this.onData); this.input.off('end', this.onEnd); this.signal?.removeEventListener('abort', this.onAbort); this.input.pause(); }
}

export async function createAttemptRoot(base = tmpdir()) {
  const root = await mkdtemp(path.join(base, 'aigate-setup-'));
  try { await chmod(root, 0o700); return await realpath(root); }
  catch { await rm(root, { recursive: true, force: true }); throw fail('Could not create a private native login directory.'); }
}

export async function removeAttemptRoot(root) {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try { await lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw fail('Could not verify removal of local temporary credentials.'); }
  throw fail('Local temporary credentials could not be removed. Remove the attempt directory before continuing.');
}

export async function ownedArtifacts(root) {
  const actualRoot = await realpath(root);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || (rootInfo.mode & 0o077) || (process.getuid && rootInfo.uid !== process.getuid())) throw fail('Native login root is not private and owned.');
  function relativeParts(relative) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || path.isAbsolute(relative)) throw fail('Native login artifact path was rejected.');
    const parts = relative.split('/');
    if (parts.some(part => !part || part === '.' || part === '..') || parts.length > 12) throw fail('Native login artifact path was rejected.');
    return parts;
  }
  async function check(relative, directory = false) {
    const parts = relativeParts(relative);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || ((i < parts.length - 1 || directory) && !info.isDirectory())) throw fail('Native login artifact symlinks and non-directories are forbidden.');
    }
    if (await realpath(root) !== actualRoot) throw fail('Native login root changed during collection.');
    return current;
  }
  return {
    async readOwnedFile(relative) {
      const target = await check(relative);
      const file = await open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_FIELD || info.nlink !== 1 || (process.getuid && info.uid !== process.getuid())) throw fail('Native login artifact is not a bounded owned regular file.');
        const after = await lstat(target);
        if (after.isSymbolicLink() || after.ino !== info.ino || after.dev !== info.dev) throw fail('Native login artifact changed during collection.');
        await check(relative);
        const data = await file.readFile();
        if (data.length > MAX_FIELD) throw fail('Native login artifact exceeds the supported size.');
        // Normalize the local artifact's mode before it is removed as well.
        await file.chmod(0o600);
        return data.toString('utf8');
      } finally { await file.close(); }
    },
    async listOwnedFiles(relative) {
      const target = await check(relative, true);
      const names = await readdir(target, { withFileTypes: true });
      if (names.length > 100) throw fail('Native login artifact directory exceeds the supported size.');
      const files = [];
      for (const entry of names) {
        if (entry.isSymbolicLink() || !entry.isFile()) throw fail('Native login artifact directory must contain only regular files.');
        files.push(`${relative}/${entry.name}`);
      }
      return files.sort();
    },
  };
}

export async function requestJSON(origin, token, endpoint, { method = 'GET', data, signal, timeout = HTTP_TIMEOUT } = {}) {
  cancelled(signal);
  const target = new URL(endpoint, origin);
  const body = data === undefined ? null : JSON.stringify(data);
  if (body && Buffer.byteLength(body) > MAX_HTTP) throw fail('Credential payload exceeds the supported size.');
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    let settled = false; let deadline;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(deadline); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const req = transport.request(target, { method, rejectUnauthorized: true, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, res => {
      if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); finish(fail(`AIGate ${method} request failed (HTTP ${res.statusCode}); no successful save was verified.`)); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > MAX_HTTP) { res.destroy(); finish(fail('AIGate response exceeds the supported size.')); } else chunks.push(chunk); });
      res.on('error', () => finish(fail('AIGate response was interrupted; no successful save was verified.')));
      res.on('end', () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(fail('AIGate returned invalid JSON; no successful save was verified.')); }
      });
    });
    const abort = () => { req.destroy(); finish(fail('Setup cancelled; local temporary credentials will be removed.', 130)); };
    signal?.addEventListener('abort', abort, { once: true });
    deadline = setTimeout(() => { req.destroy(); finish(fail('AIGate request timed out; no successful save was verified.')); }, timeout);
    if (signal?.aborted) { abort(); return; }
    req.on('error', () => finish(fail('Could not reach AIGate securely; no successful save was verified.')));
    if (body) req.write(body);
    req.end();
  });
}

const AUTH_HOSTS = /^(?:auth\.openai\.com|chatgpt\.com|platform\.openai\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com|login\.kimi\.com|auth\.kimi\.com|kimi\.com|www\.kimi\.com|accounts\.x\.ai|auth\.x\.ai|accounts\.xai\.com|auth\.grok\.com|grok\.com|www\.meta\.ai|meta\.ai|auth\.meta\.ai|auth\.meta\.com|dev\.meta\.ai|www\.facebook\.com|facebook\.com)$/i;

function safeAuthorizationURL(raw) {
  const url = new URL(raw.replace(/[),.;]+$/, ''));
  if (url.protocol !== 'https:' || !AUTH_HOSTS.test(url.hostname) || url.username || url.password || url.hash || url.port || /[A-Za-z0-9_-]{24,}/.test(url.pathname)) return null;
  for (const [key, value] of url.searchParams) {
    if (/^(?:access_token|refresh_token|id_token|client_secret|api_key|key|token|password|secret|authorization)$/i.test(key) || /bearer\s|^sk[-_]|^sk-ant-|^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i.test(value)) return null;
    let valid = false;
    switch (key) {
      case 'response_type': valid = value === 'code'; break;
      case 'client_id': valid = /^[A-Za-z0-9._:-]{1,200}$/.test(value); break;
      case 'state': case 'nonce': valid = /^[A-Za-z0-9._~-]{8,512}$/.test(value); break;
      case 'code_challenge': valid = /^[A-Za-z0-9_-]{32,128}$/.test(value); break;
      case 'code_challenge_method': valid = value === 'S256'; break;
      case 'scope': valid = /^[A-Za-z0-9_.:/ +\-]{1,600}$/.test(value); break;
      case 'user_code': valid = /^[A-Z0-9-]{4,16}$/.test(value); break;
      case 'code': valid = value === 'true' || /^[A-Z0-9-]{4,16}$/.test(value); break;
      case 'prompt': valid = /^(?:login|consent|select_account|none)(?: (?:login|consent|select_account))*$/.test(value); break;
      case 'login_hint': valid = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,100}@[A-Za-z0-9.-]{1,150}$/.test(value); break;
      case 'codex_cli_simplified_flow': case 'device_auth': valid = value === 'true' || value === 'false'; break;
      case 'originator': valid = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value); break;
      case 'organization_id': case 'workspace_id': valid = /^[A-Za-z0-9_-]{1,100}$/.test(value); break;
      case 'redirect_uri': {
        try {
          const redirect = new URL(value);
          valid = !redirect.username && !redirect.password && !redirect.hash && !redirect.search && ((redirect.protocol === 'https:' && AUTH_HOSTS.test(redirect.hostname)) || (redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)));
        } catch { valid = false; }
        break;
      }
    }
    if (!valid) return null;
  }
  return url.href;
}

// Arbitrary provider output is private, including unknown token formats. Only
// narrowly recognized public verification URLs and short user-code hints can
// reach the operator. Lines are buffered, so split chunks cannot bypass this.
export function nativeHints(output) {
  let buffered = ''; const shown = new Set();
  function emit(line) {
    line = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|[{}]/.test(line)) return;
    if (/^\s*(?:(?:access_token|refresh_token|id_token|client_secret|api_key|setup_token|secret|password|authorization)\s*[:=]|bearer\b)/i.test(line)) return;
    const urls = line.match(/https:\/\/[^\s<>"'`]+/g) || [];
    for (const raw of urls) {
      try {
        const url = safeAuthorizationURL(raw);
        if (!url) continue;
        const hint = `Verification page (open in a private/incognito window to select the account): ${url}`;
        if (!shown.has(hint)) { shown.add(hint); output.write(hint + '\n'); }
      } catch { /* unknown output stays private */ }
    }
    const code = /^(?:your\s+)?(?:user|device|verification|one[- ]time)\s+code\s*(?:is\s*)?[:=]?\s*([A-Z0-9]{3,5}-[A-Z0-9]{3,5})\s*$/i.exec(line.trim());
    if (code) { const hint = `Verification code: ${code[1]}`; if (!shown.has(hint)) { shown.add(hint); output.write(hint + '\n'); } }
  }
  return {
    write(chunk) {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf('\n')) !== -1) { emit(buffered.slice(0, index).replace(/\r$/, '')); buffered = buffered.slice(index + 1); }
      if (buffered.length > 16_384) buffered = ''; // an oversized line is never displayed
    },
    end() { if (buffered) emit(buffered); buffered = ''; },
  };
}

function killGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw fail('Could not terminate the owned native login process.'); }
}

export async function runNative(spec, { root, signal, prompts, output, timeout = LOGIN_TIMEOUT }) {
  if (!spec || typeof spec.command !== 'string' || !Array.isArray(spec.args) || !spec.env || typeof spec.collect !== 'function') throw fail('Native login adapter is not available.');
  cancelled(signal);
  prompts.suspend();
  output.write('Complete the provider browser/device login. Keep this terminal open; paste a native authentication code if the provider requests one. Native credential output stays private.\n');
  let child; let stdout = ''; let stderr = ''; let size = 0; let timer; let terminateTimer; let aborted = false; let exceeded = false;
  const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
  const stdoutHints = nativeHints(output); const stderrHints = nativeHints(output);
  const terminateOwnedGroup = () => {
    if (!child) return;
    killGroup(child, 'SIGTERM');
    terminateTimer ||= setTimeout(() => { try { killGroup(child, 'SIGKILL'); } catch { /* close below still determines cleanup */ } }, 1_500);
  };
  const stop = () => {
    aborted = true;
    terminateOwnedGroup();
  };
  try {
    const status = await new Promise((resolve, reject) => {
      try { child = spawn(spec.command, spec.args, { cwd: root, env: spec.env, shell: false, detached: process.platform !== 'win32', stdio: ['inherit', 'pipe', 'pipe'] }); } catch { reject(fail('Could not start the native login command.')); return; }
      child.once('error', () => reject(fail('Could not start the native login command. Check that the provider CLI is installed.')));
      const capture = (chunk, stream) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) { exceeded = true; stop(); return; }
        const text = (stream === 'stdout' ? stdoutDecoder : stderrDecoder).write(chunk);
        if (stream === 'stdout') { stdout += text; stdoutHints.write(text); } else { stderr += text; stderrHints.write(text); }
      };
      child.stdout.on('data', chunk => capture(chunk, 'stdout'));
      child.stderr.on('data', chunk => capture(chunk, 'stderr'));
      child.once('exit', () => { try { terminateOwnedGroup(); } catch { stop(); } });
      child.once('close', (code, childSignal) => resolve({ code, childSignal }));
      signal?.addEventListener('abort', stop, { once: true });
      timer = setTimeout(stop, timeout);
      if (signal?.aborted) stop();
    });
    // A login command can exit while a helper still holds a pipe. Owned helpers
    // share its new process group and must stop before artifact reads/removal.
    killGroup(child, 'SIGKILL');
    if (signal?.aborted) throw fail('Setup cancelled; local temporary credentials will be removed.', 130);
    if (exceeded) throw fail('Native login output exceeded the supported size.');
    if (aborted) throw fail('Native login timed out or was interrupted.');
    if (status.code !== 0 || status.childSignal) throw fail('Native login did not finish successfully. No successful save was verified.');
    stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
    stdoutHints.end(); stderrHints.end();
    const readers = await ownedArtifacts(root);
    try { return await spec.collect({ ...readers, stdout, stderr }); } catch { throw fail('Native login did not produce supported, bounded credential artifacts.'); }
  } finally {
    clearTimeout(timer); clearTimeout(terminateTimer); signal?.removeEventListener('abort', stop);
    if (child?.pid) { try { killGroup(child, 'SIGKILL'); } catch { /* surfaced by caller cleanup verification if needed */ } }
    stdout = ''; stderr = ''; prompts.resume();
  }
}

async function findExecutable(command, env) {
  if (command.includes(path.sep)) { try { await access(command, fsConstants.X_OK); return (await stat(command)).isFile() ? command : null; } catch { return null; } }
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, command);
    try { await access(candidate, fsConstants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

async function clipboardCommand(command, args, env, value, signal) {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    let child; let data = ''; let size = 0; let timer;
    const abort = () => child?.kill('SIGKILL');
    try { child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'], shell: false }); } catch { reject(fail('Clipboard command could not start.')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', chunk => { size += chunk.length; if (size > MAX_HTTP) child.kill('SIGKILL'); else data += chunk.toString('utf8'); });
    child.stderr.resume();
    child.once('error', () => { finish(); reject(fail('Clipboard command could not start.')); });
    child.once('close', code => { finish(); if (signal?.aborted) reject(fail('Setup cancelled; local temporary credentials will be removed.', 130)); else if (code !== 0 || size > MAX_HTTP) reject(fail('Clipboard command failed.')); else resolve(data); });
    child.stdin.on('error', () => {});
    child.stdin.end(value || '');
    timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  });
}

export async function prepareClipboard(env) {
  let write; let read; let writeArgs = []; let readArgs = [];
  if (process.platform === 'darwin') {
    write = await findExecutable(env.AIGATE_SETUP_PBCOPY_BIN || 'pbcopy', env); read = await findExecutable(env.AIGATE_SETUP_PBPASTE_BIN || 'pbpaste', env);
  } else {
    write = await findExecutable('wl-copy', env); read = await findExecutable('wl-paste', env); readArgs = ['--no-newline'];
    if (!write || !read) { write = await findExecutable('xclip', env); read = write; writeArgs = ['-selection', 'clipboard']; readArgs = ['-selection', 'clipboard', '-o']; }
  }
  if (!write || !read) throw fail('Clipboard mode requires both clipboard write and read commands. Install them before beginning a login, or use API mode.');
  // Clipboard tools need the real user session, but never its credentials or
  // inherited loader/environment hooks. No native login uses this environment.
  const safe = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (env[name]) safe[name] = env[name];
  return {
    copy: (value, signal) => clipboardCommand(write, writeArgs, safe, value, signal),
    read: signal => clipboardCommand(read, readArgs, safe, undefined, signal),
    clear: () => clipboardCommand(write, writeArgs, safe, '', undefined),
  };
}

function endpointFor(descriptor) { return ['codex', 'claude'].includes(descriptor.kind) ? '/api/accounts' : descriptor.kind === 'api_key' ? '/api/keys' : '/api/proxy/credentials'; }
function expectedAccountKind(descriptor) { return descriptor.kind === 'codex' || descriptor.kind === 'claude' ? descriptor.kind : null; }
function asMetadataRows(value) { if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw fail('AIGate metadata response has an unsupported shape.'); return value; }

function materialPayload(descriptor, material, account, label) {
  if (material.kind === 'codex') {
    if (!material.auth_json || typeof material.auth_json !== 'object' || Array.isArray(material.auth_json) || Buffer.byteLength(JSON.stringify(material.auth_json)) > MAX_FIELD) throw fail('Native Codex authentication artifact is not supported.');
    return { endpoint: '/api/accounts', payload: { account, kind: 'codex', auth_json: material.auth_json, label, create_only: true } };
  }
  if (material.kind === 'claude') {
    if (typeof material.setup_token !== 'string' || !/^sk-ant-oat[0-9]*-[A-Za-z0-9_-]+$/.test(material.setup_token) || material.setup_token.length > MAX_FIELD) throw fail('Native Claude login did not produce a supported setup token.');
    return { endpoint: '/api/accounts', payload: { account, kind: 'claude', setup_token: material.setup_token, label, create_only: true } };
  }
  if (material.kind === 'api_key') {
    if (typeof material.key !== 'string' || !material.key || /\s|,/.test(material.key) || /^["']|["']$/.test(material.key) || /^(?:export\s|\w+=)/.test(material.key) || material.key.length > MAX_FIELD) throw fail('Enter the API key value only, without whitespace, quotes, export, or NAME=.');
    return { endpoint: '/api/keys', payload: { provider: descriptor.provider, key: material.key, label } };
  }
  const fields = material.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length < 1 || Object.keys(fields).length > 50 || Object.entries(fields).some(([name, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof value !== 'string' || !value || Buffer.byteLength(value) > MAX_FIELD)) throw fail('Credential bundle fields are missing or unsupported.');
  return { endpoint: '/api/proxy/credentials', payload: { provider: descriptor.provider, kind: descriptor.kind === 'aws_sigv4' ? 'aws_sigv4' : 'bundle', fields, label } };
}

export function verifyReadback(endpoint, payload, result, value) {
  const rows = asMetadataRows(value);
  if (endpoint === '/api/accounts') {
    if (!result || result.ok !== true || !rows.some(row => row.account === payload.account && row.kind === payload.kind)) throw fail('AIGate account read-back did not match; no successful save was verified.');
  } else if (endpoint === '/api/keys') {
    if (!result || result.ok !== true || result.provider !== payload.provider || typeof result.hint !== 'string' || !result.hint || !rows.some(row => row.provider === payload.provider && row.key_hint === result.hint && row.label === payload.label)) throw fail('AIGate key read-back did not match; no successful save was verified.');
  } else {
    const names = Object.keys(payload.fields).sort();
    if (!Number.isSafeInteger(result?.id) || result.id < 1 || result.provider !== payload.provider || result.kind !== payload.kind || !rows.some(row => row.id === result.id && row.provider === payload.provider && row.kind === payload.kind && row.label === payload.label && Array.isArray(row.fields) && JSON.stringify([...row.fields].sort()) === JSON.stringify(names))) throw fail('AIGate bundle read-back did not match; no successful save was verified.');
  }
}

function help(id = '<provider>') {
  return `Usage: ${id}_aigate_setup_script [options]\n       node setupscripts/setup.mjs <provider> [options]\n\nManual operator setup; no existing credentials are discovered or reused.\nDefault: authenticated API save, metadata read-back, then local cleanup.\n\n  --url URL          AIGate origin (or explicit AIGATE_URL environment value)\n  --account NAME     New native account name; duplicates are rejected\n  --label LABEL      Credential label for the first account\n  --once             Stop after one account (otherwise repeat)\n  --auth native|api-key  Choose API key entry for a native CLI provider\n  --device-auth      Use the CLI's supported device login\n  --clipboard        Dashboard handoff for Codex, Claude, or API keys;\n                     literal saved acknowledgement is operator confirmation\n                     only. It does not verify a server save.\n  --list             List providers\n  --help             Show this help\n\nAIGATE_TOKEN may explicitly supply the administrator token; otherwise it is\nprompted without echo. Never put secrets in command arguments. Each native\nattempt has a separate private auth root; cleanup handles success, errors, EOF,\nand caught signals. SIGKILL/power loss cannot run cleanup.\n`;
}

export async function runSetup(argv, { env = process.env, input = process.stdin, output = process.stdout, error = process.stderr, signal, native = prepareNativeLogin, clipboardFactory = prepareClipboard } = {}) {
  const options = parseArgs(argv);
  if (options.help) { output.write(help(options.id)); return; }
  if (options.list) { output.write(SETUP_PROVIDERS.map(provider => `${provider.id}\t${provider.name}\t${provider.kind}`).join('\n') + '\n'); return; }
  let descriptor = getSetupProvider(options.id);
  if (!descriptor) throw fail('Choose a known provider. Use --list or --help.');
  if (options.auth === 'api-key' && descriptor.kind !== 'api_key') {
    if (!descriptor.apiKeyProvider) throw fail('This provider does not offer an API-key setup mode.');
    descriptor = { ...descriptor, kind: 'api_key', provider: descriptor.apiKeyProvider, storageOnly: false };
  }
  const nativeKind = ['codex', 'claude', 'native'].includes(descriptor.kind);
  if (options.account !== undefined && !expectedAccountKind(descriptor)) throw fail('--account is supported for Codex and Claude accounts. Use --label for other credentials.');
  if (options.deviceAuth && !nativeKind) throw fail('--device-auth requires a native login provider.');
  if (options.clipboard && !['codex', 'claude', 'api_key'].includes(descriptor.kind)) throw fail('Clipboard mode supports only Codex auth.json, Claude setup-token, and a raw API key. Use API mode for bundles.');
  // Do this before any administrator prompts or native account creation.
  const clipboard = options.clipboard ? await clipboardFactory(env) : null;
  const prompts = new PromptReader(input, output, signal);
  let origin; let token;
  try {
    output.write(`${descriptor.name} setup. Credentials are entered or created only by this operator run.\n`);
    if (!options.clipboard) {
      origin = validateServerURL(options.url || env.AIGATE_URL || await prompts.ask('AIGate server URL'));
      token = env.AIGATE_TOKEN || await prompts.ask('AIGate administrator token (hidden)', { secret: true });
      if (!token || /[\r\n\x00]/.test(token) || token.length > 8_192) throw fail('Administrator token is missing or unsupported.');
    }
    let first = true;
    do {
      cancelled(signal);
      let metadata = null;
      if (!options.clipboard) metadata = asMetadataRows(await requestJSON(origin, token, endpointFor(descriptor), { signal }));
      let account;
      if (expectedAccountKind(descriptor)) {
        account = validateAccount(first && options.account !== undefined ? options.account : (await prompts.ask('New account name')).trim());
        if (metadata?.some(row => row.account === account)) throw fail('That account name already exists. Choose a new name; existing accounts are never overwritten.');
      }
      const label = validateLabel(first && options.label !== undefined ? options.label : await prompts.ask('Account/credential label (optional)'));
      let root; let copied = null; let attemptFailed = false;
      try {
        root = await createAttemptRoot();
        if (nativeKind) output.write(`Private attempt directory: ${root}. It will be removed when this attempt ends.\n`);
        let material;
        if (nativeKind) {
          if (descriptor.storageOnly) {
            output.write('This native OAuth bundle is encrypted storage only. Proxy execution and automatic credential refresh are not provided for this bundle.\n');
            if ((await prompts.ask('Continue creating a storage-only native credential? Type yes', { fresh: true })).trim() !== 'yes') throw fail('Setup cancelled before native login.');
          }
          const spec = await native(descriptor.nativeId || descriptor.id, { root, env: childEnvironment(env, root), deviceAuth: options.deviceAuth });
          material = await runNative(spec, { root, signal, prompts, output });
          const expected = expectedAccountKind(descriptor);
          if (expected && material?.kind !== expected || descriptor.kind === 'native' && material?.kind !== 'bundle') throw fail('Native login returned an unexpected credential kind.');
        } else if (descriptor.kind === 'api_key') {
          material = { kind: 'api_key', key: await prompts.ask('API key value (hidden)', { secret: true }) };
        } else {
          if (descriptor.storageOnly) output.write('This credential bundle is encrypted storage only; saving it does not enable proxy execution.\n');
          const fields = {};
          for (const field of descriptor.fields || []) {
            const value = await prompts.ask(field.label || field.name, { secret: field.secret !== false, defaultValue: field.default });
            if (!value && field.required) throw fail('A required credential field was left empty.');
            if (value) fields[field.name] = value;
          }
          material = { kind: descriptor.kind, fields };
        }
        const { endpoint, payload } = materialPayload(descriptor, material, account, label);
        material = null;
        output.write(`Ready to ${options.clipboard ? 'copy for dashboard handoff' : 'save to AIGate'}: ${descriptor.name}, ${payload.kind || 'API key'}. Secret values stay hidden.\n`);
        if ((await prompts.ask(options.clipboard ? 'Copy the credential? Type yes' : 'Save the credential? Type yes', { fresh: true })).trim() !== 'yes') throw fail('Setup cancelled before save.');
        if (options.clipboard) {
          copied = payload.auth_json ? JSON.stringify(payload.auth_json, null, 2) : payload.setup_token || payload.key;
          await clipboard.copy(copied, signal);
          output.write(`Credential copied. Paste ${payload.auth_json ? 'the complete JSON into the dashboard Codex auth.json field' : payload.setup_token ? 'the token into the dashboard Claude setup-token field' : 'the raw key into the dashboard provider key field'}. Complete the dashboard account name/label and save.\n`);
          if (await prompts.ask('After the dashboard confirms success, type the literal word saved', { fresh: true }) !== 'saved') throw fail('Dashboard save was not acknowledged; no server save was verified.');
          output.write('Operator confirmed the dashboard save. This handoff did not verify the server.\n');
        } else {
          const result = await requestJSON(origin, token, endpoint, { method: 'POST', data: payload, signal });
          const rows = await requestJSON(origin, token, endpoint, { signal });
          verifyReadback(endpoint, payload, result, rows);
          output.write('Saved to AIGate; matching credential metadata was read back. Provider authentication validity was not tested.\n');
        }
      } catch (caught) { attemptFailed = true; throw caught; }
      finally {
        let cleanupFailed = false;
        if (copied !== null) {
          try { if (await clipboard.read(undefined) === copied) await clipboard.clear(); } catch { cleanupFailed = true; error.write('Could not verify or clear the owned clipboard credential. Clear it manually.\n'); }
          copied = null;
        }
        if (root) {
          try { await removeAttemptRoot(root); output.write('Temporary local credentials removed.\n'); } catch { cleanupFailed = true; error.write(`Temporary credential cleanup failed. Remove ${root} before another setup.\n`); }
        }
        if (cleanupFailed && !attemptFailed) throw fail('Setup stopped because local cleanup could not be verified.');
      }
      first = false;
      if (options.once) break;
    } while ((await prompts.ask('Set up another account/credential? Type yes to continue')).trim() === 'yes');
  } finally { token = undefined; prompts.close(); }
}

async function main() {
  const controller = new AbortController();
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) { const handler = () => controller.abort(); handlers.set(signal, handler); process.on(signal, handler); }
  try { await runSetup(process.argv.slice(2), { signal: controller.signal }); }
  catch (error) { process.stderr.write((error[SAFE_ERROR] ? error.message : 'Setup failed; no successful save was verified. Local temporary cleanup was attempted.') + '\n'); process.exitCode = error.exitCode || 1; }
  finally { for (const [signal, handler] of handlers) process.off(signal, handler); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
