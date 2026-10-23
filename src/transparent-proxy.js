import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { createTrafficStore } from './proxy-traffic.js';
import { PROVIDER_BY_ID } from './providers.js';
import { tokenMatches } from './lib.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'transfer-encoding', 'upgrade']);
const reserved = (p) => p.startsWith('/api') || p === '/health' || p === '/healthz' || p === '/ws';
const safeInt = (v, fallback, max) => /^\d+$/.test(String(v ?? '')) ? Math.min(max, Number(v)) : fallback;
const pairs = (raw) => Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2], raw[i * 2 + 1]]);
function informational(res, information) {
  // Node's public 103 writer drops responses without Link and normalizes header
  // pairs. Use the same queued OutgoingMessage writer used by writeContinue and
  // writeEarlyHints, retaining pipelined-response ordering (never socket.write).
  if (typeof res._writeRaw !== 'function') throw new Error('informational response writer is unavailable');
  const headers = relayHeaders(information.rawHeaders);
  let message = `HTTP/1.1 ${information.statusCode} ${information.statusMessage}\r\n`;
  for (let i = 0; i < headers.length; i += 2) {
    http.validateHeaderName(headers[i]); http.validateHeaderValue(headers[i], headers[i + 1]);
    message += headers[i] + ': ' + headers[i + 1] + '\r\n';
  }
  res._writeRaw(message + '\r\n', 'latin1');
}
const drain = (stream) => new Promise((resolve, reject) => {
  const cleanup = () => { stream.off('drain', ready); stream.off('error', failed); stream.off('close', closed); };
  const ready = () => { cleanup(); resolve(); };
  const failed = (e) => { cleanup(); reject(e); };
  const closed = () => failed(new Error('stream closed'));
  stream.once('drain', ready); stream.once('error', failed); stream.once('close', closed);
  if (stream.destroyed) closed();
});
function authentication(req) {
  const fields = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i].toLowerCase();
    if (name === 'authorization' || name === 'x-api-key') fields.push([name, req.rawHeaders[i + 1]]);
  }
  if (fields.length !== 1) return { error: 'exactly one Authorization or x-api-key header is required' };
  const [header, value] = fields[0];
  if (header === 'authorization') {
    const m = /^Bearer ([^\s,]+)$/i.exec(value);
    if (!m) return { error: 'Bearer authentication required' };
    return { token: m[1], header };
  }
  if (!value || /[\s,]/.test(value)) return { error: 'invalid x-api-key' };
  return { token: value, header };
}
function relayHeaders(raw, { upstream, authHeader, key } = {}) {
  const connection = new Set();
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'connection') {
    for (const name of raw[i + 1].split(',')) connection.add(name.trim().toLowerCase());
  }
  const out = [];
  let inserted = false, hasHost = false;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (HOP.has(name) || connection.has(name)) continue;
    if (upstream && name === 'host') { out.push(raw[i], upstream.host); hasHost = true; continue; }
    if (upstream && (name === 'authorization' || name === 'x-api-key')) {
      const canonical = authHeader === 'x-api-key' ? 'x-api-key' : 'Authorization';
      out.push(name === authHeader ? raw[i] : canonical, authHeader === 'x-api-key' ? key : 'Bearer ' + key);
      inserted = true; continue;
    }
    out.push(raw[i], raw[i + 1]);
  }
  if (upstream && !hasHost) out.push('Host', upstream.host);
  if (upstream && !inserted) out.push(authHeader, authHeader === 'x-api-key' ? key : 'Bearer ' + key);
  return out;
}
function upstreamUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('upstream must be an http(s) origin with optional path prefix, without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}
function defaultUpstream(provider) {
  if (provider === 'kimi') return 'https://api.kimi.com/coding';
  const base = PROVIDER_BY_ID.get(provider)?.base;
  if (!base) return null;
  // A binding is a reverse-proxy mount: clients keep the provider's API path.
  // Remove only terminal /v1, retaining provider-specific mount prefixes.
  return base.replace(/\/v1\/?$/, '');
}
function supportedAdapter(provider, explicitUpstream = false) {
  const metadata = PROVIDER_BY_ID.get(provider);
  if (provider === 'aws') return false;
  if (['anthropic', 'kimi', 'muse'].includes(provider)) return true;
  if (metadata) return metadata.oaiCompat === true;
  return explicitUpstream;
}

export async function createTransparentProxy({ db, encrypt, decrypt, dbPath, masterToken, reqIp, authFail, authLocked, authOk }) {
  db.exec(`CREATE TABLE IF NOT EXISTS proxy_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL, fields_enc TEXT NOT NULL, field_names TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ); CREATE TABLE IF NOT EXISTS proxy_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
    key_id INTEGER, credential_id INTEGER, key_fingerprint TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', upstream TEXT NOT NULL,
    created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK ((key_id IS NULL) != (credential_id IS NULL))
  )`);
  const traffic = await createTrafficStore({ db, directory: join(dirname(dbPath), 'proxy-traffic'), encrypt, decrypt });
  const bindingFor = db.prepare('SELECT * FROM proxy_clients WHERE token_hash=?');
  const keyFor = db.prepare('SELECT provider,key_enc,status FROM provider_keys WHERE id=?');
  const credentialFor = db.prepare('SELECT * FROM proxy_credentials WHERE id=?');
  const publicClients = () => db.prepare('SELECT id,provider,key_id,credential_id,label,upstream,created FROM proxy_clients ORDER BY id').all();
  const credentials = () => db.prepare('SELECT id,provider,label,kind,field_names,created FROM proxy_credentials ORDER BY id').all().map(({ field_names, ...row }) => ({ ...row, fields: JSON.parse(field_names) }));
  const presetTokens = () => {
    const tokens = [process.env.AIGATE_PROXY_TOKEN, process.env.AIGATE_PROXY_TOKEN_2].filter(Boolean);
    if (tokens.some(t => t.length < 8 || t.length > 512 || /[\s,]/.test(t) || tokenMatches(t, masterToken)) || (tokens.length === 2 && tokenMatches(tokens[0], tokens[1]))) throw new Error('proxy-only env tokens must be distinct, differ from admin, and contain 8-512 non-whitespace characters');
    return tokens;
  };
  presetTokens();
  const presetBinding = (req) => {
    const match = /^\/proxy\/([a-z0-9._-]+)(\/.*)$/.exec(req.url);
    if (!match) return { invalid: { status: 400, reason: 'provider path required: /proxy/<provider>/<original path>' } };
    const provider = match[1];
    if (!supportedAdapter(provider)) return { invalid: { status: 422, reason: 'provider requires an unsupported authentication adapter' } };
    let upstream;
    try { upstream = upstreamUrl(process.env['AIGATE_TRANSPARENT_UPSTREAM_' + provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')] || defaultUpstream(provider)); }
    catch { return { invalid: { status: 503, reason: 'provider upstream is not configured correctly' } }; }
    const credential = db.prepare("SELECT id FROM proxy_credentials WHERE provider=? AND kind='api_key' ORDER BY id DESC LIMIT 1").get(provider);
    if (credential) return { binding: { provider, credential_id: credential.id, upstream, relay_target: match[2] } };
    if (db.prepare('SELECT id FROM proxy_credentials WHERE provider=? LIMIT 1').get(provider)) return { invalid: { status: 422, reason: 'credential kind requires an unsupported signing adapter' } };
    const key = db.prepare("SELECT id FROM provider_keys WHERE provider=? AND status='working' ORDER BY id DESC LIMIT 1").get(provider);
    if (!key) return { invalid: { status: 503, reason: 'no manually added credential for this provider' } };
    return { binding: { provider, key_id: key.id, upstream, relay_target: match[2] } };
  };

  async function relay(req, res, binding, invalid) {
    let capture;
    try {
      capture = await traffic.start({ clientId: binding?.id, provider: binding?.provider, method: req.method, target: req.url, http_version: req.httpVersion, headers: req.rawHeaders, peer: reqIp(req) });
    } catch { res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":{"message":"traffic capture unavailable","type":"api_error"}}'); return; }
    if (req.aigateExpectContinue) {
      try { await capture.append('information', { status: 100, headers: [], generated: true }); res.writeContinue(); }
      catch { await capture.finish('logging_error').catch(() => {}); res.destroy(); return; }
    }
    let status = null, finished = false, outgoing, incoming, requestFinished = false, responseFinished = false;
    const complete = async (state, extra) => {
      if (finished) return;
      finished = true;
      try { await capture.finish(state, status, extra); } catch { if (!res.destroyed) res.destroy(); }
    };
    const fault = async (code, reason, error) => {
      if (finished) return;
      try { await capture.append('error', { reason, code: error?.code || null }); } catch { res.destroy(); await complete('logging_error'); outgoing?.destroy(); incoming?.destroy(); return; }
      outgoing?.destroy(); incoming?.destroy();
      if (!res.headersSent && !res.destroyed) {
        status = code;
        const error = { message: reason, type: code === 401 ? 'authentication_error' : 'api_error' };
        const anthropic = !/^\/v1\/(?:chat\/completions|responses)(?:\?|$)/.test(req.url);
        const bytes = Buffer.from(JSON.stringify(anthropic ? { type: 'error', error } : { error }));
        try { await capture.append('response', { status, headers: ['content-type', 'application/json', 'connection', 'close'], generated: true }); await capture.chunk('response', bytes); }
        catch { res.destroy(); await complete('logging_error'); return; }
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(bytes);
      } else if (!res.destroyed) res.destroy();
      await complete(code === 401 ? 'rejected' : 'error', { reason });
    };
    const reject = async (code, reason) => {
      // Drain and record rejected bodies too; no unbounded buffering or key intake.
      try {
        for await (const chunk of req) await capture.chunk('request', chunk);
        await capture.append('request_end', { trailers: req.rawTrailers });
      } catch (e) { if (!req.complete) { await complete('client_abort'); return; } return fault(503, 'traffic capture unavailable', e); }
      await fault(code, reason);
    };
    if (invalid) return reject(invalid.status, invalid.reason);
    if (!supportedAdapter(binding.provider, true)) return reject(422, 'provider requires an unsupported authentication adapter');
    let key;
    if (binding.credential_id != null) {
      const row = credentialFor.get(binding.credential_id);
      if (!row || row.provider !== binding.provider) return reject(503, 'configured credential is unavailable');
      if (row.kind !== 'api_key') return reject(422, 'credential kind requires an unsupported signing adapter');
      try { key = JSON.parse(decrypt(row.fields_enc)).api_key; } catch { return reject(503, 'configured credential is unavailable'); }
    } else {
      const row = keyFor.get(binding.key_id);
      if (!row || row.provider !== binding.provider || row.status !== 'working') return reject(503, 'configured provider key is unavailable');
      try { key = decrypt(row.key_enc); } catch { return reject(503, 'configured provider key is unavailable'); }
    }
    if (typeof key !== 'string' || (binding.key_fingerprint && hash(key) !== binding.key_fingerprint)) return reject(503, 'configured credential has changed; register a new client binding');
    if (key.startsWith('sk-ant-oat')) return reject(503, 'subscription OAuth tokens cannot be proxied');
    const target = binding.relay_target || req.url;
    if (!target.startsWith('/') || target.startsWith('//')) return reject(400, 'origin-form request target required');
    if (req.method === 'CONNECT' || req.headers.upgrade) return reject(501, 'CONNECT and upgraded protocols are not supported');
    const destination = new URL(binding.upstream);
    const path = destination.pathname.replace(/\/$/, '') + target;
    const headers = relayHeaders(req.rawHeaders, { upstream: destination, authHeader: binding.provider === 'anthropic' ? 'x-api-key' : 'authorization', key });
    // Without explicit framing Node omits chunked bodies on GET/DELETE. The
    // transfer-coding belongs to each leg; regenerate it for these uploads.
    if (req.headers['transfer-encoding'] && !headers.some((v, i) => i % 2 === 0 && v.toLowerCase() === 'content-length')) headers.push('Transfer-Encoding', 'chunked');
    try { await capture.append('forward', { method: req.method, target: path, upstream: destination.origin, headers }); }
    catch { return fault(503, 'traffic capture unavailable'); }
    const clientAbort = () => {
      if (finished) return;
      outgoing?.destroy(); incoming?.destroy(); void complete('client_abort');
    };
    req.on('aborted', clientAbort);
    res.on('close', () => { if (!res.writableFinished) clientAbort(); });
    res.on('finish', () => {
      responseFinished = true;
      if (requestFinished && !finished) void complete('complete');
    });
    const timeout = Math.max(1000, Number(process.env.AIGATE_TRANSPARENT_TIMEOUT_MS) || 300000);
    try {
      outgoing = (destination.protocol === 'https:' ? https : http).request(destination, {
        method: req.method, path, headers, setHost: false, agent: false,
      });
      outgoing.setTimeout(timeout, () => { void fault(504, 'upstream timed out'); });
      outgoing.on('error', e => { if (!incoming?.complete) void fault(502, 'upstream connection failed', e); });
      outgoing.on('upgrade', (_response, socket) => { socket.destroy(); void fault(501, 'upgraded protocols are not supported'); });
      outgoing.on('information', (information) => {
        void (async () => {
          try {
            await capture.append('information', { status: information.statusCode, status_message: information.statusMessage, headers: information.rawHeaders });
            // The downstream 100 was already sent and captured for its own
            // Expect handshake. Do not send that transport handshake twice.
            if (information.statusCode !== 100) informational(res, information);
          } catch { await fault(503, 'traffic capture unavailable'); }
        })();
      });
      outgoing.on('response', (response) => {
        incoming = response;
        void (async () => {
          try {
            status = response.statusCode;
            const responseHeaders = relayHeaders(response.rawHeaders);
            await capture.append('response', { status, status_message: response.statusMessage, headers: response.rawHeaders, forwarded_headers: responseHeaders, http_version: response.httpVersion });
            res.sendDate = false;
            res.writeHead(status, response.statusMessage, responseHeaders);
            res.flushHeaders();
            for await (const chunk of response) {
              await capture.chunk('response', chunk);
              if (!res.write(chunk)) await drain(res);
            }
            await capture.append('response_end', { trailers: response.rawTrailers });
            const trailers = relayHeaders(response.rawTrailers);
            if (trailers.length) res.addTrailers(pairs(trailers));
            res.end();
          } catch (e) { if (!finished) await fault(502, 'upstream stream or traffic capture failed', e); }
        })();
      });
      for await (const chunk of req) {
        if (finished) break;
        await capture.chunk('request', chunk);
        if (!outgoing.destroyed && !outgoing.writableEnded && !outgoing.write(chunk)) await drain(outgoing);
      }
      if (!finished) {
        await capture.append('request_end', { trailers: req.rawTrailers });
        requestFinished = true;
        const trailers = relayHeaders(req.rawTrailers);
        if (!outgoing.destroyed) { if (trailers.length) outgoing.addTrailers(pairs(trailers)); outgoing.end(); }
        if (responseFinished) await complete('complete');
      }
    } catch (e) { if (!finished) await fault(502, 'request forwarding or traffic capture failed', e); }
  }
  return {
    traffic,
    async unsupported(req, socket, head = Buffer.alloc(0)) {
      const auth = authentication(req);
      let preset = false;
      try { preset = presetTokens().some(token => tokenMatches(auth.token, token)); } catch { /* reject invalid configuration */ }
      const binding = auth.token ? bindingFor.get(hash(auth.token)) : null;
      const status = binding || preset ? 501 : 401;
      let capture;
      try {
        capture = await traffic.start({ clientId: binding?.id, provider: binding?.provider, method: req.method, target: req.url, http_version: req.httpVersion, headers: req.rawHeaders, peer: reqIp(req) });
        if (head.length) await capture.chunk('request', head);
        await capture.append('response', { status, generated: true, reason: 'CONNECT and upgraded protocols are not supported', headers: ['Connection', 'close', 'Content-Length', '0'] });
        await capture.finish('rejected', status);
        socket.end(`HTTP/1.1 ${status} ${status === 501 ? 'Not Implemented' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      } catch { socket.destroy(); if (capture) try { await capture.finish('logging_error'); } catch { /* unavailable storage */ } }
    },
    async handle(req, res) {
      let p;
      try { p = new URL(req.url, 'http://x').pathname; } catch { return false; }
      if (reserved(p)) return false;
      const auth = authentication(req);
      // Leave the established administrator-only compatibility routes intact.
      if (auth.token === masterToken) return false;
      let tokens;
      try { tokens = presetTokens(); } catch { await relay(req, res, null, { status: 503, reason: 'proxy authentication configuration is invalid' }); return true; }
      if (auth.token && tokens.some(token => tokenMatches(auth.token, token))) {
        const route = presetBinding(req);
        const ip = reqIp(req);
        if (authLocked(ip)) { await relay(req, res, route.binding, { status: 429, reason: 'too many authentication failures' }); return true; }
        authOk(ip); await relay(req, res, route.binding, route.invalid); return true;
      }
      const binding = auth.token ? bindingFor.get(hash(auth.token)) : null;
      if (!binding && !p.startsWith('/v1') && !p.startsWith('/proxy/')) return false;
      const ip = reqIp(req);
      if (authLocked(ip)) { await relay(req, res, binding, { status: 429, reason: 'too many authentication failures' }); return true; }
      if (!binding || auth.error) {
        authFail(ip); await relay(req, res, null, { status: 401, reason: auth.error || 'unknown proxy credential' }); return true;
      }
      authOk(ip); await relay(req, res, binding); return true;
    },
    async admin(req, res, url, { json, body }) {
      const p = url.pathname;
      if (p === '/api/proxy/credentials' && req.method === 'GET') { json(res, 200, credentials()); return true; }
      if (p === '/api/proxy/credentials' && req.method === 'POST') {
        const data = await body(req);
        const fail = (message) => { json(res, 400, { error: message }); return true; };
        if (data.__oversized) return fail('body too large');
        if (typeof data.provider !== 'string' || !/^[a-z0-9._-]+$/.test(data.provider)) return fail('provider is required');
        if (!['api_key', 'bundle', 'aws_sigv4'].includes(data.kind)) return fail('kind must be api_key, bundle or aws_sigv4');
        if (data.label != null && (typeof data.label !== 'string' || data.label.length > 200)) return fail('label must be at most 200 characters');
        const fields = data.fields;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length < 1 || Object.keys(fields).length > 50 || Object.entries(fields).some(([name, value]) => !/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof value !== 'string' || !value || value.length > 65536)) return fail('fields must be named nonempty strings');
        if (data.kind === 'api_key' && (Object.keys(fields).length !== 1 || !fields.api_key || /[\s,]/.test(fields.api_key))) return fail('api_key kind requires only fields.api_key without whitespace or commas');
        if (data.kind === 'aws_sigv4' && (!fields.access_key_id || !fields.secret_access_key || !fields.region)) return fail('aws_sigv4 requires access_key_id, secret_access_key and region');
        if (data.kind === 'api_key' && fields.api_key.startsWith('sk-ant-oat')) return fail('subscription OAuth tokens cannot be proxy credentials');
        const result = db.prepare('INSERT INTO proxy_credentials(provider,label,kind,fields_enc,field_names) VALUES(?,?,?,?,?)').run(data.provider, data.label || '', data.kind, encrypt(JSON.stringify(fields)), JSON.stringify(Object.keys(fields)));
        json(res, 201, credentials().find(c => c.id === Number(result.lastInsertRowid))); return true;
      }
      const credential = /^\/api\/proxy\/credentials\/(\d+)$/.exec(p);
      if (credential && req.method === 'DELETE') {
        const id = Number(credential[1]);
        db.exec('BEGIN');
        let result;
        try { db.prepare('DELETE FROM proxy_clients WHERE credential_id=?').run(id); result = db.prepare('DELETE FROM proxy_credentials WHERE id=?').run(id); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        json(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'unknown credential' }); return true;
      }
      if (p === '/api/proxy/clients' && req.method === 'GET') { json(res, 200, publicClients()); return true; }
      if (p === '/api/proxy/clients' && req.method === 'POST') {
        const data = await body(req);
        const fail = (message) => { json(res, 400, { error: message }); return true; };
        if (data.__oversized) return fail('body too large');
        if (typeof data.token !== 'string' || data.token.length < 8 || data.token.length > 512 || /[\s,]/.test(data.token)) return fail('token must be 8-512 characters without whitespace or commas');
        if (data.token === masterToken) return fail('proxy token must differ from the administrator token');
        if (presetTokens().some(token => tokenMatches(data.token, token))) return fail('proxy client token must differ from configured proxy-only env tokens');
        if (typeof data.provider !== 'string' || !/^[a-z0-9._-]+$/.test(data.provider)) return fail('provider is required');
        if ((data.key_id == null) === (data.credential_id == null)) return fail('provide exactly one key_id or credential_id');
        const id = data.credential_id ?? data.key_id;
        if (!Number.isSafeInteger(id) || id < 1) return fail('credential id must be a positive integer');
        const key = data.credential_id != null ? credentialFor.get(id) : keyFor.get(id);
        if (!key || key.provider !== data.provider || (data.key_id != null && key.status !== 'working')) return fail('credential id must identify a manually added credential for this provider');
        if (key.kind && key.kind !== 'api_key') { json(res, 422, { error: 'credential kind requires an unsupported signing adapter' }); return true; }
        if (!supportedAdapter(data.provider, typeof data.upstream === 'string')) { json(res, 422, { error: 'provider requires an unsupported authentication adapter' }); return true; }
        let keyFingerprint;
        try { keyFingerprint = hash(data.credential_id != null ? JSON.parse(decrypt(key.fields_enc)).api_key : decrypt(key.key_enc)); }
        catch { return fail('credential could not be decrypted'); }
        if (data.label != null && (typeof data.label !== 'string' || data.label.length > 200)) return fail('label must be at most 200 characters');
        let upstream;
        try { upstream = upstreamUrl(data.upstream ?? defaultUpstream(data.provider)); } catch { return fail('valid upstream required (http/https origin and optional path prefix)'); }
        try {
          const result = db.prepare('INSERT INTO proxy_clients(token_hash,provider,key_id,credential_id,key_fingerprint,label,upstream) VALUES(?,?,?,?,?,?,?)').run(hash(data.token), data.provider, data.key_id ?? null, data.credential_id ?? null, keyFingerprint, data.label || '', upstream);
          json(res, 201, publicClients().find(c => c.id === Number(result.lastInsertRowid)));
        } catch (e) { if (e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message)) return fail('token is already registered'); throw e; }
        return true;
      }
      const client = /^\/api\/proxy\/clients\/(\d+)$/.exec(p);
      if (client && req.method === 'DELETE') {
        const result = db.prepare('DELETE FROM proxy_clients WHERE id=?').run(Number(client[1]));
        json(res, result.changes ? 200 : 404, result.changes ? { ok: true } : { error: 'unknown proxy client' }); return true;
      }
      if (p === '/api/proxy/traffic' && req.method === 'GET') {
        json(res, 200, traffic.list(Math.max(1, safeInt(url.searchParams.get('limit'), 100, 1000)), safeInt(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER))); return true;
      }
      const log = /^\/api\/proxy\/traffic\/(\d+)(\/events)?$/.exec(p);
      if (log && req.method === 'GET') {
        const id = Number(log[1]), metadata = traffic.get(id);
        if (!metadata) { json(res, 404, { error: 'unknown traffic record' }); return true; }
        if (log[2]) { await traffic.download(id, res); return true; }
        const after = url.searchParams.has('after') ? safeInt(url.searchParams.get('after'), -1, Number.MAX_SAFE_INTEGER) : -1;
        json(res, 200, { ...metadata, ...await traffic.page(id, after, Math.max(1, safeInt(url.searchParams.get('limit'), 100, 1000))) }); return true;
      }
      return false;
    },
  };
}
