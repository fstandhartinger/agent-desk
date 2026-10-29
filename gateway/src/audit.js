import crypto from 'node:crypto';
import { cfg } from './config.js';
import { short } from './redact.js';

let sink = null;

/** Mirror every audit line to the bridge (fire-and-forget). */
export function setAuditSink(fn) {
  sink = fn;
}

export function ipHash(ip) {
  return crypto.createHmac('sha256', cfg.sessionSecret() || 'unset').update(String(ip)).digest('hex').slice(0, 12);
}

/** entry: {action, detail?, ip?, actor?, cost_usd?}. One JSON line to stdout and, when connected, to the bridge. */
export function audit({ action, detail = '', ip, actor = 'florian', cost_usd }) {
  const line = {
    ts: new Date().toISOString(),
    actor,
    ip_hash: ip ? ipHash(ip) : undefined,
    action,
    detail: short(typeof detail === 'string' ? detail : JSON.stringify(detail), 300),
    cost_usd,
  };
  console.log(JSON.stringify(line));
  try {
    sink?.(line);
  } catch {
    // auditing must never break a request
  }
}
