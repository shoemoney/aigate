import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseClaudeQuotaHeaders } from './claude-pool.js';

const pairs = raw => Array.from({ length: raw.length / 2 }, (_, i) => [raw[i * 2], raw[i * 2 + 1]]);
const number = (value, fallback, max) => /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
const waitDrain = stream => new Promise((resolve, reject) => {
  const clean = () => { stream.off('drain', ok); stream.off('error', fail); stream.off('close', close); };
  const ok = () => { clean(); resolve(); }, fail = error => { clean(); reject(error); }, close = () => fail(new Error('stream closed'));
  stream.once('drain', ok); stream.once('error', fail); stream.once('close', close);
  if (stream.destroyed) close();
});

// A bounded JSON lexer can locate a top-level model without waiting for the
// entire upload. Nested model keys and quoted JSON inside a message never match.
function prefixModel(buffer) {
  const text = buffer.toString('utf8'); let depth = 0, key = null, expectingKey = false, expectingValue = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i; let closed = false;
      while (++i < text.length) { if (text[i] === '\\') { i++; continue; } if (text[i] === '"') { closed = true; break; } }
      if (!closed) return null;
      if (depth === 1) {
        let value; try { value = JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        if (expectingKey) { key = value; expectingKey = false; }
        else if (expectingValue) { if (key === 'model' && value.length <= 256) return value; expectingValue = false; }
      }
    } else if (char === '{' || char === '[') { depth++; if (depth === 1) expectingKey = true; }
    else if (char === '}' || char === ']') depth--;
    else if (depth === 1 && char === ':') expectingValue = true;
    else if (depth === 1 && char === ',') { expectingKey = true; expectingValue = false; key = null; }
  }
  return null;
}
function resourceBound(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(resourceBound);
  // Context edit policies (for example native Claude Code's clear_thinking)
  // are stateless instructions. Only actual account-bound resource references
  // constrain failover; recursively inspect context objects for those references.
  return Object.entries(value).some(([key, item]) => ['file_id', 'container', 'container_id', 'mcp_servers', 'workspace_id', 'organization_id'].includes(key) && item != null || resourceBound(item));
}

export function classifyClaudeExhaustion(status, rawHeaders) {
  if (status !== 429) return null;
  const quota = parseClaudeQuotaHeaders(rawHeaders);
  for (const window of ['seven_day', 'five_hour']) if (quota[window].remaining_pct === 0)
    return { window, resetAt: quota[window].reset_ms, reason: 'quota_exhausted' };
  // The representative claim names the actual rejecting window. Require the
  // provider's explicit rejected status; a generic throttling 429 is insufficient.
  const fields = new Map();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i].toLowerCase(); fields.set(key, fields.has(key) ? null : rawHeaders[i + 1]);
  }
  if (fields.get('anthropic-ratelimit-unified-status') !== 'rejected') return null;
  const claim = fields.get('anthropic-ratelimit-unified-representative-claim');
  const rawReset = Number(fields.get('anthropic-ratelimit-unified-reset'));
  const reset = Number.isFinite(rawReset) ? (rawReset < 1e12 ? rawReset * 1000 : rawReset) : null;
  if (claim === 'five_hour' || claim === 'seven_day') {
    const resetAt = quota[claim].reset_ms || reset;
    return resetAt > Date.now() ? { window: claim, resetAt, reason: 'quota_exhausted' } : null;
  }
  if ((claim === 'seven_day_opus' || claim === 'seven_day_sonnet') && reset > Date.now()) return {
    window: 'model', modelFamily: claim.slice('seven_day_'.length),
    resetAt: reset, reason: 'model_quota_exhausted',
  };
  return null;
}

