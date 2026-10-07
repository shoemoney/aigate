import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedPrices, pickRate, priceEvent, toMicros, fromMicros, billingClass } from '../src/spend-pricing.js';

const rows = seedPrices();
const rate = (provider, model, ts = '2026-10-05T00:00:00Z') => {
  const r = pickRate(rows, provider, model, ts);
  assert.ok(r, `no rate for ${provider}/${model}`);
  return r;
};
const anth = (o) => ({ cache_tokens_in_prompt: false, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cache_write_1h_tokens: 0, ...o });
const oai = (o) => anth({ cache_tokens_in_prompt: true, ...o });
const row = (o) => ({ provider: 'x', model: 'm', match: 'exact', effective_from: '2026-01-01', input_micros: 0, output_micros: 0,
  cache_read_micros: null, cache_write_micros: null, cache_write_1h_micros: null, tiers_json: '[]', ...o });

test('toMicros / fromMicros round-trip and reject junk', () => {
  assert.equal(toMicros('4.00'), 4_000_000);
  assert.equal(toMicros(0.125), 125_000);
  assert.equal(toMicros(0.0975), 97_500);
  assert.equal(toMicros('0.0000005'), 1);
  assert.equal(toMicros('0.0000004'), 0);
  assert.equal(toMicros(12), 12_000_000);
  assert.throws(() => toMicros('abc'));
  assert.throws(() => toMicros(-1));
  assert.throws(() => toMicros(NaN));
  assert.equal(fromMicros(4_000_000), '4.00');
  assert.equal(fromMicros(125_000), '0.125');
  assert.equal(fromMicros(1), '0.000001');
  assert.equal(fromMicros(0), '0.00');
});

test('anthropic convention: opus-5-5 with all cache writes on the 1h TTL', () => {
  // 2*4 + 304*20 + 20132*0.2 + 0*5 + 62010*8 = 8 + 6080 + 4026.4 + 0 + 496080 = 506194.4 micro-dollars
  const r = priceEvent(anth({ input_tokens: 2, output_tokens: 304, cache_read_tokens: 20132, cache_write_tokens: 62010, cache_write_1h_tokens: 62010 }),
    rate('anthropic', 'claude-opus-5-5', '2026-10-06T16:33:21.989Z'));
  assert.equal(r.cost_micros, 506194);
  assert.deepEqual(r.lines.map((l) => [l.meter, l.tokens]), [['input', 2], ['output', 304], ['cache_read', 20132], ['cache_write_5m', 0], ['cache_write_1h', 62010]]);
  assert.equal(r.lines[4].cost_micros, 496080);
});

test('anthropic convention: 5m and 1h writes split, 1h clamped to total writes', () => {
  // 1000 cw of which 400 are 1h: 600*5 + 400*8 = 6200 µ$ ; clamp: 1h=5000 > cw=1000 -> all 1h -> 1000*8
  const opus = rate('anthropic', 'claude-opus-5-5');
  assert.equal(priceEvent(anth({ cache_write_tokens: 1000, cache_write_1h_tokens: 400 }), opus).cost_micros, 6200);
  assert.equal(priceEvent(anth({ cache_write_tokens: 1000, cache_write_1h_tokens: 5000 }), opus).cost_micros, 8000);
});

test('openai convention: cached tokens are a subset of input', () => {
  // gpt-6.1-sol: fresh 216854-212352 = 4502 @2 ; cached 212352 @0.1 ; out 1000 @10
  // 9,004,000,000 + 21,235,200,000 + 10,000,000,000 = 40,239,200,000 / 1e6 = 40239.2
  const r = priceEvent(oai({ input_tokens: 216854, output_tokens: 1000, cache_read_tokens: 212352 }), rate('openai', 'gpt-6.1-sol'));
  assert.equal(r.cost_micros, 40239);
  assert.equal(r.lines[0].tokens, 4502);
  assert.equal(r.lines[2].tokens, 212352);
  assert.equal(r.tier, null);
});

test('openai convention: contradictory cache counts bill everything as fresh input', () => {
  // cr 80 + cw 40 > input 100 -> all 100 fresh @2 = 200 µ$
  const r = priceEvent(oai({ input_tokens: 100, cache_read_tokens: 80, cache_write_tokens: 40 }), rate('openai', 'gpt-6-sol'));
  assert.equal(r.cost_micros, 200);
  assert.equal(r.lines[2].tokens, 0);
  assert.equal(r.warnings.length, 1);
});

test('NULL cache rate folds the tokens back to the input rate, never a discount', () => {
  // gpt-5.5: in 5, cache read 0.5, no write rate. in 1000 / cr 400 / cw 100 -> fresh 500 + cw 100 folded = 600 @5 = 3000, cr 400 @0.5 = 200
  const r = priceEvent(oai({ input_tokens: 1000, cache_read_tokens: 400, cache_write_tokens: 100 }), rate('openai', 'gpt-5.5'));
  assert.equal(r.cost_micros, 3200);
  // no cache_read rate at all: cached 300 of 1000 bill as input
  const bare = row({ input_micros: 1_000_000 });
  assert.equal(priceEvent(oai({ input_tokens: 1000, cache_read_tokens: 300 }), bare).cost_micros, 1000);
  assert.equal(priceEvent(anth({ input_tokens: 1000, cache_read_tokens: 300 }), bare).cost_micros, 1300);
});

