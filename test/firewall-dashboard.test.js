import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/assets/aigate-brand.css', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const script = scripts.find(s => /Vue\.createApp\(/.test(s));
const section = html.match(/<section id="firewall"[\s\S]*?<\/section>/)?.[0] || '';
const plain = value => JSON.parse(JSON.stringify(value));
const json = (status, value) => Promise.resolve({ ok: status < 400, status, json: async () => value });
const policy = (overrides = {}) => ({
  revision: 1, enabled: true,
  rules: [{ cidr: '192.168.1.0/24', label: 'LAN' }, { cidr: 'fd7a:115c:a1e0::/48', label: 'Tailscale IPv6' }],
  client_ip: '192.168.1.33', peer_ip: '192.168.1.10', loopback_always_allowed: true,
  updated_at: '2026-10-26T02:00:00.000Z', source: 'environment', ...overrides,
});

// Execute the actual page script; only Vue's mount and browser APIs are stubbed.
// The root integration lane separately exercises the DOM in a real browser.
function loadApp(fetchImpl = () => json(200, policy()), overrides = {}) {
  let captured;
  const listeners = {};
  const element = () => ({ addEventListener() {}, setAttribute() {}, hidden: false, value: '', type: 'password',
    focus() {}, scrollIntoView() {}, firstElementChild: { className: '' }, lastElementChild: { textContent: '' } });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, URLSearchParams, AbortSignal, Date,
    Math, Number, JSON, Promise, Array, Object, String, Boolean, Error, RegExp, Map, Set, Symbol,
    document: { getElementById: element, title: '' },
    location: { hash: '', search: '', protocol: 'http:', host: 'fixture', replace() {} },
    localStorage: { getItem() { return null; }, removeItem() {} },
    fetch: (url, init) => url === '/api/session' ? json(200, { authenticated: false }) : fetchImpl(url, init),
    WebSocket: function () { return { close() {} }; },
    CustomEvent: function () {}, matchMedia: () => ({ matches: false }),
    ResizeObserver: function () { return { disconnect() {}, observe() {} }; },
    confirm: () => false,
    ...overrides,
    Vue: { createApp(options) { captured = options; return { config: {}, mount() { return {}; } }; } },
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.AIGateSession = { token: '' }; sandbox.aigateLoginMessage = () => {};
  sandbox.addEventListener = (name, fn) => { listeners[name] = fn; }; sandbox.dispatchEvent = () => {};
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox, { filename: 'index.html#firewall' });
  assert.ok(captured);
  const app = { ...captured.data(), ...captured.methods, authed: true, $nextTick: async () => {}, $refs: {} };
  for (const [name, fn] of Object.entries(captured.computed)) Object.defineProperty(app, name, { get() { return fn.call(app); } });
  return { app, sandbox, listeners, options: captured };
}

test('Firewall navigation and editor use escaped bindings, accessible controls and readable styling', () => {
  assert.ok(section);
  assert.match(html, /href="\/#firewall"[^>]*>[\s\S]*?fa-shield-halved[^<]*<\/i> Firewall/);
  for (const text of ['Your observed IP', 'IP address or CIDR range', 'Save firewall', 'Discard changes', '172.16.17.1', '172.18.0.1', 'administrator authentication']) assert.ok(section.includes(text), text);
  assert.match(section, /Devices seen as the same gateway IP share that access rule; individual device rules require their real IPs to reach Aigate\./);
  assert.match(section, /v-model="rule\.label"/);
  assert.doesNotMatch(section, /v-html|innerHTML/);
  assert.match(section, /role="alert"/);
  assert.match(section, /role="status"/);
  assert.match(section, /:disabled="firewallLoading \|\| firewallSaving"/);
  assert.match(css, /\.firewall-rule input\{font-size:20px/);
  const firewallCss = css.slice(css.indexOf('/* Firewall:'));
  for (const match of firewallCss.matchAll(/font-size:(\d+)px/g)) assert.ok(Number(match[1]) >= 18);
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source));
});

test('loading calls the authenticated helper and keeps saved rules separate from editable drafts', async () => {
  const calls = [];
  const { app, sandbox } = loadApp((url, init) => { calls.push([url, init]); return json(200, policy()); });
  sandbox.AIGateSession.token = 'test-administrator-fixture';
  await app.loadFirewall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/firewall');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].headers.authorization, 'Bearer test-administrator-fixture');
  assert.equal(app.firewall.client_ip, '192.168.1.33');
  assert.equal(app.firewallDirty, false);
  app.firewallDraft.rules[0].label = '<img src=x onerror=alert(1)>';
  app.touchFirewall();
  assert.equal(app.firewall.rules[0].label, 'LAN');
  assert.equal(app.firewallDraft.rules[0].label, '<img src=x onerror=alert(1)>');
  assert.equal(app.firewallDirty, true);
  await app.loadFirewall();
  assert.equal(calls.length, 1, 'background reload cannot replace an unsaved draft or revision');
});

