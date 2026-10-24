import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
const appScript=scripts.find(s=>/Vue\.createApp\(/.test(s));
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
    fetch: (url,init) => url==='/api/session'?Promise.resolve({ok:true,status:200,json:async()=>({authenticated:false})}):(fetchImpl || (() => new Promise(() => {})))(url,init),
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
  self.$sandbox=sandbox;return self;
}

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });


const status={policy:'soonest_weekly_reset',poll_interval_ms:300000,max_age_ms:600000,last_completed_at:null,next_poll_at:null,next_account:'ready',accounts:[{account:'ready',eligible:true,quota_scope:'subscription-one',in_flight:0,five_hour:{remaining_pct:100,used_pct:0,observed_at:new Date().toISOString(),fresh:true},seven_day:{remaining_pct:0.25,observed_at:new Date().toISOString(),fresh:true}},{account:'unknown',eligible:false,reason:'usage_unknown',five_hour:{remaining_pct:null,fresh:false},seven_day:{remaining_pct:null,fresh:false}}]};
test('rotation refresh posts once then reads authoritative status without token access',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([String(url),init.method,init.body]);return json(200,status)});
 await app.refreshRotation();assert.deepEqual(calls.map(c=>c.slice(0,2)),[['/api/proxy/claude-code/refresh','POST'],['/api/proxy/claude-code/status','GET']]);
 assert.equal(app.rotation.next_account,'ready');assert.equal(app.remainingLabel(app.rotationAccounts[0].seven_day.remaining_pct),'0.25%');assert.equal(app.remainingLabel(null),'Unknown');assert.equal(app.rotationRefreshing,false);
 const panel=html.slice(html.indexOf('id="rotation-title"'),html.indexOf('<form id="new-account"'));assert.doesNotMatch(panel,/key_hint|setup_token|access_token|refresh_token/);
});
test('rotation errors clear stale status and quota freshness expires after max age',async()=>{
 const app=loadOptions(()=>json(503,{error:'offline'}));app.rotation=status;await app.loadRotation();assert.equal(app.rotation,null);assert.equal(app.rotationError,'offline');
 app.rotation=status;app.now=Date.now();assert.equal(app.windowFresh({fresh:true,observed_at:new Date(app.now-600001).toISOString()}),false);assert.equal(app.windowFresh({fresh:true,observed_at:new Date(app.now).toISOString()}),true);
});
test('quota metadata is manual and preserves a cleared expiry as null',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});const a=status.accounts[0];app.setMetadataDraft(a,'quota_scope','shared-scope');app.setMetadataDraft(a,'credential_expires_at','');await app.saveRotationMetadata(a);
 assert.equal(calls[0][0],'/api/proxy/claude-code/accounts/ready/metadata');assert.deepEqual(JSON.parse(calls[0][1].body),{quota_scope:'shared-scope',credential_expires_at:null});
});
test('catalog filters, cursor and null prices survive the API contract',async()=>{
 const calls=[];const item={provider:'anthropic',model:'claude-old',unit:'USD / 1M tokens',input_usd:null,output_usd:15,priced:true};
 const app=loadOptions(url=>{calls.push(String(url));if(String(url).includes('/history?'))return json(200,{versions:[]});return json(200,{as_of:'2026-01-01T00:00:00Z',items:[item],next_cursor:'page-two',total:2});},{URL});app.catalogProvider='anthropic';app.catalogQuery='claude';await app.loadCatalog();assert.match(calls[0],/provider=anthropic/);assert.match(calls[0],/q=claude/);assert.equal(app.catalogItems[0].input_usd,null);assert.equal(app.rateLabel(null),'Unpriced');assert.equal(app.rateLabel(0),'$0');await app.loadCatalog(true);assert.ok(calls.some(u=>u.includes('cursor=page-two')));assert.equal(app.catalogItems.length,2);
});
test('legacy price fallback does not claim historical as-of support',async()=>{
 const urls=[];const app=loadOptions(url=>{urls.push(String(url));return String(url)==='/api/spend/prices'?json(200,[{provider:'anthropic',model:'old',input_usd:null,output_usd:'15'}]):json(404,{error:'not found'});});await app.loadCatalog();assert.equal(app.catalog.legacy,true);assert.equal(app.catalogItems[0].input_usd,null);app.catalogAsOf='2020-01-01T00:00';await app.loadCatalog();assert.match(app.catalogError,/Historical catalog lookup is unavailable/);assert.equal(urls.filter(u=>u==='/api/spend/prices').length,1);
});
test('late rotation and catalog responses cannot repopulate a locked workspace',async()=>{
 let resolve;const app=loadOptions(()=>new Promise(r=>resolve=r));const pending=app.loadRotation();app.authed=false;app.rotationStamp++;resolve({ok:true,status:200,json:async()=>status});await pending;assert.equal(app.rotation,null);
});
test('rotation and rate charts use readable labels and null values instead of fabricated zero prices',()=>{
 const options=[];const app=loadOptions(undefined,{echarts:{init:el=>({setOption:o=>options.push(o),resize(){},dispose(){}})}});app.rotation=status;app.catalogItems=[{model:'old',provider:'anthropic',unit:'USD / 1M tokens',priced:true,input_usd:null,output_usd:15}];app.priceHistory={versions:[{effective_from:'2024-01-01T00:00:00Z',input_usd:null,output_usd:15}]};app.$refs={rotationChart:{clientWidth:800,style:{}},catalogChart:{clientWidth:800,style:{}},historyChart:{clientWidth:800,style:{}}};app.drawRotationChart();app.drawCatalogChart();app.drawHistoryChart();assert.equal(options.length,3);assert.equal(options[0].series[0].data[1],null);assert.equal(options[1].series[0].data[0],null);assert.equal(options[2].series[0].data[0][1],null);
 const visit=o=>{if(!o||typeof o!=='object')return;for(const [key,value]of Object.entries(o)){if(key==='fontSize')assert.ok(value>=18,'all chart text >=18');visit(value)}};options.forEach(visit);assert.doesNotMatch(html,/font-size:16px|fontSize:16/);
});

test('legacy account badges use the authoritative Claude pool selection',()=>{const app=loadOptions();app.accounts=[{account:'ready',kind:'claude',has_token:true,five_hour_pct:0,seven_day_pct:0},{account:'unknown',kind:'claude',has_token:true,five_hour_pct:0,seven_day_pct:0}];app.rotation=status;assert.equal(app.eligible(app.accounts[0]),true);assert.equal(app.eligible(app.accounts[1]),false);assert.equal(app.nextPicks.claude,'ready');app.rotation=null;assert.equal(app.eligible(app.accounts[0]),false);assert.equal(app.nextPicks.claude,undefined);});