test('1h write with no 1h rate bills at the 5m write rate', () => {
  const r = row({ cache_write_micros: 2_000_000 });
  assert.equal(priceEvent(anth({ cache_write_tokens: 10, cache_write_1h_tokens: 4 }), r).cost_micros, 20);
});

test('long-context tier flips at 272001 input tokens', () => {
  const sol = rate('openai', 'gpt-6-sol');
  assert.equal(priceEvent(oai({ input_tokens: 272000 }), sol).cost_micros, 544_000);      // 272000 * $2
  assert.equal(priceEvent(oai({ input_tokens: 272001 }), sol).cost_micros, 1_088_004);    // 272001 * $4
  assert.equal(priceEvent(oai({ input_tokens: 272001 }), sol).tier, 272001);
  // tier overrides only the fields it names: output stays 10 -> 4 on tier (named), cache read 0.4 on tier
  const t = priceEvent(oai({ input_tokens: 272001, cache_read_tokens: 1000, output_tokens: 100 }), sol);
  // fresh 271001*4 = 1,084,004 ; cr 1000*0.4 = 400 ; out 100*15 = 1500
  assert.equal(t.cost_micros, 1_085_904);
  // anthropic-shape total counts cache tokens toward the tier threshold
  const tiered = row({ input_micros: 1_000_000, cache_read_micros: 100_000, tiers_json: JSON.stringify([{ min_input_tokens: 100, input_micros: 2_000_000 }]) });
  assert.equal(priceEvent(anth({ input_tokens: 50, cache_read_tokens: 50 }), tiered).cost_micros, 105);  // 50*2 + 50*0.1
  assert.equal(priceEvent(anth({ input_tokens: 49, cache_read_tokens: 50 }), tiered).cost_micros, 54);   // 49*1 + 50*0.1
});

test('rounding is half-up and happens once per event', () => {
  assert.equal(priceEvent(anth({ input_tokens: 1 }), row({ input_micros: 500_000 })).cost_micros, 1);
  assert.equal(priceEvent(anth({ input_tokens: 1 }), row({ input_micros: 499_999 })).cost_micros, 0);
  assert.equal(priceEvent(anth({ input_tokens: 3 }), row({ input_micros: 500_000 })).cost_micros, 2);
  // two 0.5 lines sum to exactly 1, not 1 + 1
  assert.equal(priceEvent(anth({ input_tokens: 1, output_tokens: 1 }), row({ input_micros: 500_000, output_micros: 500_000 })).cost_micros, 1);
});

test('large counts do not lose precision (BigInt)', () => {
  // (2^31-1) tokens @ $50/MTok = 2147483647 * 50 = 107,374,182,350 micro-dollars; numerator 1.07e17 is past 2^53
  const r = priceEvent(anth({ output_tokens: 2_147_483_647 }), row({ output_micros: 50_000_000 }));
  assert.equal(r.cost_micros, 107_374_182_350);
});

test('pickRate: newest row not after the event ts; older than every row is null', () => {
  assert.equal(pickRate(rows, 'openai', 'gpt-5.6-sol', '2026-08-01T00:00:00Z').input_micros, 5_000_000);
  assert.equal(pickRate(rows, 'openai', 'gpt-5.6-sol', '2026-08-21T00:00:00Z').input_micros, 4_000_000);
  assert.equal(pickRate(rows, 'openai', 'gpt-5.6-sol', '2026-10-05T00:00:00Z').input_micros, 4_000_000);
  assert.equal(pickRate(rows, 'openai', 'gpt-5.6-sol', '2026-07-01T00:00:00Z'), null);
  assert.equal(pickRate(rows, 'anthropic', 'claude-opus-5-5', '2026-09-21T23:59:59Z'), null);
  assert.ok(pickRate(rows, 'anthropic', 'claude-opus-5-5', '2026-09-22T00:00:00Z'));
});

test('pickRate: exact provider beats "*", then "*" matches any provider', () => {
  const rs = [row({ provider: '*', model: 'm', input_micros: 1 }), row({ provider: 'p', model: 'm', input_micros: 2 })];
  assert.equal(pickRate(rs, 'p', 'm', '2026-06-01').input_micros, 2);
  assert.equal(pickRate(rs, 'other', 'm', '2026-06-01').input_micros, 1);
  assert.equal(pickRate(rows, 'codex', 'gpt-6-astra', '2026-10-05').provider, '*');
});

