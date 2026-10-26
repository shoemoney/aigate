import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClaudePool, parseClaudeQuotaHeaders } from '../src/claude-pool.js';
import { createClaudeUsageProbe } from '../src/claude-usage-probe.js';
import { createTrafficStore } from '../src/proxy-traffic.js';
import { makeVault } from '../src/lib.js';

const BASE = Date.UTC(2026, 9, 23);
const quota = (five = 0, seven = 0, reset = BASE + 86400000) => [
  'anthropic-ratelimit-unified-5h-utilization', String(five),
  'anthropic-ratelimit-unified-7d-utilization', String(seven),
  'anthropic-ratelimit-unified-5h-reset', String((BASE + 18000000) / 1000),
  'anthropic-ratelimit-unified-7d-reset', String(reset / 1000),
];
const rejection = (claim = 'five_hour', reset = BASE + 100000) => [
  'anthropic-ratelimit-unified-status', 'rejected',
  'anthropic-ratelimit-unified-representative-claim', claim,
  'anthropic-ratelimit-unified-reset', String(reset / 1000),
];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  const vault = makeVault(randomBytes(32));
  db.exec(`CREATE TABLE accounts(account TEXT PRIMARY KEY,label TEXT,token_enc TEXT,kind TEXT DEFAULT 'claude',token_exp INTEGER,
    disabled INTEGER DEFAULT 0,reauth_needed INTEGER DEFAULT 0,parked_until TEXT,
    five_hour_pct REAL DEFAULT 0,seven_day_pct REAL DEFAULT 0,five_hour_reset REAL,seven_day_reset REAL,usage_updated TEXT)`);
  let now = BASE;
  const pool = await createClaudePool({ db, ...vault, clock: () => now, probe: async () => ({ status: 200, rawHeaders: quota(), observedAt: now }), ...options });
  t.after(async () => { await pool.stop(); db.close(); });
  return { db, pool, now: () => now, advance: ms => { now += ms; }, add: (name, token = 'sk-ant-oat01-test-' + name, extra = {}) => {
    db.prepare('INSERT INTO accounts(account,label,token_enc,kind,disabled,reauth_needed,parked_until,token_exp) VALUES(?,?,?,?,?,?,?,?)')
      .run(name, name, vault.encrypt(token), extra.kind || 'claude', extra.disabled || 0, extra.reauth_needed || 0, extra.parked_until || null, extra.token_exp || null);
  }, replace: (name, token) => db.prepare('UPDATE accounts SET token_enc=? WHERE account=?').run(vault.encrypt(token), name) };
}

test('quota parser preserves zero and fractional headroom and rejects unknown or duplicate headers', () => {
  assert.equal(parseClaudeQuotaHeaders(quota(0, .995)).five_hour.remaining_pct, 100);
  assert.equal(parseClaudeQuotaHeaders(quota(0, .995)).seven_day.remaining_pct, .5);
  for (const bad of ['', 'NaN', '-1', 'Infinity', 'unknown']) assert.equal(parseClaudeQuotaHeaders({ 'anthropic-ratelimit-unified-5h-utilization': bad }).five_hour.used_pct, null);
  assert.equal(parseClaudeQuotaHeaders(quota(1.1)).five_hour.used_pct, 100);
  assert.equal(parseClaudeQuotaHeaders([...quota(), 'ANTHROPIC-RATELIMIT-UNIFIED-5H-UTILIZATION', '0']).five_hour.used_pct, null);
});

test('timestamp formats preserve valid dates and reject values outside the Date range', async t => {
  const f = await fixture(t); f.add('a');
  const maximum = 8640000000000000;
  for (const value of [BASE / 1000, String(BASE / 1000), BASE, String(BASE), new Date(BASE).toISOString(), maximum]) {
    const expected = value === maximum ? maximum : BASE;
    assert.equal(f.pool.setMetadata('a', { credential_expires_at: value }).credential_expires_at, new Date(expected).toISOString());
    for (const window of ['5h', '7d']) {
      assert.equal(parseClaudeQuotaHeaders({ [`anthropic-ratelimit-unified-${window}-reset`]: value })[window === '5h' ? 'five_hour' : 'seven_day'].reset_ms, expected);
    }
  }
  assert.equal(f.pool.setMetadata('a', { credential_expires_at: null }).credential_expires_at, null);
  for (const value of [maximum + 1, String(maximum + 1), Number.MAX_VALUE, '999999999999999999999', Infinity, NaN]) {
    assert.throws(() => f.pool.setMetadata('a', { credential_expires_at: value }), TypeError);
    assert.equal(parseClaudeQuotaHeaders({ 'anthropic-ratelimit-unified-5h-reset': value }).five_hour.reset_ms, null);
  }
  assert.equal(parseClaudeQuotaHeaders({ 'anthropic-ratelimit-unified-5h-reset': null }).five_hour.reset_ms, null);
});

