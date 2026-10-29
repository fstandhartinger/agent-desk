import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeFromHash } from '../src/lib/hashLogin.ts';

test('login link parsing', () => {
  assert.equal(codeFromHash('#k=abc%2Fdef'), 'abc/def');
  assert.equal(codeFromHash('#k=abc&x=1'), 'abc');
  assert.equal(codeFromHash('#k='), null);
  assert.equal(codeFromHash('#other'), null);
  assert.equal(codeFromHash('#k=%E0%A4%A'), null);
});
