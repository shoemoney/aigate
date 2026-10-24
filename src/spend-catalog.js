/** Dated catalog metadata and provenance. Monetary truth remains spend_prices. */
import { createHash } from 'node:crypto';
import { fromMicros, pickRate } from './spend-pricing.js';

export const RATE_FIELDS = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_1h'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const check = (ok, message) => { if (!ok) throw new TypeError(message); };
export const digest = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
export function iso(value) {
  let s = String(value ?? '').trim().replace(' ', 'T');
  if (!/(?:Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z';
  const n = Date.parse(s);
  check(Number.isFinite(n) && n >= Date.parse('2020-01-01'), 'invalid date');
  return new Date(n).toISOString();
}
// Exact decimal/exponent conversion. scale=6 for USD/MTok, scale=12 for USD/token.
export function decimalMicros(value, scale = 6) {
  const m = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value ?? '').trim());
  check(m && Math.abs(Number(m[3] || 0)) <= 100, 'invalid nonnegative decimal rate');
  const digits = BigInt(m[1] + (m[2] || ''));
  const shift = scale + Number(m[3] || 0) - (m[2] || '').length;
  const n = shift >= 0 ? digits * 10n ** BigInt(shift) : (digits + 10n ** BigInt(-shift) / 2n) / 10n ** BigInt(-shift);
  check(n <= BigInt(Number.MAX_SAFE_INTEGER), 'rate exceeds safe integer');
  return Number(n);
}

export function ensureCatalogSchema(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(spend_prices)').all().map(r => r.name));
  if (!cols.has('catalog_source')) db.exec("ALTER TABLE spend_prices ADD COLUMN catalog_source TEXT NOT NULL DEFAULT 'manual'");
  db.exec(`CREATE TABLE IF NOT EXISTS spend_catalog_snapshots (
    hash TEXT PRIMARY KEY, source TEXT NOT NULL, source_as_of TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE IF NOT EXISTS spend_catalog_models (
    snapshot_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, source_model_key TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT NOT NULL, unsupported INTEGER NOT NULL, metadata_json TEXT NOT NULL,
    PRIMARY KEY(snapshot_hash,provider,model,source_model_key));
    CREATE TABLE IF NOT EXISTS spend_catalog_provenance (
    snapshot_hash TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, effective_from TEXT NOT NULL,
    source_model_key TEXT NOT NULL, price_id INTEGER, outcome TEXT NOT NULL,
    PRIMARY KEY(snapshot_hash,provider,model,effective_from));
    CREATE INDEX IF NOT EXISTS idx_catalog_model ON spend_catalog_models(provider,model);`);
}

function ident(v) { check(typeof v === 'string' && /^[A-Za-z0-9._:@/~+*-]{1,256}$/.test(v), 'invalid provider/model identifier'); return v; }
function text(v, max) { check(typeof (v ?? '') === 'string' && String(v ?? '').length <= max, 'invalid catalog text'); return v ?? ''; }
function keys(v, allowed) { check(object(v), 'expected JSON object'); for (const k of Object.keys(v)) check(allowed.includes(k), `unknown catalog field: ${k}`); }
function normalizePrice(r) {
  keys(r, ['provider','model','effective_from','input_usd','output_usd','cache_read_usd','cache_write_usd','cache_write_1h_usd','tiers','source_model_key','note']);
  const p = { provider:ident(r.provider), model:ident(r.model), effective_from:iso(r.effective_from), match:'exact',
    source_model_key:text(r.source_model_key || `${r.provider}:${r.model}`, 511), note:text(r.note, 2000) };
  for (const f of RATE_FIELDS) p[f+'_micros'] = r[f+'_usd'] == null ? null : decimalMicros(r[f+'_usd']);
  check(p.input_micros != null && p.output_micros != null, 'input/output token rates are required');
  check(Array.isArray(r.tiers ?? []) && (r.tiers ?? []).length <= 100, 'invalid tiers');
  p.tiers_json = JSON.stringify((r.tiers || []).map(t => {
    keys(t, ['min_input_tokens', ...RATE_FIELDS.map(f=>f+'_usd')]);
    check(Number.isSafeInteger(t.min_input_tokens) && t.min_input_tokens >= 0, 'invalid tier threshold');
    const out = { min_input_tokens:t.min_input_tokens };
    for (const f of RATE_FIELDS) if (t[f+'_usd'] != null) out[f+'_micros'] = decimalMicros(t[f+'_usd']);
    return out;
  }));
  return p;
}