test('invalid combined metadata edit leaves all database state untouched, even before initialization', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  const snapshot = () => ['accounts', 'claude_pool_metadata', 'claude_pool_usage', 'claude_pool_blocks']
    .map(table => f.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  let before = snapshot();
  assert.throws(() => f.pool.setMetadata('a', { quota_scope: 'shared', credential_expires_at: 8640000000000001 }), TypeError);
  assert.deepEqual(snapshot(), before);
  f.pool.observeHeaders('a', quota(.25, .5));
  f.pool.setMetadata('a', { quota_scope: 'original', credential_expires_at: BASE + 100000 });
  f.pool.observeHeaders('a', quota(.25, .5));
  before = snapshot();
  assert.throws(() => f.pool.setMetadata('a', { quota_scope: 'changed', credential_expires_at: Number.MAX_VALUE }), TypeError);
  assert.deepEqual(snapshot(), before);
});

test('status tolerates legacy out-of-range stored expiry and reset values', async t => {
  const f = await fixture(t); f.add('a');
  f.pool.setMetadata('a', { credential_expires_at: BASE + 100000 });
  f.pool.observeHeaders('a', quota());
  f.db.prepare('UPDATE claude_pool_metadata SET credential_expires_at=? WHERE account=?').run(1e20, 'a');
  f.db.prepare('UPDATE claude_pool_usage SET five_reset=?,seven_reset=? WHERE account=?').run(1e20, 1e20, 'a');
  const account = f.pool.status().accounts[0];
  assert.equal(account.credential_expires_at, null);
  assert.equal(account.five_hour.resets_at, null);
  assert.equal(account.seven_day.resets_at, null);
});

test('fresh positive allowance in BOTH windows is required; earliest future weekly reset wins', async t => {
  const f = await fixture(t); for (const name of ['late', 'soon', 'spent', 'unknown', 'past', 'api']) f.add(name, undefined, name === 'api' ? { kind: 'codex' } : {});
  f.pool.observeHeaders('late', quota(0, 0, BASE + 200000));
  f.pool.observeHeaders('soon', quota(.995, .995, BASE + 100000));
  f.pool.observeHeaders('spent', quota(1, 0, BASE + 50000));
  f.pool.observeHeaders('past', quota(0, 0, BASE - 1));
  const status = f.pool.status();
  assert.equal(status.next_account, 'soon');
  assert.equal(status.accounts.find(a => a.account === 'soon').five_hour.remaining_pct, .5);
  assert.equal(status.accounts.find(a => a.account === 'spent').reason, 'exhausted');
  assert.equal(status.accounts.find(a => a.account === 'unknown').reason, 'usage_unknown');
  assert.equal(status.accounts.some(a => a.account === 'api'), false);
  assert.equal(JSON.stringify(status).includes('sk-ant'), false);
  assert.equal(status.accounts.find(a => a.account === 'late').credential_expires_at, null);
  const lease = f.pool.acquire(); assert.equal(lease.account, 'soon'); assert.match(lease.token, /^sk-ant-oat/); f.pool.release(lease);
});

test('window freshness is independent; missing fields never become full capacity', async t => {
  const f = await fixture(t); f.add('a');
  f.pool.observeHeaders('a', quota(.2, .3)); f.advance(600001);
  f.pool.observeHeaders('a', ['anthropic-ratelimit-unified-5h-utilization', '0']);
  const state = f.pool.status().accounts[0];
  assert.equal(state.five_hour.fresh, true); assert.equal(state.seven_day.fresh, false); assert.equal(state.reason, 'usage_stale');
  assert.equal(state.five_hour.resets_at, null);
  assert.equal(f.pool.acquire(), null);
});

test('new utilization above one replaces previous positive allowance with exhausted state', async t => {
  const f = await fixture(t); f.add('a'); f.pool.observeHeaders('a', quota(.1, .2)); assert.ok(f.pool.acquire());
  f.advance(1); f.pool.observeHeaders('a', quota(1.1, .2));
  const state = f.pool.status().accounts[0]; assert.equal(state.reason, 'exhausted'); assert.equal(state.five_hour.remaining_pct, 0); assert.equal(f.pool.acquire(), null);
  f.advance(1); f.pool.observeHeaders('a', ['anthropic-ratelimit-unified-5h-utilization', 'malformed']);
  assert.equal(f.pool.status().accounts[0].five_hour.observed_at, new Date(BASE + 1).toISOString());
  assert.equal(f.pool.acquire(), null);
});

