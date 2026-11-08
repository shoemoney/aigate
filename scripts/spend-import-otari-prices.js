#!/usr/bin/env node
// Explicit one-shot pricing import. Reads ONLY pricing tables, never credentials.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { decimalMicros, digest, iso, RATE_FIELDS } from '../src/spend-catalog.js';
import { fromMicros } from '../src/spend-pricing.js';
import { loadConfig } from './spend-import-otari.js';

const DEFAULT_DB=`${process.env.HOME}/Projects/otari/otari.db`;
const MTOK={input:'input_mtok',output:'output_mtok',cache_read:'cache_read_mtok',cache_write:'cache_write_mtok',cache_write_1h:'cache_write_1h_mtok'};
const usd=v=>v == null?null:fromMicros(decimalMicros(v));
export function normalizeModelKey(key) {
  const split=String(key).indexOf(':');
  if(split<1) throw new TypeError('Otari model key must include provider instance');
  let provider=key.slice(0,split),model=key.slice(split+1);
  if(provider==='claude') {provider='anthropic';model=model.replace(/^anthropic\//,'');}
  return {provider,model,source_model_key:key};
}

// Price variants with non-date constraints cannot safely become universal token rates.
function snapshotRates(prices, asof) {
  if(!Array.isArray(prices)) return prices || {};
  const choices=prices.filter(v=>!v.constraint || Object.keys(v.constraint).every(k=>k==='start_date'))
    .filter(v=>!v.constraint?.start_date || iso(v.constraint.start_date)<=asof)
    .sort((a,b)=>String(b.constraint?.start_date || '').localeCompare(String(a.constraint?.start_date || '')));
  return choices[0]?.prices || {};
}
export function normalizeSnapshot(row) {
  const asof=iso(row.accepted_at || row.updated_at), raw=typeof row.snapshot==='string'?row.snapshot:JSON.stringify(row.snapshot);
  const providers=JSON.parse(raw);
  if(!Array.isArray(providers)) throw new TypeError('snapshot must contain provider array');
  const models=[], prices=[];
  for(const provider of providers) for(const model of provider.models || []) {
    const rates=snapshotRates(model.prices,asof), base={}, tiers=new Map();
    let unsupported=false, tokenUnsupported=false;
    for(const field of RATE_FIELDS) {
      const value=rates[MTOK[field]];
      if(value!=null && typeof value==='object') {
        if(value.base==null || !Array.isArray(value.tiers)) {tokenUnsupported=true;continue;}
        base[field+'_usd']=usd(value.base);
        for(const t of value.tiers) {
          if(!Number.isSafeInteger(t.start) || t.start<0 || t.price==null) {tokenUnsupported=true;continue;}
          const tier=tiers.get(t.start)||{min_input_tokens:t.start};tier[field+'_usd']=usd(t.price);tiers.set(t.start,tier);
        }
      } else base[field+'_usd']=usd(value);
    }
    const supported=!tokenUnsupported && base.input_usd!=null && base.output_usd!=null;
    unsupported ||= !supported || Object.keys(rates).some(k=>!Object.values(MTOK).includes(k));
    const identity={provider:provider.id,model:model.id,source_model_key:`${provider.id}:${model.id}`};
    models.push({...identity,name:model.name || model.id,description:model.description || '',unsupported,
      metadata:{provider_name:provider.name || provider.id,upstream_source:row.source || 'genai-prices',pricing_urls:provider.pricing_urls || [],context_window:model.context_window ?? null,
        raw_prices:model.prices ?? null,source_unit:'USD per million tokens for *_mtok; other meters unsupported'}});
    // The ledger selects one complete tier row. Feed meters have independent
    // threshold schedules, so retain each earlier meter change at later steps.
    const carried={...base};
    const cumulativeTiers=[...tiers.values()].sort((a,b)=>a.min_input_tokens-b.min_input_tokens).map(t=>{
      Object.assign(carried,t);
      return {...carried};
    });
    if(supported) prices.push({...identity,effective_from:asof,...base,tiers:cumulativeTiers,note:`Otari accepted ${row.source || 'genai-prices'} snapshot; first observed ${asof}`});
  }
  return {source:'otari',snapshot:{hash:digest(raw),source_as_of:asof},models,prices};
}
export function normalizeHistorical(row) {
  const identity=normalizeModelKey(row.model_key), effective=iso(row.effective_at), supported=(row.unit || 'tokens')==='tokens';
  const fields={};for(const f of RATE_FIELDS) fields[f+'_usd']=usd(row[f+'_price_per_million']);
  const rawTiers=typeof row.pricing_tiers==='string'?JSON.parse(row.pricing_tiers):row.pricing_tiers || [];
  const tiers=rawTiers.map(t=>{const v={min_input_tokens:t.min_input_tokens};for(const f of RATE_FIELDS) if(t[f+'_price_per_million']!=null) v[f+'_usd']=usd(t[f+'_price_per_million']);return v;});
  return {source:'otari',snapshot:{hash:digest(['model_pricing',row]),source_as_of:effective},
    models:[{...identity,name:identity.model,description:'',unsupported:!supported,metadata:{source_unit:row.unit || 'tokens',origin:row.origin ?? null,raw_rates:fields}}],
    prices:supported?[{...identity,effective_from:effective,...fields,tiers,note:`Otari model_pricing origin=${row.origin ?? 'unknown'}; original key ${row.model_key}`}]:[]};
}
export function readOtariPrices(path) {
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('BEGIN');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
    const payloads=[], hashes=new Set();
    if(tables.has('pricing_snapshot_history')) {
      for(const row of db.prepare('SELECT source,snapshot,accepted_at FROM pricing_snapshot_history ORDER BY accepted_at').all()) {
        const p=normalizeSnapshot(row);if(!hashes.has(p.snapshot.hash)){hashes.add(p.snapshot.hash);payloads.push(p);}
      }
    }
    if(tables.has('pricing_snapshots')) for(const row of db.prepare('SELECT source,snapshot,updated_at FROM pricing_snapshots ORDER BY updated_at').all()) {
      const p=normalizeSnapshot(row);if(!hashes.has(p.snapshot.hash)){hashes.add(p.snapshot.hash);payloads.push(p);}
    }
    if(tables.has('model_pricing')) {
      // CAST preserves the source decimal representation; no JS multiplication of floats.
      const cols=new Set(db.prepare('PRAGMA table_info(model_pricing)').all().map(r=>r.name));
      const fields=RATE_FIELDS.map(f=>cols.has(f+'_price_per_million')?`CAST(${f}_price_per_million AS TEXT) AS ${f}_price_per_million`:`NULL AS ${f}_price_per_million`);
      for(const row of db.prepare(`SELECT model_key,effective_at,${fields.join(',')},pricing_tiers,${cols.has('unit')?'unit':"'tokens' AS unit"},${cols.has('origin')?'origin':'NULL AS origin'} FROM model_pricing ORDER BY effective_at,model_key`).all()) payloads.push(normalizeHistorical(row));
    }
    return payloads;
  } finally {try{db.exec('ROLLBACK');}catch{}db.close();}
}

export async function run(opts,cfg,out=process.stdout) {
  const payloads=readOtariPrices(opts.db), totals={snapshots:payloads.length,models:0,prices:0,unsupported:0,inserted:0,duplicate:0,conflicts:0,providers:[],first_effective:null,last_effective:null};
  const providers=new Set(), uniqueModels=new Set();
  for(const payload of payloads) {
    totals.models+=payload.models.length;totals.prices+=payload.prices.length;totals.unsupported+=payload.models.filter(m=>m.unsupported).length;
    for(const m of payload.models) {providers.add(m.provider);uniqueModels.add(`${m.provider}:${m.model}`);}
    for(const p of payload.prices) {if(!totals.first_effective || p.effective_from<totals.first_effective)totals.first_effective=p.effective_from;if(!totals.last_effective||p.effective_from>totals.last_effective)totals.last_effective=p.effective_from;}
    // Keep bodies well below the admin JSON cap; same snapshot identity across chunks.
    const count=Math.max(payload.models.length,payload.prices.length);
    for(let offset=0;offset<count;offset+=100) {
      const part={...payload,models:payload.models.slice(offset,offset+100),prices:payload.prices.slice(offset,offset+100),dry_run:!!opts.preview};
      if(opts.dryRun) continue;
      const res=await fetch(`${cfg.url}/api/spend/catalog/import`,{method:'POST',headers:{authorization:`Bearer ${cfg.token}`,'content-type':'application/json'},body:JSON.stringify(part),signal:AbortSignal.timeout(60000)});
      if(!res.ok) {
        const detail=(await res.text()).replace(/[\u0000-\u001f]/g,' ').slice(0,300);
        throw new Error(`catalog import HTTP ${res.status}: ${detail}`);
      }
      let data;try{data=await res.json();}catch{throw new Error('malformed catalog success response');}
      if(!data || data.snapshot_hash!==part.snapshot.hash || !['models','inserted','duplicate','conflicts','unsupported'].every(k=>Number.isSafeInteger(data[k])&&data[k]>=0)
        || data.inserted+data.duplicate+data.conflicts!==part.prices.length) throw new Error('invalid catalog success response');
      for(const k of ['inserted','duplicate','conflicts'])totals[k]+=data[k];
    }
  }
  totals.providers=[...providers].sort();totals.unique_models=uniqueModels.size;
  out.write(JSON.stringify({dry_run:!!opts.dryRun,preview:!!opts.preview,...totals})+'\n');return totals;
}
async function main() {
  const opts={db:DEFAULT_DB,dryRun:false,preview:false};
  try {
    for(let i=2;i<process.argv.length;i++) {
      const a=process.argv[i];if(a==='--db'){if(!process.argv[i+1])throw new Error('--db needs a path');opts.db=process.argv[++i];}
      else if(a==='--dry-run')opts.dryRun=true;
      else if(a==='--preview')opts.preview=true;
      else if(a==='--help'){process.stdout.write('spend-import-otari-prices --db PATH [--dry-run | --preview]\nRead-only Otari pricing. --dry-run normalizes locally; --preview reports server conflicts without writes. Accept explicitly by omitting both flags.\n');return 0;}
      else throw new Error(`unknown option ${a}`);
    }
    const cfg=opts.dryRun?{}:loadConfig();if(!opts.dryRun && (!cfg.url||!cfg.token))throw new Error('AIGATE_URL and AIGATE_TOKEN required');
    await run(opts,cfg);return 0;
  }catch(e){process.stderr.write(`spend-import-otari-prices: ${e.message}\n`);return 1;}
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1])process.exit(await main());
