import assert from 'node:assert/strict';
import { it, after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-decision-key-'));
process.env.BRIDGE_HOME = home;
const { decisionKey } = await import('../src/ctx.js');
after(() => fs.rm(home, { recursive: true, force: true }));
it('bounded exact reader finds an old definition and excludes the body', async () => {
 await fs.writeFile(path.join(home, 'DECISIONS.md'), '## Recent\nresolved-keys: wanted\n' + 'x'.repeat(70000) + '\n## Old definition\nKey: wanted\nPrivate EUR 999\n');
 const result = await decisionKey({ key: 'wanted' });
 assert.deepEqual(result, { found: true, heading: '## Old definition' });
 assert.equal((await decisionKey({ key: 'missing' })).found, false);
 await fs.writeFile(path.join(home, 'DECISIONS.md'), 'x'.repeat(2000001));
 assert.deepEqual(await decisionKey({ key: 'wanted' }), { found: false, truncated: true });
});