test('manual metadata expiration, disabled, parked and reauth accounts are excluded without deleting credentials', async t => {
  const f = await fixture(t); f.add('expired'); f.add('disabled', undefined, { disabled: 1 }); f.add('reauth', undefined, { reauth_needed: 1 }); f.add('parked', undefined, { parked_until: new Date(BASE + 10000).toISOString() });
  for (const account of ['expired', 'disabled', 'reauth', 'parked']) f.pool.observeHeaders(account, quota(), { status: 529 });
  f.pool.setMetadata('expired', { credential_expires_at: new Date(BASE - 1).toISOString() });
  assert.deepEqual(Object.fromEntries(f.pool.status().accounts.map(a => [a.account, a.reason])), { disabled: 'disabled', expired: 'credential_expired', parked: 'parked', reauth: 'reauth_needed' });
  assert.throws(() => f.pool.setMetadata('expired', { quota_scope: 'wrong', credential_expires_at: 'bad' }));
  assert.equal(f.pool.status().accounts.find(a => a.account === 'expired').quota_scope, 'expired');
  f.replace('expired', 'sk-ant-oat01-new');
  assert.equal(f.pool.status().accounts.find(a => a.account === 'expired').credential_expires_at, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 4);
});

test('shared scopes and identical credentials share usage, exhaustion, and one polling representative', async t => {
  let calls = 0;
  const f = await fixture(t, { probe: async () => { calls++; return { status: 200, rawHeaders: quota(.25, .5) }; } });
  f.add('a', 'sk-ant-oat01-same'); f.add('b', 'sk-ant-oat01-same'); f.add('c');
  f.pool.setMetadata('a', { quota_scope: 'subscription-one' }); f.pool.setMetadata('b', { quota_scope: 'subscription-two' }); f.pool.setMetadata('c', { quota_scope: 'subscription-two' });
  await f.pool.refreshAll(); assert.equal(calls, 1);
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === 25), true);
  f.advance(1); f.pool.markExhausted('a', { window: 'seven_day', resetAt: BASE + 100000 });
  assert.equal(f.pool.status().accounts.every(a => a.reason === 'exhausted'), true);
  f.pool.observeHeaders('a', quota(0, 0), { status: 429 });
  assert.equal(f.pool.acquire(), null, '429 positive headers do not clear authoritative exhaustion');
  f.advance(1); f.pool.observeHeaders('a', quota(0, 0), { status: 200 }); assert.ok(f.pool.acquire());
});

test('model-family cooldowns do not exhaust other models; bare throttles never mark allowances spent', async t => {
  const f = await fixture(t); f.add('a'); f.pool.observeHeaders('a', quota(.1, .2));
  f.pool.markExhausted('a', { window: 'model', model: 'claude-opus-4-6', resetAt: BASE + 100000 });
  assert.equal(f.pool.status({ model: 'claude-opus-4-6' }).accounts[0].reason, 'model_cooldown');
  assert.equal(f.pool.status({ model: 'claude-sonnet-4-6' }).accounts[0].eligible, true);
  assert.deepEqual(f.pool.status().accounts[0].cooldowns, [{ model: 'opus', until: new Date(BASE + 100000).toISOString() }]);
  f.pool.observeHeaders('a', [], { status: 429 }); f.pool.observeHeaders('a', [], { status: 529 });
  assert.equal(f.pool.status().accounts[0].five_hour.used_pct, 10);
  f.pool.observeHeaders('a', quota(.1, .2), { model: 'claude-sonnet-4-6' });
  assert.equal(f.pool.status({ model: 'claude-opus-4-6' }).accounts[0].reason, 'model_cooldown');
});

test('claim-only probe rejection blocks the shared subscription without inventing utilization and a fresh probe recovers it', async t => {
  let result = { status: 429, rawHeaders: rejection() };
  const f = await fixture(t, { probe: async () => result }); f.add('a'); f.add('b');
  f.pool.setMetadata('a', { quota_scope: 'shared' }); f.pool.setMetadata('b', { quota_scope: 'shared' });
  f.pool.observeHeaders('a', quota(.1, .2)); assert.ok(f.pool.acquire()); f.advance(1);
  const refreshed = await f.pool.refreshAccount('a'); assert.equal(refreshed.applied, true); assert.equal(refreshed.exhaustion.window, 'five_hour');
  assert.equal(f.pool.status().accounts.every(a => a.reason === 'exhausted'), true); assert.equal(f.pool.acquire(), null);
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === 10 && a.seven_day.used_pct === 20), true);
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.observed_at === new Date(BASE).toISOString()), true);
  result = { status: 200, rawHeaders: quota(.2, .3) }; f.advance(1); await f.pool.refreshAccount('b');
  assert.equal(f.pool.status().accounts.every(a => a.eligible && a.five_hour.used_pct === 20), true);
});

