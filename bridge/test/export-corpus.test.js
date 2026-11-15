// The corpus export (scripts/map/export-corpus.mjs): what the research agent's shell gets to see. Needs Node >= 22.5 (node:sqlite);
// the Sandy bridge's Node 20 skips this file.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DENIED_MARKER, SECRET, makeFixture } from './map-fixture.js';

const sqlite = await import('node:sqlite').catch(() => null);
const skip = sqlite ? false : 'needs Node >= 22.5 (node:sqlite)';
const fx = makeFixture();
const script = new URL('../scripts/map/export-corpus.mjs', import.meta.url).pathname;
const dbFile = path.join(fx.mapDir, 'index.sqlite');
const out = path.join(fx.home, 'desk-knowledge', 'corpus');
const exportRun = (...args) => {
  const r = spawnSync(process.execPath, [script, '--db', dbFile, '--out', out, ...args], { env: fx.env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const files = (dir = out) => execFileSync('find', [dir, '-type', 'f', '-printf', '%P\n'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
const text = (rel) => fs.readFileSync(path.join(out, rel), 'utf8');
const all = () => files().filter((f) => f !== '.corpus-meta.json').map((f) => text(f)).join('\n');
const homeRel = (p) => p.replace(/^\//, ''); // the canonical path without the leading slash

before(() => { if (!skip) { fx.run(); const r = exportRun(); assert.equal(r.status, 0, r.stderr); } });
after(() => fx.cleanup());

test('layout: <source>/<canonical path>.txt, board entries board/<thread>/<id>.txt, first line names path and time', { skip }, () => {
  const names = files();
  assert.ok(names.includes('board/22/1.txt') && names.includes('board/15/2.txt') && names.includes('board/22/3.txt'), names.join(' '));
  const result = `jobs/${homeRel(path.join(fx.home, 'jobs', 'alpha-job-20261101', 'RESULT.md'))}.txt`;
  assert.ok(names.includes(result), `${result} in ${names.filter((n) => n.startsWith('jobs/')).join(' ')}`);
  const t = text(result);
  assert.match(t, new RegExp(`^# ${path.join(fx.home, 'jobs', 'alpha-job-20261101', 'RESULT.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\| updated 2026-11-02T10:00:00Z\\n\\n`));
  assert.match(t, /landing pages went live and the scoring phase budget was confirmed/);
  assert.equal(text('board/22/1.txt'), '# board/22/1 | updated 2026-11-13T10:00:00Z\n\nDecision: the scoring phase takes 36 hours and costs USD 370, approved.\n');
  for (const src of ['wissen', 'entscheidungen', 'regeln', 'chats/laptop', 'skills', 'code', 'jobs']) assert.ok(names.some((n) => n.startsWith(`${src}/`)), `source ${src}`);
  // every doc of the index is there (26 docs, none denied, none empty) plus the meta file
  assert.equal(names.length, 26 + 1);
});

test('the chunks of a document come back in line order; DECISIONS keeps its entries apart', { skip }, () => {
  const dec = text(`entscheidungen/${homeRel(path.join(fx.home, 'DECISIONS.md'))}.txt`);
  const i1 = dec.indexOf('## 2026-11-14 10:00Z');
  const i2 = dec.indexOf('## 2026-11-02 09:30Z');
  const i3 = dec.indexOf('## 2026-10-20 08:00Z');
  assert.ok(0 < i1 && i1 < i2 && i2 < i3, `${i1} ${i2} ${i3}`);
  assert.match(dec, /\n\n## 2026-11-02/);
});

test('scrubbed: the secret in a note never reaches the corpus, the text around it does; denied paths never appear', { skip }, () => {
  const everything = all();
  assert.ok(!everything.includes(SECRET), 'the secret is gone');
  assert.ok(!everything.includes(SECRET.slice(-20)), 'also its tail');
  assert.match(everything, /Note: OPENAI_API_KEY=\[REDACTED\]/, 'the mask is in the text where the secret was');
  assert.match(everything, /The landing pages went live/, 'the text around it is there');
  assert.ok(!everything.includes(DENIED_MARKER), 'denied files and jobs never entered the index nor the corpus');
  const names = files().join('\n');
  assert.doesNotMatch(names, /token\.txt|wallet-keys|big\.md/);
});

test('defence in depth: a secret that reached the index text, and a denied path that reached the docs table, still stay out', { skip }, () => {
  const copy = path.join(fx.home, 'tampered.sqlite');
  fs.copyFileSync(dbFile, copy);
  const db = new sqlite.DatabaseSync(copy);
  const nextId = db.prepare('SELECT max(id) AS m FROM docs').get().m + 1;
  const bad = [
    [nextId, path.join(fx.home, '.config', 'dev-secrets.env'), 'jobs'], // a denied file name
    [nextId + 1, path.join(fx.home, 'jobs', 'wallet-x-20261101', 'STATE.md'), 'jobs'], // a denied job name
    [nextId + 2, '/etc/../../root/x.md', 'jobs'], // a path that tries to leave
    [nextId + 3, path.join(fx.home, 'jobs', 'ok-20261101', 'NOTES.md'), 'jobs'], // fine, but its text holds a secret
    [nextId + 4, path.join(fx.home, 'x', 'y.md'), '../escape'], // a source name that tries to leave
  ];
  for (const [id, p, src] of bad) {
    db.prepare("INSERT INTO docs(id, path, source, node, title, mtime, size, class, kind) VALUES (?, ?, ?, 'x', 't', 1793613600000, 10, 'open', 'file')").run(id, p, src);
    db.prepare('INSERT INTO chunks(rowid, doc_id, line, heading, body) VALUES (?, ?, 0, \'\', ?)').run(id * 100000, id, `body of ${path.basename(p)} ${DENIED_MARKER}2 key=${SECRET}`);
  }
  db.close();
  const out2 = path.join(fx.home, 'corpus-tampered');
  const r = spawnSync(process.execPath, [script, '--db', copy, '--out', out2], { env: fx.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const names = files(out2);
  assert.ok(names.includes(`jobs/${homeRel(path.join(fx.home, 'jobs', 'ok-20261101', 'NOTES.md'))}.txt`), 'the harmless doc is exported');
  assert.equal(names.filter((n) => /dev-secrets|wallet|root\/x|escape/.test(n)).length, 0, names.filter((n) => /dev-secrets|wallet|root|escape/.test(n)).join(','));
  const body = fs.readFileSync(path.join(out2, `jobs/${homeRel(path.join(fx.home, 'jobs', 'ok-20261101', 'NOTES.md'))}.txt`), 'utf8');
  assert.ok(!body.includes(SECRET) && !body.includes(SECRET.slice(-20)), 'the secret is masked again at export time');
  assert.match(body, /body of NOTES\.md DENIEDMARKERZEBRA2 key=/);
  assert.match(r.stdout, /skipped 2 denied, 0 empty, 2 unmappable/); // dev-secrets.env and the wallet job; the ".." path and the "../escape" source
  fs.rmSync(out2, { recursive: true, force: true });
  fs.rmSync(copy);
});

test('private: directories 0700, files 0600, no stray work files after the swap', { skip }, () => {
  const modes = execFileSync('find', [out, '-printf', '%y %m %P\n'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const line of modes) {
    const [type, mode] = line.split(' ');
    assert.equal(mode, type === 'd' ? '700' : '600', line);
  }
  const parent = fs.readdirSync(path.dirname(out));
  assert.deepEqual(parent.filter((n) => /^corpus\.(new|old|lock)/.test(n)), [], parent.join(' '));
  const meta = JSON.parse(text('.corpus-meta.json'));
  assert.equal(meta.docs, 26);
  assert.equal(meta.files, 26);
  assert.equal(meta.written, 26);
  assert.equal(meta.redact, true);
});

test('incremental: unchanged documents are hard links of the old files, a changed one is rewritten, a removed one disappears', { skip }, () => {
  const rel = 'board/22/1.txt';
  const before = fs.statSync(path.join(out, rel));
  const second = exportRun();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /written 0, reused 26;/);
  assert.equal(fs.statSync(path.join(out, rel)).ino, before.ino, 'same inode: the file was linked, not copied');
  // a changed note and a removed one, then a new index build
  fx.write(path.join(fx.mirror, 'alpha-job-20261101', 'STATE.md'), '# STATE — alpha\n\nLead: opus.\n- step one done\n- step two: marmalade shipped\n- FINAL DONE\n', '2026-11-05T10:00:00Z');
  fs.rmSync(path.join(fx.mirror, 'beta-job-20261002', 'PROMPT.md'));
  fx.run();
  const third = exportRun();
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /written 1, reused 24;/);
  const stateRel = `jobs/${homeRel(path.join(fx.home, 'jobs', 'alpha-job-20261101', 'STATE.md'))}.txt`;
  assert.match(text(stateRel), /updated 2026-11-05T10:00:00Z[\s\S]*marmalade shipped/);
  assert.ok(!files().some((f) => f.endsWith('beta-job-20261002/PROMPT.md.txt')), 'the removed note is gone');
  assert.equal(fs.statSync(path.join(out, rel)).ino, before.ino);
  // --full re-reads everything
  const full = exportRun('--full');
  assert.match(full.stdout, /written 25, reused 0;/);
  assert.notEqual(fs.statSync(path.join(out, rel)).ino, before.ino);
});

test('safety: an index that suddenly holds far fewer documents does not replace the corpus (unless forced); a locked run is skipped', { skip }, () => {
  const small = path.join(fx.home, 'small.sqlite');
  fs.copyFileSync(dbFile, small);
  const db = new sqlite.DatabaseSync(small);
  db.close();
  // pretend the existing corpus is large by faking its meta file, then export the small index over it
  const metaFile = path.join(out, '.corpus-meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, files: 5000 }), { mode: 0o600 });
  const refused = spawnSync(process.execPath, [script, '--db', small, '--out', out], { env: fx.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to swap in a corpus of \d+ files over 5000/);
  assert.ok(files().length > 20, 'the old corpus is untouched');
  assert.ok(!fs.existsSync(`${out}.new`));
  const forced = spawnSync(process.execPath, [script, '--db', small, '--out', out, '--force'], { env: fx.env, encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  // a running export holds the lock: the second one says so and exits 0
  fs.writeFileSync(`${out}.lock`, String(process.pid));
  const locked = spawnSync(process.execPath, [script, '--db', small, '--out', out], { env: fx.env, encoding: 'utf8' });
  assert.equal(locked.status, 0);
  assert.match(locked.stdout, /another corpus export is running/);
  fs.rmSync(`${out}.lock`);
  fs.rmSync(small);
});

test('errors are plain: a missing index, an unknown argument', { skip }, () => {
  const missing = spawnSync(process.execPath, [script, '--db', path.join(fx.home, 'nope.sqlite'), '--out', path.join(fx.home, 'c2')], { env: fx.env, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /export-corpus failed: index not found/);
  const bad = spawnSync(process.execPath, [script, '--nope'], { env: fx.env, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown argument --nope/);
  assert.ok(!fs.existsSync(path.join(fx.home, 'c2')), 'nothing is created for a failed run');
});

test('refresh.sh runs the export after the build and a failing export does not fail the refresh', { skip }, () => {
  const dir = path.join(fx.home, 'refresh-test');
  fs.mkdirSync(dir, { recursive: true });
  const sh = new URL('../scripts/map/refresh.sh', import.meta.url).pathname;
  const env = { ...fx.env, DESK_MAP_DIR: fx.mapDir, DESK_MAP_NODE: process.execPath, DESK_CORPUS_OUT: path.join(dir, 'corpus') };
  const ok = spawnSync('bash', [sh], { env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'corpus', '.corpus-meta.json')), 'the export ran');
  assert.match(fs.readFileSync(path.join(fx.mapDir, '.refresh.log'), 'utf8'), /export-corpus: \d+ docs -> \d+ files/);
  // an export that cannot work (output below a file) logs its failure; the refresh still succeeds
  fs.writeFileSync(path.join(dir, 'a-file'), 'x');
  const bad = spawnSync('bash', [sh], { env: { ...env, DESK_CORPUS_OUT: path.join(dir, 'a-file', 'corpus') }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(bad.status, 0, bad.stderr);
  assert.match(fs.readFileSync(path.join(fx.mapDir, '.refresh.log'), 'utf8'), /export-corpus failed/);
});
