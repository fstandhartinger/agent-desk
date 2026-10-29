import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOf } from '../../web/src/lib/providerAvailability.ts';
import { snapshot, markFailure, markOk, resetProviderHealthForTests } from '../src/providerHealth.js';

test('picker availability is derived from the real providerHealth snapshot shape', (t) => {
  // critic r3 P2-6: "configured" comes from the env; the test sets its own synthetic keys and restores the host's values
  const saved = { XAI_API_KEY: process.env.XAI_API_KEY, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
  process.env.XAI_API_KEY = 'xai-test-key';
  process.env.GEMINI_API_KEY = 'gemini-test-key'; // P2-5: synthetic, so the test passes on a host without (or with a real) Gemini key
  process.env.GOOGLE_API_KEY = 'google-test-key'; // the gateway reads GOOGLE_API_KEY (config.js); GEMINI_API_KEY is set too, for any alias
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  resetProviderHealthForTests();
  markFailure('xai', 'Grok Voice ist gerade nicht verfügbar (xAI-Guthaben aufgebraucht)');
  markOk('gemini');
  const snap = snapshot();
  assert.deepEqual(availabilityOf(snap.xai), { level: 'down', label: 'Braucht Guthaben', reason: snap.xai.reason });
  assert.equal(availabilityOf(snap.gemini).level, 'ok');
  assert.equal(availabilityOf({ configured: true, ok: null }).level, 'unknown');
  assert.equal(availabilityOf({ configured: false, ok: null }).level, 'missing');
  assert.equal(availabilityOf({ configured: true, ok: false, reason: 'Verbindung unerwartet abgebrochen' }).label, 'Gerade gestört');
  assert.equal(availabilityOf(true).level, 'unknown');
  assert.equal(availabilityOf(false).level, 'missing');
  resetProviderHealthForTests();
});
