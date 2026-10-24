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

test('Claude card status honors fractional remaining allowance instead of the legacy cutoff',()=>{
 const app=loadOptions();const account={account:'fractional',kind:'claude',has_token:true,five_hour_pct:99.5,seven_day_pct:99.5};
 app.accounts=[account];app.rotation={...status,next_account:'fractional',accounts:[{account:'fractional',eligible:true,reason:null,five_hour:{remaining_pct:0.5,fresh:true},seven_day:{remaining_pct:0.5,fresh:true}}]};
 assert.equal(app.accountStatus(account).text,'Ready');assert.equal(app.accountStatus(account).cls,'ok');assert.equal(app.eligible(account),true);assert.equal(app.isNextPick(account),true);
});
test('Claude card status displays each authoritative exclusion even below the legacy cutoff',()=>{
 const app=loadOptions();const account={account:'excluded',kind:'claude',has_token:true,five_hour_pct:1,seven_day_pct:1};
 for(const [reason,label,cls] of [['usage_unknown','Usage unknown','warn'],['usage_stale','Usage stale','warn'],['disabled','Paused','dim'],['model_cooldown','Model cooldown','warn'],['exhausted','Allowance exhausted','warn'],['reauth_needed','New token required','crit']]){
  app.rotation={...status,next_account:null,accounts:[{account:'excluded',eligible:false,reason}]};
  const badge=app.accountStatus(account);assert.equal(badge.text,label,reason);assert.equal(badge.cls,cls,reason);assert.equal(app.eligible(account),false,reason);assert.equal(app.isNextPick(account),false,reason);
 }
});
test('Claude status unavailable or missing candidate never renders Ready',()=>{
 const app=loadOptions();const account={account:'unknown',kind:'claude',has_token:true,five_hour_pct:0,seven_day_pct:0};
 assert.equal(app.accountStatus(account).text,'Usage unknown');app.rotationLoading=true;assert.equal(app.accountStatus(account).text,'Checking status');app.rotationError='offline';assert.equal(app.accountStatus(account).text,'Status unavailable');
 app.rotation={...status,accounts:[]};assert.equal(app.accountStatus(account).text,'Usage unknown');
});
test('Codex card status retains its existing cutoff and refresh branches',()=>{
 const app=loadOptions();const codex={account:'codex',kind:'codex',has_token:true,five_hour_pct:99.5,seven_day_pct:99.5};assert.equal(app.accountStatus(codex).text,'At limit');codex.five_hour_pct=0;codex.seven_day_pct=0;assert.equal(app.accountStatus(codex).text,'Ready');codex.refresh_unknown=true;assert.equal(app.accountStatus(codex).text,'Refresh halted');codex.disabled=true;assert.equal(app.accountStatus(codex).text,'Paused');
});
test('rate display accepts legacy numeric strings while keeping missing rates unpriced',()=>{const app=loadOptions();assert.equal(app.rateLabel('0.30'),'$0.3');assert.equal(app.rateLabel('15'),'$15');assert.equal(app.rateLabel(null),'Unpriced');assert.equal(app.rateLabel(undefined),'Unpriced');assert.equal(app.rateLabel('invalid'),'Unpriced');});

test('chart tooltips wrap long provider and model names within narrow screens',()=>{const app=loadOptions();const tooltip=app.chartBase().tooltip;assert.equal(tooltip.enterable,true);assert.match(tooltip.extraCssText,/max-width:min\(100%,calc\(100vw - 48px\)\)/);assert.match(tooltip.extraCssText,/white-space:normal/);assert.match(tooltip.extraCssText,/overflow-wrap:anywhere/);assert.match(tooltip.extraCssText,/max-height:65vh/);assert.match(tooltip.extraCssText,/overflow:auto/);assert.equal(tooltip.textStyle.fontSize,18);});

