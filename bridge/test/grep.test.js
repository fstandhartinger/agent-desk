// ctx.grep (job agent-desk-research-upgrade-20261125): ripgrep in one allowed tree, same allowlist as ctx.read.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-home-grep-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outside-grep-'));
process.env.BRIDGE_HOME = home;
const ctx = await import('../src/ctx.js');

before(() => {
  const kit = path.join(home, 'jobs', 'gr2-window', 'kit', 'windowkit');
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'podium.py'), 'def podium():\n    # One podium place per holder\n    return holder_first\n');
  fs.writeFileSync(path.join(kit, 'notes.md'), 'holder rule 2.9\n');
  fs.writeFileSync(path.join(outside, 'secret.py'), 'holder outside\n');
  fs.symlinkSync(path.join(outside, 'secret.py'), path.join(kit, 'link.py'));
});
after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

test('finds fixed text in an allowed tree with 0-based lines', async () => {
  const r = await ctx.grep({ path: path.join(home, 'jobs', 'gr2-window'), pattern: 'podium place per holder' });
  assert.equal(r.hits.length, 1);
  assert.match(r.hits[0].path, /podium\.py$/);
  assert.equal(r.hits[0].line, 1);
});
test('glob filter and no symlink escape', async () => {
  const r = await ctx.grep({ path: path.join(home, 'jobs', 'gr2-window'), pattern: 'holder', glob: '*.py' });
  assert.ok(r.hits.every((h) => h.path.endsWith('.py')));
  assert.ok(!r.hits.some((h) => /outside|link\.py/.test(h.path)));
});
test('refuses paths outside the allowlist and bad globs', async () => {
  await assert.rejects(ctx.grep({ path: outside, pattern: 'holder' }), /not allowed or not found/);
  await assert.rejects(ctx.grep({ path: path.join(home, 'jobs'), pattern: 'x', glob: '$(rm)' }), /glob/);
  await assert.rejects(ctx.grep({ path: path.join(home, 'jobs'), pattern: '' }), /pattern required/);
});
