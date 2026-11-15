// map.discover / map.search / map.status over a small built index: walking, paging, open hints, German↔English search,
// FTS-injection safety, filters and the registration on the right bridge host.
// Needs Node >= 22.5 (node:sqlite); the Sandy bridge's Node 20 skips this file.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFixture } from './map-fixture.js';

const sqlite = await import('node:sqlite').catch(() => null);
const skip = sqlite ? false : 'needs Node >= 22.5 (node:sqlite)';
const fx = makeFixture();
process.env.BRIDGE_HOME = fx.home; // before ../src/paths.js is imported
const map = await import('../src/map.js');
const { buildMatch, queryGroups } = map;

before(() => {
  if (skip) return;
  fx.run();
  map.setMapDirForTests(fx.mapDir);
});
after(() => { map.setMapDirForTests(null); fx.cleanup(); });

const canonical = (rel) => path.join(fx.home, rel);

test('status: counts, sources, build time, no error', { skip }, async () => {
  const s = await map.status();
  assert.ok(s.built && s.docs >= 15 && s.chunks >= s.docs && s.nodes > 30 && s.bytes > 10_000);
  assert.ok(s.sources.jobs.docs >= 8 && s.sources.board.docs === 3 && s.sources['chats/laptop'].docs === 4);
  assert.equal(s.lastError, null);
  assert.deepEqual(s.warnings, []);
});

test('status before the first build: not built, never a crash', { skip }, async () => {
  map.setMapDirForTests(path.join(fx.home, 'nothing-here'));
  const s = await map.status();
  assert.equal(s.built, null);
  assert.match(String(s.lastError), /not built/);
  await assert.rejects(() => map.search({ query: 'anything' }), /not built/);
  map.setMapDirForTests(fx.mapDir);
});

test('discover root: 20 sources in order, each line has path/title/summary/class/open', { skip }, async () => {
  const r = await map.discover({ limit: 40 });
  assert.equal(r.path, '');
  assert.equal(r.total, 20);
  assert.equal(r.nextOffset, null);
  assert.deepEqual(r.lines.slice(0, 5).map((l) => l.path), ['wissen', 'entscheidungen', 'chats/laptop', 'desk-sitzungen', 'jobs']);
  for (const l of r.lines) {
    assert.ok(l.title && l.summary && l.open, `line ${l.path} has title, summary and open`);
    assert.ok(['open', 'personal', 'finance'].includes(l.class));
  }
  const by = Object.fromEntries(r.lines.map((l) => [l.path, l]));
  assert.equal(by.board.open, 'discover("board")');
  assert.match(by.mail.open, /^mail_search/);
  assert.match(by.server.open, /^run_readonly/);
  assert.match(by['desk-sitzungen'].open, /desk_sessions/);
  assert.equal(by.mail.class, 'personal');
  assert.equal(by.ledger.class, 'finance');
});

test('discover paging: limit, offset, total, nextOffset; default 20, max 40', { skip }, async () => {
  const a = await map.discover({ limit: 8 });
  assert.equal(a.lines.length, 8);
  assert.equal(a.nextOffset, 8);
  const b = await map.discover({ limit: 8, offset: a.nextOffset });
  const c = await map.discover({ limit: 8, offset: b.nextOffset });
  assert.equal(c.lines.length, 4);
  assert.equal(c.nextOffset, null);
  assert.deepEqual([...a.lines, ...b.lines, ...c.lines].map((l) => l.path), (await map.discover({ limit: 40 })).lines.map((l) => l.path));
  assert.equal((await map.discover({})).lines.length, 20);
  assert.equal((await map.discover({ limit: 9999 })).lines.length, 20, 'the limit is capped at 40');
  assert.equal((await map.discover({ limit: 0 })).lines.length, 1, 'and floored at 1');
  const decisions = await map.discover({ path: 'entscheidungen/2026-11', limit: 1 });
  assert.equal(decisions.total, 2);
  assert.equal(decisions.nextOffset, 1);
});

