import { BlockList, isIP } from 'node:net';

export const FIREWALL_META_KEY = 'firewall_policy_v1';
const MAX_RULES = 256;
const MAX_LABEL = 120;

export class FirewallError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FirewallError';
    this.status = status;
    this.code = code;
  }
}
const invalid = (message) => new FirewallError(400, 'invalid_policy', message);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, names, description) {
  if (!object(value) || Object.keys(value).some((key) => !names.includes(key))) throw invalid(`Invalid ${description} fields.`);
}

function address(raw) {
  // net.isIP accepts scoped IPv6 literals; scopes depend on a local interface and
  // are deliberately not valid portable firewall rules or forwarded addresses.
  if (typeof raw !== 'string' || !raw || raw.includes('%')) return null;
  const family = isIP(raw);
  if (family === 4) {
    const parts = raw.split('.');
    return { family, value: parts.reduce((n, part) => (n << 8n) | BigInt(part), 0n), text: raw };
  }
  if (family !== 6) return null;
  const text = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const [left, right] = text.split('::');
  const before = left ? left.split(':') : [];
  const after = right ? right.split(':') : [];
  const groups = [...before, ...Array(8 - before.length - after.length).fill('0'), ...after];
  const value = BigInt('0x' + groups.map((group) => group.padStart(4, '0')).join(''));
  return { family, value, text, mapped: value >> 32n === 0xffffn };
}
function ipv4(value) {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 255n)).join('.');
}
function ipv6(value) {
  const groups = Array.from({ length: 8 }, (_, index) => ((value >> BigInt((7 - index) * 16)) & 65535n).toString(16));
  return new URL(`http://[${groups.join(':')}]/`).hostname.slice(1, -1);
}
function loopback(parsed) {
  if (!parsed) return false;
  if (parsed.family === 6 && !parsed.mapped) return parsed.value === 1n;
  const value = parsed.mapped ? parsed.value & 0xffffffffn : parsed.value;
  return value >> 24n === 127n;
}

function normalizeRule(rule, index) {
  fields(rule, ['cidr', 'label'], `rule ${index + 1}`);
  if (typeof rule.cidr !== 'string' || rule.cidr.length > 128) throw invalid(`Rule ${index + 1} needs an IP address or CIDR range.`);
  const parts = rule.cidr.trim().split('/');
  const parsed = address(parts[0]);
  if (!parsed || parts.length > 2) throw invalid(`Rule ${index + 1} is not a valid IP address or CIDR range.`);
  const explicitPrefix = parts.length === 2;
  const width = parsed.family === 4 ? 32 : 128;
  if (explicitPrefix && !/^(?:0|[1-9]\d{0,2})$/.test(parts[1])) throw invalid(`Rule ${index + 1} has an invalid CIDR prefix.`);
  let prefix = explicitPrefix ? Number(parts[1]) : width;
  if (prefix > width) throw invalid(`Rule ${index + 1} has an invalid CIDR prefix.`);
  if (parsed.mapped && prefix < 96) throw invalid(`Rule ${index + 1} uses a mapped IPv4 subnet outside the IPv4-mapped /96 range.`);
  let family = parsed.family, value = parsed.value;
  // A mapped IPv6 address and its equivalent IPv4 address identify the same
  // caller. A mapped subnet wholly within /96 is an ordinary IPv4 subnet.
  if (parsed.mapped && prefix >= 96) {
    family = 4;
    value &= 0xffffffffn;
    prefix -= 96;
  }
  const shift = BigInt((family === 4 ? 32 : 128) - prefix);
  const network = (value >> shift) << shift;
  const text = family === 4 ? ipv4(network) : ipv6(network);
  const cidr = explicitPrefix ? `${text}/${prefix}` : text;
  const label = rule.label === undefined ? '' : rule.label;
  if (typeof label !== 'string' || label.length > MAX_LABEL || /[\x00-\x1f\x7f]/.test(label)) throw invalid(`Rule ${index + 1} labels must be at most ${MAX_LABEL} characters without control characters.`);
  return { rule: { cidr, label: label.trim() }, family, network: text, prefix, signature: `${family}|${text}|${prefix}` };
}

