import { createHash, randomUUID } from 'node:crypto';
import { createClaudeUsageProbe } from './claude-usage-probe.js';

const WINDOWS = ['five_hour', 'seven_day'];
const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => value == null ? null : new Date(value).toISOString();
const epoch = value => {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value); return Number.isFinite(number) && number >= 0 ? (number < 1e12 ? number * 1000 : number) : null;
  }
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
};
const family = model => /(?:^|[-/])opus(?:[-/]|$)/i.test(model || '') ? 'opus'
  : /(?:^|[-/])sonnet(?:[-/]|$)/i.test(model || '') ? 'sonnet'
    : /(?:^|[-/])haiku(?:[-/]|$)/i.test(model || '') ? 'haiku' : String(model || '').slice(0, 256);
const abortError = () => Object.assign(new Error('Claude pool request cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });

function headerMap(raw) {
  const values = new Map();
  const add = (name, value) => { name = name.toLowerCase(); values.set(name, values.has(name) ? null : value); };
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) add(String(raw[i]), raw[i + 1]);
  else if (raw?.entries) for (const [name, value] of raw.entries()) add(name, value);
  else if (raw && typeof raw === 'object') for (const [name, value] of Object.entries(raw)) add(name, Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value);
  return values;
}

export function parseClaudeQuotaHeaders(raw) {
  const headers = headerMap(raw), result = {};
  for (const [window, short] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const value = headers.get(`anthropic-ratelimit-unified-${short}-utilization`);
    const text = value == null ? '' : String(value).trim();
    const number = text === '' ? NaN : Number(text);
    const used = Number.isFinite(number) && number >= 0 && number <= 1 ? number * 100 : null;
    result[window] = { used_pct: used, remaining_pct: used == null ? null : 100 - used,
      reset_ms: epoch(headers.get(`anthropic-ratelimit-unified-${short}-reset`)), present: value != null };
  }
  return result;
}

// The returned status is admin-safe; acquire alone returns an internal credential.
// Polling never creates accounts. Each window needs its own real observation.
export async function createClaudePool({ db, decrypt, clock = Date.now, pollMs = 300000, maxAgeMs = 600000,
  concurrency = 3, maxInFlight = 4, probe, getTrafficStore, timers = { setTimeout, clearTimeout },
  probeTimeoutMs = 15000, upstream, probeModel } = {}) {
  for (const [name, value] of Object.entries({ pollMs, maxAgeMs, concurrency, maxInFlight, probeTimeoutMs }))
    if (!Number.isFinite(value) || value < (name === 'pollMs' ? 0 : 1)) throw new TypeError(`${name} must be a valid positive number`);
  const runProbe = probe || createClaudeUsageProbe({ getTrafficStore, clock, timeoutMs: probeTimeoutMs,
    ...(upstream ? { upstream } : {}), ...(probeModel ? { model: probeModel } : {}) });
  db.exec(`CREATE TABLE IF NOT EXISTS claude_pool_metadata (
    account TEXT PRIMARY KEY, quota_scope TEXT, credential_expires_at INTEGER, expiry_fingerprint TEXT,
    last_used_at INTEGER NOT NULL DEFAULT 0
  ); CREATE TABLE IF NOT EXISTS claude_pool_usage (
    account TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    five_used REAL, five_reset INTEGER, five_observed INTEGER, seven_used REAL, seven_reset INTEGER, seven_observed INTEGER,
    source TEXT, last_error TEXT, last_capture_id INTEGER, last_poll_started INTEGER, last_poll_finished INTEGER
  ); CREATE TABLE IF NOT EXISTS claude_pool_blocks (
    scope_key TEXT NOT NULL, model_family TEXT NOT NULL DEFAULT '', window TEXT NOT NULL DEFAULT 'account',
    until_ms INTEGER NOT NULL, observed_at INTEGER NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY(scope_key,model_family,window)
  )`);
  const allAccounts = db.prepare("SELECT account,label,token_enc,kind,token_exp,disabled,reauth_needed,parked_until FROM accounts WHERE kind='claude' AND token_enc IS NOT NULL ORDER BY account");
  const getAccount = db.prepare("SELECT account,label,token_enc,kind,token_exp,disabled,reauth_needed,parked_until FROM accounts WHERE account=? AND kind='claude' AND token_enc IS NOT NULL");
  const getMeta = db.prepare('SELECT * FROM claude_pool_metadata WHERE account=?');
  const getUsage = db.prepare('SELECT * FROM claude_pool_usage WHERE account=?');
  const ensureUsage = db.prepare(`INSERT INTO claude_pool_usage(account,fingerprint) VALUES(?,?)
    ON CONFLICT(account) DO UPDATE SET fingerprint=excluded.fingerprint,revision=claude_pool_usage.revision+1,
    five_used=NULL,five_reset=NULL,five_observed=NULL,seven_used=NULL,seven_reset=NULL,seven_observed=NULL,
    source=NULL,last_error=NULL,last_capture_id=NULL,last_poll_started=NULL,last_poll_finished=NULL
    WHERE claude_pool_usage.fingerprint<>excluded.fingerprint`);
  const ensureMeta = db.prepare('INSERT OR IGNORE INTO claude_pool_metadata(account) VALUES(?)');
  const leases = new Map(), refreshing = new Map(), controllers = new Set();
  let cycle = null, timer = null, started = false, stopped = false;
  let lastStarted = null, lastCompleted = null, nextPoll = null;

  function load(raw) {
    if (!raw) return null;
    let token;
    try { token = decrypt(raw.token_enc); } catch { return { ...raw, invalid: true, token: null, fingerprint: null, meta: getMeta.get(raw.account) || {} }; }
    if (typeof token !== 'string' || !token) return { ...raw, invalid: true, token: null, fingerprint: null, meta: getMeta.get(raw.account) || {} };
    const fingerprint = hash(token);
    ensureUsage.run(raw.account, fingerprint); ensureMeta.run(raw.account);
    return { ...raw, token, fingerprint, meta: getMeta.get(raw.account), usage: getUsage.get(raw.account) };
  }
  const rows = () => allAccounts.all().map(load);
  const scopeKeys = row => [`token:${row.fingerprint}`, row.meta.quota_scope ? `scope:${row.meta.quota_scope}` : `account:${row.account}`];
  const sameScope = (a, b) => a.fingerprint === b.fingerprint || (a.meta.quota_scope && a.meta.quota_scope === b.meta.quota_scope);
  function scopeMembers(row, candidates = rows()) {
    const members = [row], names = new Set([row.account]);
    for (let index = 0; index < members.length; index++) for (const candidate of candidates) {
      if (!candidate.invalid && !names.has(candidate.account) && sameScope(members[index], candidate)) {
        names.add(candidate.account); members.push(candidate);
      }
    }
    return members;
  }
  const sharedKeys = row => new Set(scopeMembers(row).flatMap(scopeKeys));
  const expiryFor = row => row.meta.expiry_fingerprint === row.fingerprint ? row.meta.credential_expires_at : null;
  function blocksFor(row, model) {
    if (!row.fingerprint) return [];
    const keys = sharedKeys(row), requestedFamily = family(model);
    return db.prepare('SELECT * FROM claude_pool_blocks').all().filter(block => keys.has(block.scope_key)
      && (!block.model_family || block.model_family === requestedFamily));
  }
  function describe(row, { model, excluded = new Set(), affinity } = {}) {
    const now = clock(), usage = row.usage || {}, blocks = blocksFor(row, model);
    const windowOut = (prefix, name) => {
      const used = usage[prefix + '_used'] ?? null, observed = usage[prefix + '_observed'] ?? null;
      const barrier = Math.max(-Infinity, ...blocks.filter(b => !b.model_family && ['account', name].includes(b.window)).map(b => b.observed_at));
      return { used_pct: used, remaining_pct: used == null ? null : 100 - used,
        resets_at: iso(usage[prefix + '_reset']), observed_at: iso(observed),
        fresh: observed != null && observed <= now && now - observed <= maxAgeMs && observed > barrier };
    };
    const five = windowOut('five', 'five_hour'), seven = windowOut('seven', 'seven_day');
    const activeBlocks = blocks.filter(block => block.until_ms > now);
    const inFlight = [...leases.values()].filter(lease => lease.account === row.account).length;
    const expiry = expiryFor(row), scopeId = row.meta.quota_scope || row.account;
    let reason = null;
    if (row.invalid || !row.token?.startsWith('sk-ant-oat')) reason = 'invalid_credential';
    else if (row.disabled) reason = 'disabled';
    else if (row.reauth_needed) reason = 'reauth_needed';
    else if (epoch(row.parked_until) > now) reason = 'parked';
    else if (expiry != null && expiry <= now) reason = 'credential_expired';
    else if (excluded.has(row.account) || excluded.has(scopeId)) reason = 'already_attempted';
    else if (affinity && ![row.account, scopeId].includes(typeof affinity === 'string' ? affinity : affinity.scopeId || affinity.account)) reason = 'scope_mismatch';
    else if (activeBlocks.some(block => block.model_family)) reason = 'model_cooldown';
    else if (activeBlocks.length) reason = 'exhausted';
    else if (five.used_pct == null || seven.used_pct == null) reason = 'usage_unknown';
    else if (!five.fresh || !seven.fresh) reason = 'usage_stale';
    else if (five.remaining_pct <= 0 || seven.remaining_pct <= 0) reason = 'exhausted';
    else if (inFlight >= maxInFlight) reason = 'in_flight_limit';
    return { account: row.account, label: row.label || '', eligible: reason == null, reason,
      quota_scope: scopeId, credential_expires_at: iso(expiry), in_flight: inFlight,
      cooldown_until: activeBlocks.length ? iso(Math.max(...activeBlocks.map(block => block.until_ms))) : null,
      cooldowns: row.invalid ? [] : db.prepare('SELECT * FROM claude_pool_blocks').all().filter(block => sharedKeys(row).has(block.scope_key) && block.model_family && block.until_ms > now)
        .map(block => ({ model: block.model_family, until: iso(block.until_ms) }))
        .filter((block, index, all) => all.findIndex(other => other.model === block.model && other.until === block.until) === index),
      five_hour: five, seven_day: seven, observation_source: usage.source || null,
      last_error: usage.last_error || null, last_capture_id: usage.last_capture_id || null };
  }
  function ranked(options = {}) {
    const exclude = options.excludeAccounts || [];
    const excluded = new Set(exclude instanceof Set ? exclude : exclude);
    const now = clock();
    return rows().map(row => ({ row, item: describe(row, { ...options, excluded }) })).sort((a, b) => {
      if (a.item.eligible !== b.item.eligible) return a.item.eligible ? -1 : 1;
      const reset = value => value != null && value > now ? value : Infinity;
      return reset(a.row.usage?.seven_reset) - reset(b.row.usage?.seven_reset)
        || Math.max(a.item.five_hour.used_pct ?? 100, a.item.seven_day.used_pct ?? 100) - Math.max(b.item.five_hour.used_pct ?? 100, b.item.seven_day.used_pct ?? 100)
        || a.item.in_flight - b.item.in_flight
        || (a.row.meta.last_used_at || 0) - (b.row.meta.last_used_at || 0)
        || a.item.account.localeCompare(b.item.account);
    });
  }
  function status(options = {}) {
    const accounts = ranked(options).map(entry => entry.item);
    return { policy: 'soonest_weekly_reset', poll_interval_ms: pollMs, max_age_ms: maxAgeMs,
      last_started_at: iso(lastStarted), last_completed_at: iso(lastCompleted), next_poll_at: iso(nextPoll),
      refreshing: !!cycle || refreshing.size > 0, next_account: accounts.find(account => account.eligible)?.account || null, accounts };
  }
  function acquire(options = {}) {
    if (options.signal?.aborted) throw abortError();
    const candidate = ranked(options).find(entry => entry.item.eligible);
    if (!candidate) return null;
    const { row, item } = candidate;
    const lease = { account: row.account, token: row.token, leaseId: randomUUID(), scopeId: item.quota_scope,
      snapshot: { ...item, selected_at: iso(clock()) }, fingerprint: row.fingerprint };
    leases.set(lease.leaseId, lease);
    db.prepare('UPDATE claude_pool_metadata SET last_used_at=? WHERE account=?').run(clock(), row.account);
    return lease;
  }
  function release(lease) { return leases.delete(typeof lease === 'string' ? lease : lease?.leaseId); }
  function observationCurrent(account, fingerprint, revision) {
    const current = load(getAccount.get(account));
    return current && !current.invalid && current.fingerprint === fingerprint
      && (revision == null || current.usage.revision === revision) ? current : null;
  }
  function applyObservation(account, rawHeaders, options = {}) {
    const current = load(getAccount.get(account));
    if (!current || current.invalid) return { applied: false, reason: 'account_unavailable' };
    if (options.tokenEnvelope && current.token_enc !== options.tokenEnvelope) return { applied: false, reason: 'newer_credential_or_observation' };
    if (options.fingerprint && !observationCurrent(account, options.fingerprint, options.revision)) return { applied: false, reason: 'newer_credential_or_observation' };
    const at = options.observedAt ?? clock();
    if (!Number.isFinite(at) || at > clock()) return { applied: false, reason: 'invalid_observation_time' };
    const parsed = parseClaudeQuotaHeaders(rawHeaders), valid = WINDOWS.filter(window => parsed[window].used_pct != null);
    const httpStatus = options.status ?? 200;
    const alive = httpStatus >= 200 && httpStatus < 300 || httpStatus === 429 && valid.length > 0;
    const authFailure = httpStatus === 401 || (httpStatus === 403 && options.errorType === 'authentication_error');
    const authUpdate = db.prepare('UPDATE accounts SET reauth_needed=? WHERE account=?');
    if (authFailure) authUpdate.run(1, account);
    else if (alive) authUpdate.run(0, account);
    const members = scopeMembers(current);
    for (const row of members) {
      if (row.account !== account && options.source === 'probe' && row.disabled) continue;
      const state = row.usage;
      if (options.startedAt != null && state.last_poll_started != null && state.last_poll_started > options.startedAt) continue;
      for (const [window, prefix] of [['five_hour', 'five'], ['seven_day', 'seven']]) {
        const value = parsed[window];
        if (value.used_pct == null || (state[prefix + '_observed'] != null && state[prefix + '_observed'] > at)) continue;
        db.prepare(`UPDATE claude_pool_usage SET ${prefix}_used=?,${prefix}_reset=?,${prefix}_observed=? WHERE account=?`)
          .run(value.used_pct, value.reset_ms, at, row.account);
      }
      if (valid.length || authFailure) db.prepare('UPDATE claude_pool_usage SET revision=revision+1,source=?,last_error=?,last_capture_id=COALESCE(?,last_capture_id) WHERE account=?')
        .run(options.source || 'response', authFailure && row.account === account ? 'authentication_failed' : null, options.capture_id || null, row.account);
      if (valid.length) {
        const updated = getUsage.get(row.account);
        db.prepare('UPDATE accounts SET five_hour_pct=COALESCE(?,five_hour_pct),seven_day_pct=COALESCE(?,seven_day_pct),five_hour_reset=COALESCE(?,five_hour_reset),seven_day_reset=COALESCE(?,seven_day_reset),usage_updated=? WHERE account=?')
          .run(updated.five_used, updated.seven_used, updated.five_reset == null ? null : updated.five_reset / 1000,
            updated.seven_reset == null ? null : updated.seven_reset / 1000, new Date(at).toISOString(), row.account);
      }
      // A successful inference is a current observation, unlike delayed cost analytics.
      // It can clear only global windows it proves positive, or the same model family.
      if (httpStatus >= 200 && httpStatus < 300) for (const block of blocksFor(row, options.model)) {
        if (options.startedAt != null && options.startedAt < block.observed_at) continue;
        const positive = block.model_family ? family(options.model) === block.model_family && httpStatus >= 200 && httpStatus < 300
          : block.window === 'account' ? valid.length === 2 && valid.every(window => parsed[window].remaining_pct > 0)
            : parsed[block.window]?.remaining_pct > 0;
        if (positive) db.prepare('DELETE FROM claude_pool_blocks WHERE scope_key=? AND model_family=? AND window=?').run(block.scope_key, block.model_family, block.window);
      }
    }
    return { applied: valid.length > 0 || authFailure, status: httpStatus, alive, account,
      five: parsed.five_hour.used_pct, seven: parsed.seven_day.used_pct,
      note: valid.length ? null : 'no valid quota headers' };
  }
  function observeHeaders(account, rawHeaders, options = {}) { return applyObservation(account, rawHeaders, { ...options, source: options.source || 'response' }); }
  function markExhausted(account, options = {}) {
    const row = load(getAccount.get(account));
    if (!row || row.invalid || (options.fingerprint && row.fingerprint !== options.fingerprint)) return false;
    const at = options.observedAt ?? clock(), window = options.window || 'account';
    if (!['five_hour', 'seven_day', 'account', 'model'].includes(window)) throw new TypeError('invalid quota exhaustion window');
    const modelFamily = options.modelFamily || (window === 'model' ? family(options.model) : '');
    if (window === 'model' && !modelFamily) throw new TypeError('model exhaustion needs a model family');
    let until = epoch(options.resetAt ?? options.until);
    if (until == null) until = window === 'five_hour' ? row.usage.five_reset : window === 'seven_day' ? row.usage.seven_reset : null;
    if (until == null || until <= at) until = at + (pollMs || 300000);
    const members = scopeMembers(row), keys = [...new Set(members.flatMap(scopeKeys))];
    for (const key of keys) db.prepare(`INSERT INTO claude_pool_blocks(scope_key,model_family,window,until_ms,observed_at,reason) VALUES(?,?,?,?,?,?)
      ON CONFLICT(scope_key,model_family,window) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms),observed_at=MAX(observed_at,excluded.observed_at),reason=excluded.reason`)
      .run(key, modelFamily || '', window, until, at, options.reason || (modelFamily ? 'model_quota_exhausted' : 'quota_exhausted'));
    for (const member of members) db.prepare('UPDATE claude_pool_usage SET revision=revision+1 WHERE account=?').run(member.account);
    return true;
  }
  function setMetadata(account, data) {
    const row = load(getAccount.get(account));
    if (!row || row.invalid) throw Object.assign(new Error('unknown Claude account'), { statusCode: 404 });
    const allowed = new Set(['quota_scope', 'credential_expires_at']);
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.has(key))) throw new TypeError('invalid Claude account metadata');
    const expiry = data.credential_expires_at === null ? null : epoch(data.credential_expires_at);
    if (data.credential_expires_at !== undefined && data.credential_expires_at !== null && expiry == null) throw new TypeError('invalid credential_expires_at');
    if (data.quota_scope !== undefined) {
      if (data.quota_scope !== null && (typeof data.quota_scope !== 'string' || !/^[A-Za-z0-9._:@-]{1,200}$/.test(data.quota_scope))) throw new TypeError('invalid quota_scope');
      db.prepare('UPDATE claude_pool_metadata SET quota_scope=? WHERE account=?').run(data.quota_scope, account);
    }
    if (data.credential_expires_at !== undefined) {
      db.prepare('UPDATE claude_pool_metadata SET credential_expires_at=?,expiry_fingerprint=? WHERE account=?').run(expiry, row.fingerprint, account);
    }
    db.prepare('UPDATE claude_pool_usage SET revision=revision+1 WHERE account=?').run(account);
    return status().accounts.find(item => item.account === account);
  }
  function refreshAccount(account, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (refreshing.has(account)) return refreshing.get(account);
    const row = load(getAccount.get(account));
    if (!row || row.invalid) return Promise.resolve({ account, error: 'account_unavailable' });
    const controller = new AbortController(), startedAt = clock(), revision = row.usage.revision;
    controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    db.prepare('UPDATE claude_pool_usage SET last_poll_started=? WHERE account=?').run(startedAt, account);
    const pending = Promise.resolve().then(async () => {
      let deadline, probeAbort;
      try {
        const result = await new Promise((resolve, reject) => {
          probeAbort = () => reject(abortError());
          controller.signal.addEventListener('abort', probeAbort, { once: true });
          if (controller.signal.aborted) { reject(abortError()); return; }
          deadline = setTimeout(() => {
            reject(Object.assign(new Error('Claude usage probe timed out'), { code: 'PROBE_TIMEOUT' }));
            controller.abort();
          }, probeTimeoutMs);
          deadline.unref?.();
          Promise.resolve().then(() => runProbe({ account, token: row.token, signal: controller.signal })).then(resolve, reject);
        });
        if (controller.signal.aborted) throw abortError();
        const applied = applyObservation(account, result.rawHeaders || result.headers, { ...result,
          fingerprint: row.fingerprint, tokenEnvelope: row.token_enc, revision, startedAt, observedAt: result.observedAt ?? clock(), source: 'probe' });
        if (observationCurrent(account, row.fingerprint)) db.prepare('UPDATE claude_pool_usage SET last_poll_finished=?,last_error=? WHERE account=?')
          .run(clock(), applied.applied ? null : applied.reason || applied.note || `probe_http_${result.status}`, account);
        return { ...applied, account, capture_id: result.capture_id || null };
      } catch (error) {
        if (observationCurrent(account, row.fingerprint)) db.prepare('UPDATE claude_pool_usage SET last_poll_finished=?,last_error=? WHERE account=?')
          .run(clock(), controller.signal.aborted ? 'probe_cancelled' : error?.code || 'probe_failed', account);
        return { account, error: error?.code === 'PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : controller.signal.aborted ? 'probe_cancelled' : error?.code || 'probe_failed' };
      } finally {
        clearTimeout(deadline); controller.signal.removeEventListener('abort', probeAbort);
        controllers.delete(controller); refreshing.delete(account); signal?.removeEventListener('abort', abort);
      }
    });
    refreshing.set(account, pending); return pending;
  }
  function refreshAll({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (cycle) return cycle;
    lastStarted = clock();
    cycle = (async () => {
      const representatives = [], represented = new Set();
      for (const row of rows()) {
        if (row.invalid || row.disabled || row.reauth_needed || expiryFor(row) != null && expiryFor(row) <= clock()) continue;
        if (!represented.has(row.account)) {
          representatives.push(row);
          for (const member of scopeMembers(row)) represented.add(member.account);
        }
      }
      let cursor = 0; const results = [];
      const worker = async () => {
        while (cursor < representatives.length && !signal?.aborted && !stopped) {
          const row = representatives[cursor++]; results.push(await refreshAccount(row.account, { signal }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, representatives.length) }, worker));
      return results;
    })().finally(() => { lastCompleted = clock(); cycle = null; });
    return cycle;
  }
  function schedule() {
    if (!started || stopped || pollMs <= 0) return;
    timer = timers.setTimeout(() => {
      timer = null;
      void refreshAll().catch(() => {}).finally(() => {
        if (!started || stopped) return;
        do { nextPoll += pollMs; } while (nextPoll <= clock());
        schedule();
      });
    }, Math.max(0, nextPoll - clock()));
    timer?.unref?.();
  }
  function start({ immediate = true } = {}) {
    if (started || pollMs <= 0) return;
    stopped = false; started = true; nextPoll = clock() + pollMs; schedule();
    if (immediate) void refreshAll().catch(() => {});
  }
  async function stop() {
    started = false; stopped = true; nextPoll = null;
    if (timer != null) timers.clearTimeout(timer); timer = null;
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...refreshing.values()]); leases.clear();
  }
  function forgetAccount(account) {
    db.prepare('DELETE FROM claude_pool_usage WHERE account=?').run(account);
    db.prepare('DELETE FROM claude_pool_metadata WHERE account=?').run(account);
    for (const [id, lease] of leases) if (lease.account === account) leases.delete(id);
  }
  return { status, acquire, release, observeHeaders, markExhausted, refreshAccount, refreshAll,
    start, stop, setMetadata, forgetAccount };
}