test('discover walk: source → month → job → files; every line opens with an exact call', { skip }, async () => {
  const jobs = await map.discover({ path: 'jobs' });
  assert.deepEqual(jobs.lines.map((l) => l.path), ['jobs/2026-11', 'jobs/2026-10', 'jobs/2026-08'].filter((p) => jobs.lines.some((l) => l.path === p)));
  assert.equal(jobs.lines[0].path, 'jobs/2026-11');
  const month = await map.discover({ path: 'jobs/2026-11/' }); // trailing slash tolerated
  assert.equal(month.path, 'jobs/2026-11');
  assert.deepEqual(month.lines.map((l) => l.path), ['jobs/2026-11/alpha-job-20261101']);
  const jobLine = month.lines[0];
  assert.equal(jobLine.open, 'job_status("alpha-job-20261101")');
  assert.match(jobLine.summary, /^FINAL DONE · The landing pages/);
  const job = await map.discover({ path: jobLine.path });
  assert.deepEqual(job.lines.slice(0, 3).map((l) => path.basename(l.path)), ['STATE.md', 'RESULT.md', 'PROMPT.md']);
  assert.ok(job.lines.some((l) => l.path.endsWith('/sub/notes.md')));
  for (const l of job.lines) assert.ok(l.open.startsWith(`read_file("${canonical('jobs/alpha-job-20261101/')}`), l.open);
  // laptop: project → session → day
  const day = (await map.discover({ path: 'chats/laptop/Demo/abcd1234' })).lines;
  assert.deepEqual(day.map((l) => l.path.split('/').at(-1)), ['2026-11-12', '2026-11-10'], 'newest day first');
  assert.ok(day.every((l) => l.class === 'personal' && l.open.startsWith('read_file(')));
  // a decision entry opens at its exact line
  const entries = (await map.discover({ path: 'entscheidungen/2026-11' })).lines;
  const budget = entries.find((l) => /Scoring phase budget/.test(l.title));
  const m = /offset=(\d+)/.exec(budget.open);
  assert.ok(fs.readFileSync(canonical('DECISIONS.md'), 'utf8').split('\n')[Number(m[1])].includes('Scoring phase budget'));
  // a file node has no children but names its open call; a canonical file path resolves to its node
  const file = await map.discover({ path: 'wissen/steuer' });
  assert.deepEqual(file.lines, []);
  assert.equal(file.open, `read_file("${canonical('desk-knowledge/topics/steuer.md')}")`);
  const viaFile = await map.discover({ path: canonical('jobs/alpha-job-20261101/STATE.md') });
  assert.equal(viaFile.path, 'jobs/2026-11/alpha-job-20261101/STATE.md');
  // an unknown path explains itself
  await assert.rejects(() => map.discover({ path: 'jobs/2099-01' }), /unknown map path "jobs\/2099-01"; try one of: .*2026-11/);
  await assert.rejects(() => map.discover({ path: 'a\0b' }), /invalid path/);
});

test('discover with a query searches only inside that branch', { skip }, async () => {
  const inJobs = await map.discover({ path: 'jobs', query: 'marmalade' });
  assert.equal(inJobs.lines.length, 1);
  assert.equal(inJobs.lines[0].path, 'jobs/2026-11/alpha-job-20261101/sub/notes.md');
  assert.match(inJobs.lines[0].snippet, /marmalade/);
  assert.ok(inJobs.lines[0].open.startsWith('read_file('));
  assert.equal((await map.discover({ path: 'wissen', query: 'marmalade' })).lines.length, 0, 'not in another branch');
  const laptop = await map.discover({ path: 'chats/laptop', query: 'Bewertungsphase' });
  assert.ok(laptop.lines.length >= 1 && laptop.lines.every((l) => l.class === 'personal'));
  const board = await map.discover({ path: 'board', query: 'scoring' });
  assert.equal(board.lines[0].path, 'board/22/1');
  assert.equal(board.lines[0].open, 'board_entry("1")');
});

test('a query below a month, an entry or a section of one file searches just that range', { skip }, async () => {
  const names = (r) => r.lines.map((l) => l.title);
  const nov = await map.discover({ path: 'entscheidungen/2026-11', query: 'crypto' });
  assert.equal(nov.lines.length, 1);
  assert.match(nov.lines[0].title, /DECISIONS\.md|Acme crypto rule|Scoring phase/);
  assert.match(nov.lines[0].snippet, /crypto/);
  assert.equal((await map.discover({ path: 'entscheidungen/2026-10', query: 'crypto' })).lines.length, 0, 'the other month has no such entry');
  assert.equal((await map.discover({ path: 'entscheidungen/2026-11', query: 'tax' })).lines.length, 0);
  assert.equal((await map.discover({ path: 'entscheidungen/2026-10', query: 'tax' })).lines.length, 1);
  const entry = await map.search({ query: 'scoring', path: 'entscheidungen/2026-11/2026-11-02-09-30z-scoring-phase-budget' });
  assert.equal(entry.hits.length, 1);
  assert.match(entry.hits[0].heading, /Scoring phase budget/);
  assert.equal((await map.search({ query: 'crypto', path: 'entscheidungen/2026-11/2026-11-02-09-30z-scoring-phase-budget' })).hits.length, 0, 'a neighbouring entry is outside');
  assert.equal((await map.discover({ path: 'regeln/AGENTS.md/1-money', query: 'spend' })).lines.length, 1);
  assert.equal((await map.discover({ path: 'regeln/AGENTS.md/1-money', query: 'plane' })).lines.length, 0, 'text of another section');
  assert.equal((await map.discover({ path: 'regeln/AGENTS.md', query: 'plane' })).lines.length, 1);
  assert.equal(names(nov).length, 1);
  await assert.rejects(() => map.search({ query: 'scoring', path: 'entscheidungen/1999-01' }), /unknown map path/);
});

