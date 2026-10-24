const epoch = value => {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const number = Number(value); return Number.isFinite(number) && number >= 0 ? (number < 1e12 ? number * 1000 : number) : null;
  }
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
};

function headerMap(raw) {
  const values = new Map();
  const add = (name, value) => { name = name.toLowerCase(); values.set(name, values.has(name) ? null : value); };
  if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) add(String(raw[i]), raw[i + 1]);
  else if (raw?.entries) for (const [name, value] of raw.entries()) add(name, value);
  else if (raw && typeof raw === 'object') for (const [name, value] of Object.entries(raw)) add(name, Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value);
  return values;
}

export function parseClaudeQuotaHeaders(raw) {
  const headers = headerMap(raw), result = {};
  for (const [window, short] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const value = headers.get(`anthropic-ratelimit-unified-${short}-utilization`);
    const text = value == null ? '' : String(value).trim();
    const number = text === '' ? NaN : Number(text);
    const used = Number.isFinite(number) && number >= 0 ? Math.min(number, 1) * 100 : null;
    result[window] = { used_pct: used, remaining_pct: used == null ? null : 100 - used,
      reset_ms: epoch(headers.get(`anthropic-ratelimit-unified-${short}-reset`)), present: value != null };
  }
  return result;
}

// Classification is shared by native probes and relayed requests. Passing model
// explicitly also requires a known matching family before accepting family quota.
export function classifyClaudeExhaustion(status, rawHeaders, options = {}) {
  if (status !== 429) return null;
  const quota = parseClaudeQuotaHeaders(rawHeaders);
  for (const window of ['seven_day', 'five_hour']) if (quota[window].remaining_pct === 0)
    return { window, resetAt: quota[window].reset_ms, reason: 'quota_exhausted' };
  const fields = headerMap(rawHeaders);
  if (fields.get('anthropic-ratelimit-unified-status') !== 'rejected') return null;
  const claim = fields.get('anthropic-ratelimit-unified-representative-claim');
  const reset = epoch(fields.get('anthropic-ratelimit-unified-reset'));
  const now = options.now ?? Date.now();
  if (claim === 'five_hour' || claim === 'seven_day') {
    const resetAt = quota[claim].reset_ms ?? reset;
    return resetAt > now ? { window: claim, resetAt, reason: 'quota_exhausted' } : null;
  }
  if ((claim === 'seven_day_opus' || claim === 'seven_day_sonnet') && reset > now) {
    const modelFamily = claim.slice('seven_day_'.length);
    if (Object.hasOwn(options, 'model') && !new RegExp('(?:^|[-/])' + modelFamily + '(?:[-/]|$)', 'i').test(options.model || '')) return null;
    return { window: 'model', modelFamily, resetAt: reset, reason: 'model_quota_exhausted' };
  }
  return null;
}
