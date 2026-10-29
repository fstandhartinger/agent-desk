// Cheap checks of "does this vendor work right now", feeding providerHealth (the header dots). The text and voice
// code paths report their own real failures; these probes catch an empty account before the first voice session.
import { cfg } from './config.js';
import { markFailure, markOk, snapshot } from './providerHealth.js';

const INTERVAL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const NO_CREDIT = 'Kein Guthaben';

/** xAI: GET /v1/models answers 403 once the team has no credits left. */
async function probeXai() {
  const response = await fetch(`${cfg.xaiBase()}/models`, { headers: { authorization: `Bearer ${cfg.xaiKey()}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.ok) return { ok: true };
  if (response.status === 402 || response.status === 403) return { ok: false, reason: NO_CREDIT };
  if (response.status === 401) return { ok: false, reason: 'Schlüssel abgelehnt' };
  return null; // transient: keep the previous state
}

/**
 * OpenAI: /v1/models answers 200 even without credit, so the probe embeds one token (about USD 0.00000002),
 * which answers 429 insufficient_quota / credit_balance_exhausted on an empty account.
 */
async function probeOpenai() {
  const response = await fetch(`${cfg.openaiBase()}/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.openaiKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: 'a' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return { ok: true };
  const code = (await response.json().catch(() => ({})))?.error;
  if (code?.type === 'insufficient_quota' || code?.code === 'insufficient_quota' || code?.code === 'credit_balance_exhausted') return { ok: false, reason: NO_CREDIT };
  if (response.status === 401) return { ok: false, reason: 'Schlüssel abgelehnt' };
  return null;
}

/** Gemini: listing one model answers 200 with a valid key (no tokens, no cost) and 400/403 with a bad one. */
async function probeGemini() {
  const response = await fetch(`${cfg.googleBase()}/models?pageSize=1`, { headers: { 'x-goog-api-key': cfg.googleKey() }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.ok) return { ok: true };
  if ([400, 401, 403].includes(response.status)) return { ok: false, reason: 'Schlüssel abgelehnt' };
  return null;
}

const PROBES = [
  ['xai', cfg.xaiKey, probeXai],
  ['openai', cfg.openaiKey, probeOpenai],
  ['gemini', cfg.googleKey, probeGemini],
];

// A failure that a real call reported (voice session, transcription) stays until its 10 minutes are over;
// a probe only overwrites state it wrote itself or that is unknown.
const probeFailures = new Set();

export async function probeProviders() {
  await Promise.all(PROBES.map(async ([name, key, probe]) => {
    if (!key()) return;
    let result = null;
    try {
      result = await probe();
    } catch {
      return; // network trouble says nothing about the account
    }
    if (!result) return;
    if (!result.ok) {
      probeFailures.add(name);
      markFailure(name, result.reason);
    } else if (probeFailures.delete(name) || snapshot()[name].ok !== false) {
      markOk(name);
    }
  }));
}

/** Probe now and every 10 minutes; returns the stop function. */
export function startProviderProbes() {
  probeProviders().catch(() => {});
  const timer = setInterval(() => probeProviders().catch(() => {}), INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function resetProbesForTests() {
  probeFailures.clear();
}
