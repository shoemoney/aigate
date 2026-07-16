/**
 * aigate/lib — pure, side-effect-free logic extracted from server.js so it can
 * be unit-tested in isolation. Nothing here touches the DB, the network, or
 * process env; callers pass in what these functions need.
 */
import crypto from 'node:crypto';
import { join, sep } from 'node:path';

// ---- token vault (AES-256-GCM) -----------------------------------------
// key: 32-byte Buffer. Returns { encrypt, decrypt }. decrypt throws on any
// tampering (GCM auth tag mismatch) — that's the point.
export function makeVault(key) {
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
    },
    decrypt(b64) {
      const buf = Buffer.from(b64, 'base64');
      const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(data), d.final()]).toString('utf8');
    },
  };
}

// ---- timing-safe token compare -----------------------------------------
// Never throws — guards on BYTE length before timingSafeEqual (which throws on
// mismatched buffer lengths). Bug: server previously guarded on string length.
export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---- ipv4 helpers -------------------------------------------------------
// Parse an IPv4 (optionally ::ffff: mapped) to a uint32, or null if malformed.
// Validates each octet is 0..255 — garbage like '999.1.1.1' / 'abc' → null.
export function ip2int(ip) {
  const s = String(ip).replace(/^::ffff:/, '');
  const p = s.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const oct of p) {
    if (!/^\d{1,3}$/.test(oct)) return null;
    const v = Number(oct);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

// Is `ip` inside any of `cidrs` (array of "net/bits" or bare "net")?
// Empty allowlist → allow all. Loopback always allowed. Unparseable ip → deny
// (when gated). Unparseable cidr entries are skipped.
export function ipAllowed(ip, cidrs) {
  if (!cidrs || !cidrs.length) return true;
  if (ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1') return true;
  const n = ip2int(ip);
  if (n === null) return false;
  for (const c of cidrs) {
    const [net, b] = c.split('/');
    const bits = b === undefined ? 32 : +b;
    // reject out-of-range/NaN prefixes: JS bit-shifts are mod-32, so an invalid
    // `/33` or `/abc` silently computes a garbage mask that mis-authorizes IPs.
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    if (net === '0.0.0.0' && bits === 0) return true;
    const netN = ip2int(net);
    if (netN === null) continue;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    if ((n & mask) === (netN & mask)) return true;
  }
  return false;
}

// Resolve the client IP. X-Forwarded-For is attacker-controlled unless aigate
// sits behind a proxy WE trust, so only honor it when trustProxy is set.
// Bug: server previously trusted XFF unconditionally → CIDR gate spoofable.
// Bug: even under trustProxy, taking the LEFTMOST hop is spoofable — a client
// can prepend `X-Forwarded-For: 127.0.0.1` and our proxy (NPM uses
// $proxy_add_x_forwarded_for, which APPENDS) leaves that forged entry on the
// left. Take the RIGHTMOST hop — the one our own directly-connected proxy
// appended — which the client cannot forge. Assumes ONE trusted proxy hop
// (aigate's topology); for N chained proxies you'd strip N from the right.
// `proxies` (optional) hardens further: only parse XFF when the socket peer is
// actually one of our proxies. Empty list = honor XFF from any peer (trustProxy
// is already an explicit opt-in that you're behind a trusted edge).
export function clientIp(headers, remoteAddress, { trustProxy = false, proxies = [] } = {}) {
  const peerTrusted = trustProxy && (proxies.length === 0 || proxies.includes(remoteAddress));
  if (peerTrusted) {
    const hops = String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return remoteAddress || '';
}

// ---- account token liveness --------------------------------------------
// Given the HTTP status from a usage-poll against Anthropic, is the account's
// token still alive? 401/403 mean the OAuth token is expired/revoked and the
// account needs re-auth; everything else (200, 400, 429, 5xx) authenticated
// fine, so we must NOT flag it. Network errors are handled by the caller (the
// flag is left unchanged so an Anthropic outage can't lock every account out).
export function tokenIsAlive(httpStatus) {
  return httpStatus !== 401 && httpStatus !== 403;
}

// ---- static file containment -------------------------------------------
// Map a URL path to a file inside publicDir, or null if it would escape.
// Bug: server used fp.startsWith(PUBLIC) with no separator, so a sibling dir
// like `public-secret/` slips past the prefix check. Require the boundary.
export function safeStaticPath(publicDir, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const fp = join(publicDir, file);
  if (fp !== publicDir && !fp.startsWith(publicDir + sep)) return null;
  return fp;
}
