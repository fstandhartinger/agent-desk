// Last known usability of each vendor, so the UI can tell "configured" from "works right now" (round 2, D4).
// Owned by r2-backend; r2-voice calls markFailure/markOk. Contract:
//   markFailure(provider, reason)   provider in xai|openai|gemini|openrouter|elevenlabs; reason = short German text
//   markOk(provider)
//   snapshot() -> { [provider]: { configured: boolean, ok: boolean|null, reason?: string, checkedAt?: string } }
//     ok=null: never used yet; a failure counts for FAILURE_TTL_MS (then ok=null again, i.e. "unknown, try").
//   Round 6: a success survives a process restart (file in production or DESK_HEALTH_FILE), so a vendor that worked
//     today never reads "ok=null" just because the gateway was redeployed; failures are never persisted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { providerFlags } from './config.js';

const FAILURE_TTL_MS = 10 * 60_000;
const OK_FILE_TTL_MS = 24 * 60 * 60_000; // a persisted success counts for a day
const state = new Map();

const healthFile = () => {
  const explicit = process.env.DESK_HEALTH_FILE;
  if (explicit !== undefined) return explicit; // '' = off
  return process.env.NODE_ENV === 'production' ? path.join(os.tmpdir(), 'agent-desk-provider-health.json') : '';
};

function persist() {
  const file = healthFile();
  if (!file) return;
  try {
    const okAt = Object.fromEntries([...state].filter(([, s]) => s.ok).map(([name, s]) => [name, s.at]));
    fs.writeFileSync(file, JSON.stringify(okAt));
  } catch { /* health is advisory */ }
}

let loaded = false;
function restore() {
  if (loaded) return;
  loaded = true;
  const file = healthFile();
  if (!file) return;
  try {
    for (const [name, at] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
      if (typeof at === 'number' && Date.now() - at < OK_FILE_TTL_MS && !state.has(name)) state.set(name, { ok: true, at });
    }
  } catch { /* no file yet */ }
}

export function markFailure(provider, reason) {
  restore();
  state.set(provider, { ok: false, reason: String(reason || '').slice(0, 160), at: Date.now() });
}

export function markOk(provider) {
  restore();
  const before = state.get(provider);
  state.set(provider, { ok: true, at: Date.now() });
  if (!before?.ok || Date.now() - before.at > 60_000) persist();
}

export function snapshot(now = Date.now()) {
  restore();
  const flags = providerFlags();
  const configured = { xai: flags.xai, openai: flags.openai, gemini: flags.google, openrouter: flags.openrouter, elevenlabs: flags.elevenlabs };
  const out = {};
  for (const [name, isConfigured] of Object.entries(configured)) {
    const s = state.get(name);
    const fresh = s && (s.ok || now - s.at < FAILURE_TTL_MS);
    out[name] = { configured: isConfigured, ok: fresh ? s.ok : null, ...(fresh && s.reason ? { reason: s.reason } : {}), ...(s ? { checkedAt: new Date(s.at).toISOString() } : {}) };
  }
  return out;
}

export function resetProviderHealthForTests() {
  state.clear();
  loaded = true; // tests start from an empty state, never from a file
}