function usageObserver(headers) {
  const encoded = headers['content-encoding'] && headers['content-encoding'] !== 'identity';
  const sse = /^text\/event-stream(?:;|$)/i.test(headers['content-type'] || '');
  const json = /^application\/json(?:;|$)/i.test(headers['content-type'] || '');
  const decoder = new StringDecoder('utf8');
  let disabled = !!encoded || !sse && !json, text = '', block = '', value = null, stopped = false, size = 0;
  const event = line => {
    if (!line) {
      if (!block) return;
      let data; try { data = JSON.parse(block); } catch { disabled = true; return; }
      block = '';
      if (data.type === 'message_start' && !value) value = { ...data.message, usage: { ...data.message?.usage } };
      else if (data.type === 'message_delta' && value && data.usage && !stopped) value.usage = { ...value.usage, ...data.usage };
      else if (data.type === 'message_stop' && value) stopped = true;
      else if (data.type === 'error') disabled = true;
      return;
    }
    if (line.startsWith('data:')) block += (block ? '\n' : '') + line.slice(5).trimStart();
    if (block.length > 262144) disabled = true;
  };
  return {
    write(chunk) {
      if (disabled) return;
      if (json) { size += chunk.length; if (size > 1048576) { disabled = true; text = ''; return; } text += decoder.write(chunk); return; }
      text += decoder.write(chunk);
      let newline; while (!disabled && (newline = text.indexOf('\n')) >= 0) { const line = text.slice(0, newline).replace(/\r$/, ''); text = text.slice(newline + 1); event(line); }
      if (text.length > 262144) { disabled = true; text = ''; }
    },
    finish() {
      if (disabled) return null;
      text += decoder.end();
      if (json) { try { value = JSON.parse(text); stopped = value.type === 'message' && value.stop_reason != null; } catch { return null; } }
      else { if (text) event(text.replace(/\r$/, '')); event(''); }
      return stopped && value?.id && value?.model ? value : null;
    },
  };
}