test('probe exhaustion classifier uses the injected clock and requires an actual matching requested model', async t => {
  let result = { status: 429, rawHeaders: rejection('seven_day_opus'), model: 'claude-haiku-4-5-20251001' };
  const f = await fixture(t, { probe: async () => result }); f.add('a'); f.pool.observeHeaders('a', quota(.1, .2));
  await f.pool.refreshAccount('a'); assert.equal(f.pool.status().accounts[0].cooldowns.length, 0);
  result = { status: 429, rawHeaders: rejection('seven_day_opus') }; await f.pool.refreshAccount('a');
  assert.equal(f.pool.status().accounts[0].cooldowns.length, 0, 'unknown model cannot establish a family block');
  result = { status: 429, rawHeaders: rejection('seven_day_opus'), model: 'claude-opus-4-6' }; await f.pool.refreshAccount('a');
  assert.equal(f.pool.status({ model: 'claude-opus-4-6' }).accounts[0].reason, 'model_cooldown');
  assert.equal(f.pool.status({ model: 'claude-sonnet-4-6' }).accounts[0].eligible, true);
});

test('bare 429, global overload and expired or unknown claims do not exhaust the probe pool', async t => {
  let result; const f = await fixture(t, { probe: async () => result }); f.add('a'); f.pool.observeHeaders('a', quota(.1, .2));
  for (result of [ { status: 429, rawHeaders: [] }, { status: 529, rawHeaders: rejection() },
    { status: 429, rawHeaders: rejection('unknown') }, { status: 429, rawHeaders: rejection('five_hour', BASE - 1) } ]) {
    await f.pool.refreshAccount('a'); assert.equal(f.pool.status().accounts[0].eligible, true);
    assert.equal(f.pool.status().accounts[0].five_hour.used_pct, 10);
  }
});

test('claim-only rejected probes cannot mutate replaced, deleted, renamed or remapped identities', async t => {
  for (const mutation of ['replace', 'delete', 'rename', 'scope']) {
    const gate = deferred(); const f = await fixture(t, { probe: () => gate.promise }); f.add('a'); f.add('b');
    f.pool.setMetadata('a', { quota_scope: 'shared' }); f.pool.setMetadata('b', { quota_scope: 'shared' }); f.pool.observeHeaders('a', quota(.1, .2));
    const pending = f.pool.refreshAccount('a'); await tick();
    if (mutation === 'replace') f.replace('a', 'sk-ant-oat01-new');
    else if (mutation === 'delete') { f.db.prepare('DELETE FROM accounts WHERE account=?').run('a'); f.pool.forgetAccount('a'); }
    else if (mutation === 'rename') f.pool.renameAccount('a', 'renamed');
    else f.pool.setMetadata('a', { quota_scope: 'other' });
    gate.resolve({ status: 429, rawHeaders: rejection() }); assert.equal((await pending).applied, false, mutation);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM claude_pool_blocks').get().n, 0, mutation);
  }
});

test('delayed probes cannot resurrect a replaced/deleted credential or overwrite newer exhaustion', async t => {
  const gate = deferred(); const f = await fixture(t, { probe: () => gate.promise }); f.add('a');
  const pending = f.pool.refreshAccount('a'); await tick(); f.replace('a', 'sk-ant-oat01-replaced');
  gate.resolve({ status: 200, rawHeaders: quota(0, 0) }); const result = await pending;
  assert.equal(result.applied, false); assert.equal(f.pool.status().accounts[0].reason, 'usage_unknown');
  const second = deferred(); const g = await fixture(t, { probe: () => second.promise }); g.add('a');
  const poll = g.pool.refreshAccount('a'); await tick(); g.advance(1); g.pool.markExhausted('a', { window: 'seven_day', resetAt: BASE + 100000 });
  second.resolve({ status: 200, rawHeaders: quota() }); assert.equal((await poll).applied, false); assert.equal(g.pool.status().accounts[0].reason, 'exhausted');
  const third = deferred(); const h = await fixture(t, { probe: () => third.promise }); h.add('a');
  const deleted = h.pool.refreshAccount('a'); await tick(); h.db.prepare('DELETE FROM accounts WHERE account=?').run('a'); third.resolve({ status: 200, rawHeaders: quota() });
  assert.equal((await deleted).applied, false); assert.equal(h.pool.status().accounts.length, 0);
});

