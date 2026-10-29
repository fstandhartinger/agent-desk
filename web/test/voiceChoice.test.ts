import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseVoice, voiceUnavailableNotice } from '../src/lib/voiceChoice.ts';
import { optionByKey } from '../src/lib/voice.ts';

const grok = optionByKey('xai');

test('a usable choice starts as is', () => {
  assert.deepEqual(chooseVoice(grok, { xai: { state: 'ok' }, gemini: { state: 'ok' } }), { run: grok });
  assert.deepEqual(chooseVoice(grok, {}), { run: grok }, 'unknown status: try the choice');
  assert.deepEqual(chooseVoice(grok, { xai: { state: 'unknown' } }), { run: grok });
});

test('a provider known to be down starts Gemini extended at once and keeps the choice as "picked"', () => {
  const r = chooseVoice(grok, { xai: { state: 'failed', reason: 'Kein Guthaben' }, openai: { state: 'unknown' }, gemini: { state: 'ok' } });
  assert.equal(r.run.key, 'gemini');
  assert.equal(r.picked, grok);
  assert.equal(voiceUnavailableNotice(r.picked!, r.run), 'Grok Voice 3.0 ist nicht verfügbar – Gemini 3.8 Live übernimmt.');
});

test('when the choice is ok again it is used; an unusable Gemini is skipped; nothing usable keeps the choice', () => {
  assert.equal(chooseVoice(grok, { xai: { state: 'ok' }, gemini: { state: 'ok' } }).run.key, 'xai');
  assert.equal(chooseVoice(grok, { xai: { state: 'failed' }, gemini: { state: 'off' }, openai: { state: 'ok' } }).run.key, 'openai');
  assert.deepEqual(chooseVoice(grok, { xai: { state: 'failed' }, gemini: { state: 'failed' }, openai: { state: 'off' } }), { run: grok });
  assert.equal(chooseVoice(optionByKey('gemini'), { gemini: { state: 'failed' }, xai: { state: 'ok' }, openai: { state: 'failed' } }).run.key, 'xai');
});