test('search: a German query finds the English note (synonyms, compounds, umlauts)', { skip }, async () => {
  const r = await map.search({ query: 'Steuerrücklage' });
  assert.ok(r.hits.length >= 1);
  assert.equal(r.hits[0].path, canonical('desk-knowledge/topics/steuer.md'), 'the curated knowledge page wins');
  assert.match(r.hits[0].snippet, /tax reserve/);
  const rule = await map.search({ query: 'Krypto Regel Acme' });
  assert.match(rule.hits[0].path, /DECISIONS\.md$/);
  assert.equal(rule.hits[0].class, 'open');
  assert.match(rule.hits[0].heading, /Acme crypto rule/);
  const long = await map.search({ query: '36 Stunden Bewertungsphase' }); // the note says "scoring phase", "36-hour" and "Bewertungsphase"
  assert.ok(long.hits.length >= 3);
  assert.ok(long.hits.some((h) => /Scoring phase budget/.test(h.heading)));
});

test('search hits: shape, line offsets that point at the chunk, snippet <= 300 chars, open hints', { skip }, async () => {
  const r = await map.search({ query: 'budget scoring', limit: 20 });
  assert.ok(r.hits.length >= 3);
  for (const h of r.hits) {
    for (const k of ['path', 'line', 'title', 'heading', 'snippet', 'score', 'updated', 'class', 'open']) assert.ok(k in h, `${k} in hit`);
    assert.ok(h.snippet.length <= 300, `snippet of ${h.snippet.length}`);
    assert.ok(h.open.startsWith('read_file(') || h.open.startsWith('board_entry('), h.open);
    assert.ok(Number.isFinite(h.score));
  }
  const decision = r.hits.find((h) => h.path.endsWith('DECISIONS.md'));
  const lines = fs.readFileSync(decision.path, 'utf8').split('\n');
  assert.ok(lines[decision.line].startsWith('## 2026-11-02'), `line ${decision.line} is the start of the chunk`);
  assert.equal(decision.open, `read_file("${decision.path}", offset=${decision.line})`);
  const board = r.hits.find((h) => h.source === 'board');
  assert.equal(board.open, 'board_entry("1")');
  assert.equal(board.line, 0);
  // sorted best first, paged
  assert.deepEqual(r.hits.map((h) => h.score), [...r.hits.map((h) => h.score)].sort((a, b) => b - a));
  const p1 = await map.search({ query: 'budget scoring', limit: 2 });
  assert.equal(p1.hits.length, 2);
  assert.equal(p1.nextOffset, 2);
  const p2 = await map.search({ query: 'budget scoring', limit: 2, offset: 2 });
  assert.deepEqual([...p1.hits, ...p2.hits].map((h) => `${h.path}:${h.line}`), r.hits.slice(0, 4).map((h) => `${h.path}:${h.line}`));
});

test('search filters: source, path (branch), since', { skip }, async () => {
  const board = await map.search({ query: 'scoring', source: 'board' });
  assert.ok(board.hits.length >= 1 && board.hits.every((h) => h.source === 'board'));
  const branch = await map.search({ query: 'scoring', path: 'jobs/2026-11' });
  assert.ok(branch.hits.length >= 1 && branch.hits.every((h) => h.node.startsWith('jobs/2026-11')));
  const recent = await map.search({ query: 'scoring', since: '2026-11-13' });
  assert.ok(recent.hits.every((h) => h.updated >= '2026-11-13'), recent.hits.map((h) => h.updated).join());
  const old = await map.search({ query: 'tax', since: '2099-01-01' });
  assert.equal(old.hits.length, 0);
  await assert.rejects(() => map.search({ query: 'tax', since: 'yesterday-ish' }), /ISO date/);
});