test('pickRate: prefix rows match startsWith, exact beats prefix, longest prefix wins', () => {
  assert.equal(pickRate(rows, 'anthropic', 'claude-haiku-4-5-20251001', '2026-10-01T00:00:00Z').model, 'claude-haiku-4-5');
  const rs = [row({ model: 'ab', match: 'prefix', input_micros: 1 }), row({ model: 'abc', match: 'prefix', input_micros: 2 }), row({ model: 'abcd', input_micros: 3 })];
  assert.equal(pickRate(rs, 'x', 'abcd', '2026-06-01').input_micros, 3);
  assert.equal(pickRate(rs, 'x', 'abcde', '2026-06-01').input_micros, 2);
  assert.equal(pickRate(rs, 'x', 'abz', '2026-06-01').input_micros, 1);
});

test('pickRate: -YYYYMMDD and vendor/ fallbacks', () => {
  assert.equal(pickRate(rows, 'anthropic', 'claude-sonnet-5-5-20260928', '2026-10-01T00:00:00Z').model, 'claude-sonnet-5-5');
  const v = pickRate(rows, 'openai', 'openai/gpt-6.1-sol', '2026-10-05T00:00:00Z');
  assert.equal(v.model, 'gpt-6.1-sol');
  assert.equal(v.cache_read_micros, 100_000);
  // a full vendor-qualified row is tried before stripping
  assert.equal(pickRate(rows, 'openrouter', 'openai/gpt-6-sol', '2026-10-07T00:00:00Z').model, 'openai/gpt-6-sol');
});

test('pickRate: unknown models are null, never guessed; kimi coding plan stays unpriced', () => {
  assert.equal(pickRate(rows, 'anthropic', 'opus', '2026-10-05'), null);
  assert.equal(pickRate(rows, 'anthropic', 'sonnet', '2026-10-05'), null);
  assert.equal(pickRate(rows, 'nobody', 'nothing-here', '2026-10-05'), null);
  for (const m of ['kimi-k3', 'k3', 'kimi-code/k3', 'kimi/k3']) assert.equal(pickRate(rows, 'moonshot', m, '2026-10-01T00:00:00Z'), null, m);
  assert.equal(pickRate(rows, 'anthropic', '', '2026-10-05'), null);
  assert.equal(pickRate([], 'anthropic', 'claude-opus-5-5', '2026-10-05'), null);
});

test('billingClass follows DESIGN 4.4', () => {
  assert.equal(billingClass('anthropic', 'shoemoney'), 'subscription');
  assert.equal(billingClass('openai', 'work'), 'subscription');
  assert.equal(billingClass('anthropic', null), 'unknown');
  assert.equal(billingClass('openai', ''), 'unknown');
  assert.equal(billingClass('moonshot', 'x'), 'api');
  assert.equal(billingClass('openrouter', null), 'api');
  assert.equal(billingClass('meta', 'x'), 'api');
});

test('seed: parseable, unique, sane, no moonshot, tiers only on the gpt-6 / gpt-5.6 families', () => {
  assert.ok(rows.length >= 15);
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.provider}|${r.model}|${r.effective_from}`;
    assert.ok(!seen.has(k), `duplicate ${k}`);
    seen.add(k);
    assert.notEqual(r.provider, 'moonshot');
    assert.ok(Number.isFinite(Date.parse(r.effective_from)), k);
    for (const f of ['input_micros', 'output_micros']) assert.ok(Number.isInteger(r[f]) && r[f] >= 0, `${k} ${f}`);
    for (const f of ['cache_read_micros', 'cache_write_micros', 'cache_write_1h_micros']) assert.ok(r[f] === null || (Number.isInteger(r[f]) && r[f] >= 0), `${k} ${f}`);
    assert.ok(r.note.length > 0, `${k} has no note`);
    const tiers = JSON.parse(r.tiers_json);
    if (tiers.length) assert.match(r.model, /^gpt-(6|5\.6)/);
  }
  for (const m of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const latest = pickRate(rows, 'openai', m, '2026-10-05');
    assert.equal(JSON.parse(latest.tiers_json)[0].min_input_tokens, 272001, m);
  }
});

test('seed: space-bunny rows are exactly 1/5 of claude-opus-5-5', () => {
  const opus = rate('anthropic', 'claude-opus-5-5');
  const fields = ['input_micros', 'output_micros', 'cache_read_micros', 'cache_write_micros', 'cache_write_1h_micros'];
  for (const [provider, model] of [['openrouter', 'stealth/space-bunny-alpha'], ['anything', 'space-bunny-alpha'], ['anything', 'space-bunny-free']]) {
    const b = rate(provider, model);
    for (const f of fields) assert.equal(b[f] * 5, opus[f], `${model} ${f}`);
  }
  // end to end: 1M input tokens cost 1/5 of opus
  const ev = anth({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.equal(priceEvent(ev, rate('x', 'space-bunny-alpha')).cost_micros * 5, priceEvent(ev, opus).cost_micros);
});