test('leases, affinity, exclusions and cancellation are bounded and deterministic', async t => {
  const f = await fixture(t, { maxInFlight: 1 }); f.add('a'); f.add('b');
  f.pool.observeHeaders('a', quota()); f.pool.observeHeaders('b', quota());
  const first = f.pool.acquire(); assert.equal(first.account, 'a'); const second = f.pool.acquire(); assert.equal(second.account, 'b'); assert.equal(f.pool.acquire(), null);
  f.pool.release(first); assert.equal(f.pool.acquire({ excludeAccounts: ['a'] }), null);
  f.pool.release(second); assert.equal(f.pool.acquire({ affinity: 'b' }).account, 'b');
  const cancel = new AbortController(); cancel.abort(); assert.throws(() => f.pool.acquire({ signal: cancel.signal }), { name: 'AbortError' });
});

test('a same-millisecond response from an older lease cannot clear newer shared exhaustion', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  f.pool.setMetadata('a', { quota_scope: 'shared' }); f.pool.setMetadata('b', { quota_scope: 'shared' });
  f.pool.observeHeaders('a', quota()); const lease = f.pool.acquire();
  f.pool.markExhausted('b', { window: 'seven_day', resetAt: BASE + 100000 });
  const observed = f.pool.observeHeaders('a', quota(), { fingerprint: lease.fingerprint, tokenEnvelope: lease.tokenEnvelope,
    revision: lease.revision, generation: lease.generation, startedAt: lease.startedAt, status: 200 });
  assert.equal(observed.applied, false); assert.equal(f.pool.status().accounts.every(a => a.reason === 'exhausted'), true);
  f.advance(100001); assert.equal(f.pool.acquire(), null, 'old positive meters remain stale after the block expires');
});

test('concurrent newer observations cannot hide authoritative exhaustion from another lease', async t => {
  const f = await fixture(t); f.add('a'); f.pool.observeHeaders('a', quota()); const lease = f.pool.acquire();
  f.pool.observeHeaders('a', quota(.1, .1));
  f.pool.observeHeaders('a', quota(1.1, .1), { fingerprint: lease.fingerprint, revision: lease.revision,
    generation: lease.generation, tokenEnvelope: lease.tokenEnvelope, startedAt: lease.startedAt });
  assert.equal(f.pool.status().accounts[0].five_hour.remaining_pct, 0); assert.equal(f.pool.acquire(), null);
});

test('manual scope changes invalidate already admitted observations across the old shared scope', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  f.pool.setMetadata('a', { quota_scope: 'shared' }); f.pool.setMetadata('b', { quota_scope: 'shared' });
  f.pool.observeHeaders('a', quota()); const lease = f.pool.acquire({ affinity: 'b' });
  f.pool.setMetadata('a', { quota_scope: 'other' });
  const observed = f.pool.observeHeaders('b', quota(1), { fingerprint: lease.fingerprint, revision: lease.revision,
    generation: lease.generation, tokenEnvelope: lease.tokenEnvelope, startedAt: lease.startedAt });
  assert.equal(observed.applied, false); assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === null), true);
});

test('merging conflicting subscription meters invalidates both until one fresh probe restores consistency', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  f.pool.observeHeaders('a', quota(.1, .1)); f.pool.observeHeaders('b', quota(1, .5));
  assert.equal(f.pool.status().next_account, 'a');
  f.pool.setMetadata('a', { quota_scope: 'same-subscription' });
  f.pool.setMetadata('b', { quota_scope: 'same-subscription' });
  assert.equal(f.pool.acquire(), null);
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === null && a.seven_day.used_pct === null), true);
  await f.pool.refreshAccount('a');
  assert.equal(f.pool.status().accounts.every(a => a.eligible && a.five_hour.used_pct === 0 && a.seven_day.used_pct === 0), true);
});

test('scope splitting invalidates both former groups and probes only restore their current members', async t => {
  const f = await fixture(t); f.add('a'); f.add('b');
  f.pool.setMetadata('a', { quota_scope: 'shared' }); f.pool.setMetadata('b', { quota_scope: 'shared' });
  f.pool.observeHeaders('a', quota(.2, .3));
  f.pool.setMetadata('a', { quota_scope: null });
  assert.equal(f.pool.status().accounts.every(a => !a.eligible && a.five_hour.used_pct === null), true);
  await f.pool.refreshAccount('a');
  assert.equal(f.pool.status().accounts.find(a => a.account === 'a').eligible, true);
  assert.equal(f.pool.status().accounts.find(a => a.account === 'b').reason, 'usage_unknown');
  await f.pool.refreshAccount('b'); assert.equal(f.pool.status().accounts.every(a => a.eligible), true);
});