test('expiry-only metadata edits omit quota scope and preserve existing quota observations',async()=>{
 const calls=[];const candidate={...status.accounts[0],quota_scope:'implicit-account-fallback',credential_expires_at:null};const before=JSON.stringify(candidate);
 const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});app.setMetadataDraft(candidate,'credential_expires_at','2027-03-01T12:30');
 assert.deepEqual(Object.keys(app.metadataDrafts[candidate.account]),['credential_expires_at']);await app.saveRotationMetadata(candidate);
 assert.deepEqual(JSON.parse(calls[0][1].body),{credential_expires_at:new Date('2027-03-01T12:30').toISOString()});assert.equal(JSON.stringify(candidate),before,'editing expiry never changes candidate quota scope or windows');assert.equal(app.metadataDrafts[candidate.account],undefined);assert.equal(app.metadataMessages[candidate.account],'Metadata saved.');
});
test('clearing only quota scope sends null and leaves expiry untouched',async()=>{
 const calls=[];const candidate={...status.accounts[0],credential_expires_at:'2027-01-01T00:00:00Z'};const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});
 app.setMetadataDraft(candidate,'quota_scope','   ');await app.saveRotationMetadata(candidate);assert.deepEqual(JSON.parse(calls[0][1].body),{quota_scope:null});assert.equal(candidate.credential_expires_at,'2027-01-01T00:00:00Z');
});
test('editing only quota scope trims the payload without writing displayed expiry defaults',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});const candidate=status.accounts[0];app.setMetadataDraft(candidate,'quota_scope','  shared-plan  ');await app.saveRotationMetadata(candidate);
 assert.deepEqual(JSON.parse(calls[0][1].body),{quota_scope:'shared-plan'});assert.equal(app.metadataMessages[candidate.account],'Metadata saved.');assert.equal(app.metadataBusy,'');assert.equal(app.metadataDrafts[candidate.account],undefined);
});
test('failed metadata saves preserve edited fields and report the server error',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([url,init]);return json(400,{error:'Unknown quota scope'})});const candidate=status.accounts[0];app.setMetadataDraft(candidate,'quota_scope','  requested-scope  ');await app.saveRotationMetadata(candidate);
 assert.deepEqual(JSON.parse(calls[0][1].body),{quota_scope:'requested-scope'});assert.equal(calls.length,1,'failed update does not reload or mutate usage');assert.equal(app.metadataMessages[candidate.account],'Unknown quota scope');assert.equal(app.metadataDrafts[candidate.account].quota_scope,'  requested-scope  ');assert.equal(app.metadataBusy,'');
});
test('untouched metadata form sends nothing and clearing only expiry sends null',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});const candidate={...status.accounts[0],credential_expires_at:'2027-01-01T00:00:00Z'};await app.saveRotationMetadata(candidate);assert.equal(calls.length,0);app.setMetadataDraft(candidate,'credential_expires_at','');await app.saveRotationMetadata(candidate);assert.deepEqual(JSON.parse(calls[0][1].body),{credential_expires_at:null});
});

