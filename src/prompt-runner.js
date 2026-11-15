/**
 * aigate/prompt-runner — run ONE text-in/text-out prompt through the OFFICIAL `claude` or
 * `codex` binary and hand back the answer.
 *
 * aigate never talks to Anthropic or ChatGPT with an OAuth credential itself: it spawns the
 * vendor's own CLI (args array, no shell) in a private throwaway HOME, with an allowlisted
 * environment, and reads what the CLI prints. The prompt travels on STDIN (never argv, so no flag
 * parsing can see it). See COMPLIANCE.md, "The prompt API".
 */
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export class PromptError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

// The child gets ONLY these from the server's own environment. The server env holds the vault
// encryption key and the admin token; nothing outside this list (and the per-run additions) may reach it.
const ENV_PASS = ['PATH', 'LANG', 'LC_ALL', 'TZ',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
export function childEnv(src, dir, extra = {}) {
  const env = {};
  for (const k of ENV_PASS) if (src[k] !== undefined && src[k] !== '') env[k] = src[k];
  return { ...env, HOME: dir, TMPDIR: dir, ...extra };
}

const MAX_OUT = 16 * 1024 * 1024, MAX_ERR = 64 * 1024;
const LIMIT_RX = /rate.?limit|usage limit|too many requests|\b429\b|quota|reached your (usage|limit)|limit reached|no available|insufficient/i;
const OVERLOAD_RX = /overloaded_error|\b529\b/i;

// ---- private parent for every run dir -------------------------------------------------------------
// <tmp root>/aigate-prompt-<uid>/ is created 0700 and must be a real directory owned by us: nothing another
// local user can plant (a symlink, a pre-made dir, a stray CLAUDE.md inside) is ever used, and the boot sweep
// only ever reads files that live under it.
export function promptParent(env = process.env) {
  const root = env.AIGATE_PROMPT_TMPDIR || tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const parent = join(root, `aigate-prompt-${uid}`);
  try { mkdirSync(parent, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw new PromptError(500, `cannot create ${parent}: ${e.code}`); }
  const st = lstatSync(parent);
  if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === 'function' && st.uid !== uid)) throw new PromptError(500, `${parent} is not a private directory owned by the server`);
  if ((st.mode & 0o077) !== 0) chmodSync(parent, 0o700);
  return parent;
}

// ---- argument arrays (exported so tests and the report can state them exactly) ---------------
// The prompt is NEVER in argv: the claude binary scans raw argv for some flags, so a "--"-protected prompt
// could still be read as one. It goes in on stdin; the system prompt goes in as a file in the 0700 run dir.
// `--tools ""` removes every built-in tool; dontAsk + permission-prompts none means nothing can ask for
// (or be granted) a permission; MCP, slash commands/skills, session files and Chrome are off.
export function claudeArgs({ model, systemFile }) {
  return ['-p', '--output-format', 'json', '--model', model,
    '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    ...(systemFile ? ['--system-prompt-file', systemFile] : []),
  ];
}
// codex exec has no tool-free flag, so every feature that can be switched off is (see CODEX_DISABLE_CANDIDATES
// and codexSurface), web search is disabled, the sandbox is read-only and nothing is persisted; the parser
// then refuses any run that used a tool anyway. `-` reads the prompt from stdin; it has no system-prompt flag,
// so `system` is prepended to the stdin text.
export function codexArgs({ model, serviceTier, cwd, disable = [] }) {
  return ['exec', '--json', '-m', model, ...(serviceTier ? ['-c', `service_tier="${serviceTier}"`] : []),
    '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-c', 'web_search="disabled"', ...disable.flatMap((f) => ['--disable', f]),
    '--color', 'never', '-C', cwd, '-'];
}
// every tool-bearing or ambient feature codex 0.167 lists; only the names the installed binary knows are
// passed (an unknown name is a hard error in codex)
export const CODEX_DISABLE_CANDIDATES = ['shell_tool', 'unified_exec', 'unified_exec_tty', 'apps', 'plugins', 'plugin_sharing', 'plugin_discovery_prefetch', 'remote_plugin',
  'multi_agent', 'image_generation', 'view_image', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'hooks',
  'skill_mcp_dependency_install', 'skill_search', 'sleep_tool', 'tool_suggest', 'workspace_dependencies', 'daemon_auto_start'];