test('transitive fingerprint membership is invalidated together and expiry-only edits preserve real meters', async t => {
  const f = await fixture(t); f.add('a', 'sk-ant-oat01-identical'); f.add('b', 'sk-ant-oat01-identical'); f.add('c');
  f.pool.setMetadata('a', { quota_scope: 'one' }); f.pool.setMetadata('b', { quota_scope: 'two' }); f.pool.setMetadata('c', { quota_scope: 'two' });
  f.pool.observeHeaders('a', quota(.25, .5));
  f.pool.setMetadata('c', { credential_expires_at: new Date(BASE + 100000).toISOString() });
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === 25 && a.seven_day.used_pct === 50), true);
  f.pool.setMetadata('b', { quota_scope: 'three' });
  assert.equal(f.pool.status().accounts.every(a => a.five_hour.used_pct === null), true);
  await f.pool.refreshAccount('a');
  assert.equal(f.pool.status().accounts.filter(a => ['a', 'b'].includes(a.account)).every(a => a.eligible), true);
  assert.equal(f.pool.status().accounts.find(a => a.account === 'c').reason, 'usage_unknown');
  await f.pool.refreshAccount('c'); assert.equal(f.pool.status().accounts.every(a => a.eligible), true);
});

test('atomic rename preserves manual expiry, scope, observations and model cooldowns', async t => {
  const f = await fixture(t); f.add('old');
  f.pool.setMetadata('old', { quota_scope: 'subscription', credential_expires_at: new Date(BASE - 1).toISOString() });
  f.pool.observeHeaders('old', quota(.25, .5)); f.pool.markExhausted('old', { window: 'model', model: 'claude-opus-4-6', resetAt: BASE + 100000 });
  const tokenBefore = f.db.prepare('SELECT token_enc FROM accounts WHERE account=?').get('old').token_enc;
  assert.equal(f.pool.renameAccount('old', 'renamed', { label: 'Renamed label' }).changes, 1);
  const state = f.pool.status({ model: 'claude-opus-4-6' }).accounts[0];
  assert.equal(state.account, 'renamed'); assert.equal(state.label, 'Renamed label'); assert.equal(state.reason, 'credential_expired');
  assert.equal(state.credential_expires_at, new Date(BASE - 1).toISOString()); assert.equal(state.quota_scope, 'subscription');
  assert.equal(state.five_hour.used_pct, 25); assert.equal(state.seven_day.used_pct, 50); assert.equal(state.cooldowns[0].model, 'opus');
  assert.equal(f.pool.acquire(), null); assert.equal(f.pool.observeHeaders('old', quota()).applied, false);
  assert.equal(f.db.prepare('SELECT token_enc FROM accounts WHERE account=?').get('renamed').token_enc, tokenBefore);
  assert.equal(f.db.prepare('SELECT * FROM claude_pool_metadata WHERE account=?').get('old'), undefined);
});

test('default scope blocks and active lease accounting survive rename while old contexts cannot update it', async t => {
  const f = await fixture(t); f.add('old'); f.pool.observeHeaders('old', quota()); const lease = f.pool.acquire();
  f.pool.markExhausted('old', { window: 'seven_day', resetAt: BASE + 100000 });
  f.pool.renameAccount('old', 'renamed');
  assert.equal(f.pool.status().accounts[0].quota_scope, 'renamed'); assert.equal(f.pool.status().accounts[0].reason, 'exhausted');
  assert.equal(f.pool.status().accounts[0].in_flight, 1); assert.equal(lease.account, 'old');
  assert.ok(f.db.prepare('SELECT 1 FROM claude_pool_blocks WHERE scope_key=?').get('account:renamed'));
  assert.equal(f.db.prepare('SELECT 1 FROM claude_pool_blocks WHERE scope_key=?').get('account:old'), undefined);
  assert.equal(f.pool.observeHeaders('old', quota(), lease).applied, false);
  assert.equal(f.pool.observeHeaders('renamed', quota(), lease).applied, false);
  assert.equal(f.pool.markExhausted('renamed', { ...lease, window: 'model', model: 'claude-opus-4-6' }), false);
  assert.equal(f.pool.release(lease), true); assert.equal(f.pool.status().accounts[0].in_flight, 0);
});

test('metadata rename failure rolls account, pool generations and in-memory leases back together', async t => {
  const f = await fixture(t); f.add('old'); f.pool.observeHeaders('old', quota(.2, .3)); const lease = f.pool.acquire();
  const before = f.db.prepare('SELECT * FROM claude_pool_usage WHERE account=?').get('old');
  f.db.exec(`CREATE TRIGGER reject_pool_rename BEFORE UPDATE OF account ON claude_pool_metadata
    WHEN NEW.account='blocked' BEGIN SELECT RAISE(ABORT,'metadata rename rejected'); END`);
  assert.throws(() => f.pool.renameAccount('old', 'blocked', { label: 'wrong' }), /metadata rename rejected/);
  assert.equal(f.db.prepare('SELECT account,label FROM accounts WHERE account=?').get('old').label, 'old');
  assert.equal(f.db.prepare('SELECT 1 FROM accounts WHERE account=?').get('blocked'), undefined);
  assert.deepEqual(f.db.prepare('SELECT * FROM claude_pool_usage WHERE account=?').get('old'), before);
  assert.equal(f.pool.status().accounts[0].in_flight, 1); assert.equal(lease.account, 'old');
  assert.equal(f.pool.observeHeaders('old', quota(.4, .5), lease).applied, true); assert.equal(f.pool.release(lease), true);
});

