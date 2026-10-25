#!/usr/bin/env node
// Proxy-only client. Upstream UniFi credentials remain on Aigate.
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

const HELP = `Usage: aigate-unifi.mjs [--method METHOD] [--data-stdin] [--content-type TYPE] [TARGET]

Requires explicit AIGATE_URL (HTTP(S) origin) and AIGATE_PROXY_TOKEN.
The administrator AIGATE_TOKEN is never used as a fallback.
Default: GET /proxy/network/api/s/default/rest/user
TARGET must be an origin-form path, optionally with a query string.
It is forwarded through /proxy/unifi with its original encoding intact.

Options:
  --method METHOD      GET, HEAD, POST, PUT, PATCH, DELETE, or OPTIONS
  --data-stdin         Stream request bytes from stdin; requires --method
  --content-type TYPE  Content-Type for a request with --data-stdin
  --help, -h           Show this help without contacting Aigate

Only the proxy bearer and optional Content-Type header are sent.
No credential files are read, upstream keys fetched, or redirects followed.
HTTP failures print status only; response error bodies are suppressed.
`;

class ClientError extends Error {}
function fail(message) { throw new ClientError(message); }

function options(args) {
  const result = { method: 'GET', target: '/proxy/network/api/s/default/rest/user', data: false };
  let methodSet = false;
  let targetSet = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--method' || arg === '--content-type') {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('An option value is missing. Use --help for usage.');
      if (arg === '--method') { result.method = value; methodSet = true; }
      else result.contentType = value;
    } else if (arg === '--data-stdin') result.data = true;
    else if (arg.startsWith('-')) fail('Unsupported option. Use --help for usage.');
    else {
      if (targetSet) fail('Supply only one target path.');
      result.target = arg;
      targetSet = true;
    }
  }
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(result.method)) fail('Unsupported HTTP method.');
  if (result.data && (!methodSet || /^(GET|HEAD)$/.test(result.method))) {
    fail('--data-stdin requires an explicit body-capable --method.');
  }
  if (result.contentType && (!result.data || !/^[\x20-\x7e]{1,256}$/.test(result.contentType))) {
    fail('--content-type requires --data-stdin and a valid header value.');
  }
  // Validate raw bytes, without URL parsing that would normalize dot segments,
  // percent encodings, slashes, or query strings.
  if (!result.target.startsWith('/') || result.target.startsWith('//') ||
      !/^[\x21-\x7e]+$/.test(result.target) || /[#\\]/.test(result.target) ||
      /%(?![\da-fA-F]{2})/.test(result.target)) fail('Invalid target: use an origin-form path without fragments.');
  return result;
}

function config() {
  const rawUrl = process.env.AIGATE_URL;
  const token = process.env.AIGATE_PROXY_TOKEN;
  if (!rawUrl) fail('Missing AIGATE_URL. Set the Aigate HTTP(S) origin explicitly.');
  if (!token) fail('Missing AIGATE_PROXY_TOKEN. Supply a stable proxy-only key.');
  if (!/^[^\s,]{8,512}$/.test(token) || /[^\x21-\x7e]/.test(token)) fail('Invalid AIGATE_PROXY_TOKEN.');
  let base;
  try { base = new URL(rawUrl); } catch { fail('Invalid AIGATE_URL: expected an HTTP(S) origin.'); }
  if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash ||
      base.pathname !== '/' || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(rawUrl)) {
    fail('Invalid AIGATE_URL: expected an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  return { base, token };
}

async function request({ base, token }, opts) {
  await new Promise((resolve, reject) => {
    let response;
    let settled = false;
    const onInputError = () => finish(new ClientError('Could not read request body from stdin.'));
    function finish(error) {
      if (settled) return;
      settled = true;
      if (opts.data) {
        process.stdin.unpipe(req);
        process.stdin.removeListener('error', onInputError);
        process.stdin.destroy();
      }
      req.setTimeout(0);
      response?.destroy();
      req.destroy();
      if (error) reject(error);
      else resolve();
    }
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    const transport = base.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port,
      method: opts.method, path: `/proxy/unifi${opts.target}`, headers,
    }, (res) => {
      response = res;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        // Never display server-controlled status text, headers, or error bodies:
        // even a malicious error response cannot echo a credential into logs.
        finish(new ClientError(`Aigate request failed with HTTP ${res.statusCode}. Response body suppressed.`));
        return;
      }
      pipeline(res, process.stdout, { end: false }).then(() => finish(), () => finish(new ClientError('Response stream failed.')));
    });
    req.setTimeout(30_000, () => finish(new ClientError('Aigate request timed out.')));
    req.on('error', (error) => finish(error instanceof ClientError ? error : new ClientError('Cannot reach Aigate or verify its TLS connection.')));
    if (opts.data) {
      process.stdin.on('error', onInputError);
      process.stdin.pipe(req);
    } else req.end();
  });
}

try {
  if (process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) process.stdout.write(HELP);
  else await request(config(), options(process.argv.slice(2)));
} catch (error) {
  // Unexpected transport/library errors may contain request data; keep them private.
  process.stderr.write(`aigate-unifi: ${error instanceof ClientError ? error.message : 'Request failed.'}\n`);
  process.exitCode = 1;
}
