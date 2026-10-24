import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { ensureSchema, handleSpend, recordProxyUsage } from '../src/spend.js';
import { importCatalog, readCatalog, readCatalogHistory, decimalMicros, digest } from '../src/spend-catalog.js';
import { pickRate, priceEvent, seedPrices } from '../src/spend-pricing.js';
import { normalizeSnapshot, normalizeHistorical, readOtariPrices, run as importPrices } from '../scripts/spend-import-otari-prices.js';
import { mapRow, run as importUsage, newStats } from '../scripts/spend-import-otari.js';

function fixture() {const db=new DatabaseSync(':memory:');ensureSchema(db);return db;}
const base={source:'otari',snapshot:{hash:digest('fixture'),source_as_of:'2026-09-01T00:00:00Z'},models:[{provider:'anthropic',model:'test-model',name:'Test Model',unsupported:false}],
  prices:[{provider:'anthropic',model:'test-model',effective_from:'2026-09-01T00:00:00Z',input_usd:'3',output_usd:'15',cache_read_usd:'0.3',cache_write_usd:'3.75',cache_write_1h_usd:'6',tiers:[{min_input_tokens:200000,input_usd:'6',output_usd:'22.5'}]}]};
const clone=()=>structuredClone(base);
const params=o=>new URLSearchParams(o);

test('legacy provenance migration recognizes only complete unchanged seeds and never retags explicit manual rows on restart',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE spend_prices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT NOT NULL,model TEXT NOT NULL,
    match TEXT NOT NULL DEFAULT 'exact',effective_from TEXT NOT NULL,
    input_micros INTEGER NOT NULL,output_micros INTEGER NOT NULL,
    cache_read_micros INTEGER,cache_write_micros INTEGER,cache_write_1h_micros INTEGER,
    tiers_json TEXT NOT NULL DEFAULT '[]',note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider,model,effective_from));`);
  const seeds=seedPrices().slice(0,6).map(r=>({...r}));
  seeds[1].cache_read_micros=(seeds[1].cache_read_micros ?? 0)+123;
  seeds[2].tiers_json=JSON.stringify([{min_input_tokens:100,input_micros:123456}]);
  seeds[3].match=seeds[3].match==='exact'?'prefix':'exact';
  seeds[4].cache_write_micros=(seeds[4].cache_write_micros ?? 0)+456;
  seeds[5].cache_write_1h_micros=(seeds[5].cache_write_1h_micros ?? 0)+789;
  const insert=db.prepare(`INSERT INTO spend_prices(provider,model,match,effective_from,input_micros,output_micros,cache_read_micros,cache_write_micros,cache_write_1h_micros,tiers_json,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for(const r of seeds) insert.run(r.provider,r.model,r.match,r.effective_from,r.input_micros,r.output_micros,r.cache_read_micros,r.cache_write_micros,r.cache_write_1h_micros,r.tiers_json,r.note);
  try {
    ensureSchema(db);
    const rows=db.prepare('SELECT * FROM spend_prices ORDER BY id').all();
    assert.equal(rows[0].catalog_source,'seed');
    for(const r of rows.slice(1)) assert.equal(r.catalog_source,'manual');
    for(let i=0;i<seeds.length;i++) for(const field of ['match','cache_read_micros','cache_write_micros','cache_write_1h_micros','tiers_json']) assert.equal(rows[i][field],seeds[i][field]);
    // An operator can intentionally mark an otherwise seed-identical price manual.
    db.prepare("UPDATE spend_prices SET catalog_source='manual' WHERE id=?").run(rows[0].id);
    recordProxyUsage(db,{message_id:'msg-migrated-manual',model:seeds[1].model,account:'acct',ts:'2026-10-20',usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:1000000}});
    const settled=db.prepare('SELECT cost_micros,price_id FROM usage_events').get();
    assert.equal(settled.cost_micros,seeds[1].cache_read_micros);
    const imported={source:'otari',snapshot:{hash:digest('newer-than-custom-manual'),source_as_of:'2026-10-01'},prices:[{
      provider:seeds[1].provider,model:seeds[1].model,effective_from:'2026-10-01',input_usd:999,output_usd:999,cache_read_usd:999
    }]};
    importCatalog(db,imported);
    ensureSchema(db);
    assert.equal(db.prepare('SELECT catalog_source FROM spend_prices WHERE id=?').get(rows[0].id).catalog_source,'manual');
    const rates=db.prepare('SELECT * FROM spend_prices').all();
    assert.equal(pickRate(rates,seeds[1].provider,seeds[1].model,'2026-10-20').id,rows[1].id);
    assert.deepEqual(db.prepare('SELECT cost_micros,price_id FROM usage_events').get(),settled);
  }finally{db.close();}
});