test('metadata maps isolate __proto__ and constructor accounts without inherited drafts or prototype mutations',async()=>{
 const calls=[];const app=loadOptions((url,init)=>{calls.push([url,init]);return json(200,status)});
 const intrinsicPrototype=vm.runInContext('Object.getPrototypeOf({})',app.$sandbox);const before=Object.getOwnPropertyDescriptors(intrinsicPrototype);const sharedBefore=Object.getOwnPropertyDescriptors(Object.prototype);
 assert.equal(Object.getPrototypeOf(app.metadataDrafts),null);assert.equal(Object.getPrototypeOf(app.metadataMessages),null);assert.equal(app.metadataDrafts.__proto__,undefined);assert.equal(app.metadataDrafts.constructor,undefined);assert.equal(app.metadataMessages.constructor,undefined);
 const proto={account:'__proto__',quota_scope:'implicit-proto'},constructor={account:'constructor',quota_scope:'implicit-constructor'};
 await app.saveRotationMetadata(proto);await app.saveRotationMetadata(constructor);assert.equal(calls.length,0,'inherited names never provide an untouched draft');
 app.setMetadataDraft(proto,'credential_expires_at','');app.setMetadataDraft(constructor,'quota_scope','  separate-scope  ');
 assert.equal(Object.getPrototypeOf(app.metadataDrafts.__proto__),null);assert.equal(Object.getPrototypeOf(app.metadataDrafts.constructor),null);assert.notEqual(app.metadataDrafts.__proto__,app.metadataDrafts.constructor);assert.deepEqual(Object.keys(app.metadataDrafts.__proto__),['credential_expires_at']);assert.deepEqual(Object.keys(app.metadataDrafts.constructor),['quota_scope']);
 await app.saveRotationMetadata(proto);assert.deepEqual(JSON.parse(calls[0][1].body),{credential_expires_at:null});assert.equal(calls[0][0],'/api/proxy/claude-code/accounts/__proto__/metadata');assert.equal(app.metadataMessages.__proto__,'Metadata saved.');
 await app.saveRotationMetadata(constructor);const posted=calls.filter(([url])=>url.endsWith('/metadata'));assert.deepEqual(JSON.parse(posted[1][1].body),{quota_scope:'separate-scope'});assert.equal(app.metadataMessages.constructor,'Metadata saved.');assert.equal(app.metadataDrafts.__proto__,undefined);assert.equal(app.metadataDrafts.constructor,undefined);
 assert.deepEqual(Object.getOwnPropertyDescriptors(intrinsicPrototype),before);assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype),sharedBefore);
 app.lockLocally();assert.equal(Object.getPrototypeOf(app.metadataDrafts),null);assert.equal(Object.getPrototypeOf(app.metadataMessages),null);assert.equal(app.metadataDrafts.__proto__,undefined);assert.equal(app.metadataMessages.constructor,undefined);
});
test('special account metadata clear/error paths retain independent own entries',async()=>{
 const calls=[];let fail=true;const app=loadOptions((url,init)=>{calls.push([url,init]);return url.endsWith('/metadata')&&fail?json(400,{error:'Rejected scope'}):json(200,status)});const candidate={account:'__proto__'};
 app.setMetadataDraft(candidate,'quota_scope','  ');app.setMetadataDraft({account:'constructor'},'credential_expires_at','');await app.saveRotationMetadata(candidate);
 assert.deepEqual(JSON.parse(calls[0][1].body),{quota_scope:null});assert.equal(app.metadataMessages.__proto__,'Rejected scope');assert.equal(app.metadataDrafts.__proto__.quota_scope,'  ');assert.equal(app.metadataDrafts.constructor.credential_expires_at,'');assert.equal(app.metadataMessages.constructor,undefined);
 fail=false;await app.saveRotationMetadata(candidate);assert.equal(app.metadataMessages.__proto__,'Metadata saved.');assert.equal(app.metadataDrafts.__proto__,undefined);assert.equal(app.metadataDrafts.constructor.credential_expires_at,'');
});
test('all new charts recreate instances and observers when v-if recovery replaces their DOM',()=>{
 for(const [method,ref]of [['drawRotationChart','rotationChart'],['drawCatalogChart','catalogChart'],['drawHistoryChart','historyChart']]){
  const initialized=[],observers=[];const app=loadOptions(undefined,{echarts:{init:el=>{const chart={el,disposed:0,renders:0,getDom(){return el},setOption(){this.renders++},resize(){},dispose(){this.disposed++}};initialized.push(chart);return chart}},ResizeObserver:function(callback){const observer={callback,target:null,disconnected:0,observe(el){this.target=el},disconnect(){this.disconnected++}};observers.push(observer);return observer}});
  app.rotation=status;app.catalogItems=[{model:'old',provider:'anthropic',unit:'USD / 1M tokens',priced:true,input_usd:3,output_usd:15}];app.priceHistory={versions:[{effective_from:'2024-01-01T00:00:00Z',input_usd:3,output_usd:15}]};const first={clientWidth:800,style:{}},replacement={clientWidth:390,style:{}};
  app.$refs[ref]=first;app[method]();app[method]();assert.equal(initialized.length,1,method+' reuses same DOM');assert.equal(observers.length,1);assert.equal(initialized[0].renders,2);assert.equal(observers[0].target,first);
  app.$refs[ref]=null;app[method]();assert.equal(initialized.length,1,'missing v-if ref does not initialize');
  app.$refs[ref]=replacement;app[method]();assert.equal(initialized[0].disposed,1,method+' disposes detached instance');assert.equal(observers[0].disconnected,1,method+' disconnects old observer');assert.equal(initialized.length,2);assert.equal(initialized[1].el,replacement);assert.equal(observers.length,2);assert.equal(observers[1].target,replacement);assert.equal(initialized[1].renders,1);
  app[method]();assert.equal(initialized.length,2,'recovered DOM reuses replacement instance');assert.equal(initialized[1].renders,2);assert.equal(observers[1].disconnected,0);
 }
});
