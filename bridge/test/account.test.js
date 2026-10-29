import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAccount } from '../src/claude.js';

test('pickAccount skips a logged-out account (C with expired OAuth) and falls back to a logged-in one', async () => {
  delete process.env.BRIDGE_CLAUDE_ACCOUNT;
  const got = await pickAccount({ pick: async () => 'C', isLoggedIn: async (a) => a !== 'C' });
  assert.equal(got, 'A');
  assert.equal(await pickAccount({ pick: async () => 'B', isLoggedIn: async () => true }), 'B');
  assert.equal(await pickAccount({ pick: async () => 'C', isLoggedIn: async () => false }), 'C');
});