test('Codex rename and label-only edits preserve credentials and existing pool observations', async t => {
  const f = await fixture(t); f.add('codex', 'JSON_CODEX_AUTH', { kind: 'codex' });
  const encrypted = f.db.prepare('SELECT token_enc FROM accounts WHERE account=?').get('codex').token_enc;
  assert.equal(f.pool.renameAccount('codex', 'renamed-codex', { label: 'Codex label' }).changes, 1);
  assert.equal(f.db.prepare('SELECT token_enc FROM accounts WHERE account=?').get('renamed-codex').token_enc, encrypted);
  assert.equal(f.pool.status().accounts.length, 0);
  f.add('claude'); f.pool.observeHeaders('claude', quota(.3, .4));
  const before = f.db.prepare('SELECT * FROM claude_pool_usage WHERE account=?').get('claude');
  f.pool.renameAccount('claude', 'claude', { label: 'Updated label' });
  assert.deepEqual(f.db.prepare('SELECT * FROM claude_pool_usage WHERE account=?').get('claude'), before);
  assert.equal(f.pool.status().accounts[0].label, 'Updated label');
});

test('single flight clears failures and scheduled refresh runs every five minutes without overlap', async t => {
  let calls = 0, callback, delay; const gate = deferred();
  const timers = { setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() { callback = null; } };
  const f = await fixture(t, { timers, probe: () => { calls++; return gate.promise; } }); f.add('a');
  f.pool.start({ immediate: false }); assert.equal(delay, 300000); f.advance(300000); callback(); await tick(); assert.equal(calls, 1);
  const same = f.pool.refreshAll(); assert.equal(f.pool.refreshAll(), same); await tick(); assert.equal(calls, 1);
  gate.resolve({ status: 200, rawHeaders: quota() }); await same; await tick(); assert.equal(delay, 300000);
  await f.pool.stop(); assert.equal(callback, null); assert.equal(f.pool.status().next_poll_at, null);
  let failures = 0; const g = await fixture(t, { probe: () => { failures++; throw new Error('private secret'); } }); g.add('a');
  await g.pool.refreshAccount('a'); await g.pool.refreshAccount('a'); assert.equal(failures, 2); assert.equal(g.pool.status().refreshing, false);
  assert.equal(JSON.stringify(g.pool.status()).includes('private secret'), false);
});

test('authentication errors require reauth; generic permission failures do not', async t => {
  const f = await fixture(t); f.add('a'); f.add('b'); f.pool.setMetadata('a', { quota_scope: 'same' }); f.pool.setMetadata('b', { quota_scope: 'same' });
  f.pool.observeHeaders('a', quota()); f.pool.observeHeaders('a', [], { status: 403 }); assert.equal(f.pool.status().next_account, 'a');
  f.pool.observeHeaders('a', [], { status: 403, errorType: 'authentication_error' });
  assert.equal(f.pool.status().accounts.find(a => a.account === 'a').reason, 'reauth_needed'); assert.equal(f.pool.status().accounts.find(a => a.account === 'b').last_error, null);
  f.pool.observeHeaders('a', quota()); assert.equal(f.pool.status().accounts.find(a => a.account === 'a').eligible, true);
});

test('scheduler can refresh Claude and Codex through one shared callback', async t => {
  let callback, delay, cycles = 0; const timers = { setTimeout(fn, ms) { callback = fn; delay = ms; return 1; }, clearTimeout() {} };
  const f = await fixture(t, { timers }); f.add('a');
  f.pool.start({ immediate: false, refresh: async () => { cycles++; await f.pool.refreshAll(); } });
  assert.equal(delay, 300000); f.advance(300000); callback(); await tick();
  assert.equal(cycles, 1); assert.equal(f.pool.status().next_poll_at, new Date(BASE + 600000).toISOString());
  assert.equal(f.pool.status().next_account, 'a');
});

test('shutdown cancels a probe even when injected transport ignores abort', async t => {
  const f = await fixture(t, { probe: () => new Promise(() => {}) }); f.add('a');
  const pending = f.pool.refreshAccount('a'); await tick(); await f.pool.stop();
  assert.equal((await pending).error, 'probe_cancelled'); assert.equal(f.pool.status().refreshing, false);
});

