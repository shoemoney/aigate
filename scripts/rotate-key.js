#!/usr/bin/env node
/**
 * rotate-key.js — re-encrypt the whole vault under a NEW AIGATE_ENCRYPTION_KEY.
 *
 * AIGATE_ENCRYPTION_KEY was "load-bearing forever" with no recovery path — this makes
 * key rotation (suspected .env compromise, routine hygiene) a supported one-shot op
 * instead of "rebuild every account + key by hand". Runs inside a single transaction so
 * a crash mid-rotation rolls back cleanly rather than leaving a half-migrated vault.
 *
 * BACK UP data/aigate.db first (or just copy the newest data/backups/aigate-*.db).
 *
 * Usage:
 *   AIGATE_ENCRYPTION_KEY=<current hex>  node scripts/rotate-key.js <newHexKey>
 * then set AIGATE_ENCRYPTION_KEY=<newHexKey> in .env and restart aigate.
 */
import { DatabaseSync } from 'node:sqlite';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeVault } from '../src/lib.js';

try { process.loadEnvFile(); } catch { /* no .env, use real env */ }
const __dir = dirname(fileURLToPath(import.meta.url));
const OLD = (process.env.AIGATE_ENCRYPTION_KEY || '').trim();
const NEW = (process.argv[2] || process.env.AIGATE_NEW_ENCRYPTION_KEY || '').trim();
const DB_PATH = process.env.AIGATE_DB || join(__dir, '..', 'data', 'aigate.db');
const hex64 = (k) => /^[0-9a-fA-F]{64}$/.test(k);

if (!hex64(OLD)) { console.error('FATAL: current AIGATE_ENCRYPTION_KEY (old key) must be 32-byte hex'); process.exit(1); }
if (!hex64(NEW)) { console.error('FATAL: new key must be 32-byte hex — pass it as arg 1 (openssl rand -hex 32)'); process.exit(1); }
if (OLD.toLowerCase() === NEW.toLowerCase()) { console.error('new key == old key — nothing to rotate'); process.exit(1); }

const oldV = makeVault(Buffer.from(OLD, 'hex'));
const newV = makeVault(Buffer.from(NEW, 'hex'));
const db = new DatabaseSync(DB_PATH);

// prove the OLD key actually opens this vault before touching a single row
const canary = db.prepare(`SELECT v FROM meta WHERE k='canary'`).get();
if (canary) { try { oldV.decrypt(canary.v); } catch { console.error('FATAL: the current AIGATE_ENCRYPTION_KEY does not decrypt this vault — aborting, nothing changed'); process.exit(1); } }

const reenc = (enc) => newV.encrypt(oldV.decrypt(enc));   // throws on any bad row → whole txn rolls back
let accounts = 0, keys = 0;
db.exec('BEGIN');
try {
  for (const r of db.prepare(`SELECT account, token_enc FROM accounts WHERE token_enc IS NOT NULL`).all()) {
    db.prepare(`UPDATE accounts SET token_enc=? WHERE account=?`).run(reenc(r.token_enc), r.account); accounts++;
  }
  for (const r of db.prepare(`SELECT id, key_enc FROM provider_keys`).all()) {
    db.prepare(`UPDATE provider_keys SET key_enc=? WHERE id=?`).run(reenc(r.key_enc), r.id); keys++;
  }
  // rewrite the canary under the NEW key so the next boot's guard passes
  db.prepare(`INSERT INTO meta(k,v) VALUES('canary',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(newV.encrypt('aigate-canary'));
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); console.error('FATAL: rotation failed, rolled back — nothing changed:', String((e && e.message) || e)); process.exit(1); }
db.close();
console.log(`rotated ${accounts} account token(s) + ${keys} provider key(s).`);
console.log(`NEXT: set AIGATE_ENCRYPTION_KEY=${NEW} in .env and restart aigate.`);
