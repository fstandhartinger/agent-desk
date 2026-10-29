// End to end for the canvas facts: real bridge jobs.list (throwaway home) → real runTool at the voice limit → facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from '../src/tools.js';
import { toolFacts } from '../src/vizFacts.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'viz-hook-'));
process.env.BRIDGE_HOME = home;
for (let i = 1; i <= 20; i++) {
  const dir = path.join(home, 'jobs', `job-${String(i).padStart(2, '0')}-20261024`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STATE.md'), `# STATE\nRound 2: a long enough summary line so twenty jobs exceed the voice limit\n${i > 17 ? '- FINAL DONE\n' : ''}`);
}
const jobs = await import('../../bridge/src/jobs.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('20 real jobs fit the voice result with every name, timestamp, status and exact counts', async () => {
  const r = await runTool('list_jobs', {}, { hub: { call: (_, a) => jobs.list(a) }, audit: () => {}, maxChars: 2500 });
  assert.doesNotMatch(r.content, /abgeschnitten/);
  assert.ok(r.content.length <= 2500);
  assert.equal(r.content.split('\n---\n')[1].split('\n').length, 20);
  for (let i = 1; i <= 20; i++) assert.ok(r.content.includes(`job-${String(i).padStart(2, '0')}-20261024`));
  assert.match(r.content, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z \| offen/);
  const f = toolFacts('list_jobs', r.content);
  assert.equal(f.jobs, 20);
  assert.equal(f.offen, 17);
});
