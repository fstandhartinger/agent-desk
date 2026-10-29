// Patterns shared with the gateway: redactPatterns.js is a byte-identical copy of gateway/src/redactPatterns.js.
import { createPool, createSyncRunner } from './offload.js';
import { redactText } from './redactPatterns.js';
import { redactExactValues, redactFragments } from './secretValues.js';

// Critic round 7, P2-1: the shape patterns run in a worker with a hard budget for inputs above OFFLOAD_FROM (the same
// rule as gateway/src/redact.js). On timeout the text is never returned unredacted (fail closed). Exact values and
// fragments stay on this thread: they are substring and hash lookups, linear in the text.
export const OFFLOAD_FROM = 8_192;
export const REDACT_BUDGET_MS = 1_500;
export const REDACT_FALLBACK = '[Inhalt ausgeblendet: zu komplex für die Prüfung auf Geheimnisse]';
let offload = { patterns: new URL('./redactPatterns.js', import.meta.url).href, budgetMs: REDACT_BUDGET_MS };
let sync = null;
let pool = null;

function patternsSync(text) {
  if (text.length <= OFFLOAD_FROM) return redactText(text);
  sync ??= createSyncRunner({ preload: [offload.patterns] });
  try { return sync.run(offload.patterns, 'redactText', [text], offload.budgetMs); } catch { return null; }
}

async function patternsAsync(text) {
  if (text.length <= OFFLOAD_FROM) return redactText(text);
  pool ??= createPool({ size: 2, preload: [offload.patterns] });
  try { return await pool.run(offload.patterns, 'redactText', [text], offload.budgetMs); } catch { return null; }
}

/** Tests: another patterns module / budget (the fail-closed path). Returns a function that restores the defaults. */
export function setRedactOffloadForTests(next) {
  const before = offload;
  const reset = () => { sync?.close(); pool?.close(); sync = null; pool = null; };
  reset();
  offload = { ...offload, ...next };
  return () => { reset(); offload = before; };
}

// Known secret values of this host first (exact match, any context), then the shape-based patterns, then 16-char
// fragments of known values (this host's and the Sandy hash file's, see secretValues.js).
export function redact(text) {
  if (typeof text !== 'string') return text;
  const shaped = patternsSync(redactExactValues(text));
  return shaped === null ? REDACT_FALLBACK : redactFragments(shaped);
}

/** redact() for async callers (method results): big texts are redacted in the pool, the event loop stays free. */
export async function redactAsync(text) {
  if (typeof text !== 'string') return text;
  const shaped = await patternsAsync(redactExactValues(text));
  return shaped === null ? REDACT_FALLBACK : redactFragments(shaped);
}

/** Redact every string inside a JSON-like value (used on anything that leaves the bridge). */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

/** redactDeep() with redactAsync() for every string. */
export async function redactDeepAsync(value) {
  if (typeof value === 'string') return redactAsync(value);
  if (Array.isArray(value)) return Promise.all(value.map(redactDeepAsync));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await redactDeepAsync(v)])));
  }
  return value;
}
