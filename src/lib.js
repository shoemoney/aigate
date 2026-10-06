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

// ---- dashboard session cookie (stateless, signed) ----------------------
// A signed value "<exp_ms>.<hmac>" the browser holds as an HttpOnly cookie after
// a password login, so the raw bearer token never enters the browser. Stateless:
// no server-side session store — the HMAC (keyed by the shared secret) IS the
// proof. Rotating the secret (token or password) invalidates every live cookie.
export function signSession(secret, expMs) {
  const exp = String(expMs);
  const sig = crypto.createHmac('sha256', 'aigate-sess|' + secret).update(exp).digest('hex');
  return exp + '.' + sig;
}
// True only for an un-expired value whose signature verifies (timing-safe). Never
// throws on garbage input — a forged/absent cookie is just false.
export function verifySession(secret, value) {
  if (typeof value !== 'string') return false;
  const dot = value.indexOf('.');
  if (dot <= 0) return false;
  const exp = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!/^\d+$/.test(exp)) return false;
  const want = crypto.createHmac('sha256', 'aigate-sess|' + secret).update(exp).digest('hex');
  if (!tokenMatches(sig, want)) return false;
  return Number(exp) > Date.now();
}
// Pull one cookie value out of a Cookie header. '' when absent/malformed.
export function parseCookie(header, name) {
  if (typeof header !== 'string' || !header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) { try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return part.slice(eq + 1).trim(); } }
  }
  return '';
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
    if (b === '') continue;
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

// ---- codex (ChatGPT) auth helpers --------------------------------------
// Decode a JWT's payload WITHOUT verifying it — we only read claims (email, plan,
// exp) out of tokens OpenAI already issued to us; the signature is the issuer's
// business. null on anything that isn't a 3-part base64url JSON object.
export function decodeJwtPayload(tok) {
  if (typeof tok !== 'string') return null;
  const parts = tok.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const v = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// Any RFC3339 (Z or +08:00 offset) → UTC ISO string, null when unparseable. CLIProxyAPI
// files carry local-offset stamps; comparing them as strings across offsets is wrong.
const toUtcIso = (s) => {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

// Accept BOTH on-disk shapes — the real ~/.codex/auth.json ({tokens:{…}}) and the
// CLIProxyAPI flat file ({type:'codex', access_token, …, expired}) — and return the
// canonical auth.json object plus the non-secret facts aigate indexes on. Never
// throws: {error} is the 400 text. exp = the access token's own JWT exp (epoch s),
// falling back to the flat file's `expired`, then last_refresh + 10d (Codex's
// observed lifetime) so a token whose claims can't be read still gets a refresh date.
export function normalizeCodexAuth(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'auth_json must be a JSON object' };
  const src = obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : obj;
  const id_token = typeof src.id_token === 'string' ? src.id_token : '';
  const access_token = typeof src.access_token === 'string' ? src.access_token.trim() : '';
  const refresh_token = typeof src.refresh_token === 'string' ? src.refresh_token.trim() : '';
  if (!access_token) return { error: 'auth_json has no access_token' };
  if (!refresh_token) return { error: 'auth_json has no refresh_token' };
  const idc = decodeJwtPayload(id_token), acc = decodeJwtPayload(access_token);
  const authClaim = (idc && idc['https://api.openai.com/auth']) || (acc && acc['https://api.openai.com/auth']) || {};
  const account_id = String(src.account_id || obj.account_id || authClaim.chatgpt_account_id || '').trim();
  if (!account_id) return { error: 'auth_json has no account_id' };
  const email = String((idc && idc.email) || obj.email || (acc && acc.email) || '').trim() || null;
  const plan = String(authClaim.chatgpt_plan_type || obj.plan_type || '').trim() || null;
  const last_refresh = toUtcIso(obj.last_refresh) || new Date().toISOString();
  let exp = acc && Number.isFinite(acc.exp) ? Math.trunc(acc.exp) : null;
  if (exp == null) { const e = toUtcIso(obj.expired); if (e) exp = Math.floor(Date.parse(e) / 1000); }
  if (exp == null) exp = Math.floor(Date.parse(last_refresh) / 1000) + 10 * 86400;
  return {
    auth: { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token, access_token, refresh_token, account_id }, last_refresh },
    email, plan, account_id, exp,
  };
}

// chatgpt.com/backend-api/wham/usage reports each window by its LENGTH, and which
// of primary/secondary holds which varies by plan (Pro: only a weekly one). Slot by
// length — ≤6h is the short "five hour" bucket, anything longer is the weekly one.
export function codexWindowSlot(seconds) {
  return Number(seconds) <= 21600 ? 'five' : 'seven';
}
