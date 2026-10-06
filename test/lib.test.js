import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { join, sep } from 'node:path';
import { makeVault, tokenMatches, ip2int, ipAllowed, clientIp, safeStaticPath, tokenIsAlive, signSession, verifySession, parseCookie, decodeJwtPayload, normalizeCodexAuth, codexWindowSlot } from '../src/lib.js';
const _jwt = (o) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(o)).toString('base64url')}.sig`;

const KEY = crypto.randomBytes(32);

test('vault: encrypt→decrypt round-trips', () => {
  const v = makeVault(KEY);
  const secret = 'sk-ant-oat-abc123-🔑-unicode';
  assert.equal(v.decrypt(v.encrypt(secret)), secret);
});

test('vault: two encryptions of same plaintext differ (random IV)', () => {
  const v = makeVault(KEY);
  assert.notEqual(v.encrypt('x'), v.encrypt('x'));
});

test('vault: tampering with ciphertext throws (GCM auth)', () => {
  const v = makeVault(KEY);
  const buf = Buffer.from(v.encrypt('top-secret'), 'base64');
  buf[buf.length - 1] ^= 0xff;              // flip a byte in the data
  assert.throws(() => v.decrypt(buf.toString('base64')));
});

test('vault: wrong key cannot decrypt', () => {
  const good = makeVault(KEY).encrypt('hello');
  assert.throws(() => makeVault(crypto.randomBytes(32)).decrypt(good));
});

test('tokenMatches: equal tokens match', () => {
  assert.equal(tokenMatches('abc123', 'abc123'), true);
});
test('tokenMatches: same length, different content → false', () => {
  assert.equal(tokenMatches('abc123', 'abc124'), false);
});
test('tokenMatches: different length → false, never throws (bug #3)', () => {
  assert.equal(tokenMatches('abc', 'abcdef'), false);      // would throw in timingSafeEqual unguarded
  assert.equal(tokenMatches('', ''), false);               // empty never authenticates
  assert.equal(tokenMatches(null, 'x'), false);
  assert.equal(tokenMatches(undefined, undefined), false);
});

test('ip2int: valid addresses', () => {
  assert.equal(ip2int('0.0.0.0'), 0);
  assert.equal(ip2int('255.255.255.255'), 4294967295);
  assert.equal(ip2int('192.168.1.5'), ((192 << 24) | (168 << 16) | (1 << 8) | 5) >>> 0);
  assert.equal(ip2int('::ffff:127.0.0.1'), ip2int('127.0.0.1'));
});
test('ip2int: garbage → null (bug #4)', () => {
  assert.equal(ip2int('999.1.1.1'), null);
  assert.equal(ip2int('abc'), null);
  assert.equal(ip2int('1.2.3'), null);
  assert.equal(ip2int('1.2.3.4.5'), null);
  assert.equal(ip2int('1.2.3.-1'), null);
  assert.equal(ip2int('256.0.0.1'), null);
});

test('ipAllowed: empty allowlist allows everything', () => {
  assert.equal(ipAllowed('8.8.8.8', []), true);
});
test('ipAllowed: loopback always allowed even when gated', () => {
  assert.equal(ipAllowed('127.0.0.1', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('::1', ['10.0.0.0/8']), true);
});
test('ipAllowed: in-range vs out-of-range /24', () => {
  assert.equal(ipAllowed('192.168.1.42', ['192.168.1.0/24']), true);
  assert.equal(ipAllowed('192.168.2.42', ['192.168.1.0/24']), false);
});
test('ipAllowed: bare ip = /32', () => {
  assert.equal(ipAllowed('10.0.0.5', ['10.0.0.5']), true);
  assert.equal(ipAllowed('10.0.0.6', ['10.0.0.5']), false);
});
test('ipAllowed: 0.0.0.0/0 allows all', () => {
  assert.equal(ipAllowed('8.8.8.8', ['0.0.0.0/0']), true);
});
test('ipAllowed: malformed client ip denied when gated', () => {
  assert.equal(ipAllowed('not-an-ip', ['192.168.1.0/24']), false);
});
test('ipAllowed: unparseable cidr entries are skipped, not fatal', () => {
  assert.equal(ipAllowed('192.168.1.5', ['garbage/xx', '192.168.1.0/24']), true);
});
test('ipAllowed: out-of-range prefix bits are skipped, not evaluated (mod-32 mask bug)', () => {
  // /33, /-1, /abc must NOT silently produce a garbage mask that matches
  assert.equal(ipAllowed('8.8.8.8', ['1.2.3.4/33']), false);
  assert.equal(ipAllowed('8.8.8.8', ['1.2.3.4/-1']), false);
  assert.equal(ipAllowed('8.8.8.8', ['1.2.3.4/abc']), false);
  // a valid entry alongside an invalid one still works
  assert.equal(ipAllowed('192.168.1.5', ['1.2.3.4/99', '192.168.1.0/24']), true);
});

test('clientIp: XFF ignored by default (spoof blocked, bug #2)', () => {
  const ip = clientIp({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9');
  assert.equal(ip, '10.0.0.9');
});
test('clientIp: trusted proxy honors the RIGHTMOST XFF hop, not the spoofable leftmost', () => {
  // NPM appends the real client, so the rightmost hop is the trustworthy one.
  const ip = clientIp({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, '10.0.0.9', { trustProxy: true });
  assert.equal(ip, '5.6.7.8');
});
test('clientIp: a client-prepended spoof cannot win the CIDR gate', () => {
  // attacker prepends 127.0.0.1 to forge loopback; our proxy appends the real IP
  const ip = clientIp({ 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }, '10.0.0.9', { trustProxy: true });
  assert.equal(ip, '203.0.113.9');   // NOT 127.0.0.1
});
test('clientIp: XFF only honored from a configured trusted-proxy peer', () => {
  const headers = { 'x-forwarded-for': '203.0.113.9' };
  assert.equal(clientIp(headers, '10.0.0.9', { trustProxy: true, proxies: ['10.0.0.1'] }), '10.0.0.9'); // peer not a proxy → ignore XFF
  assert.equal(clientIp(headers, '10.0.0.1', { trustProxy: true, proxies: ['10.0.0.1'] }), '203.0.113.9'); // peer is the proxy
});
test('clientIp: trusted proxy but no XFF falls back to socket', () => {
  assert.equal(clientIp({}, '10.0.0.9', { trustProxy: true }), '10.0.0.9');
});

test('tokenIsAlive: 401/403 mean dead, everything else alive', () => {
  assert.equal(tokenIsAlive(401), false);   // expired/revoked
  assert.equal(tokenIsAlive(403), false);   // forbidden/revoked
  assert.equal(tokenIsAlive(200), true);    // authenticated
  assert.equal(tokenIsAlive(400), true);    // authenticated, just a bad request
  assert.equal(tokenIsAlive(429), true);    // rate-limited but alive
  assert.equal(tokenIsAlive(529), true);    // overloaded but alive
});

test('safeStaticPath: root serves index.html', () => {
  assert.equal(safeStaticPath('/srv/public', '/'), join('/srv/public', 'index.html'));
});
test('safeStaticPath: normal file inside public', () => {
  assert.equal(safeStaticPath('/srv/public', '/app.js'), join('/srv/public', 'app.js'));
});
test('safeStaticPath: sibling dir starting with "public" is blocked (bug #1)', () => {
  // /srv/public + ../public-secret/x resolves to /srv/public-secret/x which
  // naive startsWith('/srv/public') would wrongly accept.
  assert.equal(safeStaticPath('/srv/public', '/../public-secret/x'), null);
});
test('safeStaticPath: parent-traversal blocked', () => {
  assert.equal(safeStaticPath('/srv/public', '/../../etc/passwd'), null);
});

test('signSession/verifySession: round-trips, rejects tamper/expiry/wrong-secret', () => {
  const secret = 'tok|pw';
  const good = signSession(secret, Date.now() + 600000);
  assert.equal(verifySession(secret, good), true);                       // fresh + valid (far-future, no boundary race)
  assert.equal(verifySession('tok|other', good), false);                 // secret rotated (pw changed)
  assert.equal(verifySession(secret, signSession(secret, 1)), false);  // expired (far-past deterministic, no Date.now() race)
  assert.equal(verifySession(secret, good.slice(0, -1) + (good.slice(-1) === '0' ? '1' : '0')), false);   // signature tampered (flip last hex char — never a no-op when it was already '0')
  assert.equal(verifySession(secret, good.replace(/^\d+/, (n) => String(Number(n) + 1))), false);  // exp tampered (sig no longer matches)
  for (const junk of ['', 'nodot', '.abc', '123.', 'abc.def', null, undefined, 42])
    assert.equal(verifySession(secret, junk), false);                    // garbage never throws, never passes
});
test('parseCookie: extracts one value, tolerates spacing/absence', () => {
  assert.equal(parseCookie('a=1; aigate_sess=xyz; b=2', 'aigate_sess'), 'xyz');
  assert.equal(parseCookie('aigate_sess=only', 'aigate_sess'), 'only');
  assert.equal(parseCookie('other=1', 'aigate_sess'), '');
  assert.equal(parseCookie('', 'aigate_sess'), '');
  assert.equal(parseCookie(undefined, 'aigate_sess'), '');
});

// ---- codex helpers -------------------------------------------------------
test('decodeJwtPayload: reads claims, null on garbage', () => {
  assert.deepEqual(decodeJwtPayload(_jwt({ exp: 5, email: 'a@b' })), { exp: 5, email: 'a@b' });
  for (const bad of [null, undefined, 42, '', 'abc', 'a.b', 'a.!!!.c', 'a..c', `a.${Buffer.from('[1]').toString('base64url')}.c`, `a.${Buffer.from('"str"').toString('base64url')}.c`])
    assert.equal(decodeJwtPayload(bad), null, String(bad));
});
test('normalizeCodexAuth: real auth.json shape → canonical + email/plan/account_id/exp from the JWTs', () => {
  const id = _jwt({ email: 'e@x.test', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_account_id: 'acc-9' } });
  const at = _jwt({ exp: 1791000000 });
  const n = normalizeCodexAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: id, access_token: at, refresh_token: 'rt', account_id: 'acc-9' }, last_refresh: '2026-10-03T08:45:22+08:00' });
  assert.equal(n.error, undefined);
  assert.deepEqual([n.email, n.plan, n.account_id, n.exp], ['e@x.test', 'pro', 'acc-9', 1791000000]);
  assert.equal(n.auth.last_refresh, '2026-10-03T00:45:22.000Z');
  assert.deepEqual(n.auth.tokens, { id_token: id, access_token: at, refresh_token: 'rt', account_id: 'acc-9' });
  assert.equal(n.auth.auth_mode, 'chatgpt'); assert.equal(n.auth.OPENAI_API_KEY, null);
});
test('normalizeCodexAuth: CLIProxyAPI flat shape; exp falls back to `expired`, then last_refresh+10d', () => {
  const flat = { type: 'codex', access_token: 'opaque', refresh_token: 'rt', id_token: '', account_id: 'a1', email: 'f@x', plan_type: 'plus',
    expired: '2026-10-13T08:45:22+08:00', last_refresh: '2026-10-03T08:45:22+08:00' };
  let n = normalizeCodexAuth(flat);
  assert.equal(n.exp, Date.parse('2026-10-13T00:45:22Z') / 1000);
  assert.deepEqual([n.email, n.plan, n.account_id], ['f@x', 'plus', 'a1']);
  delete flat.expired;
  n = normalizeCodexAuth(flat);
  assert.equal(n.exp, Date.parse('2026-10-03T00:45:22Z') / 1000 + 10 * 86400);
});
test('normalizeCodexAuth: exp precedence is JWT exp > `expired` > last_refresh+10d', () => {
  const jwtExp = 1791000000, expiredS = Date.parse('2026-10-13T00:45:22Z') / 1000, lastRefreshS = Date.parse('2026-10-03T00:45:22Z') / 1000;
  assert.notEqual(jwtExp, expiredS); assert.notEqual(expiredS, lastRefreshS + 10 * 86400 + 1);
  const base = { refresh_token: 'rt', id_token: '', account_id: 'a1', last_refresh: '2026-10-03T08:45:22+08:00' };
  // all three present, three different values: the JWT wins
  let n = normalizeCodexAuth({ ...base, access_token: _jwt({ exp: jwtExp }), expired: '2026-10-13T08:45:22+08:00' });
  assert.equal(n.exp, jwtExp);
  // opaque access token: `expired` beats last_refresh+10d (they differ: 10d vs 0d offset... expired is 10d too, so shift it)
  n = normalizeCodexAuth({ ...base, access_token: 'opaque', expired: '2026-10-20T08:45:22+08:00' });
  assert.equal(n.exp, Date.parse('2026-10-20T00:45:22Z') / 1000);
  assert.notEqual(n.exp, lastRefreshS + 10 * 86400);
  // neither: last_refresh+10d
  n = normalizeCodexAuth({ ...base, access_token: 'opaque' });
  assert.equal(n.exp, lastRefreshS + 10 * 86400);
});
test('normalizeCodexAuth: {error} for non-objects and missing tokens/account_id — never throws', () => {
  for (const bad of [null, 'x', 5, [], undefined]) assert.match(normalizeCodexAuth(bad).error, /must be a JSON object/, String(bad));
  const full = { access_token: 'a', refresh_token: 'r', account_id: 'acc', id_token: '' };
  // each case is otherwise complete, so only ITS guard can produce the error
  assert.match(normalizeCodexAuth({ ...full, access_token: '' }).error, /no access_token/);
  assert.match(normalizeCodexAuth({ ...full, access_token: '   ' }).error, /no access_token/);
  assert.match(normalizeCodexAuth({ ...full, refresh_token: '' }).error, /no refresh_token/);
  assert.match(normalizeCodexAuth({ ...full, refresh_token: undefined }).error, /no refresh_token/);
  assert.match(normalizeCodexAuth({ ...full, account_id: '' }).error, /no account_id/);
  assert.match(normalizeCodexAuth({ tokens: { access_token: 'a', refresh_token: 'r' } }).error, /no account_id/);
  assert.match(normalizeCodexAuth({ tokens: { refresh_token: 'r', account_id: 'acc' } }).error, /no access_token/);
  assert.match(normalizeCodexAuth({ tokens: { access_token: 'a', account_id: 'acc' } }).error, /no refresh_token/);
  assert.equal(normalizeCodexAuth(full).error, undefined);     // control: the complete object passes
});
test('codexWindowSlot: ≤6h is five, anything longer is seven', () => {
  assert.equal(codexWindowSlot(18000), 'five');
  assert.equal(codexWindowSlot(21600), 'five');
  assert.equal(codexWindowSlot(21601), 'seven');
  assert.equal(codexWindowSlot(604800), 'seven');
});