// ---- output parsing: tolerant of noise lines ---------------------------------------------------
function jsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) continue;
    try { out.push(JSON.parse(t)); } catch { /* noise */ }
  }
  return out;
}
export function parseClaude(stdout) {
  let docs;
  try { docs = [JSON.parse(stdout)]; } catch { docs = jsonLines(stdout); }
  const flat = docs.flatMap((d) => (Array.isArray(d) ? d : [d]));
  const r = [...flat].reverse().find((d) => d && typeof d === 'object' && d.type === 'result');
  if (!r) return null;
  const mu = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage) : [];
  mu.sort((a, b) => (Number(b[1] && b[1].outputTokens) || 0) - (Number(a[1] && a[1].outputTokens) || 0));
  return {
    isError: r.is_error === true,
    text: typeof r.result === 'string' ? r.result : '',
    served_model: mu.length ? mu[0][0] : null,
    usage: { input_tokens: Number(r.usage && r.usage.input_tokens) || 0, output_tokens: Number(r.usage && r.usage.output_tokens) || 0 },
  };
}
// Only agent_message / reasoning / error items are text. ANY other item (command execution, MCP call, file
// change, web search, ...) means the model used a tool: toolUse is set and the caller must not return the text.
const CODEX_TEXT_ITEMS = new Set(['agent_message', 'reasoning', 'error']);
export function parseCodex(stdout) {
  let text = '', usage = null, error = '', toolUse = false;
  for (const e of jsonLines(stdout)) {
    if (!e || typeof e !== 'object') continue;
    if (e.item && typeof e.item === 'object') {
      if (!CODEX_TEXT_ITEMS.has(e.item.type)) toolUse = true;
      else if (e.type === 'item.completed' && e.item.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
      else if (e.item.type === 'error' && typeof e.item.message === 'string') error = e.item.message;
    }
    if (e.type === 'turn.completed' && e.usage) usage = e.usage;
    else if (e.type === 'turn.failed') error = String((e.error && e.error.message) || 'turn failed');
    else if (e.type === 'error') error = String(e.message || 'error');
  }
  // no event names the served model, so served_model is always null for codex
  return { isError: !!error && !text, text, error, toolUse, served_model: null,
    usage: { input_tokens: Number(usage && usage.input_tokens) || 0, output_tokens: Number(usage && usage.output_tokens) || 0 } };
}

// ---- process supervision ------------------------------------------------------------------------
function binMissing(bin, env) {
  const exists = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };
  if (bin.includes('/')) return !exists(bin);
  return !String(env.PATH || '').split(delimiter).filter(Boolean).some((d) => exists(join(d, bin)));
}
// Resolves {code, stdout, stderr, timedOut, aborted, overflow}; rejects PromptError(503) only when the
// binary is really missing (any other spawn failure is a 502).
function spawnCapture(bin, args, { cwd, env, timeoutMs, graceMs, signal, input = '' }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); }
    catch (e) { return reject(new PromptError(binMissing(bin, env) ? 503 : 502, binMissing(bin, env) ? `${bin} not found or not executable` : `${bin}: cannot start (${e.code || e.message})`)); }
    let stdout = '', stderr = '', timedOut = false, aborted = false, overflow = false, settled = false, tTerm, tKill, tGiveUp;
    const group = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const stop = () => {
      group('SIGTERM');
      tKill = setTimeout(() => { group('SIGKILL'); tGiveUp = setTimeout(() => finish(null), 2000); }, graceMs);
    };
    const finish = (code) => {
      if (settled) return; settled = true;
      clearTimeout(tTerm); clearTimeout(tKill); clearTimeout(tGiveUp);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted, overflow });
    };
    const onAbort = () => { aborted = true; stop(); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (overflow) return;                       // stop buffering the moment the cap is hit
      stdout += c;
      if (stdout.length > MAX_OUT) { overflow = true; stdout = ''; stop(); }
    });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_ERR) stderr += c; });
    child.stdin.on('error', () => { /* EPIPE: the binary exited before reading its prompt */ });
    child.stdin.end(input);
    child.on('error', (e) => {
      if (settled) return; settled = true;
      clearTimeout(tTerm); clearTimeout(tKill); clearTimeout(tGiveUp);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e && (e.code === 'ENOENT' || e.code === 'EACCES') && binMissing(bin, env) ? new PromptError(503, `${bin} not found or not executable (${e.code})`) : new PromptError(502, `${bin}: cannot run (${(e && e.code) || e.message})`));
    });
    // whatever the child left behind (success included) dies with it, and so closes the pipes 'close' waits on
    child.on('exit', () => group('SIGKILL'));
    child.on('close', (code) => finish(code));
    tTerm = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

