/**
 * aigate/prompt-runner — run ONE text-in/text-out prompt through the OFFICIAL `claude` or
 * `codex` binary and hand back the answer.
 *
 * aigate never talks to Anthropic or ChatGPT with an OAuth credential itself: it spawns the
 * vendor's own CLI (args array, no shell, stdin closed) in a private throwaway HOME, with an
 * allowlisted environment, and reads what the CLI prints. See COMPLIANCE.md, "The prompt API".
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ---- argument arrays (exported so tests and the report can state them exactly) ---------------
// `--tools ""` removes every built-in tool; dontAsk + permission-prompts none means nothing can ask for
// (or be granted) a permission; MCP, slash commands/skills, session files and Chrome are off.
// `--` ends option parsing so a prompt that starts with "-" (or follows the variadic --tools) stays a prompt.
export function claudeArgs({ model, system, prompt }) {
  return ['-p', '--output-format', 'json', '--model', model,
    '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
    '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--no-chrome',
    ...(system ? ['--system-prompt', system] : []),
    '--', prompt];
}
// codex exec has no tool-free flag, so the shell tools are switched off as features, the sandbox is
// read-only, and nothing is persisted. It has no system-prompt flag: `system` is prepended to the prompt.
export function codexArgs({ model, serviceTier, system, prompt, cwd }) {
  return ['exec', '--json', '-m', model, ...(serviceTier ? ['-c', `service_tier="${serviceTier}"`] : []),
    '--skip-git-repo-check', '-s', 'read-only', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--color', 'never', '-C', cwd,
    '--', system ? `${system}\n\n${prompt}` : prompt];
}

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
export function parseCodex(stdout) {
  let text = '', served = null, usage = null, error = '';
  for (const e of jsonLines(stdout)) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
    else if (e.type === 'turn.completed' && e.usage) usage = e.usage;
    else if (e.type === 'turn.failed') error = String((e.error && e.error.message) || 'turn failed');
    else if (e.type === 'error') error = String(e.message || 'error');
    if (typeof e.model === 'string' && e.model) served = e.model;
  }
  return { isError: !!error && !text, text, error, served_model: served,
    usage: { input_tokens: Number(usage && usage.input_tokens) || 0, output_tokens: Number(usage && usage.output_tokens) || 0 } };
}

// ---- process supervision ------------------------------------------------------------------------
// Resolves {code, stdout, stderr, timedOut, aborted}; rejects PromptError(503) when the binary is missing.
function spawnCapture(bin, args, { cwd, env, timeoutMs, graceMs, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { return reject(new PromptError(503, `${bin}: cannot start (${e.code || e.message})`)); }
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
    child.stdout.on('data', (c) => { stdout += c; if (stdout.length > MAX_OUT && !overflow) { overflow = true; stop(); } });
    child.stderr.on('data', (c) => { if (stderr.length < MAX_ERR) stderr += c; });
    child.on('error', (e) => {
      if (settled) return; settled = true;
      clearTimeout(tTerm); clearTimeout(tKill); clearTimeout(tGiveUp);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(e && (e.code === 'ENOENT' || e.code === 'EACCES') ? new PromptError(503, `${bin} not found or not executable (${e.code})`) : new PromptError(502, `${bin}: ${e.code || e.message}`));
    });
    child.on('close', (code) => finish(code));
    tTerm = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  });
}

// secrets this run knows about are cut out of anything that might be echoed back to the caller
function redactor(secrets) {
  const lits = secrets.filter((s) => typeof s === 'string' && s.length >= 8);
  return (s) => {
    let t = String(s || '');
    for (const x of lits) t = t.split(x).join('[redacted]');
    return t.replace(/\b(sk-ant-|sk-|eyJ)[A-Za-z0-9._-]{12,}/g, '[redacted]');
  };
}
const authSecrets = (a) => a && a.tokens ? [a.tokens.access_token, a.tokens.refresh_token, a.tokens.id_token] : [];
const authChanged = (a, b) => ['access_token', 'refresh_token', 'id_token'].some((k) => (a.tokens || {})[k] !== (b.tokens || {})[k]) || a.last_refresh !== b.last_refresh;

/**
 * job:   { engine: 'claude'|'codex', model, serviceTier?, prompt, system?, timeoutS, signal?,
 *          token (claude setup-token) | auth (codex auth.json object) }
 * hooks: codex only — { leaseOpen(scopeDir), leaseClose(scopeDir), syncBack(authObj) }
 * Resolves { text, served_model, usage } or throws PromptError. The run dir is removed in every outcome.
 */
