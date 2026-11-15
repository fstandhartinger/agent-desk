// The map builder (scripts/map/build.mjs): what enters the index, what never does, incremental runs, the board, classes.
// Needs Node >= 22.5 (node:sqlite); the Sandy bridge's Node 20 skips this file.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chunkText, classify, firstRealLine, stateStatus } from '../src/mapIndex.js';
import { DENIED_MARKER, SECRET, makeFixture } from './map-fixture.js';

const sqlite = await import('node:sqlite').catch(() => null);
const skip = sqlite ? false : 'needs Node >= 22.5 (node:sqlite)';
const fx = makeFixture();
let first;
let db;
const open = () => new sqlite.DatabaseSync(path.join(fx.mapDir, 'index.sqlite'), { readOnly: true });
const all = (sql, ...p) => { const d = open(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
const one = (sql, ...p) => all(sql, ...p)[0];

before(() => { if (!skip) first = fx.run(); });
after(() => { db?.close?.(); fx.cleanup(); });

test('chunker: start lines are true, sizes stay in bounds, headings are carried', () => {
  const para = (n) => `${'word '.repeat(60)}end${n}`;
  const lines = ['# Title', '', 'intro', '', '## Part A', ...Array.from({ length: 12 }, (_, i) => [para(i), '']).flat(), '## Part B', 'tail line'];
  const text = lines.join('\n');
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 4, `${chunks.length} chunks`);
  for (const c of chunks) {
    assert.ok(c.body.length <= 1800 + 40, `chunk of ${c.body.length}`);
    assert.ok(c.body.startsWith(lines[c.line].trim().slice(0, 12)), `chunk starting at line ${c.line} begins with that line`);
  }
  assert.equal(chunks[0].heading, 'Title');
  assert.ok(chunks.some((c) => c.heading === 'Part A'));
  assert.equal(chunks.at(-1).heading, 'Part B');
  // a forced split point never lets one chunk hold two sections
  const two = chunkText('## One\nfirst\n## Two\nsecond', { splitRe: /^## / });
  assert.deepEqual(two.map((c) => [c.line, c.heading]), [[0, 'One'], [2, 'Two']]);
  // one huge line is cut on spaces, every piece keeps the line number
  const long = chunkText(`${'abc '.repeat(2000)}`);
  assert.ok(long.length >= 4 && long.every((c) => c.line === 0 && c.body.length <= 1800));
});

test('helpers: first real line, state status, classes', () => {
  assert.equal(firstRealLine('---\nname: x\n---\n# Title\n\n<!-- c -->\nreal **line**'), 'real line');
  assert.equal(firstRealLine('# Only a heading\n'), 'Only a heading');
  assert.equal(stateStatus('a\n- FINAL DONE\n'), 'FINAL DONE');
  assert.equal(stateStatus('a\n- PARKED\n'), 'PARKED');
  assert.equal(stateStatus('a\nworking\n'), 'open');
  assert.equal(classify({ source: 'chats/laptop', path: 'x' }), 'personal');
  assert.equal(classify({ source: 'mail', path: 'x' }), 'personal');
  assert.equal(classify({ source: 'ledger', path: 'x' }), 'finance');
  assert.equal(classify({ source: 'jobs', path: '/home/x/jobs/owner-emission-1/STATE.md' }), 'finance');
  assert.equal(classify({ source: 'board', path: 'board/22/1', title: 'Steuer reserve' }), 'finance');
  assert.equal(classify({ source: 'jobs', path: '/home/x/jobs/mint-pricing/STATE.md', title: 'prices' }), 'open');
});

test('full build: counts, atomic file, private permissions, status file', { skip }, () => {
  assert.equal(first.ok, true);
  assert.ok(first.docs >= 15 && first.chunks >= first.docs && first.nodes > 30, JSON.stringify({ d: first.docs, c: first.chunks, n: first.nodes }));
  assert.equal(first.full, true);
  assert.equal(fs.statSync(fx.mapDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(fx.mapDir, 'index.sqlite')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(fx.mapDir, 'status.json')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(fx.mapDir, 'index.sqlite.build')), 'no temp file left behind');
  assert.ok(!fs.existsSync(path.join(fx.mapDir, '.build.lock')), 'lock released');
  for (const s of ['wissen', 'entscheidungen', 'regeln', 'jobs', 'board', 'chats/laptop', 'skills', 'code']) assert.ok(first.sources[s]?.docs > 0, `source ${s} has docs`);
  assert.equal(one("SELECT value FROM meta WHERE key = 'schema_version'").value, '1');
});

test('denied paths never enter: a denied job name, a denied file name, big files, source code', { skip }, () => {
  const paths = all('SELECT path FROM docs').map((r) => r.path);
  assert.ok(!paths.some((p) => /wallet-keys|token\.txt/.test(p)), 'denied job and file are not docs');
  assert.ok(!paths.some((p) => p.endsWith('big.md')), 'a file over 2 MB is skipped');
  assert.ok(!paths.some((p) => p.endsWith('x.js')), 'source code is not indexed');
  assert.equal(all('SELECT rowid FROM chunks WHERE chunks MATCH ?', `"${DENIED_MARKER.toLowerCase()}"`).length, 0);
  assert.equal(all('SELECT rowid FROM chunks WHERE chunks MATCH ?', '"pelican"').length, 0);
  assert.ok(!all('SELECT path FROM nodes').some((n) => /wallet-keys/.test(n.path)), 'no node for the denied job');
});

test('secrets are redacted before they enter the index', { skip }, () => {
  const rows = all('SELECT body FROM chunks WHERE chunks MATCH ?', '"landing"');
  assert.ok(rows.length >= 1);
  const everything = all('SELECT body, heading FROM chunks').map((r) => `${r.heading}\n${r.body}`).join('\n');
  assert.ok(!everything.includes(SECRET), 'the key value is not in any chunk');
  assert.ok(!everything.includes(SECRET.slice(8, 30)), 'no fragment of it either');
  assert.ok(everything.includes('[REDACTED]'), 'the place is marked');
  const nodes = all('SELECT summary, title FROM nodes').map((r) => `${r.title} ${r.summary}`).join('\n');
  assert.ok(!nodes.includes(SECRET));
});

test('sources land in the right nodes with canonical paths, summaries, statuses and offsets', { skip }, () => {
  const job = one("SELECT * FROM nodes WHERE path = 'jobs/2026-11/alpha-job-20261101'");
  assert.equal(job.kind, 'job');
  assert.equal(job.open, 'job_status("alpha-job-20261101")');
  assert.match(job.summary, /^FINAL DONE · The landing pages went live/);
  assert.equal(one("SELECT summary FROM nodes WHERE path = 'jobs/2026-10/beta-job-20261002'").summary, 'open · Pricing review for beta');
  assert.match(one("SELECT summary FROM nodes WHERE path = 'jobs/2026-10/widget-emission-tranche-20261015'").summary, /^PARKED/);
  assert.ok(one("SELECT path FROM nodes WHERE path = 'jobs/2026-08/nodate-job'"), 'a job without a date suffix goes by its file times');
  const file = one("SELECT * FROM nodes WHERE path = 'jobs/2026-11/alpha-job-20261101/sub/notes.md'");
  assert.equal(file.parent, 'jobs/2026-11/alpha-job-20261101');
  assert.equal(file.open, `read_file("${path.join(fx.home, 'jobs', 'alpha-job-20261101', 'sub', 'notes.md')}")`);
  assert.ok(!all('SELECT path FROM docs WHERE source = ?', 'jobs').some((d) => d.path.includes('job-notes')), 'never the mirror path');
  // decisions: month → entry with the exact line offset
  const entry = one("SELECT * FROM nodes WHERE kind = 'entry' AND title LIKE '%Scoring phase budget%'");
  assert.equal(entry.parent, 'entscheidungen/2026-11');
  assert.match(entry.summary, /^Florian approved USD 370/);
  const lines = fs.readFileSync(path.join(fx.home, 'DECISIONS.md'), 'utf8').split('\n');
  const m = /offset=(\d+), limit=(\d+)/.exec(entry.open);
  assert.ok(lines[Number(m[1])].startsWith('## 2026-11-02 09:30Z'), 'offset points at the heading line');
  assert.equal(one("SELECT count(*) AS n FROM nodes WHERE kind = 'month' AND parent = 'entscheidungen'").n, 2);
  // AGENTS.md: sections
  assert.equal(all("SELECT title FROM nodes WHERE parent = 'regeln/AGENTS.md' ORDER BY sort").map((r) => r.title).join('|'), '0. Servers|1. Money');
  // laptop: project → session → day, summary = the first user line
  assert.ok(one("SELECT path FROM nodes WHERE path = 'chats/laptop/Demo'"));
  assert.match(one("SELECT summary FROM nodes WHERE path = 'chats/laptop/Demo/abcd1234'").summary, /^2 Tage, 2026-11-10 bis 2026-11-12/);
  assert.equal(one("SELECT summary FROM nodes WHERE path = 'chats/laptop/Demo/abcd1234/2026-11-10'").summary, 'Wie viel kostet die Bewertungsphase mit 36 Stunden?');
  assert.equal(one("SELECT title FROM nodes WHERE path = 'chats/laptop/memory/feedback-demo'").title, 'feedback-demo');
  assert.equal(one("SELECT summary FROM nodes WHERE path = 'skills/demo-skill'").summary, 'Demo skill used to test the map');
  assert.equal(one("SELECT title FROM nodes WHERE path = 'explainer/demo-page-abc123'").title, 'Demo explainer title');
  assert.match(one("SELECT summary FROM nodes WHERE path = 'code/agent-desk'").summary, /^A private agent page for testing the code source\.$/);
  assert.equal(one("SELECT open FROM nodes WHERE path = 'code/agent-desk/bridge'").open, `code_outline("${path.join(fx.home, 'work', 'agent-desk', 'bridge')}")`);
  assert.ok(one("SELECT path FROM nodes WHERE path = 'code/agent-desk/docs/SPEC.md'"));
});

test('root: every source, in order, every node carries an open hint', { skip }, () => {
  const root = all("SELECT path FROM nodes WHERE parent = '' ORDER BY sort").map((r) => r.path);
  assert.deepEqual(root, ['wissen', 'entscheidungen', 'chats/laptop', 'desk-sitzungen', 'jobs', 'board', 'chats/sandy', 'chats/lechonk', 'regeln', 'artefakte', 'skills', 'explainer', 'code', 'ledger', 'server', 'gpu', 'mail', 'discord', 'datenbanken', 'web']);
  assert.equal(all("SELECT path FROM nodes WHERE open IS NULL OR open = ''").length, 0);
});

test('classes: personal, finance, open', { skip }, () => {
  const cls = (p) => one('SELECT class FROM nodes WHERE path = ?', p)?.class;
  assert.equal(cls('chats/laptop'), 'personal');
  assert.equal(cls('chats/laptop/Demo/abcd1234/2026-11-10'), 'personal');
  assert.equal(cls('chats/laptop/memory/feedback-demo'), 'personal');
  assert.equal(cls('mail'), 'personal');
  assert.equal(cls('discord'), 'personal');
  assert.equal(cls('ledger'), 'finance');
  assert.equal(cls('jobs/2026-10/widget-emission-tranche-20261015'), 'finance');
  assert.equal(cls('jobs/2026-11/alpha-job-20261101'), 'open');
  assert.equal(cls('wissen'), 'open');
  assert.equal(one("SELECT class FROM docs WHERE path LIKE '%laptop-mirror/sessions/Demo__abcd1234__2026-11-10.md'").class, 'personal');
  assert.equal(one("SELECT class FROM docs WHERE path LIKE '%widget-emission-tranche%STATE.md'").class, 'finance');
  assert.equal(one("SELECT class FROM docs WHERE path = 'board/22/3'").class, 'finance', 'a board entry about a tax invoice is finance');
  assert.equal(one("SELECT class FROM docs WHERE path = 'board/15/2'").class, 'open');
});

test('board: entries indexed with thread nodes; incremental by entry id; an unavailable board keeps the old rows', { skip }, () => {
  assert.equal(first.changes.boardAdded, 3);
  assert.equal(one("SELECT title FROM nodes WHERE path = 'board/22'").title, 'System1 Models + REAX');
  assert.match(one("SELECT summary FROM nodes WHERE path = 'board/22'").summary, /2 Einträge/);
  assert.equal(one("SELECT open FROM nodes WHERE path = 'board/22'").open, 'board_read("22")');
  assert.equal(one("SELECT summary FROM docs WHERE path = 'board/22/1'").summary, 'decision · claude:job-a');
  fx.setBoard([...JSON.parse(fs.readFileSync(fx.boardFile, 'utf8')), [4, 15, 'claude:x', 'note', '2026-11-15T09:00:00Z', 'A fourth entry about the fresh pipeline.']]);
  const second = fx.run();
  assert.equal(second.changes.boardAdded, 1, 'only the new entry is fetched');
  assert.equal(one('SELECT count(*) AS n FROM docs WHERE source = ?', 'board').n, 4);
  const third = fx.run('--board-cmd', path.join(fx.home, 'does-not-exist'));
  assert.ok(third.warnings.some((w) => w.startsWith('board: skipped')), third.warnings.join(';'));
  assert.equal(third.ok, true);
  assert.equal(one('SELECT count(*) AS n FROM docs WHERE source = ?', 'board').n, 4, 'the old entries stay');
  const fourth = fx.run('--no-board');
  assert.equal(fourth.changes.boardAdded, 0);
});

test('incremental: only changed files are re-read, removed files go, ids and chunks of the rest stay', { skip }, () => {
  const idOf = (p) => one('SELECT id FROM docs WHERE path = ?', p).id;
  const stateOfBeta = path.join(fx.home, 'jobs', 'alpha-job-20261101', 'STATE.md'); // canonical path of an unchanged doc
  const before = idOf(stateOfBeta);
  const noop = fx.run();
  assert.equal(noop.changes.added + noop.changes.updated + noop.changes.removed, 0, JSON.stringify(noop.changes));
  assert.ok(noop.changes.unchanged >= 15);
  // change one note, add one, remove one
  fx.write(path.join(fx.mirror, 'beta-job-20261002', 'STATE.md'), '# STATE beta\n\nnow finished: quokka pricing\n- FINAL DONE\n', '2026-11-15T10:00:00Z');
  fx.write(path.join(fx.mirror, 'beta-job-20261002', 'EXTRA.md'), '# Extra\n\nbrand new note about narwhals\n', '2026-11-15T10:00:00Z');
  fs.rmSync(path.join(fx.mirror, 'nodate-job', 'STATE.md'));
  const inc = fx.run();
  assert.deepEqual([inc.changes.added, inc.changes.updated, inc.changes.removed], [1, 1, 1], JSON.stringify(inc.changes));
  assert.equal(idOf(stateOfBeta), before, 'unchanged doc keeps its id');
  assert.equal(all('SELECT rowid FROM chunks WHERE chunks MATCH ?', '"quokka"').length, 1);
  assert.equal(all('SELECT rowid FROM chunks WHERE chunks MATCH ?', '"narwhals"').length, 1);
  assert.equal(all('SELECT rowid FROM chunks WHERE chunks MATCH ?', '"not finished"').length, 0);
  assert.equal(all("SELECT path FROM nodes WHERE path LIKE 'jobs/2026-08%'").length, 0, 'the removed job disappears from the tree');
  assert.match(one("SELECT summary FROM nodes WHERE path = 'jobs/2026-10/beta-job-20261002'").summary, /^FINAL DONE/);
  assert.equal(all("SELECT d.id FROM docs d WHERE d.path LIKE '%nodate-job%'").length, 0);
  // chunks of removed docs are gone too: every chunk belongs to a doc
  assert.equal(one('SELECT count(*) AS n FROM chunks WHERE doc_id NOT IN (SELECT id FROM docs)').n, 0);
});

test('a different schema version rebuilds fully; a failed start leaves the live index untouched', { skip }, () => {
  const d = new sqlite.DatabaseSync(path.join(fx.mapDir, 'index.sqlite'));
  d.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
  d.close();
  const rebuilt = fx.run();
  assert.equal(rebuilt.full, true);
  assert.equal(one("SELECT value FROM meta WHERE key = 'schema_version'").value, '1');
  const sizeBefore = fs.statSync(path.join(fx.mapDir, 'index.sqlite')).size;
  assert.throws(() => fx.run('--bogus-flag'));
  assert.equal(fs.statSync(path.join(fx.mapDir, 'index.sqlite')).size, sizeBefore, 'the live index is untouched');
});

test('a source that cannot be listed keeps its rows (nothing is wiped because a mount is away)', { skip }, () => {
  const jobsBefore = one("SELECT count(*) AS n FROM docs WHERE source = 'jobs'").n;
  fs.rmSync(path.join(fx.mirror, '.synced'));
  const r = fx.run();
  assert.ok(r.warnings.some((w) => w.startsWith('jobs:')), r.warnings.join(';'));
  assert.equal(one("SELECT count(*) AS n FROM docs WHERE source = 'jobs'").n, jobsBefore);
});

test('a source that suddenly lists far fewer files (a wiped mirror) removes nothing', { skip }, () => {
  fx.write(path.join(fx.mirror, '.synced'), new Date().toISOString());
  const before = one("SELECT count(*) AS n FROM docs WHERE source = 'jobs'").n;
  const keep = new Set(['gamma-20261110']);
  fx.write(path.join(fx.mirror, 'gamma-20261110', 'STATE.md'), '# gamma\n\nonly job left\n', '2026-11-10T10:00:00Z');
  for (const job of fs.readdirSync(fx.mirror)) if (!keep.has(job) && !job.startsWith('.')) fs.rmSync(path.join(fx.mirror, job), { recursive: true, force: true });
  const r = fx.run('--shrink-min', '4');
  assert.ok(r.warnings.some((w) => /^jobs: only \d+ of \d+ indexed files are listed; nothing is removed/.test(w)), r.warnings.join(';'));
  assert.equal(r.changes.removed, 0);
  assert.equal(one("SELECT count(*) AS n FROM docs WHERE source = 'jobs'").n, before + 1, 'old rows stay, the new job is added');
});
