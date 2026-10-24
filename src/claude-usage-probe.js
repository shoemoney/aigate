import http from 'node:http';
import https from 'node:https';

const aborted = () => Object.assign(new Error('usage probe cancelled'), { code: 'ABORT_ERR', name: 'AbortError' });

// A setup-token is inference-only. This deliberately makes one small model request,
// rather than assuming that the credential can read profile or management APIs.
// Its entire HTTP exchange must be captured before any credential leaves the host.
export function createClaudeUsageProbe({ getTrafficStore, clock = Date.now,
  upstream = () => process.env.AIGATE_PROXY_UPSTREAM_ANTHROPIC || 'https://api.anthropic.com',
  model = () => process.env.AIGATE_CLAUDE_USAGE_MODEL || 'claude-haiku-4-5-20251001',
  timeoutMs = 15000 } = {}) {
  return async function probe({ account, token, signal }) {
    if (signal?.aborted) throw aborted();
    const store = getTrafficStore?.();
    if (!store?.start) throw Object.assign(new Error('usage probe capture unavailable'), { code: 'CAPTURE_UNAVAILABLE' });
    const destination = new URL(typeof upstream === 'function' ? upstream() : upstream);
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password || destination.search || destination.hash)
      throw Object.assign(new Error('invalid usage probe upstream'), { code: 'INVALID_UPSTREAM' });
    const target = destination.pathname.replace(/\/+$/, '') + '/v1/messages';
    const requestedModel = typeof model === 'function' ? model() : model;
    const body = Buffer.from(JSON.stringify({ model: requestedModel,
      max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }));
    const headers = ['Host', destination.host, 'Authorization', 'Bearer ' + token,
      'Anthropic-Version', '2023-06-01', 'Anthropic-Beta', 'oauth-2025-04-20',
      'User-Agent', 'aigate/0.1.0 (claude-code-usage-probe)', 'Content-Type', 'application/json',
      'Content-Length', String(body.length), 'Connection', 'close'];
    const capture = await store.start({ provider: 'anthropic', activity: 'claude_code_usage_probe',
      account, method: 'POST', target, upstream: destination.origin, headers, consumes_allowance: true });
    let outgoing, incoming, deadline, status = null;
    const onAbort = () => { outgoing?.destroy(aborted()); incoming?.destroy(aborted()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) throw aborted();
      await capture.chunk('request', body);
      if (signal?.aborted) throw aborted();
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true; outgoing?.destroy(); incoming?.destroy(); reject(error);
        };
        deadline = setTimeout(() => fail(Object.assign(new Error('usage probe timed out'), { code: 'PROBE_TIMEOUT' })), timeoutMs);
        deadline.unref?.();
        outgoing = (destination.protocol === 'https:' ? https : http).request(destination,
          { method: 'POST', path: target, headers, setHost: false, agent: false });
        outgoing.on('error', fail);
        outgoing.setTimeout(timeoutMs, () => fail(Object.assign(new Error('usage probe timed out'), { code: 'PROBE_TIMEOUT' })));
        outgoing.on('information', info => {
          void capture.append('information', { status: info.statusCode, headers: info.rawHeaders }).catch(fail);
        });
        outgoing.on('upgrade', (response, socket, head) => {
          socket.on('error', () => {}); socket.destroy();
          void (async () => {
            await capture.append('upstream_upgrade', { status: response.statusCode, headers: response.rawHeaders });
            if (head.length) await capture.chunk('upstream_upgrade', head);
            fail(Object.assign(new Error('usage probe protocol upgrade unsupported'), { code: 'UNSUPPORTED_UPGRADE' }));
          })().catch(fail);
        });
        outgoing.on('response', response => {
          if (settled) { response.destroy(); return; }
          incoming = response;
          void (async () => {
            status = response.statusCode;
            await capture.append('response', { status, status_message: response.statusMessage,
              headers: response.rawHeaders, http_version: response.httpVersion });
            const prefix = []; let prefixBytes = 0, oversized = false;
            for await (const chunk of response) {
              await capture.chunk('response', chunk);
              if (prefixBytes + chunk.length <= 65536) { prefix.push(chunk); prefixBytes += chunk.length; }
              else oversized = true;
            }
            await capture.append('response_end', { trailers: response.rawTrailers });
            let errorType = null, errorCode = null;
            if (!oversized && !response.headers['content-encoding']) {
              try {
                const error = JSON.parse(Buffer.concat(prefix).toString('utf8')).error;
                if (typeof error?.type === 'string' && /^[a-z0-9_]{1,80}$/.test(error.type)) errorType = error.type;
                if (typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)) errorCode = error.code;
              } catch { /* capture remains exact even when the response is not JSON */ }
            }
            if (!settled) { settled = true; resolve({ status, rawHeaders: response.rawHeaders,
              observedAt: clock(), model: requestedModel, errorType, errorCode, capture_id: capture.id, source: 'probe' }); }
          })().catch(fail);
        });
        if (signal?.aborted) { fail(aborted()); return; }
        outgoing.end(body);
      });
      await capture.finish('complete', status, { activity: 'claude_code_usage_probe' });
      return result;
    } catch (error) {
      outgoing?.destroy(); incoming?.destroy();
      try {
        await capture.append('error', { reason: signal?.aborted ? 'usage probe cancelled' : 'usage probe failed', code: error?.code || null });
        await capture.finish(signal?.aborted || error?.name === 'AbortError' ? 'client_abort' : 'error', status);
      } catch { try { await capture.finish('logging_error', status); } catch { /* fail closed */ } }
      throw error;
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); }
  };
}