export function importCatalog(db, body) {
  keys(body, ['source','snapshot','models','prices','dry_run']);
  check(typeof body.dry_run === 'boolean' || body.dry_run === undefined, 'dry_run must be boolean');
  check(body.source === 'otari', 'source must be otari');
  keys(body.snapshot, ['hash','source_as_of']);
  check(/^[a-f0-9]{64}$/.test(body.snapshot.hash), 'invalid snapshot hash');
  const hash = body.snapshot.hash, asof = iso(body.snapshot.source_as_of);
  check(Array.isArray(body.models ?? []) && Array.isArray(body.prices ?? []), 'models/prices must be arrays');
  check((body.models?.length || 0) <= 1000 && (body.prices?.length || 0) <= 1000, 'catalog batch exceeds 1000');
  const models = (body.models || []).map(m => {
    keys(m, ['provider','model','name','description','source_model_key','unsupported','metadata']);
    check(typeof m.unsupported === 'boolean' || m.unsupported === undefined, 'unsupported must be boolean');
    const metadata = JSON.stringify(m.metadata ?? {}); check(metadata.length <= 32000, 'model metadata too large');
    return { provider:ident(m.provider), model:ident(m.model), name:text(m.name,512), description:text(m.description,8000),
      source_model_key:text(m.source_model_key || `${m.provider}:${m.model}`,511), unsupported:!!m.unsupported, metadata };
  });
  const prices = (body.prices || []).map(normalizePrice);
  const existing = db.prepare('SELECT * FROM spend_catalog_snapshots WHERE hash=?').get(hash);
  check(!existing || (existing.source === body.source && existing.source_as_of === asof), 'snapshot hash metadata conflict');
  const out = { dry_run:!!body.dry_run, snapshot_hash:hash, models:0, inserted:0, duplicate:0, conflicts:0,
    unsupported:models.filter(m=>m.unsupported).length, conflict_details:[] };
  const lookup = db.prepare('SELECT * FROM spend_prices WHERE provider=? AND model=? AND effective_from=?');
  const fields = [...RATE_FIELDS.map(f=>f+'_micros'), 'tiers_json'];
  db.exec('SAVEPOINT catalog_import');
  try {
    db.prepare('INSERT OR IGNORE INTO spend_catalog_snapshots(hash,source,source_as_of) VALUES(?,?,?)').run(hash,body.source,asof);
    for (const m of models) out.models += Number(db.prepare('INSERT OR IGNORE INTO spend_catalog_models VALUES(?,?,?,?,?,?,?,?)')
      .run(hash,m.provider,m.model,m.source_model_key,m.name,m.description,+m.unsupported,m.metadata).changes);
    for (const p of prices) {
      let row = lookup.get(p.provider,p.model,p.effective_from), outcome;
      if (row) {
        if (fields.every(f=>row[f] === p[f])) { out.duplicate++; outcome='duplicate'; }
        else { out.conflicts++; outcome='conflict'; out.conflict_details.push({provider:p.provider,model:p.model,effective_from:p.effective_from,price_id:row.id,source:row.catalog_source}); }
      } else {
        const result = db.prepare(`INSERT INTO spend_prices(provider,model,match,effective_from,input_micros,output_micros,cache_read_micros,cache_write_micros,cache_write_1h_micros,tiers_json,note,catalog_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(p.provider,p.model,p.match,p.effective_from,...RATE_FIELDS.map(f=>p[f+'_micros']),p.tiers_json,p.note,'otari');
        row = {id:Number(result.lastInsertRowid)}; out.inserted++; outcome='inserted';
      }
      db.prepare('INSERT OR IGNORE INTO spend_catalog_provenance VALUES(?,?,?,?,?,?,?)')
        .run(hash,p.provider,p.model,p.effective_from,p.source_model_key,row.id,outcome);
    }
    if (body.dry_run) db.exec('ROLLBACK TO catalog_import');
    db.exec('RELEASE catalog_import');
  } catch (e) { db.exec('ROLLBACK TO catalog_import; RELEASE catalog_import'); throw e; }
  return out;
}

const rateOut = row => {
  const out = {price_id:row?.id ?? null,effective_from:row?.effective_from ?? null,tiers:[]};
  for (const f of RATE_FIELDS) out[f+'_usd'] = row?.[f+'_micros'] == null ? null : Number(fromMicros(row[f+'_micros']));
  if (row) {
    out.tiers = JSON.parse(row.tiers_json || '[]').map(t => {
      const v={min_input_tokens:t.min_input_tokens};
      for (const f of RATE_FIELDS) v[f+'_usd']=t[f+'_micros']==null?null:Number(fromMicros(t[f+'_micros']));
      return v;
    });
    out.note=row.note;
  }
  return out;
};
function allItems(db, asof) {
  const rates = db.prepare('SELECT * FROM spend_prices WHERE effective_from<=?').all(asof);
  const metadata = db.prepare(`SELECT m.*,s.source,s.source_as_of FROM spend_catalog_models m JOIN spend_catalog_snapshots s ON s.hash=m.snapshot_hash WHERE s.source_as_of<=? ORDER BY s.source_as_of DESC,s.accepted_at DESC`).all(asof);
  const provenance = db.prepare(`SELECT p.*,s.source,s.source_as_of FROM spend_catalog_provenance p JOIN spend_catalog_snapshots s ON s.hash=p.snapshot_hash WHERE p.outcome!='conflict' AND s.source_as_of<=? ORDER BY s.source_as_of DESC`).all(asof);
  const meta=new Map(), prov=new Map(), ids=new Map();
  for (const m of metadata) if (!meta.has(`${m.provider}\0${m.model}`)) meta.set(`${m.provider}\0${m.model}`,m);
  for (const p of provenance) if (!prov.has(p.price_id)) prov.set(p.price_id,p);
  for (const m of metadata) ids.set(`${m.provider}\0${m.model}`,{provider:m.provider,model:m.model});
  for (const r of rates) ids.set(`${r.provider}\0${r.model}`,{provider:r.provider,model:r.model});
  return [...ids.entries()].map(([key,id]) => {
    const m=meta.get(key), r=pickRate(rates,id.provider,id.model,asof), p=r?prov.get(r.id):null;
    return {...id,name:m?.name || id.model,description:m?.description || '',...rateOut(r),priced:!!r,unit:r?'USD / 1M tokens':null,
      unsupported:!!m?.unsupported,metadata:m?JSON.parse(m.metadata_json):{},source:r?.catalog_source==='manual'?'manual':p?.source || r?.catalog_source || m?.source || null,
      source_as_of:p?.source_as_of || m?.source_as_of || null,source_model_key:p?.source_model_key || m?.source_model_key || null,snapshot_hash:p?.snapshot_hash || m?.snapshot_hash || null};
  }).sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model));
}
export function readCatalog(db, params = new URLSearchParams()) {
  const asof=params.get('as_of')?iso(params.get('as_of')):new Date().toISOString();
  const provider=params.get('provider') || '', q=(params.get('q') || '').toLowerCase();
  const limit=params.has('limit')?Number(params.get('limit')):50;
  check(Number.isInteger(limit)&&limit>0&&limit<=200,'limit must be 1..200');
  const filter=digest([provider,q,params.get('as_of') || 'now']); let offset=0;
  if (params.get('cursor')) {
    try { const c=JSON.parse(Buffer.from(params.get('cursor'),'base64url')); check(c.filter===filter&&Number.isSafeInteger(c.offset)&&c.offset>=0,'invalid cursor'); offset=c.offset; }
    catch { throw new TypeError('invalid cursor'); }
  }
  const rows=allItems(db,asof).filter(r=>(!provider||r.provider===provider)&&(!q||[r.provider,r.model,r.name].some(v=>v.toLowerCase().includes(q))));
  return {as_of:asof,items:rows.slice(offset,offset+limit),total:rows.length,next_cursor:offset+limit<rows.length?Buffer.from(JSON.stringify({filter,offset:offset+limit})).toString('base64url'):null};
}
export function readCatalogHistory(db, params) {
  const provider=ident(params.get('provider')), model=ident(params.get('model'));
  const now=new Date().toISOString(), current=allItems(db,now).find(r=>r.provider===provider&&r.model===model) || null;
  const versions=db.prepare('SELECT * FROM spend_prices WHERE provider=? AND model=? ORDER BY effective_from DESC').all(provider,model).map(r=>{
    const p=db.prepare(`SELECT p.*,s.source,s.source_as_of FROM spend_catalog_provenance p JOIN spend_catalog_snapshots s ON s.hash=p.snapshot_hash WHERE price_id=? AND outcome!='conflict' ORDER BY s.source_as_of DESC LIMIT 1`).get(r.id);
    return {provider,model,...rateOut(r),source:r.catalog_source==='manual'?'manual':p?.source || r.catalog_source,source_as_of:p?.source_as_of||null,source_model_key:p?.source_model_key||null,snapshot_hash:p?.snapshot_hash||null};
  });
  const snapshots=db.prepare(`SELECT DISTINCT s.* FROM spend_catalog_snapshots s JOIN spend_catalog_models m ON m.snapshot_hash=s.hash WHERE m.provider=? AND m.model=? ORDER BY s.source_as_of DESC`).all(provider,model);
  return {provider,model,current,versions,snapshots};
}