test('saving submits only the policy contract and adopts the normalized saved response', async () => {
  const calls = [];
  const normalized = policy({ revision: 2, source: 'database', rules: [{ cidr: '192.168.1.0/24', label: 'Home LAN' }] });
  const { app } = loadApp((url, init) => { calls.push([url, init]); return json(200, normalized); });
  app.adoptFirewall(policy());
  app.firewallDraft.rules = [{ id: 90, cidr: ' 192.168.1.33/24 ', label: ' Home LAN ' }]; app.touchFirewall();
  await app.saveFirewall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/firewall'); assert.equal(calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0][1].body), { revision: 1, enabled: true, rules: [{ cidr: '192.168.1.33/24', label: 'Home LAN' }] });
  assert.equal(app.firewall.revision, 2);
  assert.equal(app.firewallDraft.rules[0].cidr, '192.168.1.0/24');
  assert.equal(app.firewallDirty, false); assert.equal(app.firewallSaving, false);
  assert.match(app.firewallNotice, /saved/i);
});

test('empty enabled policies and incomplete rules cannot be submitted', async () => {
  let calls = 0;
  const { app } = loadApp(() => { calls++; return json(200, policy()); });
  app.adoptFirewall(policy()); app.firewallDraft.rules = []; app.touchFirewall();
  await app.saveFirewall();
  assert.equal(calls, 0); assert.equal(app.firewallErrorCode, 'invalid_policy');
  assert.match(app.firewallError, /at least one/);
  app.addFirewallRule();
  await app.saveFirewall();
  assert.equal(calls, 0); assert.match(app.firewallError, /for each rule/);
});

test('disabling requires confirmation and an affirmative save', async () => {
  const calls = []; let confirmed = false;
  const { app } = loadApp((url, init) => { calls.push([url, init]); return json(200, policy({ revision: 2, enabled: false })); }, {
    confirm: text => { assert.match(text, /Any IP/); return confirmed; },
  });
  app.adoptFirewall(policy()); app.firewallDraft.enabled = false; app.touchFirewall();
  await app.saveFirewall();
  assert.equal(calls.length, 0); assert.equal(app.firewall.enabled, true); assert.equal(app.firewallDirty, true);
  confirmed = true; await app.saveFirewall();
  assert.equal(calls.length, 1); assert.equal(JSON.parse(calls[0][1].body).enabled, false);
  assert.equal(app.firewall.enabled, false); assert.equal(app.firewallDirty, false);
});

for (const [code, message] of [['invalid_policy', 'Invalid IPv6 prefix'], ['self_lockout', 'Would exclude this client'], ['revision_conflict', 'Revision changed']]) {
  test(code + ' preserves the complete draft and previous saved policy', async () => {
    const { app } = loadApp(() => json(code === 'invalid_policy' ? 400 : 409, { error: message, code }));
    app.adoptFirewall(policy()); app.firewallDraft.rules[1].cidr = 'fd7a:115c:a1e0::/129'; app.touchFirewall();
    const draft = plain(app.firewallDraft);
    await app.saveFirewall();
    assert.deepEqual(plain(app.firewallDraft), draft); assert.equal(app.firewall.revision, 1);
    assert.equal(app.firewallErrorCode, code); assert.equal(app.firewallSaving, false);
    if (code === 'self_lockout') assert.match(app.firewallError, /192\.168\.1\.33/);
    if (code === 'revision_conflict') assert.match(app.firewallError, /Another administrator/);
    if (code === 'invalid_policy') assert.equal(app.firewallError, message);
  });
}

test('reloading after a conflict only replaces a draft after explicit confirmation', async () => {
  let confirmed = false, calls = 0;
  const { app } = loadApp(() => { calls++; return json(200, policy({ revision: 4 })); }, { confirm: () => confirmed });
  app.adoptFirewall(policy()); app.firewallDraft.rules[0].label = 'My unsaved rule'; app.touchFirewall();
  await app.reloadFirewall(); assert.equal(calls, 0); assert.equal(app.firewallDraft.rules[0].label, 'My unsaved rule');
  confirmed = true; await app.reloadFirewall();
  assert.equal(calls, 1); assert.equal(app.firewall.revision, 4); assert.equal(app.firewallDraft.rules[0].label, 'LAN'); assert.equal(app.firewallDirty, false);
});

test('failed save and failed reload retain drafts and allow retry', async () => {
  let failed = true;
  const { app } = loadApp(() => failed ? Promise.reject(new Error('Network offline')) : json(200, policy({ revision: 2 })), { confirm: () => true });
  app.adoptFirewall(policy()); app.firewallDraft.rules[0].label = 'Retain me'; app.touchFirewall();
  await app.saveFirewall(); assert.equal(app.firewallDraft.rules[0].label, 'Retain me'); assert.match(app.firewallError, /Network offline/);
  await app.reloadFirewall(); assert.equal(app.firewallDraft.rules[0].label, 'Retain me'); assert.equal(app.firewallLoading, false);
  failed = false; await app.reloadFirewall(); assert.equal(app.firewall.revision, 2); assert.equal(app.firewallError, '');
});

