// scripts/sandbox/pull-corpus.sh (Sandy, hourly): generations next to each other, an atomic symlink, never a half copy.
// The source is a local directory here (the real one is lechonk:desk-knowledge/corpus/); needs rsync and flock.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const script = new URL('../scripts/sandbox/pull-corpus.sh', import.meta.url).pathname;
const have = (bin) => spawnSync(bin, ['--version']).status === 0;
const skip = have('rsync') && have('flock') ? false : 'needs rsync and flock';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-corpus-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A source corpus and a target of its own; `pull()` runs the script, `source(rel, text)` edits the source. */
function setup({ files = {}, keep } = {}) {
  seq += 1;
  const src = path.join(root, `src${seq}`);
  const link = path.join(root, `t${seq}`, 'desk-corpus');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const put = (rel, text) => { const p = path.join(src, rel); fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 }); fs.writeFileSync(p, text, { mode: 0o600 }); };
  put('.corpus-meta.json', '{"files":2}\n');
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  if (!Object.keys(files).length) { put('board/22/1.txt', 'first entry\n'); put('jobs/home/x/RESULT.md.txt', 'result text\n'); }
  const env = { ...process.env, DESK_CORPUS_DIR: link, DESK_CORPUS_SRC: `${src}/`, DESK_CORPUS_RETRY_SLEEP: '0', ...(keep ? { DESK_CORPUS_KEEP: String(keep) } : {}) };
  const pull = (extra = {}) => { const r = spawnSync('bash', [script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 }); return { status: r.status, out: r.stdout + r.stderr }; };
  const gens = () => (fs.existsSync(`${link}.gen`) ? fs.readdirSync(`${link}.gen`).filter((n) => n.startsWith('gen-')).sort() : []);
  return { src, link, put, pull, gens, env, current: () => fs.readlinkSync(link) };
}

test('first pull: a generation, a symlink to it, private modes, the files of the source', { skip }, () => {
  const t = setup();
  const r = t.pull();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /pull-corpus: ok gen-\d{8}T\d{6}\d{9}Z: 3 files/);
  assert.ok(fs.lstatSync(t.link).isSymbolicLink());
  assert.equal(t.gens().length, 1);
  assert.equal(path.basename(t.current()), t.gens()[0]);
  assert.equal(fs.readFileSync(path.join(t.link, 'board/22/1.txt'), 'utf8'), 'first entry\n');
  assert.equal(fs.statSync(`${t.link}.gen`).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(t.link, 'board')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(t.link, 'board/22/1.txt')).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(`${t.link}.gen`).some((n) => n.endsWith('.partial')));
});

test('a change makes a new generation: the symlink moves, unchanged files are hard links, the old generation stays for a while', { skip }, () => {
  const t = setup();
  assert.equal(t.pull().status, 0);
  const first = t.current();
  const ino = fs.statSync(path.join(t.link, 'jobs/home/x/RESULT.md.txt')).ino;
  t.put('board/22/1.txt', 'first entry, edited\n');
  t.put('board/22/2.txt', 'new entry\n');
  const r = t.pull();
  assert.equal(r.status, 0, r.out);
  assert.equal(t.gens().length, 2);
  assert.notEqual(t.current(), first);
  assert.equal(fs.readFileSync(path.join(t.link, 'board/22/1.txt'), 'utf8'), 'first entry, edited\n');
  assert.equal(fs.readFileSync(path.join(first, 'board/22/1.txt'), 'utf8'), 'first entry\n', 'the previous generation is untouched');
  assert.equal(fs.statSync(path.join(t.link, 'jobs/home/x/RESULT.md.txt')).ino, ino, 'unchanged file: same inode (hard link)');
  // a removed source file disappears from the new generation only
  fs.rmSync(path.join(t.src, 'board/22/2.txt'));
  assert.equal(t.pull().status, 0);
  assert.ok(!fs.existsSync(path.join(t.link, 'board/22/2.txt')));
});

