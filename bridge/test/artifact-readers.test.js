import assert from 'node:assert/strict';
import { it } from 'node:test';
import { findDecisionKey } from '../src/ctx.js';
import { get } from '../src/jobs.js';
it('exact decision definitions ignore cumulative footers and substring matches, including old entries', () => {
 const text = '## Unrelated\nresolved-keys: wanted\n' + 'x'.repeat(70000) + '\n## Old heading\nKey: wanted\nText\n## Other\nKey: wanted-extra';
 assert.deepEqual(findDecisionKey(text, 'wanted'), { found: true, heading: '## Old heading' });
 assert.deepEqual(findDecisionKey(text, 'missing'), { found: false });
 assert.equal(findDecisionKey('## Decision `wanted`\nbody', 'wanted').found, true);
});
it('jobs reject traversal before file access or fuzzy lookup', async () => {
 for (const name of ['.', '..', 'a..b', '../job', '/job']) await assert.rejects(get({ name }), /invalid job name/);
});
