import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redact, short } from '../src/redact.js';

describe('redact', () => {
  it('leaves job names with key-like fragments alone (ask-investigate-…)', () => {
    for (const name of ['ask-investigate-job-20261024-long', 'ask-watchdog-gpu-pods-20261023', '/home/flori/jobs/ask-investigate-comms-overview-20261024/STATE.md', 'maskAIza' + 'a1B2c3D4e5'.repeat(3)]) {
      assert.equal(redact(name), name);
      assert.equal(short(name, 200), name);
    }
  });

  it('still removes keys after whitespace, quotes and punctuation', () => {
    for (const prefix of ['', ' ', '"', '=', ':', '(', '/']) {
      assert.ok(redact(`${prefix}sk-abcdefghijklmnop1234`).includes('[REDACTED]'), JSON.stringify(prefix));
      assert.ok(redact(`${prefix}xai-abcdefghijklmnopqrstu1`).includes('[REDACTED]'), JSON.stringify(prefix));
    }
  });
});