test('native probe makes one tiny inference and captures exact encrypted request, response and trailers', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'aigate-probe-test-')); const db = new DatabaseSync(':memory:'); const vault = makeVault(randomBytes(32));
  const store = await createTrafficStore({ db, directory, ...vault }); let received, hits = 0;
  const body = randomBytes(100000);
  const server = http.createServer(async (req, res) => {
    hits++; const pieces = []; for await (const chunk of req) pieces.push(chunk);
    received = { headers: req.headers, body: JSON.parse(Buffer.concat(pieces)), path: req.url };
    res.writeHead(200, [...quota(.1, .2), 'Trailer', 'x-test-trailer', 'X-Repeated', 'one', 'X-Repeated', 'two']); res.write(body); res.addTrailers({ 'x-test-trailer': 'last' }); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const upstream = `http://127.0.0.1:${server.address().port}`;
  const probe = createClaudeUsageProbe({ getTrafficStore: () => store, upstream, clock: () => BASE });
  const result = await probe({ account: 'a', token: 'sk-ant-oat01-PROBE_SECRET' });
  assert.equal(hits, 1); assert.equal(received.path, '/v1/messages'); assert.equal(received.body.max_tokens, 1); assert.match(received.headers['user-agent'], /^aigate\//); assert.equal(result.status, 200);
  assert.equal(result.model, received.body.model);
  const events = []; for await (const event of store.events(result.capture_id)) events.push(event);
  assert.equal(events[0].consumes_allowance, true); assert.equal(events[0].headers.includes('Bearer sk-ant-oat01-PROBE_SECRET'), true);
  assert.deepEqual(Buffer.concat(events.filter(e => e.type === 'response_body').map(e => Buffer.from(e.data, 'base64'))), body);
  assert.deepEqual(events.find(e => e.type === 'response_end').trailers, ['x-test-trailer', 'last']);
  assert.equal(readFileSync(join(directory, readdirSync(directory)[0])).includes('PROBE_SECRET'), false);
  await assert.rejects(createClaudeUsageProbe({ upstream })({ account: 'a', token: 'never' }), { code: 'CAPTURE_UNAVAILABLE' }); assert.equal(hits, 1);
});

test('probe cancellation and capture failure stop egress; HTTP deadline is bounded', { timeout: 5000 }, async t => {
  let hits = 0; const server = http.createServer(() => { hits++; }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const upstream = `http://127.0.0.1:${server.address().port}`; const records = [];
  const capture = { id: 1, async append(type, data) { records.push({ type, data }); }, async chunk() {}, async finish() {} };
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createClaudeUsageProbe({ upstream, getTrafficStore: () => ({ start: async () => capture }) })({ token: 'secret', signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(createClaudeUsageProbe({ upstream, getTrafficStore: () => ({ start: async () => ({ ...capture, chunk: async () => { throw new Error('disk full'); } }) }) })({ token: 'secret' }), /disk full/);
  assert.equal(hits, 0);
  // Control the configured 40ms deadlines so parallel startup cannot expire the
  // probe before its request reaches the real hanging HTTP stub.
  const realSetTimeout = globalThis.setTimeout, realRequest = http.request;
  let deadline, deadlineMs, socketDeadline, socketDeadlineMs, outgoing;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    if (ms !== 40) return realSetTimeout(callback, ms, ...args);
    deadline = callback; deadlineMs = ms;
    return { unref() {} };
  });
  t.mock.method(http, 'request', function (...args) {
    outgoing = Reflect.apply(realRequest, this, args);
    const realSocketTimeout = outgoing.setTimeout;
    t.mock.method(outgoing, 'setTimeout', function (ms, callback) {
      if (ms !== 40) return Reflect.apply(realSocketTimeout, this, [ms, callback]);
      socketDeadline = callback; socketDeadlineMs = ms;
      return this;
    });
    return outgoing;
  });
  const admission = once(server, 'request');
  const pending = createClaudeUsageProbe({ upstream, timeoutMs: 40, getTrafficStore: () => ({ start: async () => capture }) })({ token: 'secret' });
  const rejection = assert.rejects(pending, { code: 'PROBE_TIMEOUT' });
  await admission;
  assert.equal(hits, 1);
  assert.equal(deadlineMs, 40); assert.equal(typeof deadline, 'function');
  assert.equal(socketDeadlineMs, 40); assert.equal(typeof socketDeadline, 'function');
  const closed = new Promise(resolve => outgoing.once('close', resolve));
  deadline(); await rejection; await closed;
  assert.equal(outgoing.destroyed, true); assert.equal(hits, 1);
});