test('initial loading failure remains retryable without displaying a fabricated policy', async () => {
  let status = 503;
  const { app } = loadApp(() => json(status, status === 200 ? policy() : { error: 'Unavailable' }));
  await app.loadFirewall(); assert.equal(app.firewall, null); assert.equal(app.firewallLoading, false); assert.equal(app.firewallError, 'Unavailable');
  status = 200; await app.reloadFirewall(); assert.equal(app.firewall.revision, 1); assert.equal(app.firewallError, '');
});

test('newest load wins and a response cannot overwrite edits made while loading', async () => {
  const pending = [];
  const { app } = loadApp(() => new Promise(resolve => pending.push(resolve)));
  const first = app.loadFirewall(), second = app.loadFirewall();
  pending[1](await json(200, policy({ revision: 3 }))); await second;
  pending[0](await json(200, policy({ revision: 1 }))); await first;
  assert.equal(app.firewall.revision, 3);
  const third = app.loadFirewall();
  app.firewallDraft.rules[0].label = 'Newer edit'; app.touchFirewall();
  pending[2](await json(200, policy({ revision: 4 }))); await third;
  assert.equal(app.firewall.revision, 3); assert.equal(app.firewallDraft.rules[0].label, 'Newer edit'); assert.equal(app.firewallLoading, false);
});

test('a late save adopts its revision without replacing newer local edits', async () => {
  let resolve;
  const { app } = loadApp(() => new Promise(r => { resolve = r; }));
  app.adoptFirewall(policy()); app.firewallDraft.rules[0].label = 'Submitted'; app.touchFirewall();
  const pending = app.saveFirewall();
  app.firewallDraft.rules[0].label = 'Newer unsaved edit'; app.touchFirewall();
  resolve(await json(200, policy({ revision: 2, rules: [{ cidr: '192.168.1.0/24', label: 'Submitted' }] }))); await pending;
  assert.equal(app.firewall.revision, 2); assert.equal(app.firewall.rules[0].label, 'Submitted');
  assert.equal(app.firewallDraft.rules[0].label, 'Newer unsaved edit'); assert.equal(app.firewallDirty, true);
});

test('locking clears firewall state and late reads/writes cannot repopulate it', async () => {
  for (const action of ['read', 'write']) {
    let resolve;
    const { app } = loadApp((url) => url === '/api/logout' ? json(200, {}) : new Promise(r => { resolve = r; }));
    app.adoptFirewall(policy());
    if (action === 'write') { app.firewallDraft.rules[0].label = 'Pending'; app.touchFirewall(); }
    const pending = action === 'read' ? app.loadFirewall() : app.saveFirewall();
    await app.logout();
    assert.equal(app.authed, false); assert.equal(app.firewall, null); assert.equal(app.firewallDraft.rules.length, 0);
    resolve(await json(200, policy({ revision: 2 }))); await pending;
    assert.equal(app.firewall, null); assert.equal(app.firewallLoading, false); assert.equal(app.firewallSaving, false);
  }
});

test('expired authentication locks the workspace instead of retaining firewall rules', async () => {
  const { app } = loadApp(() => json(401, { error: 'unauthorized' }));
  app.adoptFirewall(policy()); app.firewallDraft.rules[0].label = 'Unsaved'; app.touchFirewall();
  await app.saveFirewall();
  assert.equal(app.authed, false); assert.equal(app.firewall, null); assert.equal(app.firewallDraft.rules.length, 0);
});

test('discard and add/remove controls operate only on the draft and do not restore deleted gateways', () => {
  const { app } = loadApp();
  app.adoptFirewall(policy({ rules: [{ cidr: '172.16.17.1/32', label: 'NPM gateway' }] }));
  app.removeFirewallRule(0); assert.equal(app.firewallDraft.rules.length, 0); assert.equal(app.firewall.rules.length, 1);
  app.addFirewallRule(); assert.equal(app.firewallDraft.rules[0].cidr, '');
  app.discardFirewall(); assert.equal(app.firewallDraft.rules[0].cidr, '172.16.17.1/32'); assert.equal(app.firewallDirty, false);
  app.firewallSaving = true; app.removeFirewallRule(0); app.addFirewallRule(); assert.equal(app.firewallDraft.rules.length, 1);
});

test('opening the Firewall navigation loads policy without bypassing draft protection', async () => {
  let calls = 0;
  const { app, sandbox, listeners, options } = loadApp(() => { calls++; return json(200, policy()); });
  options.mounted.call(app); sandbox.location.hash = '#firewall'; listeners.hashchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.activeSection, 'firewall'); assert.equal(calls, 1); assert.equal(app.firewall.revision, 1);
  app.firewallDraft.rules[0].label = 'Unsaved'; app.touchFirewall(); listeners.hashchange();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1); assert.equal(app.firewallDraft.rules[0].label, 'Unsaved');
});
