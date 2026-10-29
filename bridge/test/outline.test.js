import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outline-home-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outline-out-'));
process.env.BRIDGE_HOME = home;
const { outline, firstDoc } = await import('../src/outline.js');
const { resolveAllowed } = await import('../src/paths.js');
const ctx = await import('../src/ctx.js');

const repo = path.join(home, 'work', 'agent-desk');
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};

before(() => {
  w('gateway/src/server.js', "/**\n * HTTP server of the gateway.\n * Serves the API.\n */\nimport express from 'express';\nimport { tools } from './tools.js';\nimport * as bus from './canvasBus';\nimport './setup.js';\nconst x = require('../lib/util.cjs');\nexport { y } from './tools.js';\nconst lazy = await import('./lazy.js');\nimport nothing from '../../outside.js';\n");
  w('gateway/src/tools.js', '// Tool definitions\n// for the agent.\nexport const tools = [];\n');
  w('gateway/src/canvasBus.ts', 'export const bus = 1;\n');
  w('gateway/src/setup.js', 'export {}\n');
  w('gateway/src/lazy.js', 'export {}\n');
  w('gateway/lib/util.cjs', 'module.exports = 1;\n');
  w('web/src/App.tsx', "import { Canvas } from './canvas/index';\nexport default () => null;\n");
  w('web/src/canvas/index.tsx', 'export const Canvas = 1;\n');
  w('bridge/app.py', '"""Bridge helper.\n\nSecond paragraph."""\nfrom . import helper\nfrom .pkg.mod import thing\nimport bridge.helper\nimport os\n');
  w('bridge/helper.py', '# helper module\nx = 1\n');
  w('bridge/pkg/mod.py', 'thing = 1\n');
  w('scripts/run.sh', '#!/bin/bash\n# Runs everything\n# in order.\nsource ./lib.sh\n. "$HOME/work/agent-desk/scripts/other.sh"\nsource "$DIR/dyn.sh"\n');
  w('scripts/lib.sh', '# lib\n');
  w('scripts/other.sh', '# other\n');
  w('node_modules/pkg/index.js', 'module.exports = 1;\n');
  w('dist/bundle.js', 'x\n');
  w('.git/hooks/pre-commit.sh', 'x\n');
  w('config/secrets.env', 'TOKEN=abc\n');
  w('config/prod.env', 'KEY=1\n');
  w('config/credentials.js', 'export default 1;\n');
  w('README.md', '# readme\n');
  fs.writeFileSync(path.join(outside, 'leak.js'), '// leaked outside the root\n');
  fs.writeFileSync(path.join(home, 'outside.js'), 'export {}\n');
  fs.symlinkSync(path.join(outside, 'leak.js'), path.join(repo, 'gateway', 'src', 'leak.js'));
  fs.symlinkSync(outside, path.join(repo, 'linked-dir'));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const byPath = (r) => Object.fromEntries(r.files.map((f) => [f.path, f]));

test('outline lists code files with lines, language, first doc comment and sorted local imports', async () => {
  const r = await outline({ path: repo });
  assert.equal(r.root, repo);
  assert.equal(r.truncated, false);
  const f = byPath(r);
  assert.deepEqual(f['gateway/src/server.js'].imports, ['gateway/lib/util.cjs', 'gateway/src/canvasBus.ts', 'gateway/src/lazy.js', 'gateway/src/setup.js', 'gateway/src/tools.js']);
  assert.equal(f['gateway/src/server.js'].doc, 'HTTP server of the gateway. Serves the API.');
  assert.equal(f['gateway/src/server.js'].lang, 'js');
  assert.equal(f['gateway/src/server.js'].lines, 12);
  assert.equal(f['gateway/src/tools.js'].doc, 'Tool definitions for the agent.');
  assert.equal(f['web/src/App.tsx'].lang, 'ts');
  assert.deepEqual(f['web/src/App.tsx'].imports, ['web/src/canvas/index.tsx']);
});

test('outline: python relative and package imports, shell source', async () => {
  const f = byPath(await outline({ path: repo }));
  assert.equal(f['bridge/app.py'].doc, 'Bridge helper. Second paragraph.');
  assert.deepEqual(f['bridge/app.py'].imports, ['bridge/helper.py', 'bridge/pkg/mod.py']);
  assert.equal(f['scripts/run.sh'].doc, 'Runs everything in order.');
  assert.deepEqual(f['scripts/run.sh'].imports, ['scripts/lib.sh', 'scripts/other.sh']); // $DIR/dyn.sh cannot be resolved
});

test('outline skips node_modules, dist, .git, denied files and non-code files', async () => {
  const paths = (await outline({ path: repo })).files.map((f) => f.path);
  assert.ok(!paths.some((p) => /node_modules|^dist|\.git|secrets\.env|prod\.env|credentials/.test(p)), paths.join(','));
  assert.ok(!paths.includes('README.md'));
});

test('outline: symlinks (file and directory) and imports out of the root never leave it', async () => {
  const r = await outline({ path: repo });
  const paths = r.files.map((f) => f.path);
  assert.ok(!paths.includes('gateway/src/leak.js'));
  assert.ok(!paths.some((p) => p.startsWith('linked-dir')));
  assert.ok(!byPath(r)['gateway/src/server.js'].imports.some((i) => i.includes('outside')));
});

test('outline refuses roots outside the read roots, escapes through symlinks, and files', async () => {
  await assert.rejects(outline({ path: outside }), /not allowed or not found/);
  await assert.rejects(outline({ path: path.join(repo, 'linked-dir') }), /not allowed or not found/);
  await assert.rejects(outline({ path: path.join(repo, '..', '..', '.ssh') }), /not allowed or not found/);
  await assert.rejects(outline({ path: path.join(repo, 'README.md') }), /not a directory/);
  await assert.rejects(outline({}), /not allowed or not found/);
});

test('outline caps at 300 files and says so', async () => {
  for (let i = 0; i < 320; i++) w(`many/f${String(i).padStart(3, '0')}.js`, 'export {}\n');
  const r = await outline({ path: path.join(repo, 'many') });
  assert.equal(r.files.length, 300);
  assert.equal(r.truncated, true);
});

test('firstDoc: shebang is skipped, plain code has no doc', () => {
  assert.equal(firstDoc('#!/usr/bin/env node\n// hello\nx()', 'js'), 'hello');
  assert.equal(firstDoc('const a = 1;\n// later\n', 'js'), '');
  assert.equal(firstDoc('x'.repeat(400), 'sh'), '');
});

test('new read roots: allowed for files below them, ~/bin only flat, deny list and symlink escape still apply', () => {
  const roots = ['work/agent-desk', 'Dev/explainer-pages', 'work/explainer-pages'];
  for (const r of roots) {
    fs.mkdirSync(path.join(home, r, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(home, r, 'sub', 'a.md'), 'hi');
    assert.ok(resolveAllowed(path.join(home, r, 'sub', 'a.md')).endsWith('a.md'), r);
  }
  fs.mkdirSync(path.join(home, 'bin', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', 'notify'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(home, 'bin', 'deeper', 'x.sh'), 'x');
  fs.writeFileSync(path.join(home, 'bin', 'secrets.env'), 'TOKEN=1');
  fs.writeFileSync(path.join(home, 'bin', 'x.env'), 'TOKEN=1');
  fs.writeFileSync(path.join(home, 'bin', 'creds.pem'), 'x');
  assert.ok(resolveAllowed(path.join(home, 'bin', 'notify')).endsWith('notify'));
  assert.ok(resolveAllowed(path.join(home, 'bin')).endsWith('bin'));
  for (const p of ['bin/deeper/x.sh', 'bin/secrets.env', 'bin/x.env', 'bin/creds.pem', 'work/agent-desk/.env', 'work/agent-desk/.git/config', 'work/agent-desk/config/secrets.env']) {
    assert.throws(() => resolveAllowed(path.join(home, p)), /not allowed or not found/, p);
  }
  fs.symlinkSync(path.join(outside, 'leak.js'), path.join(home, 'bin', 'sneaky'));
  assert.throws(() => resolveAllowed(path.join(home, 'bin', 'sneaky')), /not allowed or not found/);
  assert.throws(() => resolveAllowed(path.join(home, 'work', 'other', 'x')), /not allowed or not found/);
});

test('ctx.read serves a file from a new root and redacts secrets inside it', async () => {
  fs.writeFileSync(path.join(home, 'bin', 'tool.sh'), '#!/bin/sh\nexport OPENAI=sk-abcdefghijklmnopqrstuvwxyz1234\necho ok\n');
  const r = await ctx.read({ path: path.join(home, 'bin', 'tool.sh') });
  assert.match(r.text, /echo ok/);
  assert.ok(!r.text.includes('sk-abcdefghijklmnop'));
  await assert.rejects(ctx.read({ path: path.join(home, 'bin', 'x.env') }), /not allowed or not found/);
});
