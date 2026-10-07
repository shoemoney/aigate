/**
 * aigate/spend-pricing — pure price arithmetic for the spend collector.
 * No DB, no network. Rates are integer micro-dollars per MILLION tokens
 * ($4.00/MTok = 4_000_000); cost is computed with BigInt and rounded half-up
 * to one micro-dollar, once per event.
 */
import { readFileSync } from 'node:fs';

const SEED_FILE = new URL('./spend-prices.json', import.meta.url);

// ---- micro-dollar conversion ---------------------------------------------

// '4.00' | 4 | 0.125 -> 4000000 | 4000000 | 125000. Decimal-string exact; anything
// finer than a micro-dollar is rounded half-up.
export function toMicros(value) {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new TypeError(`toMicros: not a non-negative decimal: ${JSON.stringify(value)}`);
  const frac = (m[2] || '').padEnd(7, '0');
  let micros = BigInt(m[1]) * 1_000_000n + BigInt(frac.slice(0, 6));
  if (frac[6] >= '5') micros += 1n;
  return Number(micros);
}

// 4000000 -> '4.00', 125000 -> '0.125' (at least two decimals, trailing zeros trimmed beyond that).
export function fromMicros(micros) {
  const n = BigInt(micros);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

// ---- seed ----------------------------------------------------------------

const microsOrNull = (v) => (v == null ? null : toMicros(v));

// Rows shaped like the spend_prices table. Source of truth is spend-prices.json
// (sourced, dated); `source` text becomes the row note. match 'prefix' rows
// apply to any model that startsWith row.model; provider '*' matches any provider.
export function seedPrices() {
  const file = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
  return file.map((r) => ({
    provider: r.provider,
    model: r.model,
    match: r.match === 'prefix' ? 'prefix' : 'exact',
    effective_from: r.effective_from,
    input_micros: toMicros(r.input_per_mtok),
    output_micros: toMicros(r.output_per_mtok),
    cache_read_micros: microsOrNull(r.cache_read_per_mtok),
    cache_write_micros: microsOrNull(r.cache_write_5m_per_mtok),
    cache_write_1h_micros: microsOrNull(r.cache_write_1h_per_mtok),
    tiers_json: JSON.stringify((r.tiers || []).map((t) => ({
      min_input_tokens: t.min_input_tokens,
      input_micros: microsOrNull(t.input_per_mtok),
      output_micros: microsOrNull(t.output_per_mtok),
      cache_read_micros: microsOrNull(t.cache_read_per_mtok),
      cache_write_micros: microsOrNull(t.cache_write_5m_per_mtok),
      cache_write_1h_micros: microsOrNull(t.cache_write_1h_per_mtok),
    }))),
    note: r.source || '',
  }));
}

// ---- rate lookup ---------------------------------------------------------

// Candidate model names, most specific first: as reported, trailing -YYYYMMDD
// stripped, leading <vendor>/ stripped (and both).
function modelCandidates(model) {
  const out = [];
  const add = (m) => { if (m && !out.includes(m)) out.push(m); };
  const noDate = (m) => m.replace(/-\d{8}$/, '');
  const noVendor = (m) => (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m);
  add(model);
  add(noDate(model));
  add(noVendor(model));
  add(noDate(noVendor(model)));
  return out;
}

// Newest row (effective_from <= ts) for the model. Exact-provider rows beat '*'
// rows; for one name an exact match beats a prefix match (longest prefix wins).
// An unparseable ts ignores the date filter. Returns null when nothing fits.
export function pickRate(rows, provider, model, ts) {
  if (!Array.isArray(rows) || !model) return null;
  const at = ts == null ? NaN : Date.parse(ts);
  const dated = (r) => Number.isNaN(at) || Date.parse(r.effective_from) <= at;
  for (const name of modelCandidates(String(model))) {
    for (const prov of [provider, '*']) {
      const hits = rows.filter((r) => r.provider === prov && dated(r)
        && (r.match === 'prefix' ? name.startsWith(r.model) : r.model === name));
      if (!hits.length) continue;
      hits.sort((a, b) => {
        const exactA = a.match === 'prefix' ? 0 : 1;
        const exactB = b.match === 'prefix' ? 0 : 1;
        if (exactA !== exactB) return exactB - exactA;
        if (a.match === 'prefix' && a.model.length !== b.model.length) return b.model.length - a.model.length;
        return Date.parse(b.effective_from) - Date.parse(a.effective_from);
      });
      return hits[0];
    }
  }
  return null;
}

// ---- cost ----------------------------------------------------------------

const big = (n) => BigInt(Math.max(0, Math.trunc(Number(n) || 0)));
const half = (num) => (num + 500_000n) / 1_000_000n;

function parseTiers(t) {
  if (Array.isArray(t)) return t;
  try { const v = JSON.parse(t || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// event: { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
//          cache_write_1h_tokens, cache_tokens_in_prompt }. rateRow: a spend_prices row.
// Returns { cost_micros, lines:[{meter,tokens,rate_micros,cost_micros}], tier, warnings }.
// cost_micros is the exact sum rounded once; per-line costs are rounded for display.
export function priceEvent(event, rateRow) {
  const warnings = [];
  const output = big(event.output_tokens);
  const inTok = big(event.input_tokens);
  let cr = big(event.cache_read_tokens);
  let cw = big(event.cache_write_tokens);
  let cw1h = big(event.cache_write_1h_tokens);
  if (cw1h > cw) cw1h = cw;

  let totalInput;
  let fresh;
  if (!event.cache_tokens_in_prompt) {
    totalInput = inTok + cr + cw;
    fresh = inTok;
  } else {
    totalInput = inTok;
    if (cr + cw > inTok) {
      warnings.push('cache tokens exceed input; billed all as fresh input');
      cr = 0n; cw = 0n; cw1h = 0n;
    }
    fresh = inTok - cr - cw;
  }
  let cw5 = cw - cw1h;

  const rates = {
    input: rateRow.input_micros,
    output: rateRow.output_micros,
    cache_read: rateRow.cache_read_micros,
    cache_write: rateRow.cache_write_micros,
    cache_write_1h: rateRow.cache_write_1h_micros,
  };
  let tier = null;
  for (const t of parseTiers(rateRow.tiers_json)) {
    if (totalInput >= BigInt(t.min_input_tokens) && (!tier || t.min_input_tokens > tier.min_input_tokens)) tier = t;
  }
  if (tier) {
    for (const [k, f] of [['input', 'input_micros'], ['output', 'output_micros'], ['cache_read', 'cache_read_micros'],
      ['cache_write', 'cache_write_micros'], ['cache_write_1h', 'cache_write_1h_micros']]) {
      if (tier[f] != null) rates[k] = tier[f];
    }
  }
  const rate1h = rates.cache_write_1h ?? rates.cache_write;

  // A meter with no rate is never a discount: its tokens bill as fresh input.
  if (rates.cache_read == null) { fresh += cr; cr = 0n; }
  if (rates.cache_write == null) { fresh += cw5; cw5 = 0n; }
  if (rate1h == null) { fresh += cw1h; cw1h = 0n; }

  const meters = [
    ['input', fresh, rates.input],
    ['output', output, rates.output],
    ['cache_read', cr, rates.cache_read],
    ['cache_write_5m', cw5, rates.cache_write],
    ['cache_write_1h', cw1h, rate1h],
  ];
  let numerator = 0n;
  const lines = [];
  for (const [meter, tokens, rate] of meters) {
    const r = rate == null ? 0n : BigInt(rate);
    const num = tokens * r;
    numerator += num;
    lines.push({ meter, tokens: Number(tokens), rate_micros: rate ?? null, cost_micros: Number(half(num)) });
  }
  return { cost_micros: Number(half(numerator)), lines, tier: tier ? tier.min_input_tokens : null, warnings };
}

// ---- billing class (DESIGN 4.4) -----------------------------------------

// subscription = anthropic/openai traffic from a known aigate account (API-equivalent value);
// unknown = anthropic/openai with no account; api = every other provider (real key spend).
export function billingClass(provider, account) {
  if (provider === 'anthropic' || provider === 'openai') {
    return account == null || account === '' ? 'unknown' : 'subscription';
  }
  return 'api';
}
