import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchMic, sameMic, micPreference, setMicPreference } from '../src/lib/micChoice.ts';

const devs = [
  { deviceId: 'default', label: 'Standard - Mikrofonarray (Realtek(R) Audio)', kind: 'audioinput' },
  { deviceId: 'communications', label: 'Kommunikation - Headset (Example USB)', kind: 'audioinput' },
  { deviceId: 'a1', label: 'Mikrofonarray (Realtek(R) Audio)', kind: 'audioinput' },
  { deviceId: 'b2', label: 'Headset (Example USB) (1234:abcd)', kind: 'audioinput' },
  { deviceId: 'o1', label: 'Lautsprecher (Realtek(R) Audio)', kind: 'audiooutput' },
];

test('matches the Windows name exactly, with a USB suffix, never the default alias', () => {
  assert.equal(matchMic(devs, 'Mikrofonarray (Realtek(R) Audio)'), 'a1');
  assert.equal(matchMic(devs, 'Headset (Example USB)'), 'b2');
  assert.equal(matchMic(devs, 'Lautsprecher (Realtek(R) Audio)'), null);
  assert.equal(matchMic(devs, 'Gone (Unplugged)'), null);
  assert.equal(matchMic(devs, null), null);
});

test('sameMic tolerates the suffix; no preference is always satisfied', () => {
  assert.ok(sameMic('Headset (Example USB) (1234:abcd)', 'Headset (Example USB)'));
  assert.ok(!sameMic('Mikrofonarray (Realtek(R) Audio)', 'Headset (Example USB)'));
  assert.ok(sameMic('anything', null));
});

test('preference round-trips through localStorage; empty clears it', () => {
  setMicPreference('Headset (Example USB)');
  assert.equal(micPreference(), 'Headset (Example USB)');
  setMicPreference(null);
  assert.equal(micPreference(), null);
});
