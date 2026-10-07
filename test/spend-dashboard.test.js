// Static + behavioural checks for the Spend section of public/index.html (design §7, §8 row 5).
// No server and no browser: the page is read as text, every inline <script> is compiled, and the
// real inline Vue options are run in a vm against /api/spend-shaped fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const spendSection = (html.match(/<section id="spend"[\s\S]*?<\/section>/) || [''])[0];
const appScript = scripts.find((s) => /Vue\.createApp\(/.test(s));

test('GET / markup: spend section, nav link and endpoint are wired', () => {
  assert.ok(spendSection, 'section id="spend" present');
  assert.match(html, /href="\/#spend"/, 'nav link to #spend');
  assert.ok(html.includes('/api/spend'), 'dashboard calls /api/spend');
  for (const label of ['API-equivalent value', 'Spend (API keys', 'Output tokens', 'Input tokens', 'Cache read tokens', 'Cache write tokens']) {
    assert.ok(spendSection.includes(label), `tile label "${label}"`);
  }
});

test('no composite tokens label: a bare "tokens" never renders in the Spend section', () => {
  assert.doesNotMatch(spendSection, />\s*tokens\s*</i, 'bare tokens element text');
  assert.doesNotMatch(spendSection, /\{\{\s*[^}]*\btokens\b\s*\}\}/, 'template expression named tokens');
  assert.doesNotMatch(spendSection, /spendTotals\.tokens|\.total_tokens|\.tokens\b/, 'composite tokens field read');
});

test('honesty strip: collectors, unpriced and unattributed are always surfaced', () => {
  assert.match(spendSection, /collectors?/i);
  assert.match(spendSection, /spendCollectors/);
  assert.match(spendSection, /No collector has ever reported/);
  assert.match(spendSection, /unpriced/i);
  assert.match(spendSection, /unattributed/i);
  for (const f of ['output_tokens', 'input_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cache_write_1h_tokens', 'value_usd', 'spend_usd']) {
    assert.ok(html.includes(f), `Spend block references ${f}`);
  }
});

test('every inline <script> compiles under vm.Script', () => {
  assert.ok(scripts.length >= 2, 'inline scripts found');
  scripts.forEach((body, i) => assert.doesNotThrow(() => new vm.Script(body, { filename: `index.html#script${i + 1}` })));
});

// Run the real inline app with Vue.createApp stubbed to capture its options.
function loadOptions(fetchImpl, overrides = {}) {
  assert.ok(appScript, 'inline Vue.createApp script present');
  let captured = null;
  const el = () => ({ addEventListener() {}, setAttribute() {}, hidden: false, textContent: '', value: '', type: 'password',
    focus() {}, scrollIntoView() {}, firstElementChild: { className: '' }, lastElementChild: { textContent: '' }, style: {}, clientWidth: 800 });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, AbortSignal, Date, Math, Number, JSON,
    Promise, Array, Object, String, Boolean, Error, RegExp, Map, Set, Symbol, parseInt, parseFloat, isNaN, isFinite, confirm: () => false,
    document: { getElementById: el, title: '', hidden: false },
    location: { hash: '', search: '', protocol: 'http:', host: 'x', replace() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: fetchImpl || (() => new Promise(() => {})),
    WebSocket: function () { return { close() {} }; },
    CustomEvent: function () {}, matchMedia: () => ({ matches: false }),
    ResizeObserver: function () { return { observe() {}, disconnect() {} }; },
    ...overrides,
    Vue: { createApp(o) { captured = o; return { config: {}, mount() { return {}; } }; } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
  sandbox.AIGateSession = { token: '' }; sandbox.aigateLoginMessage = () => {};
  sandbox.addEventListener = () => {}; sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(appScript, sandbox, { filename: 'public/index.html#vue' });
  assert.ok(captured, 'Vue.createApp was called');
  const self = { ...captured.data(), ...captured.methods, authed: true, now: Date.now(), activeSection: 'spend',
    $nextTick: async () => {}, $refs: {}, checkError: () => false };
  for (const [k, fn] of Object.entries(captured.computed || {})) Object.defineProperty(self, k, { get() { return fn.call(self); }, configurable: true });
  return self;
}

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });

test('loadSpend: asks /api/spend with range, bucket and group, then exposes the four buckets', async () => {
  const urls = [];
  const payload = {
    totals: { events: 3, input_tokens: 10, output_tokens: 20, cache_read_tokens: 3000, cache_write_tokens: 400, cache_write_1h_tokens: 300,
      value_usd: 1.5, spend_usd: 0.25, unknown_usd: 0, priced_events: 3, unpriced_events: 0, unattributed_events: 0, unpriced_models: [] },
    groups: [{ key: 'a', label: 'a · claude', events: 3, input_tokens: 10, output_tokens: 20, cache_read_tokens: 3000, cache_write_tokens: 400, value_usd: 1.5, spend_usd: 0.25 }],
    series: [], collectors: [],
  };
  const app = loadOptions((url) => { if (String(url).startsWith('/api/spend')) urls.push(String(url));
    return json(200, payload); });
  await app.loadSpend(true);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^\/api\/spend\?/);
  assert.match(urls[0], /bucket=day/);
  assert.match(urls[0], /group=account/);
  assert.match(urls[0], /from=/);
  assert.equal(app.spendError, '');
  assert.equal(app.spendTotals.cache_read_tokens, 3000);
  assert.equal(app.spendRows.length, 1);
  app.setSpendRange('24h');
  await new Promise((r) => setImmediate(r));
  assert.match(urls[1], /bucket=hour/, '24h range asks for hourly buckets');
});

test('loadSpend: a 404 or an error renders the empty state, never zeros', async () => {
  const app404 = loadOptions(() => json(404, { error: 'not found' }));
  await app404.loadSpend(true);
  assert.equal(app404.spend, null);
  assert.match(app404.spendError, /404/);
  assert.match(spendSection, /Spend data unavailable/);

  const app500 = loadOptions(() => json(500, { error: 'boom' }));
  await app500.loadSpend(true);
  assert.equal(app500.spend, null);
  assert.equal(app500.spendError, 'boom');
});

test('collector freshness thresholds: ok under 45 min, warn under 3 h, crit beyond', () => {
  const app = loadOptions();
  app.spendAt = app.now;
  assert.equal(app.collectorClass({ age_s: 60 }), 'ok');
  assert.equal(app.collectorClass({ age_s: 3600 }), 'warn');
  assert.equal(app.collectorClass({ age_s: 4 * 3600 }), 'crit');
});

test('formatters: dollars and compact counts', () => {
  const app = loadOptions();
  assert.equal(app.fmtUsd(9112.4205), '$9,112.42');
  assert.equal(app.fmtUsd(null), '$0.00');
  assert.equal(app.fmtCompact(999), '999');
  assert.equal(app.fmtCompact(100000), '100K');
  assert.equal(app.fmtCompact(19922031022), '19.9B');
  assert.equal(app.fmtCompact(1500), '1.5K');
});

test('spend refresh runs on a 5 minute timer and fetches whichever section is in view', async () => {
  const urls = [];
  const timers = [];
  const app = loadOptions((url) => { if (String(url).startsWith('/api/spend')) urls.push(String(url)); return json(200, { totals: {}, groups: [], series: [], collectors: [] }); },
    { setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  app.activeSection = 'overview';
  app.startSpendTimer();
  const spendTimer = timers.find((t) => t.ms === 300000);
  assert.ok(spendTimer, 'a 300000 ms interval was registered');
  spendTimer.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(urls.length, 1, 'timer tick fetched /api/spend while on #overview');
  assert.match(urls[0], /^\/api\/spend\?/);
});

test('boot loads spend even when the hash is not #spend, so scrolling down never shows a stale Loading panel', async () => {
  const urls = [];
  const app = loadOptions((url) => { if (String(url).startsWith('/api/spend')) urls.push(String(url));
    return json(200, { accounts: [], by_host: [], totals: {}, groups: [], series: [], collectors: [] }); },
    { setInterval: () => 0, clearInterval() {} });
  app.activeSection = 'overview';
  app.authed = false;
  app.connect = () => {}; app.loadSupportingData = () => {}; app.drawChart = () => {};
  await app.boot();
  await new Promise((r) => setImmediate(r));
  assert.equal(urls.length, 1, 'boot requested /api/spend');
  assert.match(urls[0], /^\/api\/spend\?/);
});

test('spend chart and table show unknown-plan value, which is most traffic until sessions are attributed', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /stack:'unknown',data:buckets\.map\(b=>\(rows\.get\([^)]*\)\|\|\{\}\)\.unknown_usd/, 'chart must plot unknown_usd as its own series');
  assert.match(html, /unknown_usd:0,events:0/, 'chart accumulator must sum unknown_usd');
  assert.match(html, />Unknown plan<\/th>/, 'table must have an Unknown plan column');
  assert.match(html, /fmtUsd\(g\.unknown_usd\)/, 'table rows must render unknown_usd');
});

test('Spend leads with an all-usage list-price total so the headline is never just the attributed slice', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, />All usage at list price</, 'headline total tile missing');
  assert.match(html, /spendTotals\.value_usd\)\|\|0\)\+\(Number\(spendTotals\.unknown_usd\)\|\|0\)\+\(Number\(spendTotals\.spend_usd\)/, 'total must include value + unknown + spend');
  assert.ok(html.indexOf('All usage at list price') < html.indexOf('>API-equivalent value<'), 'the total must come first');
});