export function createClaudeRelay({ pool, traffic, replayStore, relayHeaders, informational, reqIp, recordUsage, sessionCookie = 'aigate_sess' }) {
  return async function relay(req, res, binding) {
    res.sendDate = false;
    const timeoutMs = number(process.env.AIGATE_TRANSPARENT_TIMEOUT_MS, 300000, 3600000);
    const maxAttempts = number(process.env.AIGATE_CLAUDE_MAX_ATTEMPTS, 8, 32);
    let capture, spool, lease, outgoing, incoming, status = null, terminal = false, faulting = false, finishing;
    let cancelled = req.aborted || res.destroyed, uploadDone = false, responseDone = false, visible = false;
    let uploadResolve, responseResolve;
    const uploadComplete = new Promise(resolve => { uploadResolve = resolve; });
    const responseComplete = new Promise(resolve => { responseResolve = resolve; });
    const attempted = new Set(); let attemptCount = 0, activeId, requestModel = null, metadata = null;
    let metadataBytes = 0, metadataChunks = [], metadataOversized = false, uploadResponseSeen = false, admissionRejected = false;
    const target = binding.relay_target;
    const generation = req.method === 'POST' && /^\/v1\/messages(?:\?|$)/.test(target)
      && /^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') && !req.headers['content-encoding'];
    const destination = new URL(binding.upstream), path = destination.pathname.replace(/\/$/, '') + target;
    const finish = (state, extra = {}) => {
      if (finishing) return finishing;
      terminal = true;
      finishing = (async () => { if (capture) await capture.finish(state, status, extra); })()
        .catch(() => { if (!res.destroyed) res.destroy(); })
        .finally(() => { pool.release(lease); responseResolve(); });
      return finishing;
    };
    const stop = () => { outgoing?.destroy(); incoming?.destroy(); };
    const clientAbort = () => { cancelled = true; stop(); uploadResolve(); if (capture) void finish('client_abort'); };
    req.on('aborted', clientAbort); res.on('close', () => { if (!res.writableFinished) clientAbort(); });
    const unavailable = () => terminal || faulting || cancelled || req.aborted || res.destroyed;
    const fault = async (code, reason, error, beforeError) => {
      if (terminal || faulting) return finishing;
      faulting = true; stop(); uploadResolve();
      try {
        if (beforeError) await beforeError();
        if (cancelled || req.aborted || res.destroyed) return await finish('client_abort');
        await capture?.append('error', { reason, code: error?.code || null, attempt_id: activeId });
        if (!res.headersSent && !cancelled && !res.destroyed) {
          status = code;
          const bytes = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error', message: reason } }));
          await capture?.append('response', { status, generated: true, headers: ['content-type', 'application/json', 'connection', 'close'] });
          await capture?.chunk('response', bytes);
          if (!cancelled && !res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(bytes); }
        } else if (!res.destroyed) res.destroy();
        await finish('error', { reason });
      } catch { res.destroy(); await finish(cancelled ? 'client_abort' : 'logging_error'); }
    };
    const deadline = setTimeout(() => { void fault(504, 'Claude proxy deadline exceeded'); }, timeoutMs); deadline.unref?.();
    const failLog = error => fault(503, 'traffic capture or replay unavailable', error);
    const endIfReady = async () => { if (uploadDone && responseDone && !unavailable()) await finish('complete', { attempts: attemptCount }); };
    const snapshotOptions = model => {
      const excluded = new Set(attempted);
      // Without a known model, never spend an account with a live family block.
      if (!model) for (const row of pool.status().accounts) if (row.cooldowns?.length) excluded.add(row.account);
      return { model, excludeAccounts: excluded };
    };
    const attemptBody = async (attemptId, direction, chunk) => {
      for (let i = 0; i < chunk.length; i += 65536) await capture.append(direction + '_body', {
        attempt_id: attemptId, encoding: 'base64', data: chunk.subarray(i, i + 65536).toString('base64'),
      });
    };
    const startAttempt = async (model, replay = false, affinity) => {
      if (unavailable()) return false;
      lease = pool.acquire({ ...snapshotOptions(model), ...(affinity ? { affinity } : {}) });
      if (!lease) return false;
      attempted.add(lease.account); attempted.add(lease.scopeId);
      activeId = randomUUID(); const attemptId = activeId, selected = lease; attemptCount++;
      const headers = relayHeaders(req.rawHeaders, { upstream: destination, authHeader: 'authorization', key: selected.token, sessionCookie });
      if (req.headers['transfer-encoding'] && !headers.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length')) headers.push('Transfer-Encoding', 'chunked');
      await capture.append('attempt_start', { attempt_id: attemptId, number: attemptCount, account: selected.account,
        quota_scope: selected.scopeId, quota: selected.snapshot, model: model || null, replay });
      await capture.append('forward', { attempt_id: attemptId, method: req.method, target: path, upstream: destination.origin, headers });
      if (unavailable()) return false;
      const startedAt = Date.now(); let attemptIncoming;
      const request = (destination.protocol === 'https:' ? https : http).request(destination, { method: req.method, path, headers, setHost: false, agent: false });
      outgoing = request;
      request.on('error', error => { if (!terminal && !faulting && activeId === attemptId && !attemptIncoming) void fault(502, 'upstream connection failed', error); });
      request.on('upgrade', (response, socket, head) => {
        attemptIncoming = response; socket.on('error', () => {}); socket.destroy();
        const writes = [capture.append('upstream_upgrade', { attempt_id: attemptId, status: response.statusCode, headers: response.rawHeaders, head_bytes: head.length })];
        for (let i = 0; i < head.length; i += 65536) writes.push(capture.append('upstream_upgrade_body', {
          attempt_id: attemptId, encoding: 'base64', data: head.subarray(i, i + 65536).toString('base64'),
        }));
        const observed = Promise.all(writes); void observed.catch(failLog);
        void fault(501, 'upgraded protocols are not supported', null, () => observed);
      });
      request.on('information', info => {
        // Admit visibility synchronously: a final response may arrive while the
        // informational capture fsync is still pending.
        if (info.statusCode !== 100) visible = true;
        void (async () => {
          await capture.append('information', { attempt_id: attemptId, status: info.statusCode, status_message: info.statusMessage, headers: info.rawHeaders });
          if (!unavailable() && info.statusCode !== 100) informational(res, info, sessionCookie);
        })().catch(failLog);
      });
      request.on('response', response => {
        incoming = response; attemptIncoming = response; if (!replay) uploadResponseSeen = true;
        if (unavailable()) { response.destroy(); return; }
        void (async () => {
          let refusal = classifyClaudeExhaustion(response.statusCode, response.rawHeaders);
          if (refusal?.modelFamily && !new RegExp('(?:^|[-/])' + refusal.modelFamily + '(?:[-/]|$)', 'i').test(model || requestModel || '')) refusal = null;
          const withholding = !!refusal && generation && !visible;
          await capture.append('attempt_response', { attempt_id: attemptId, status: response.statusCode,
            status_message: response.statusMessage, headers: response.rawHeaders, http_version: response.httpVersion, withheld: withholding });
          if (unavailable()) return response.destroy();
          await pool.observeHeaders(selected.account, response.rawHeaders, { status: response.statusCode, fingerprint: selected.fingerprint,
            revision: selected.revision, startedAt: selected.startedAt ?? startedAt, tokenEnvelope: selected.tokenEnvelope,
            generation: selected.generation, model: model || requestModel, capture_id: capture.id });
          const held = withholding ? await replayStore.start() : null;
          const usage = usageObserver(response.headers);
          let authErrorBytes = 0, authErrorChunks = [];
          const forwardHeaders = async () => {
            if (unavailable()) return false;
            status = response.statusCode;
            const headers = relayHeaders(response.rawHeaders, { sessionCookie });
            await capture.append('response', { attempt_id: attemptId, status, status_message: response.statusMessage,
              headers: response.rawHeaders, forwarded_headers: headers, http_version: response.httpVersion });
            if (unavailable()) return false;
            visible = true; res.writeHead(status, response.statusMessage, headers); res.flushHeaders(); return true;
          };
          try {
            if (!withholding && !await forwardHeaders()) return;
            for await (const chunk of response) {
              await attemptBody(attemptId, 'attempt_response', chunk);
              if (unavailable()) return response.destroy();
              if (response.statusCode === 403 && !response.headers['content-encoding']) {
                authErrorBytes += chunk.length;
                if (authErrorBytes <= 65536) authErrorChunks.push(chunk); else authErrorChunks = [];
              }
              if (held) await held.append(chunk);
              else {
                await capture.chunk('response', chunk); usage.write(chunk);
                if (unavailable()) return response.destroy();
                if (!res.write(chunk)) await waitDrain(res);
              }
            }
            await capture.append('attempt_response_end', { attempt_id: attemptId, trailers: response.rawTrailers });
            if (response.statusCode === 403 && authErrorBytes > 0 && authErrorBytes <= 65536) {
              let errorType; try { errorType = JSON.parse(Buffer.concat(authErrorChunks).toString('utf8')).error?.type; } catch {}
              if (errorType === 'authentication_error') await pool.observeHeaders(selected.account, [], {
                status: 403, errorType, fingerprint: selected.fingerprint, revision: selected.revision,
                startedAt: selected.startedAt ?? startedAt, tokenEnvelope: selected.tokenEnvelope, generation: selected.generation,
                capture_id: capture.id,
              });
            }
            if (held) {
              request.destroy();
              await held.seal(response.rawTrailers);
              await pool.markExhausted(selected.account, { ...refusal, model: model || requestModel,
                fingerprint: selected.fingerprint, tokenEnvelope: selected.tokenEnvelope, generation: selected.generation });
              await capture.append('attempt_outcome', { attempt_id: attemptId, outcome: 'quota_refused', cooldown: refusal,
                account: selected.account, quota: pool.status({ model: model || requestModel }).accounts.find(row => row.account === selected.account) });
              await uploadComplete;
              if (unavailable()) return;
              const safe = uploadDone && metadata && typeof metadata.model === 'string' && metadata.model.length <= 256 && attemptCount < maxAttempts;
              const affinity = resourceBound(metadata) || req.headers['anthropic-organization-id'] || req.headers['x-anthropic-organization-id'] ? selected.scopeId : undefined;
              pool.release(selected);
              if (safe) {
                // Validate every encrypted record before a billable second
                // request can be admitted; replay itself authenticates again.
                for await (const _ of spool.read()) { if (unavailable()) return; }
                await capture.append('attempt_decision', { attempt_id: attemptId, decision: 'try_eligible_account', model: metadata.model, affinity: affinity || null });
                if (await startAttempt(metadata.model, true, affinity)) return;
              }
              await capture.append('attempt_decision', { attempt_id: attemptId, decision: 'return_quota_response', reason: safe ? 'no_compatible_eligible_account' : 'request_not_safely_replayable_or_attempt_limit' });
              if (!await forwardHeaders()) return;
              for await (const { chunk } of held.read()) if (chunk) {
                await capture.chunk('response', chunk); if (unavailable()) return;
                if (!res.write(chunk)) await waitDrain(res);
              }
            } else {
              const measured = response.statusCode >= 200 && response.statusCode < 300 ? usage.finish() : null;
              if (measured && recordUsage) {
                const result = recordUsage({ message_id: measured.id, model: measured.model, ts: new Date().toISOString(), usage: measured.usage, account: selected.account, complete: true });
                await capture.append('usage', { attempt_id: attemptId, message_id: measured.id, model: measured.model, result });
              }
              await capture.append('attempt_outcome', { attempt_id: attemptId, outcome: 'forwarded', status: response.statusCode });
            }
            await capture.append('response_end', { attempt_id: attemptId, trailers: response.rawTrailers });
            if (unavailable()) return;
            const trailers = relayHeaders(response.rawTrailers, { sessionCookie }); if (trailers.length) res.addTrailers(pairs(trailers));
            res.end(); responseDone = true; responseResolve(); pool.release(selected); await endIfReady();
          } finally { await held?.dispose(); }
        })().catch(error => { if (!terminal && !faulting) void fault(502, 'upstream stream or traffic capture failed', error); });
      });
      if (replay) {
        for await (const record of spool.read()) {
          if (unavailable()) return false;
          if (record.chunk) {
            await attemptBody(attemptId, 'attempt_request', record.chunk);
            if (unavailable()) return false;
            if (!request.destroyed && !request.writableEnded && !request.write(record.chunk)) await waitDrain(request);
          } else if (!request.destroyed) {
            const trailers = relayHeaders(record.trailers, { sessionCookie, requestCookies: true });
            await capture.append('attempt_request_end', { attempt_id: attemptId, trailers });
            if (trailers.length) request.addTrailers(pairs(trailers)); request.end();
          }
        }
      }
      return true;
    };
    try {
      capture = await traffic.start({ provider: 'claude-code', method: req.method, target: req.url, http_version: req.httpVersion, headers: req.rawHeaders, peer: reqIp(req) });
      if (unavailable()) { await finish('client_abort'); return; }
      if (!target?.startsWith('/') || target.startsWith('//')) { await fault(400, 'origin-form request target required'); return; }
      if (req.method === 'CONNECT' || req.headers.upgrade) { await fault(501, 'CONNECT and upgraded protocols are not supported'); return; }
      spool = await replayStore.start();
      if (req.aigateExpectContinue) { await capture.append('information', { status: 100, headers: [], generated: true }); if (!unavailable()) res.writeContinue(); }
      for await (const chunk of req) {
        if (unavailable()) break;
        await capture.chunk('request', chunk); await spool.append(chunk);
        if (metadataBytes + chunk.length <= 1048576 && !metadataOversized) { metadataChunks.push(chunk); metadataBytes += chunk.length; }
        else { metadataOversized = true; metadataChunks = []; }
        if (!outgoing && !admissionRejected) {
          requestModel = prefixModel(chunk.subarray(0, 65536));
          if (!await startAttempt(requestModel)) {
            admissionRejected = true;
          }
        }
        if (admissionRejected) continue;
        if (unavailable()) break;
        if (!uploadResponseSeen && !outgoing.destroyed && !outgoing.writableEnded) {
          await attemptBody(activeId, 'attempt_request', chunk);
          if (unavailable()) break;
          if (!uploadResponseSeen && !outgoing.destroyed && !outgoing.writableEnded && !outgoing.write(chunk)) {
            try { await waitDrain(outgoing); } catch (error) { if (!uploadResponseSeen) throw error; }
          }
        }
      }
      if (!unavailable()) {
        if (!req.complete) throw new Error('incomplete client upload');
        await capture.append('request_end', { trailers: req.rawTrailers }); await spool.seal(req.rawTrailers);
        if (!metadataOversized) { try { metadata = JSON.parse(Buffer.concat(metadataChunks).toString('utf8')); if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) metadata = null; } catch { metadata = null; } }
        metadataChunks = []; requestModel = metadata?.model || requestModel;
        uploadDone = true;
        if (admissionRejected || !outgoing && !await startAttempt(requestModel)) await fault(503, 'no eligible Claude Code account with known positive five-hour and weekly allowance');
        if (!unavailable() && !outgoing.destroyed) {
          const trailers = relayHeaders(req.rawTrailers, { sessionCookie, requestCookies: true }); if (trailers.length) outgoing.addTrailers(pairs(trailers)); outgoing.end();
          await capture.append('attempt_request_end', { attempt_id: activeId, trailers });
        }
        uploadResolve(); await endIfReady();
      } else uploadResolve();
      await responseComplete;
      if (finishing) await finishing;
    } catch (error) { await failLog(error); }
    finally {
      clearTimeout(deadline); uploadResolve(); pool.release(lease);
      await spool?.dispose().catch(() => { res.destroy(); });
      req.off('aborted', clientAbort);
    }
  };
}
