import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthText, normalizeStatus } from '../src/lib/status.ts';

test('providerHealth snapshot maps to ok / failed / unknown / off per provider (D4)', () => {
  const s = normalizeStatus({
    bridges: [{ host: 'lechonk', connected: true, claude: { running: 1, max: 3 } }],
    providers: {
      xai: { configured: true, ok: false, reason: 'xAI-Guthaben aufgebraucht', checkedAt: '2026-10-24T10:00:00Z' },
      openai: { configured: true, ok: null },
      gemini: { configured: true, ok: true },
      openrouter: { configured: true, ok: true },
      elevenlabs: { configured: false, ok: null },
    },
  });
  assert.deepEqual(s.providers, {
    xai: { state: 'failed', reason: 'xAI-Guthaben aufgebraucht' },
    openai: { state: 'unknown' },
    gemini: { state: 'ok' },
  });
  assert.equal(s.bridges[0].running, 1);
  assert.equal(healthText(s.providers.xai), 'xAI-Guthaben aufgebraucht');
  assert.equal(healthText(s.providers.openai), 'eingerichtet, noch nicht genutzt');
});

test('round-1 gateway shape: config flags with "google" still light up Gemini (critic D4a)', () => {
  const s = normalizeStatus({ providers: { xai: true, openai: true, google: true, openrouter: true } });
  assert.deepEqual(s.providers.gemini, { state: 'unknown' });
  assert.deepEqual(s.providers.xai, { state: 'unknown' });
});

test('a configured=false provider is off even if a stale ok is present', () => {
  const s = normalizeStatus({ providers: { openai: { configured: false, ok: true } } });
  assert.deepEqual(s.providers.openai, { state: 'off' });
  assert.equal(healthText(s.providers.openai), 'nicht eingerichtet');
});
