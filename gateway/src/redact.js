// Secret scrubbing for anything that leaves the process as text (tool results, audit, logs, errors).
// The patterns live in redactPatterns.js, a byte-identical copy of bridge/src/redactPatterns.js.
import { createPool, createSyncRunner } from './offload.js';
import { redactText } from './redactPatterns.js';

// Critic round 7, P2-1: inputs above OFFLOAD_FROM are redacted in a worker with a hard budget, so no crafted text can hold
// the event loop longer than REDACT_BUDGET_MS. On timeout the text is never returned unredacted (fail closed).
export const OFFLOAD_FROM = 8_192;
export const REDACT_BUDGET_MS = 1_500;
export const REDACT_FALLBACK = '[Inhalt ausgeblendet: zu komplex für die Prüfung auf Geheimnisse]';
let offload = { patterns: new URL('./redactPatterns.js', import.meta.url).href, budgetMs: REDACT_BUDGET_MS };
let sync = null;
let pool = null;

export function redact(text) {
  const s = String(text);
  if (s.length <= OFFLOAD_FROM) return redactText(s);
  sync ??= createSyncRunner({ preload: [offload.patterns] });
  try { return sync.run(offload.patterns, 'redactText', [s], offload.budgetMs); } catch { return REDACT_FALLBACK; }
}

/** redact() for async callers (tool results): the work runs in the pool, the event loop stays free. */
export async function redactAsync(text) {
  const s = String(text);
  if (s.length <= OFFLOAD_FROM) return redactText(s);
  pool ??= createPool({ size: 2, preload: [offload.patterns] });
  try { return await pool.run(offload.patterns, 'redactText', [s], offload.budgetMs); } catch { return REDACT_FALLBACK; }
}

/** Starts the workers now, so the first big tool result does not pay the start-up (~40-70 ms). */
export function warmRedact() {
  sync ??= createSyncRunner({ preload: [offload.patterns] });
  pool ??= createPool({ size: 2, preload: [offload.patterns] });
  return pool.run(offload.patterns, 'redactText', ['warm'], 10_000).catch(() => {});
}

/** Tests: another patterns module / budget (the fail-closed path). Returns a function that restores the defaults. */
export function setRedactOffloadForTests(next) {
  const before = offload;
  const reset = () => { sync?.close(); pool?.close(); sync = null; pool = null; };
  reset();
  offload = { ...offload, ...next };
  return () => { reset(); offload = before; };
}

/** Redact every string inside a JSON-like value. */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

export function short(text, max = 200) {
  const flat = redact(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