export function normalizeFirewallPolicy(value) {
  fields(value, ['revision', 'enabled', 'rules'], 'firewall policy');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw invalid('A valid policy revision is required. Reload the firewall settings.');
  if (typeof value.enabled !== 'boolean') throw invalid('Firewall enabled must be true or false.');
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) throw invalid(`Provide at most ${MAX_RULES} allow rules.`);
  if (value.enabled && !value.rules.length) throw invalid('An enabled firewall must have at least one allow rule.');
  const normalized = value.rules.map(normalizeRule);
  const seen = new Set();
  for (const entry of normalized) {
    if (seen.has(entry.signature)) throw invalid('Duplicate allow rules are not permitted.');
    seen.add(entry.signature);
  }
  return { revision: value.revision, enabled: value.enabled, rules: normalized.map((entry) => entry.rule) };
}
function compile(policy) {
  // Separate family lists prevent an IPv6 ::/0 rule from implicitly permitting
  // all IPv4 addresses through BlockList's mapped-address interoperability.
  const lists = { 4: new BlockList(), 6: new BlockList() };
  for (const entry of policy.rules.map(normalizeRule)) lists[entry.family].addSubnet(entry.network, entry.prefix, entry.family === 4 ? 'ipv4' : 'ipv6');
  return (ip) => {
    if (!policy.enabled) return true;
    const parsed = address(ip);
    if (loopback(parsed)) return true;
    if (!parsed) return false;
    const family = parsed.mapped ? 4 : parsed.family;
    const text = parsed.mapped ? ipv4(parsed.value & 0xffffffffn) : parsed.text;
    return lists[family].check(text, family === 4 ? 'ipv4' : 'ipv6');
  };
}
function storedRecord(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid('Stored firewall policy is not valid JSON. Restore a valid policy before starting Aigate.'); }
  fields(value, ['version', 'revision', 'enabled', 'rules', 'updated_at', 'source'], 'stored firewall policy');
  if (value.version !== 1 || !['environment', 'database'].includes(value.source) || typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at))) throw invalid('Stored firewall policy metadata is invalid.');
  return { version: 1, ...normalizeFirewallPolicy({ revision: value.revision, enabled: value.enabled, rules: value.rules }), updated_at: value.updated_at, source: value.source };
}

/** One process owns this DB. Environment is consulted only when the row is absent. */
export function createFirewall({ db, bootstrap = '' }) {
  const read = db.prepare('SELECT v FROM meta WHERE k=?');
  let current, allows;
  function publish(record, matcher = compile(record)) { current = record; allows = matcher; }

  // Security settings must survive a successful response followed by power loss.
  // Only publish the matcher after COMMIT. A restore-to-NORMAL failure leaves
  // FULL in effect; it must not report a committed policy as an unsuccessful save.
  function transaction(write) {
    const previousSync = db.prepare('PRAGMA synchronous').get().synchronous;
    db.exec('PRAGMA synchronous=FULL');
    let started = false, committed = false;
    try {
      db.exec('BEGIN IMMEDIATE'); started = true;
      const result = write();
      const matcher = compile(result);
      db.exec('COMMIT'); committed = true;
      publish(result, matcher);
      return result;
    } catch (error) {
      if (started && !committed) try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      try { db.exec(`PRAGMA synchronous=${previousSync}`); }
      catch (error) { console.error('[firewall] could not restore SQLite synchronous mode', String(error?.message || error)); }
    }
  }
  const existing = read.get(FIREWALL_META_KEY);
  if (existing) publish(storedRecord(existing.v));
  else transaction(() => {
    // A second initializer cannot replace a policy written after our first read.
    const raced = read.get(FIREWALL_META_KEY);
    if (raced) return storedRecord(raced.v);
    if (typeof bootstrap !== 'string') throw invalid('AIGATE_ALLOW_CIDR must be a comma-separated list of IP addresses or CIDRs.');
    const entries = bootstrap.trim() ? bootstrap.split(',').map((cidr) => ({ cidr: cidr.trim(), label: '' })) : [];
    const policy = normalizeFirewallPolicy({ revision: 1, enabled: entries.length > 0, rules: entries });
    const record = { version: 1, ...policy, updated_at: new Date().toISOString(), source: 'environment' };
    db.prepare('INSERT INTO meta(k,v) VALUES(?,?)').run(FIREWALL_META_KEY, JSON.stringify(record));
    return record;
  });

  function snapshot(clientIp = '', peerIp = '') {
    return {
      revision: current.revision, enabled: current.enabled,
      rules: current.rules.map((rule) => ({ ...rule })),
      client_ip: clientIp, peer_ip: peerIp, loopback_always_allowed: true,
      updated_at: current.updated_at, source: current.source,
    };
  }
  function update(input, { clientIp, audit } = {}) {
    const policy = normalizeFirewallPolicy(input);
    const candidateAllows = compile(policy);
    transaction(() => {
      const row = read.get(FIREWALL_META_KEY);
      if (!row) throw new Error('Firewall policy is missing from the database.');
      const stored = storedRecord(row.v);
      if (stored.revision !== policy.revision) throw new FirewallError(409, 'revision_conflict', 'Firewall rules changed in another session. Reload the saved rules before trying again.');
      if (policy.enabled && !candidateAllows(clientIp)) throw new FirewallError(409, 'self_lockout', 'These rules would block your current IP address. Add an allow rule for it before saving.');
      if (stored.revision === Number.MAX_SAFE_INTEGER) throw invalid('Firewall revision limit reached.');
      const record = { version: 1, ...policy, revision: policy.revision + 1, updated_at: new Date().toISOString(), source: 'database' };
      const result = db.prepare('UPDATE meta SET v=? WHERE k=? AND v=?').run(JSON.stringify(record), FIREWALL_META_KEY, row.v);
      if (result.changes !== 1) throw new FirewallError(409, 'revision_conflict', 'Firewall rules changed in another session. Reload the saved rules.');
      if (audit) audit(record);
      return record;
    });
    return snapshot(clientIp);
  }
  return { allows: (ip) => allows(ip), snapshot, update };
}
