import assert from 'node:assert/strict';
import { it } from 'node:test';
import { handleNativeMessage, companionMuted, setCompanionMuted } from '../src/lib/companion';
it('host mute state changes before ack; invalid host values cannot toggle microphone', () => {
  const acks: unknown[] = [];
  const host = { postMessage: (msg: unknown) => { assert.equal(companionMuted(), (msg as { on: boolean }).on); acks.push(msg); } };
  setCompanionMuted(false);
  handleNativeMessage({ type: 'mute', on: true }, host, () => {}); assert.equal(companionMuted(), true);
  for (const msg of [{ type: 'mute', on: 'false' }, null, 'mute']) handleNativeMessage(msg, host, () => {});
  assert.equal(companionMuted(), true); assert.equal(acks.length, 1);
  handleNativeMessage({ type: 'mute', on: false }, host, () => {}); assert.equal(companionMuted(), false);
  assert.deepEqual(acks, [{ type: 'mute-ack', on: true }, { type: 'mute-ack', on: false }]);
});
it('screen row accepts only canonical IDs, deduplicates and bounds host messages', () => {
  let ids: string[] = [];
  const show = (value: string[]) => { ids = value; };
  handleNativeMessage({ type: 'screen', ids: ['ABCDEF', 'abcdef', '<script>', null, '123abc'] }, { postMessage() {} }, show);
  assert.deepEqual(ids, ['abcdef', '123abc']);
  handleNativeMessage({ type: 'screen', ids: Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(6, '0')) }, { postMessage() {} }, show);
  assert.equal(ids.length, 20);
  handleNativeMessage({ type: 'screen', ids: [] }, { postMessage() {} }, show); assert.deepEqual(ids, []);
});