test('decimal rates use exact exponent conversion and half-up microdollars',()=>{
  assert.equal(decimalMicros('1.2345675'),1234568);
  assert.equal(decimalMicros('1e-6'),1);
  assert.equal(decimalMicros('0.000003',12),3000000);
  assert.equal(decimalMicros('2.5e-7'),0);
  assert.throws(()=>decimalMicros('-1'),TypeError);
});

test('catalog preview rolls back, repeat acceptance is idempotent, original rates and tiers preserved',()=>{
  const db=fixture();try{
    assert.equal(importCatalog(db,{...clone(),dry_run:true}).inserted,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spend_prices').get().n,0);
    assert.equal(importCatalog(db,clone()).inserted,1);
    assert.equal(importCatalog(db,clone()).duplicate,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spend_catalog_snapshots').get().n,1);
    const r=readCatalog(db).items[0];assert.equal(r.input_usd,3);assert.equal(r.cache_write_1h_usd,6);assert.equal(r.tiers[0].output_usd,22.5);
    const h=readCatalogHistory(db,params({provider:'anthropic',model:'test-model'}));assert.equal(h.versions.length,1);assert.equal(h.snapshots.length,1);assert.equal(h.versions[0].snapshot_hash,base.snapshot.hash);
  }finally{db.close();}
});

test('dated boundary excludes future prices and snapshot is never applied retroactively',()=>{
  const db=fixture();try{
    importCatalog(db,clone());
    assert.equal(readCatalog(db,params({as_of:'2026-08-31T23:59:59Z'})).total,0);
    assert.equal(readCatalog(db,params({as_of:'2026-09-01T00:00:00Z'})).items[0].input_usd,3);
    const next=clone();next.snapshot={hash:digest('next'),source_as_of:'2026-10-01T00:00:00Z'};next.prices[0].effective_from='2026-10-01T00:00:00Z';next.prices[0].input_usd='9';importCatalog(db,next);
    assert.equal(readCatalog(db,params({as_of:'2026-09-30T23:59:59Z'})).items[0].input_usd,3);
    assert.equal(readCatalog(db,params({as_of:'2026-10-01T00:00:00Z'})).items[0].input_usd,9);
  }finally{db.close();}
});

test('manual rates win refreshes and same-date conflicts are reported without overwrites',()=>{
  const db=fixture();try{
    db.prepare(`INSERT INTO spend_prices(provider,model,effective_from,input_micros,output_micros) VALUES(?,?,?,?,?)`).run('anthropic','test-model','2026-08-01T00:00:00.000Z',2000000,10000000);
    importCatalog(db,clone());
    const rates=db.prepare('SELECT * FROM spend_prices').all();assert.equal(pickRate(rates,'anthropic','test-model','2026-10-01').input_micros,2000000);
    assert.equal(readCatalog(db).items[0].source,'manual');
    const conflict=clone();conflict.snapshot.hash=digest('conflict');conflict.prices[0].effective_from='2026-08-01T00:00:00Z';
    assert.equal(importCatalog(db,conflict).conflicts,1);
    assert.equal(db.prepare('SELECT input_micros FROM spend_prices WHERE catalog_source=?').get('manual').input_micros,2000000);
  }finally{db.close();}
});

test('date-only manual rate conflicts with the same imported midnight instant and keeps settled usage',()=>{
  const db=fixture();try {
    db.prepare(`INSERT INTO spend_prices(provider,model,effective_from,input_micros,output_micros) VALUES(?,?,?,?,?)`)
      .run('anthropic','test-model','2026-09-01',2000000,10000000);
    recordProxyUsage(db,{message_id:'msg-date-conflict',model:'test-model',account:'acct',ts:'2026-09-02',usage:{input_tokens:1000000,output_tokens:0}});
    const settled=db.prepare('SELECT cost_micros,price_id FROM usage_events').get();
    const out=importCatalog(db,clone());
    assert.equal(out.inserted,0);assert.equal(out.conflicts,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM spend_prices').get().n,1);
    const manual=db.prepare('SELECT effective_from,input_micros,catalog_source FROM spend_prices').get();
    assert.equal(manual.effective_from,'2026-09-01');assert.equal(manual.input_micros,2000000);assert.equal(manual.catalog_source,'manual');
    assert.deepEqual(db.prepare('SELECT cost_micros,price_id FROM usage_events').get(),settled);
    assert.equal(readCatalog(db).items[0].input_usd,2);
    assert.equal(importCatalog(db,clone()).conflicts,1);
  }finally{db.close();}
});

test('unsupported/non-token modalities remain null; token cache and threshold variants survive snapshot normalization',()=>{
  const p=normalizeSnapshot({source:'genai-prices',updated_at:'2026-10-01 00:00:00',snapshot:JSON.stringify([{id:'anthropic',name:'Anthropic',models:[
    {id:'tiered',prices:[{prices:{input_mtok:{base:3,tiers:[{start:200000,price:6}]},output_mtok:15,cache_write_1h_mtok:6}},{constraint:{start_date:'2027-01-01'},prices:{input_mtok:99,output_mtok:99}}]},
    {id:'image',prices:{input_image:0.01,output_mtok:3}},
    {id:'region-only',prices:[{constraint:{region:'mars'},prices:{input_mtok:1,output_mtok:2}}]}
  ]}])});
  assert.equal(p.prices.length,1);assert.equal(p.prices[0].input_usd,'3.00');assert.equal(p.prices[0].cache_write_1h_usd,'6.00');assert.equal(p.prices[0].tiers[0].input_usd,'6.00');
  const db=fixture();try{importCatalog(db,p);const rows=readCatalog(db).items;const image=rows.find(m=>m.model==='image');assert.equal(image.priced,false);assert.equal(image.input_usd,null);assert.equal(image.unsupported,true);assert.equal(image.unit,null);}finally{db.close();}
});

test('catalog pagination and search keep opaque cursor bound to filters',()=>{
  const db=fixture();try{
    const p=clone();p.models.push({provider:'meta',model:'other',name:'Other',unsupported:true});importCatalog(db,p);
    const first=readCatalog(db,params({limit:1}));assert.equal(first.total,2);assert.ok(first.next_cursor);
    const second=readCatalog(db,params({limit:1,cursor:first.next_cursor}));assert.equal(second.items[0].provider,'meta');
    assert.equal(readCatalog(db,params({q:'TEST MODEL'})).total,1);
    assert.throws(()=>readCatalog(db,params({provider:'meta',cursor:first.next_cursor})),/cursor/);
  }finally{db.close();}
});

test('router tilde aliases import unchanged and independent meter tiers carry forward',()=>{
  const payload=normalizeSnapshot({source:'genai-prices',updated_at:'2026-10-01',snapshot:JSON.stringify([{id:'openrouter',models:[{
    id:'~anthropic/claude-sonnet-latest',prices:{
      input_mtok:{base:3,tiers:[{start:100,price:6}]},
      output_mtok:{base:15,tiers:[{start:200,price:30}]},
      cache_read_mtok:{base:0.3,tiers:[{start:300,price:0.6}]}
    }
  }]}])});
  assert.equal(payload.prices[0].tiers[1].input_usd,'6.00');
  assert.equal(payload.prices[0].tiers[2].input_usd,'6.00');
  assert.equal(payload.prices[0].tiers[2].output_usd,'30.00');
  assert.equal(payload.prices[0].tiers[2].cache_write_usd,null);
  const db=fixture();try {
    importCatalog(db,payload);
    const rate=db.prepare('SELECT * FROM spend_prices').get();
    assert.equal(rate.model,'~anthropic/claude-sonnet-latest');
    const event=n=>({input_tokens:n,output_tokens:1000,cache_read_tokens:0,cache_write_tokens:0,cache_write_1h_tokens:0,cache_tokens_in_prompt:true});
    assert.equal(priceEvent(event(199),rate).cost_micros,16194);
    assert.equal(priceEvent(event(200),rate).cost_micros,31200);
    assert.equal(priceEvent(event(300),rate).cost_micros,31800);
    assert.equal(priceEvent({...event(299),cache_read_tokens:100},rate).cost_micros,31224);
    assert.equal(priceEvent({...event(300),cache_read_tokens:100},rate).cost_micros,31260);
    const tier=JSON.parse(rate.tiers_json)[2];assert.equal(tier.cache_read_micros,600000);assert.equal(tier.output_micros,30000000);assert.equal(tier.input_micros,6000000);
  }finally{db.close();}
});

test('historical Otari keys, units, dates and per-million rates normalize deliberately',()=>{
  const p=normalizeHistorical({model_key:'claude:anthropic/claude-fable-5.1',effective_at:'2026-08-01 01:00:00',input_price_per_million:'10',output_price_per_million:'50',cache_write_1h_price_per_million:'20',pricing_tiers:'[]',unit:'tokens',origin:'api'});
  assert.equal(p.prices[0].provider,'anthropic');assert.equal(p.prices[0].model,'claude-fable-5.1');assert.equal(p.prices[0].source_model_key,'claude:anthropic/claude-fable-5.1');assert.equal(p.prices[0].input_usd,'10.00');
  assert.equal(normalizeHistorical({model_key:'otari:search',effective_at:'2026-08-01',input_price_per_million:'1',output_price_per_million:'0',unit:'requests'}).prices.length,0);
});

async function httpFixture(fn) {
  const db=fixture();
  const server=createServer(async(req,res)=>{
    if(req.headers.authorization!=='Bearer fixture') {res.writeHead(401);return res.end('{}');}
    const ctx={db,reqIp:()=> '127.0.0.1',shortHost:s=>s,json:(r,code,b)=>{r.writeHead(code,{'content-type':'application/json'});r.end(JSON.stringify(b));},
      body:async r=>{let b='';for await(const chunk of r)b+=chunk;try{return JSON.parse(b);}catch{return null;}},logAccess:()=>{}};
    await handleSpend(req,res,new URL(req.url,'http://localhost'),ctx);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  try{await fn({db,url,token:'fixture'});}finally{await new Promise(r=>server.close(r));db.close();}
}

test('real HTTP routes retain old prices array, admin gate, nulls and preview contract',async()=>{
  await httpFixture(async({url})=>{
    assert.equal((await fetch(url+'/api/spend/catalog')).status,401);
    const h={authorization:'Bearer fixture','content-type':'application/json'};
    const post=await fetch(url+'/api/spend/catalog/import',{method:'POST',headers:h,body:JSON.stringify(clone())});assert.equal(post.status,200);assert.equal((await post.json()).inserted,1);
    const prices=await(await fetch(url+'/api/spend/prices',{headers:h})).json();assert.ok(Array.isArray(prices));assert.equal(prices[0].input_usd,'3.00');
    const bad=await fetch(url+'/api/spend/catalog/import',{method:'POST',headers:h,body:JSON.stringify({...clone(),file:'/etc/passwd'})});assert.equal(bad.status,400);
    assert.equal((await fetch(url+'/api/spend/catalog?as_of=bad',{headers:h})).status,400);
  });
});

test('trusted relay usage and collector/import replay share identity and preserve settled costs',async()=>{
  await httpFixture(async({db,url,token})=>{
    importCatalog(db,clone());
    assert.equal(recordProxyUsage(db,{message_id:'msg-live',model:'test-model',account:'acct',usage:{input_tokens:10},complete:false}).skipped,1);
    const args={message_id:'msg-live',model:'test-model',ts:'2026-09-02T00:00:00Z',account:'acct',usage:{input_tokens:1000000,output_tokens:1}};
    assert.equal(recordProxyUsage(db,args).accepted,1);
    const original=db.prepare('SELECT * FROM usage_events').get();assert.equal(original.billing,'subscription');assert.equal(original.account,'acct');
    const post=await fetch(url+'/api/spend/events',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({source:'claude_code',host:'collector',events:[{source_event_id:'msg-live',ts:args.ts,model:'test-model',provider:'anthropic',input_tokens:99,source_cost_micros:9000000,source_cost_kind:'api_equivalent'}]})});
    assert.equal((await post.json()).duplicate,1);const settled=db.prepare('SELECT * FROM usage_events').get();assert.equal(settled.cost_micros,original.cost_micros);assert.equal(settled.input_tokens,1000000);
    assert.equal(recordProxyUsage(db,args).duplicate,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);
    const forbidden=await fetch(url+'/api/spend/events',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({source:'claude_code',host:'x',events:[{source_event_id:'new',ts:args.ts,model:'test-model',provider:'anthropic',account:'other'}]})});assert.equal(forbidden.status,400);
  });
});

test('usage and pricing imports see committed live-WAL rows, repeat dedupes and source cost is separate',async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'catalog-wal-')),path=join(tmp,'source.db'),source=new DatabaseSync(path);
  source.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE model_pricing(model_key TEXT,effective_at TEXT,input_price_per_million TEXT,output_price_per_million TEXT,pricing_tiers TEXT,unit TEXT,origin TEXT);
    CREATE TABLE usage_logs(source TEXT,source_event_id TEXT,timestamp TEXT,provider TEXT,model TEXT,status TEXT,source_label TEXT,prompt_tokens INTEGER,completion_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cache_write_1h_tokens INTEGER,cache_tokens_in_prompt INTEGER,cost TEXT,pricing_reference TEXT);
    CREATE TABLE credentials(secret TEXT);
    INSERT INTO credentials VALUES('must-never-import');
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO model_pricing VALUES('claude:anthropic/test-model','2026-08-01','3','15','[]','tokens','api');
    INSERT INTO usage_logs VALUES('claude_code','msg-wal','2026-09-01','anthropic','test-model','success','host:project',1000000,0,0,0,0,0,'99.123456','deployment-v1');`);
  try{
    assert.equal(readOtariPrices(path).length,1);
    await httpFixture(async cfg=>{
      let output='';const out={write:s=>{output+=s;}};
      await importPrices({db:path,dryRun:false},cfg,out);await importPrices({db:path,dryRun:false},cfg,out);
      assert.equal(cfg.db.prepare('SELECT COUNT(*) n FROM spend_prices').get().n,1);
      await importUsage({db:path,source:'claude_code',sources:['claude_code'],batch:100},cfg,newStats(),out);
      await importUsage({db:path,source:'claude_code',sources:['claude_code'],batch:100},cfg,newStats(),out);
      const event=cfg.db.prepare('SELECT * FROM usage_events').get();assert.equal(event.cost_micros,3000000);assert.equal(event.source_cost_micros,99123456);assert.equal(event.source_cost_kind,'api_equivalent');assert.equal(event.source_pricing_reference,'deployment-v1');
      assert.equal(cfg.db.prepare('SELECT COUNT(*) n FROM usage_events').get().n,1);assert.ok(!output.includes('must-never-import'));
    });
  }finally{source.close();rmSync(tmp,{recursive:true,force:true});}
});

test('usage mapper copies only allowlisted reported price provenance, never content',()=>{
  const r=mapRow({source:'claude_code',source_event_id:'msg',timestamp:'2026-09-01',model:'claude-test',source_cost:'1.23',prompt:'secret',api_key:'secret'});
  assert.equal(r.event.source_cost_micros,1230000);assert.equal(r.event.source_cost_kind,'api_equivalent');assert.ok(!JSON.stringify(r).includes('secret'));
});

test('both CLI importers exit nonzero for rejected HTTP and malformed success',async()=>{
  const tmp=mkdtempSync(join(tmpdir(),'catalog-reject-')),path=join(tmp,'source.db'),source=new DatabaseSync(path);
  source.exec(`CREATE TABLE model_pricing(model_key TEXT,effective_at TEXT,input_price_per_million TEXT,output_price_per_million TEXT,pricing_tiers TEXT);
    INSERT INTO model_pricing VALUES('meta:test','2026-08-01','1','2','[]');
    CREATE TABLE usage_logs(source TEXT,source_event_id TEXT,timestamp TEXT,provider TEXT,model TEXT,status TEXT,source_label TEXT,prompt_tokens INTEGER,completion_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,cache_write_1h_tokens INTEGER,cache_tokens_in_prompt INTEGER);
    INSERT INTO usage_logs VALUES('claude_code','msg','2026-09-01','anthropic','claude-test','success','x',1,1,0,0,0,0);`);source.close();
  let status=200,body='{}';const server=createServer((req,res)=>{req.resume();res.writeHead(status,{'content-type':'application/json'});res.end(body);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const run=name=>new Promise(resolve=>execFile(process.execPath,[new URL('../scripts/'+name,import.meta.url).pathname,'--db',path],{env:{...process.env,HOME:tmp,AIGATE_URL:`http://127.0.0.1:${server.address().port}`,AIGATE_TOKEN:'fixture'}},error=>resolve(error?.code || 0)));
  try{for(const name of ['spend-import-otari-prices.js','spend-import-otari.js']) {assert.notEqual(await run(name),0);body='invalid JSON';assert.notEqual(await run(name),0);body='{}';status=403;assert.notEqual(await run(name),0);status=200;}}
  finally{await new Promise(r=>server.close(r));rmSync(tmp,{recursive:true,force:true});}
});