// ---- which codex features can actually be switched off here ----------------------------------------
let surfaceCache = null;
const parseFeatures = (out) => new Map(out.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3 && /^(true|false)$/.test(p[p.length - 1])).map((p) => [p[0], p[p.length - 1] === 'true']));
// Runs `codex features list` under an empty CODEX_HOME, once without and once with the runner's flags.
// disable = candidates this binary knows; still_on = requested-off features that are STILL effectively on.
export async function codexSurface(env = process.env, { force = false } = {}) {
  const bin = env.AIGATE_CODEX_BIN || 'codex';
  if (!force && surfaceCache && surfaceCache.bin === bin) return surfaceCache.value;
  const dir = mkdtempSync(join(promptParent(env), 's-'));
  try {
    const run = (args) => spawnCapture(bin, args, { cwd: dir, env: childEnv(env, dir, { CODEX_HOME: join(dir, 'codex') }), timeoutMs: 20000, graceMs: 1000 });
    const base = await run(['features', 'list']);
    const known = parseFeatures(base.stdout);
    if (base.code !== 0 || known.size === 0) throw new PromptError(502, 'cannot inspect codex features (features list failed)');
    const disable = CODEX_DISABLE_CANDIDATES.filter((f) => known.has(f));
    const after = parseFeatures((await run([...disable.flatMap((f) => ['--disable', f]), '-c', 'web_search="disabled"', 'features', 'list'])).stdout);
    const value = { disable, still_on: disable.filter((f) => after.get(f) === true), checked_at: new Date().toISOString() };
    surfaceCache = { bin, value };
    return value;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// secrets this run knows about are cut out of anything that might be echoed back to the caller (exact values)
function redactor(secrets) {
  const cut = (s) => { let t = String(s || ''); for (const x of secrets) if (typeof x === 'string' && x.length >= 8) t = t.split(x).join('[redacted]'); return t; };
  cut.errors = (s) => cut(s).replace(/\b(sk-ant-|sk-|eyJ)[A-Za-z0-9._-]{12,}/g, '[redacted]');
  return cut;
}
// every string credential in an auth.json (tokens.* except the non-secret account id, and an API key if any)
const authSecrets = (a) => a ? [...Object.entries(a.tokens || {}).filter(([k, v]) => k !== 'account_id' && typeof v === 'string').map(([, v]) => v), typeof a.OPENAI_API_KEY === 'string' ? a.OPENAI_API_KEY : null].filter(Boolean) : [];
const authChanged = (a, b) => ['access_token', 'refresh_token', 'id_token'].some((k) => (a.tokens || {})[k] !== (b.tokens || {})[k]) || a.last_refresh !== b.last_refresh;

/**
 * job:   { engine: 'claude'|'codex', model, serviceTier?, prompt, system?, timeoutS, signal?, account,
 *          token (claude setup-token) | auth (codex auth.json object) }
 * hooks: codex only — { leaseOpen(scopeDir), leaseClose(scopeDir),
 *          syncBack(authObj) -> {ok}  (async; stores the rotated login or flags the account itself),
 *          rotationFailed(account, why) }
 * Resolves { text, served_model, usage } or throws PromptError. The run dir is removed in every outcome
 * EXCEPT when a rotated codex login could not be stored: then codex/auth.json stays for the boot sweep.
 */
export async function runPrompt(job, hooks = {}) {
  const e = process.env;
  const bin = job.engine === 'claude' ? (e.AIGATE_CLAUDE_BIN || 'claude') : (e.AIGATE_CODEX_BIN || 'codex');
  const graceMs = Number(e.AIGATE_PROMPT_KILL_GRACE_MS) || 5000;
  const secrets = [job.token, ...authSecrets(job.auth)];
  const redact = redactor(secrets);
  const surf = job.engine === 'codex' ? await codexSurface(e) : null;
  const dir = mkdtempSync(join(promptParent(e), 'r-'));
  let keep = false;
  try {
    chmodSync(dir, 0o700);
    const opts = { timeoutMs: job.timeoutS * 1000, graceMs, signal: job.signal };
    let args, env, cwd = dir, authPath, written, scope, input = job.prompt;
    if (job.engine === 'claude') {
      let systemFile;
      if (job.system) { systemFile = join(dir, 'system.txt'); writeFileSync(systemFile, job.system, { mode: 0o600 }); }
      args = claudeArgs({ model: job.model, systemFile });
      env = childEnv(e, dir, { CLAUDE_CODE_OAUTH_TOKEN: job.token, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' });
    } else {
      const codexHome = join(dir, 'codex'); cwd = join(dir, 'work');
      mkdirSync(codexHome, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
      authPath = join(codexHome, 'auth.json');
      written = JSON.stringify(job.auth);
      writeFileSync(authPath, written, { mode: 0o600 }); chmodSync(authPath, 0o600);
      writeFileSync(join(dir, 'account'), JSON.stringify({ account: job.account }), { mode: 0o600 });   // sidecar for the boot sweep
      scope = realpathSync(codexHome);
      args = codexArgs({ model: job.model, serviceTier: job.serviceTier, cwd, disable: surf.disable });
      env = childEnv(e, dir, { CODEX_HOME: codexHome });
      if (job.system) input = `${job.system}\n\n${job.prompt}`;
    }
    const flag = (why) => { try { if (hooks.rotationFailed) hooks.rotationFailed(job.account, why); } catch { /* best effort */ } };
    // a login codex rotated mid-run exists nowhere else: it is offered to the vault even when the run failed,
    // timed out or was aborted, and the file is only deleted once the vault has it (or knows it must not trust it)
    const settleAuth = async () => {
      let raw;
      try { raw = readFileSync(authPath, 'utf8'); } catch { console.error('[prompt] codex auth.json is gone after the run'); return false; }
      if (raw === written) return false;
      let a = null;
      try { a = JSON.parse(raw); } catch { /* handled below */ }
      if (!a || typeof a !== 'object' || !a.tokens) { flag('auth.json unreadable after the run (killed mid-write?)'); return true; }
      secrets.push(...authSecrets(a));
      if (!authChanged(job.auth, a)) return false;
      try { const o = await hooks.syncBack(a); return !(o && o.ok); }
      catch (err) { flag('storing the rotated login threw: ' + String((err && err.message) || err)); return true; }
    };
    let r;
    try {
      if (hooks.leaseOpen && scope) hooks.leaseOpen(scope);
      r = await spawnCapture(bin, args, { ...opts, cwd, env, input });
    } finally {
      if (authPath) {
        try { keep = await settleAuth(); } catch { keep = true; }
        try { if (hooks.leaseClose) hooks.leaseClose(scope); } catch { /* attribution only */ }
      }
    }
    if (r.aborted) throw new PromptError(499, 'client disconnected');
    if (r.timedOut) throw new PromptError(504, `${job.engine} timed out after ${job.timeoutS}s`);
    if (r.overflow) throw new PromptError(502, `${job.engine} output too large`);
    const p = job.engine === 'claude' ? parseClaude(r.stdout) : parseCodex(r.stdout);
    if (p && p.toolUse) throw new PromptError(502, 'tool use detected: the run is refused and its output discarded');
    const bad = r.code !== 0 || !p || p.isError || !p.text;
    if (!bad) return { text: redact(p.text), served_model: p.served_model, usage: p.usage };
    // classify on stderr and on error items only, never on what the model said
    const errText = p ? (p.isError ? (p.error || p.text) : p.error) : r.stdout.slice(0, 2000);
    const diag = redact.errors(`${errText || ''}\n${r.stderr}`);
    if (LIMIT_RX.test(diag)) throw new PromptError(503, `${job.engine} account out of headroom`, { limited: true });
    if (OVERLOAD_RX.test(diag)) throw new PromptError(503, `${job.engine} upstream overloaded`);
    throw new PromptError(502, `${job.engine} failed (exit ${r.code})${diag.trim() ? ': ' + diag.trim().slice(0, 300) : ''}`);
  } finally {
    if (keep) { rmSync(join(dir, 'work'), { recursive: true, force: true }); rmSync(join(dir, 'system.txt'), { force: true }); }
    else rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Boot sweep: any run dir a crash or an unstorable rotation left behind. A leftover codex/auth.json is offered
 * to the vault (hooks.offer(authObj, accountHint) -> {ok}); whatever happens the dir is then deleted. A leftover
 * that cannot be offered flags its account (hooks.rotationFailed). The account comes from the run's sidecar file,
 * never from the token.
 */
export async function sweepLeftovers(hooks, env = process.env) {
  const parent = promptParent(env);
  const out = { offered: 0, flagged: 0, removed: 0 };
  for (const name of readdirSync(parent)) {
    if (!/^[rs]-/.test(name)) continue;
    const dir = join(parent, name), authPath = join(dir, 'codex', 'auth.json');
    let account = null; try { account = JSON.parse(readFileSync(join(dir, 'account'), 'utf8')).account || null; } catch { /* no sidecar */ }
    if (existsSync(authPath)) {
      try {
        const a = JSON.parse(readFileSync(authPath, 'utf8'));
        if (!a || typeof a !== 'object' || !a.tokens) throw new Error('no tokens');
        out.offered++;
        const o = await hooks.offer(a, account);   // offer() flags the account itself when it cannot store
        if (!(o && o.ok)) out.flagged++;
      } catch (err) {
        out.flagged++;
        try { hooks.rotationFailed(account, 'boot sweep could not read or store a leftover login: ' + String((err && err.message) || err)); } catch { /* best effort */ }
      }
    }
    rmSync(dir, { recursive: true, force: true }); out.removed++;
  }
  return out;
}
