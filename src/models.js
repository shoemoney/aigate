/**
 * aigate/models — the role -> model map behind POST /api/prompt.
 *
 * Callers pick a ROLE, never a model. The bundled map (models.json) can be replaced
 * without a rebuild by dropping a models.json next to the database; an override that
 * fails validation is logged once and the bundled map stays in force.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), 'models.json');
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;   // no leading '-': a model name must never parse as a CLI flag
const TIER_RE = /^[a-z][a-z0-9_]{0,31}$/;

// Returns a plain {role: {engine, model, service_tier?}} map or throws with the reason.
export function validateModels(j) {
  const roles = j && typeof j === 'object' && !Array.isArray(j) ? j.roles : null;
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error('"roles" must be an object');
  const out = Object.create(null);
  for (const [name, e] of Object.entries(roles)) {
    if (!ROLE_RE.test(name)) throw new Error(`bad role name ${JSON.stringify(name)}`);
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`role ${name}: entry must be an object`);
    for (const k of Object.keys(e)) if (!['engine', 'model', 'service_tier'].includes(k)) throw new Error(`role ${name}: unknown key ${k}`);
    if (e.engine !== 'claude' && e.engine !== 'codex') throw new Error(`role ${name}: engine must be claude or codex`);
    if (typeof e.model !== 'string' || !MODEL_RE.test(e.model)) throw new Error(`role ${name}: bad model`);
    if (e.service_tier != null && (e.engine !== 'codex' || typeof e.service_tier !== 'string' || !TIER_RE.test(e.service_tier))) throw new Error(`role ${name}: bad service_tier`);
    out[name] = { engine: e.engine, model: e.model, ...(e.service_tier ? { service_tier: e.service_tier } : {}) };
  }
  const names = Object.keys(out);
  if (names.length === 0) throw new Error('no roles defined');
  // GPT is exactly one entry: the role "gpt", on the codex engine, and nothing else may use codex
  const codex = names.filter((n) => out[n].engine === 'codex');
  if (codex.length > 1 || (codex.length === 1 && codex[0] !== 'gpt')) throw new Error('only the role "gpt" may use the codex engine');
  if (out.gpt && out.gpt.engine !== 'codex') throw new Error('role "gpt" must use the codex engine');
  return out;
}

// dbPath: AIGATE_DB. Re-read on every call (a few hundred bytes) so a new release is a data
// change that needs no restart; parsed results are cached by file text so a bad override logs once.
export function createModelMap(dbPath, log = (m) => console.error(m)) {
  const overridePath = join(dirname(dbPath), 'models.json');
  const bundled = validateModels(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  let lastText = null, lastResult = null;
  return function current() {
    let text = null;
    try { text = readFileSync(overridePath, 'utf8'); } catch { /* no override */ }
    if (text === null) { lastText = null; lastResult = null; return { roles: bundled, source: 'bundled', path: BUNDLED }; }
    if (text !== lastText) {
      lastText = text;
      try { lastResult = { roles: validateModels(JSON.parse(text)), source: 'override', path: overridePath }; }
      catch (e) {
        log(`[models] ignoring invalid override ${overridePath}: ${String((e && e.message) || e)} — using the bundled map`);
        lastResult = { roles: bundled, source: 'bundled', path: BUNDLED, override_invalid: true };
      }
    }
    return lastResult;
  };
}
