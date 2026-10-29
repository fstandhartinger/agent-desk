// Test module for offload.js / redact() budgets: a redactText that never finishes in time, plus small helpers.
export function spin(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy, like a backtracking regex */ }
  return 'spun';
}
export const redactText = () => spin(60_000);
export const echo = (v) => v;
export function boom() { throw new Error('boom'); }
