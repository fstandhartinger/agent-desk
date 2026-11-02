import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairingId, companionEntry, deviceLoginContext, pairingCallback } from '../src/lib/deviceEntry';

test('only bounded URL-safe device nonces enter pairing; arbitrary query secrets are ignored', () => {
  assert.equal(pairingId({ pathname: '/device', search: '?pair=' + 'a'.repeat(43) }), 'a'.repeat(43));
  for (const value of ['', 'a'.repeat(42), 'a'.repeat(44), '../device', 'a'.repeat(42) + '%2F']) {
    assert.equal(pairingId({ pathname: '/device', search: '?pair=' + value }), null);
  }
  assert.equal(pairingId({ pathname: '/', search: '?pair=' + 'a'.repeat(43) }), null);
});

test('confirmation only navigates to an exact one-use IPv4 loopback callback with a nonprivileged port', () => {
  const callback = `http://127.0.0.1:45678/ScreenAgent/${'r'.repeat(43)}/?proof=${'p'.repeat(43)}`;
  assert.equal(pairingCallback(callback), callback);
  for (const bad of [
    null, {}, callback.replace('127.0.0.1', 'localhost'), callback.replace('127.0.0.1', 'attacker.test'),
    callback.replace('127.0.0.1', '127.0.0.1@attacker.test'), callback.replace('45678', '01024'),
    callback.replace('45678', '1023'), callback.replace('45678', '65536'), callback + '#secret',
    callback + '&next=https://attacker.test', callback.replace('/?proof=', '?proof='),
    callback.replace('http:', 'https:'), callback.replace('proof=', 'other='), callback.replace('proof=', 'proof=%2F'),
  ]) assert.equal(pairingCallback(bad), null);
});

test('only explicit app first-run entry bypasses web login; browser pairing still requires login', () => {
  assert.equal(companionEntry({ pathname: '/device', search: '?companion=1' }), true);
  assert.equal(companionEntry({ pathname: '/device', search: '?pair=' + 'a'.repeat(43) }), false);
  assert.equal(companionEntry({ pathname: '/', search: '?companion=1' }), false);
  assert.equal(deviceLoginContext({ pathname: '/device', search: '' }), true);
  assert.equal(deviceLoginContext({ pathname: '/', search: '?x=intro' }), false);
});