test('search never lets a query inject FTS5 syntax or crash the method', { skip }, async () => {
  const evil = ['"', '""', '"unterminated', '*', '**', 'NEAR(', 'NEAR(a b)', 'a NEAR/2 b', 'AND OR', 'AND', 'OR', 'NOT', ':', '::', '^', '^scoring', 'heading:scoring', 'body : scoring', '{heading body}: scoring',
    'scoring*', '(scoring', 'scoring)', '- scoring', 'scoring -tax', '+', '"scoring" OR "tax"', 'tax OR', "'; DROP TABLE docs; --", 'a'.repeat(5000), '\u0000', '%', '_', '\\', 'scoring\\"', '(((', ')))', '<>', '| |'];
  for (const q of evil) {
    try {
      const r = await map.search({ query: q, limit: 5 });
      assert.ok(Array.isArray(r.hits), `result for ${JSON.stringify(q).slice(0, 40)}`);
    } catch (err) {
      assert.match(err.message, /query has no searchable words|query required|secret|Schlüssel/, `${JSON.stringify(q).slice(0, 40)}: ${err.message}`);
    }
    await map.discover({ path: 'jobs', query: q }).catch((err) => assert.match(err.message, /query has no searchable words|secret|Schlüssel/));
  }
  // the docs table is intact and quoted operators are just words
  assert.ok((await map.status()).docs > 10);
  const m = buildMatch('NEAR(a b) AND scoring:x ^foo "bar');
  assert.match(m.strict, /^(\("[^"]*"\*?( OR "[^"]*"\*?)*\)( AND )?)+$/, m.strict);
  assert.ok(!/NEAR|[:^]/.test(m.strict));
  await assert.rejects(() => map.search({ query: '' }), /query required/);
  await assert.rejects(() => map.search({ query: 'the of and' }), /no searchable words/);
  await assert.rejects(() => map.search({ query: 'Zq7xWv2PqRt9' }), /Schlüssel|secret/);
});

test('query expansion: DE→EN rows, stems and umlaut transliteration', () => {
  const words = (q) => queryGroups(q).map((g) => g.variants.join('|'));
  assert.match(words('Steuerrücklage')[0], /steuerrücklag|tax/);
  assert.ok(queryGroups('Steuerrücklage').some((g) => g.variants.includes('tax')) && queryGroups('Steuerrücklage').some((g) => g.variants.includes('reserve')));
  assert.ok(queryGroups('48 Stunden').some((g) => g.variants.includes('hour')));
  assert.ok(queryGroups('Größe').some((g) => g.variants.includes('groesse')), 'ß/ö transliteration');
  assert.ok(queryGroups('Bewertungsphase').some((g) => g.variants.includes('scoring')));
});

test('hits never include a denied path even if one were in the index', { skip }, async () => {
  // the builder filters at build time; the method filters again at query time
  const d = new sqlite.DatabaseSync(path.join(fx.mapDir, 'index.sqlite'));
  d.exec("INSERT INTO docs(id, path, source, node, title, mtime, size) VALUES(9999, '/home/x/jobs/wallet-keys/STATE.md', 'jobs', 'jobs/2026-11/wallet-keys', 'x', 1, 1)");
  d.exec("INSERT INTO chunks(rowid, doc_id, line, heading, body) VALUES(999900000, 9999, 0, '', 'zebrafish planted in a denied path')");
  d.close();
  const r = await map.search({ query: 'zebrafish' });
  assert.equal(r.hits.length, 0);
});

test('map.* is registered on the LeChonk bridge only, and declared in METHOD_PARAMS', async () => {
  const { buildMethods } = await import('../src/bridge.js');
  const { METHOD_PARAMS } = await import('../src/params.js');
  const lechonk = Object.keys(buildMethods({}, 'lechonk'));
  const sandy = Object.keys(buildMethods({}, 'sandy'));
  for (const m of ['map.discover', 'map.search', 'map.status']) {
    assert.ok(lechonk.includes(m), `${m} on lechonk`);
    assert.ok(!sandy.includes(m), `${m} not on sandy`);
    assert.ok(m in METHOD_PARAMS, `${m} in METHOD_PARAMS`);
  }
  assert.deepEqual(Object.keys(METHOD_PARAMS['map.search']).sort(), ['limit', 'offset', 'path', 'query', 'since', 'source']);
});
