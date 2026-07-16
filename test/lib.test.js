import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { join, sep } from 'node:path';
import { makeVault, tokenMatches, ip2int, ipAllowed, clientIp, safeStaticPath, tokenIsAlive } from '../src/lib.js';

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