test('retention: the newest KEEP generations stay, older ones go once they are 10 minutes old; interrupted .partial copies are removed', { skip }, () => {
  const t = setup({ keep: 2 });
  for (let i = 0; i < 4; i += 1) { t.put('board/22/1.txt', `entry ${i}\n`); assert.equal(t.pull().status, 0); }
  assert.equal(t.gens().length, 4, 'all four are younger than 10 minutes: nothing is deleted yet');
  const old = new Date(Date.now() - 3600_000);
  for (const g of t.gens().slice(0, 3)) fs.utimesSync(path.join(`${t.link}.gen`, g), old, old);
  fs.mkdirSync(path.join(`${t.link}.gen`, 'gen-00000000T000000000000Z.partial'));
  t.put('board/22/1.txt', 'entry 4\n');
  assert.equal(t.pull().status, 0);
  const left = t.gens();
  assert.equal(left.length, 2, left.join(' '));
  assert.equal(path.basename(t.current()), left.at(-1));
});

test('a failed pull changes nothing: unreachable source, a tree without meta file, a tree that shrank to less than half', { skip }, () => {
  const t = setup({ files: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`board/1/${i}.txt`, `entry ${i}\n`])) });
  assert.equal(t.pull().status, 0);
  const good = t.current();
  const check = (r, re) => {
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, re);
    assert.equal(t.current(), good, 'the symlink did not move');
    assert.equal(t.gens().length, 1);
    assert.ok(!fs.readdirSync(`${t.link}.gen`).some((n) => n.endsWith('.partial')), 'no partial copy left');
  };
  check(t.pull({ DESK_CORPUS_SRC: path.join(root, 'does-not-exist/') }), /rsync from .* failed \(exit 23\) after 3 tries/);
  const bare = path.join(root, `bare${seq}`);
  fs.mkdirSync(bare);
  fs.writeFileSync(path.join(bare, 'x.txt'), 'x');
  check(t.pull({ DESK_CORPUS_SRC: `${bare}/` }), /no \.corpus-meta\.json/);
  const small = path.join(root, `small${seq}`);
  fs.mkdirSync(small);
  fs.writeFileSync(path.join(small, '.corpus-meta.json'), '{}');
  for (let i = 0; i < 100; i += 1) fs.writeFileSync(path.join(small, `${i}.txt`), 'x');
  check(t.pull({ DESK_CORPUS_SRC: `${small}/` }), /101 files, the current one 1001 \(less than half\)/);
  assert.equal(fs.readFileSync(path.join(t.link, 'board/1/7.txt'), 'utf8'), 'entry 7\n');
});

test('a plain directory from an earlier manual rsync becomes the first generation', { skip }, () => {
  const t = setup();
  fs.mkdirSync(t.link, { recursive: true });
  fs.writeFileSync(path.join(t.link, 'old.txt'), 'from before');
  const r = t.pull();
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.lstatSync(t.link).isSymbolicLink());
  assert.equal(t.gens().length, 2);
  assert.ok(t.gens().some((g) => g.startsWith('gen-migrated-')));
});

test('one pull at a time: a second one that starts meanwhile says so and exits 0', { skip }, async () => {
  const t = setup();
  fs.mkdirSync(`${t.link}.gen`, { recursive: true, mode: 0o700 });
  const holder = spawn('flock', [path.join(`${t.link}.gen`, '.pull.lock'), 'sleep', '3']);
  await new Promise((r) => setTimeout(r, 400));
  const r = t.pull();
  assert.equal(r.status, 0);
  assert.match(r.out, /another pull is running/);
  assert.equal(t.gens().length, 0);
  holder.kill();
});

test('a command running in the sandbox keeps its generation while a pull swaps the symlink', { skip }, async () => {
  const sbx = spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--', '/usr/bin/true']);
  if (sbx.status !== 0) { console.log('# (sandbox part skipped: no bubblewrap with user namespaces here)'); return; }
  const t = setup();
  assert.equal(t.pull().status, 0);
  process.env.BRIDGE_CORPUS_DIR = t.link;
  const { createSandbox } = await import('../src/sandbox.js');
  const sb = createSandbox({ log() {} });
  const running = sb.exec({ command: 'cat board/22/1.txt; sleep 1.5; cat board/22/1.txt; ls board/22' });
  await new Promise((r) => setTimeout(r, 500));
  t.put('board/22/1.txt', 'first entry, edited\n');
  t.put('board/22/2.txt', 'new\n');
  assert.equal(t.pull().status, 0);
  const r = await running;
  assert.equal(r.output, 'first entry\nfirst entry\n1.txt\n', 'one generation start to end');
  assert.equal((await sb.exec({ command: 'cat board/22/1.txt; ls board/22 | wc -l' })).output, 'first entry, edited\n2\n', 'the next command sees the new one');
});
