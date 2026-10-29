import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelLabel, plural } from '../src/lib/format.ts';

test('turn counter grammar: 1 Zug, 2 Züge (D16)', () => {
  assert.equal(plural(1, 'Zug', 'Züge'), '1 Zug');
  assert.equal(plural(2, 'Zug', 'Züge'), '2 Züge');
  assert.equal(plural(0, 'Zug', 'Züge'), '0 Züge');
});

test('model badge drops vendor, route suffix and date stamp so it fits untruncated', () => {
  assert.equal(modelLabel('deepseek/deepseek-v4.1-flash-20261017:nitro'), 'deepseek-v4.1-flash');
  assert.equal(modelLabel('gpt-6.1-sol'), 'gpt-6.1-sol');
});
