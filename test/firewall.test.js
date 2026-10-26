import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFirewall, normalizeFirewallPolicy, FIREWALL_META_KEY } from '../src/firewall.js';

function fixture(t, bootstrap = '') {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT); PRAGMA synchronous=NORMAL');
  t.after(() => db.close());
  return { db, firewall: createFirewall({ db, bootstrap }) };
}
const draft = (firewall, rules, enabled = true) => ({ revision: firewall.snapshot().revision, enabled, rules: rules.map((cidr) => ({ cidr, label: '' })) });
const invalid = (error) => error.code === 'invalid_policy' && error.status === 400;

test('firewall bootstrap persists disabled legacy behavior only for absent/empty configuration', (t) => {
  const { db, firewall } = fixture(t);
  assert.equal(firewall.snapshot().enabled, false);
  assert.equal(firewall.snapshot().source, 'environment');
  assert.equal(firewall.allows('203.0.113.5'), true);
  assert.equal(JSON.parse(db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v).version, 1);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('firewall preserves configured LAN, Tailscale and exact NAT peers without broadening adjacent ranges', (t) => {
  const { firewall } = fixture(t, '192.168.1.0/24,100.64.0.0/10,172.16.17.1/32,172.18.0.1/32');
  for (const ip of ['192.168.1.0', '192.168.1.255', '100.64.0.0', '100.127.255.255', '172.16.17.1', '172.18.0.1']) assert.equal(firewall.allows(ip), true, ip);
  for (const ip of ['192.168.2.1', '100.63.255.255', '100.128.0.0', '172.16.17.2', '172.18.0.2', '66.249.68.34']) assert.equal(firewall.allows(ip), false, ip);
});

test('firewall supports IPv6 prefixes, equivalent forms and mapped IPv4 without crossing families', (t) => {
  const { firewall } = fixture(t, '192.0.2.0/24,fd7a:115c:a1e0::/48');
  for (const ip of ['::ffff:192.0.2.1', '::ffff:c000:201', '0:0:0:0:0:ffff:c000:201', 'fd7a:115c:a1e0:ffff::1']) assert.equal(firewall.allows(ip), true, ip);
  for (const ip of ['::ffff:192.0.3.1', 'fd7a:115c:a1e1::1', 'fe80::1%en0', 'broken']) assert.equal(firewall.allows(ip), false, ip);
  firewall.update(draft(firewall, ['::/0']), { clientIp: '::1' });
  assert.equal(firewall.allows('2001:db8::1'), true);
  assert.equal(firewall.allows('192.0.2.1'), false);
  assert.equal(firewall.allows('::ffff:c000:201'), false);
});

test('firewall always permits local recovery addresses while enabled', (t) => {
  const { firewall } = fixture(t, '192.0.2.1');
  for (const ip of ['127.0.0.1', '127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(firewall.allows(ip), true, ip);
});

test('rule normalization masks host bits and handles mapped /120 and IP literals', () => {
  assert.deepEqual(normalizeFirewallPolicy({ revision: 1, enabled: true, rules: [
    { cidr: ' 192.168.1.88/24 ', label: ' LAN ' },
    { cidr: '2001:0DB8:beef:0001::123/64' },
    { cidr: '::ffff:c000:201/120' },
    { cidr: '::ffff:198.51.100.5' },
  ] }).rules, [
    { cidr: '192.168.1.0/24', label: 'LAN' },
    { cidr: '2001:db8:beef:1::/64', label: '' },
    { cidr: '192.0.2.0/24', label: '' },
    { cidr: '198.51.100.5', label: '' },
  ]);
});

test('strict normalization rejects malformed input, unknown fields, enabled-empty and duplicate rules', () => {
  const policy = { revision: 1, enabled: true, rules: [{ cidr: '192.0.2.1' }] };
  for (const value of [null, [], 'text', {}, { ...policy, revision: '1' }, { ...policy, revision: 0 }, { ...policy, enabled: 1 }, { ...policy, allow_all: true }, { ...policy, rules: [] }, { ...policy, rules: Array(257).fill({ cidr: '192.0.2.1' }) }]) assert.throws(() => normalizeFirewallPolicy(value), invalid);
  for (const cidr of ['', 'host.invalid', 'https://192.0.2.1', '192.0.2.1:80', '192.0.2.999', '192.000.2.1', '192.0.2.1/', '192.0.2.1/33', '192.0.2.1/-1', '192.0.2.1/+24', '192.0.2.1/024', '192.0.2.1/24/3', 'fe80::1%en0', '::/129', '::/', '::ffff:c000:201/95']) assert.throws(() => normalizeFirewallPolicy({ ...policy, rules: [{ cidr }] }), invalid, cidr);
  for (const rule of [null, '192.0.2.1', { cidr: '192.0.2.1', deny: true }, { cidr: '192.0.2.1', label: 'x'.repeat(121) }, { cidr: '192.0.2.1', label: 'line\nbreak' }]) assert.throws(() => normalizeFirewallPolicy({ ...policy, rules: [rule] }), invalid);
  assert.throws(() => normalizeFirewallPolicy({ ...policy, rules: [{ cidr: '192.0.2.1' }, { cidr: '::ffff:c000:201' }] }), invalid);
});

test('malformed nonempty bootstrap cannot silently initialize an open policy', (t) => {
  for (const bootstrap of [',,,', '192.0.2.1,', 'invalid', 'fe80::1%en0']) {
    const db = new DatabaseSync(':memory:'); t.after(() => db.close());
    db.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT)');
    assert.throws(() => createFirewall({ db, bootstrap }), invalid);
    assert.equal(db.prepare('SELECT count(*) AS n FROM meta').get().n, 0);
  }
});

test('policy updates use revisions and prevent nonloopback self-lockout', (t) => {
  const { firewall } = fixture(t, '192.0.2.0/24');
  const before = firewall.snapshot();
  assert.throws(() => firewall.update(draft(firewall, ['198.51.100.0/24']), { clientIp: '192.0.2.10' }), (e) => e.status === 409 && e.code === 'self_lockout');
  assert.deepEqual(firewall.snapshot(), before);
  const saved = firewall.update(draft(firewall, ['192.0.2.0/24', '198.51.100.0/24']), { clientIp: '192.0.2.10' });
  assert.equal(saved.revision, 2); assert.equal(saved.source, 'database');
  assert.throws(() => firewall.update({ revision: 1, enabled: false, rules: [] }, { clientIp: '192.0.2.10' }), (e) => e.code === 'revision_conflict');
  const detached = firewall.snapshot();detached.rules[0].cidr = '0.0.0.0/0';
  assert.equal(firewall.allows('203.0.113.1'), false);
});

test('failed SQL write and failed audit both roll back revision, persisted policy and matcher', (t) => {
  const { db, firewall } = fixture(t, '192.0.2.0/24');
  const before = firewall.snapshot();
  const stored = () => db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v;
  const raw = stored();
  db.exec(`CREATE TRIGGER reject_firewall BEFORE UPDATE ON meta WHEN NEW.k='${FIREWALL_META_KEY}' BEGIN SELECT RAISE(ABORT,'test write failure'); END`);
  assert.throws(() => firewall.update(draft(firewall, ['0.0.0.0/0']), { clientIp: '192.0.2.10' }), /test write failure/);
  db.exec('DROP TRIGGER reject_firewall');
  assert.throws(() => firewall.update(draft(firewall, ['0.0.0.0/0']), { clientIp: '192.0.2.10', audit: () => { throw new Error('test audit failure'); } }), /test audit failure/);
  assert.deepEqual(firewall.snapshot(), before);
  assert.equal(stored(), raw);
  assert.equal(firewall.allows('203.0.113.1'), false);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
});

test('a real SQLite COMMIT failure rolls back the audit and policy before publishing the matcher', (t) => {
  const { db, firewall } = fixture(t, '192.0.2.0/24');
  const before = firewall.snapshot();
  const raw = db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v;
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE audit_parent(id INTEGER PRIMARY KEY); CREATE TABLE audit_pending(parent INTEGER REFERENCES audit_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  assert.throws(() => firewall.update(draft(firewall, ['0.0.0.0/0']), {
    clientIp: '192.0.2.10', audit: () => db.prepare('INSERT INTO audit_pending(parent) VALUES(42)').run(),
  }), /FOREIGN KEY/);
  assert.deepEqual(firewall.snapshot(), before);
  assert.equal(db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v, raw);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_pending').get().n, 0);
  assert.equal(firewall.allows('203.0.113.1'), false);
});

test('saved policy persists across a fresh connection and overrides changed or invalid environment', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aigate-firewall-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'policy.db');let db = new DatabaseSync(path);
  db.exec('CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT)');
  let firewall = createFirewall({ db, bootstrap: '192.0.2.0/24' });
  firewall.update(draft(firewall, ['198.51.100.0/24']), { clientIp: '127.0.0.1' });db.close();
  db = new DatabaseSync(path);t.after(() => db.close());
  firewall = createFirewall({ db, bootstrap: ',,,' });
  assert.equal(firewall.snapshot().revision, 2);
  assert.equal(firewall.allows('198.51.100.5'), true);
  assert.equal(firewall.allows('192.0.2.5'), false);
});

test('unreadable or invalid stored policies fail initialization without replacing the record', (t) => {
  const { db } = fixture(t);
  for (const raw of ['{broken', 'null', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, revision: 1, enabled: true, rules: [], source: 'database', updated_at: new Date().toISOString() })]) {
    db.prepare('UPDATE meta SET v=? WHERE k=?').run(raw, FIREWALL_META_KEY);
    assert.throws(() => createFirewall({ db, bootstrap: '' }), invalid);
    assert.equal(db.prepare('SELECT v FROM meta WHERE k=?').get(FIREWALL_META_KEY).v, raw);
  }
});