export async function runPrompt(job, hooks = {}) {
  const e = process.env;
  const bin = job.engine === 'claude' ? (e.AIGATE_CLAUDE_BIN || 'claude') : (e.AIGATE_CODEX_BIN || 'codex');
  const graceMs = Number(e.AIGATE_PROMPT_KILL_GRACE_MS) || 5000;
  const dir = mkdtempSync(join(e.AIGATE_PROMPT_TMPDIR || tmpdir(), 'aigate-prompt-'));
  const redact = redactor([job.token, ...authSecrets(job.auth)]);
  try {
    chmodSync(dir, 0o700);
    const opts = { timeoutMs: job.timeoutS * 1000, graceMs, signal: job.signal };
    let args, env, cwd = dir, codexHome, authPath, written, scope;
    if (job.engine === 'claude') {
      args = claudeArgs({ model: job.model, system: job.system, prompt: job.prompt });
      env = childEnv(e, dir, { CLAUDE_CODE_OAUTH_TOKEN: job.token, DISABLE_AUTOUPDATER: '1' });
    } else {
      codexHome = join(dir, 'codex'); cwd = join(dir, 'work');
      mkdirSync(codexHome, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
      authPath = join(codexHome, 'auth.json');
      written = JSON.stringify(job.auth);
      writeFileSync(authPath, written, { mode: 0o600 }); chmodSync(authPath, 0o600);
      scope = realpathSync(codexHome);
      args = codexArgs({ model: job.model, serviceTier: job.serviceTier, system: job.system, prompt: job.prompt, cwd });
      env = childEnv(e, dir, { CODEX_HOME: codexHome });
    }
    let r;
    try {
      if (hooks.leaseOpen && scope) hooks.leaseOpen(scope);
      r = await spawnCapture(bin, args, { ...opts, cwd, env });
    } finally {
      // a token codex rotated mid-run exists nowhere else: store it back even when the run failed or timed out
      if (authPath) {
        try {
          const now = readFileSync(authPath, 'utf8');
          if (now !== written) { const a = JSON.parse(now); if (a && a.tokens && authChanged(job.auth, a) && hooks.syncBack) hooks.syncBack(a); }
        } catch { /* unreadable or removed auth.json: nothing to store */ }
        try { if (hooks.leaseClose) hooks.leaseClose(scope); } catch { /* attribution only */ }
      }
    }
    if (r.aborted) throw new PromptError(499, 'client disconnected');
    if (r.timedOut) throw new PromptError(504, `${job.engine} timed out after ${job.timeoutS}s`);
    if (r.overflow) throw new PromptError(502, `${job.engine} output too large`);
    const p = job.engine === 'claude' ? parseClaude(r.stdout) : parseCodex(r.stdout);
    const bad = r.code !== 0 || !p || p.isError || !p.text;
    if (!bad) return { text: p.text, served_model: p.served_model, usage: p.usage };
    const diag = redact(`${(p && (p.error || p.text)) || ''}\n${r.stderr}\n${p ? '' : r.stdout.slice(0, 2000)}`);
    if (LIMIT_RX.test(diag)) throw new PromptError(503, `${job.engine} account out of headroom`, { limited: true });
    if (OVERLOAD_RX.test(diag)) throw new PromptError(503, `${job.engine} upstream overloaded`);
    throw new PromptError(502, `${job.engine} failed (exit ${r.code})${diag.trim() ? ': ' + diag.trim().slice(0, 300) : ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
