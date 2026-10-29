import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Florian's 24 Oct voice session: search_files returned zero hits for "SN92 subnet honorarium emission Bittensor",
// "Steuer Rücklage" and friends, because every query was one literal phrase. These fixtures reproduce that.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-search-'));
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mirror-'));
fs.rmSync(mirror, { recursive: true });
process.env.BRIDGE_HOME = home;
process.env.BRIDGE_NOTES_MIRROR = mirror;
const ctx = await import('../src/ctx.js');
const { expandQuery, groupsIn } = await import('../src/searchTerms.js');
const notes = await import('../src/notesMirror.js');

const write = (rel, text) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

before(() => {
  write('AGENTS.md', 'Shared rules.\nREAX is Bittensor subnet 92.\n');
  write('DECISIONS.md', '## 2026-10-24 tranches\nOwner emission tranches: keep the tax reserve at 30 % and convert to EUR.\n');
  write('jobs/sn92-owner-tranches-20261019/STATE.md', '# STATE\n- SN92 owner emissions arrive as 60-alpha tranches, 4 per day.\n- Tax reserve ~30 %, converted to EUR via a wallet app.\n');
  write('jobs/sn92-owner-tranches-20261019/notes/ledger.md', 'Geldbewegungen: TAX line posted on board #22.\n');
  write('jobs/unrelated-20261001/STATE.md', '# STATE\nFixed a syntax error in the parser. Neural nets are fun.\n');
  write('jobs/unrelated-20261001/wallet/keys.md', 'SN92 owner tax reserve secret material\n');
  write('desk-knowledge/INDEX.md', '## SN92 / REAX\n<!-- keywords: sn92, owner emissions -->\nOwner emissions and tax: see topics/owner-emissions-tax.md\n');
  fs.mkdirSync(path.join(home, '.agents', 'skills', 'x'), { recursive: true });
  write('.agents/skills/x/SKILL.md', 'Bittensor reader skill.\n');
  fs.symlinkSync('/etc/hostname', path.join(home, 'jobs', 'unrelated-20261001', 'host.md'));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(mirror, { recursive: true, force: true });
});

const paths = (r) => [...new Set(r.hits.map((h) => path.relative(home, h.path)))];

test('expandQuery: German compounds split into stems with English synonyms', () => {
  const groups = expandQuery('Steuerrücklagen Honoraremissionen Euro umwandeln');
  const all = groups.map((g) => g.variants);
  assert.ok(all.some((v) => v.includes('tax')), JSON.stringify(all));
  assert.ok(all.some((v) => v.includes('reserve')));
  assert.ok(all.some((v) => v.includes('emission')));
  assert.ok(all.some((v) => v.includes('owner')));
  assert.ok(all.some((v) => v.includes('convert')));
});

test('expandQuery: "Subnetz 92" / "subnet 92" become the SN92 group; stopwords drop out', () => {
  for (const q of ['unser Subnetz 92 emittiert', 'subnet 92', 'netuid 92', 'SN92']) {
    assert.ok(expandQuery(q)[0].variants.includes('sn92'), q);
  }
  assert.deepEqual(expandQuery('was ist der Stand über unsere').map((g) => g.word), []);
});

test('groupsIn: short variants only match whole words ("tax" not in "syntax", "eur" not in "neural")', () => {
  const groups = expandQuery('tax euro');
  assert.deepEqual(groupsIn('Fixed a syntax error. Neural nets.', groups), []);
  assert.deepEqual(groupsIn('TAX line: 100 EUR', groups), [0, 1]);
});

test('multiword query = OR of terms ranked by matches, not one literal phrase (the zero-hit bug)', async () => {
  const r = await ctx.search({ query: 'SN92 subnet honorarium emission Bittensor' });
  assert.ok(r.hits.length > 0, 'zero hits is the 24 Oct bug');
  const top = paths(r);
  assert.ok(top.includes('jobs/sn92-owner-tranches-20261019/STATE.md'), top.join(', '));
});

test('single words SN92 / bittensor find job notes, docs and skills', async () => {
  assert.ok(paths(await ctx.search({ query: 'SN92' })).includes('jobs/sn92-owner-tranches-20261019/STATE.md'));
  const b = paths(await ctx.search({ query: 'bittensor' }));
  assert.ok(b.includes('AGENTS.md') && b.includes('.agents/skills/x/SKILL.md'), b.join(', '));
});

test('German query finds English notes: "Steuer", "Steuerrücklagen Honoraremissionen Euro umwandeln"', async () => {
  const s = paths(await ctx.search({ query: 'Steuer' }));
  assert.ok(s.includes('jobs/sn92-owner-tranches-20261019/STATE.md'), s.join(', '));
  assert.ok(!s.includes('jobs/unrelated-20261001/STATE.md'), 'syntax is not tax');
  const r = await ctx.search({ query: 'Steuerrücklagen Honoraremissionen Euro umwandeln' });
  const top = paths(r).slice(0, 3);
  assert.ok(top.includes('DECISIONS.md') && top.includes('jobs/sn92-owner-tranches-20261019/STATE.md'), top.join(', '));
});

test('knowledge files outrank job notes with the same coverage; deny list and symlinks never surface', async () => {
  const r = await ctx.search({ query: 'SN92 owner emissions' });
  assert.equal(path.relative(home, r.hits[0].path), 'desk-knowledge/INDEX.md');
  assert.ok(!r.hits.some((h) => h.text.startsWith('<!--')), 'keyword comment lines are not hits');
  const all = paths(await ctx.search({ query: 'SN92 owner tax reserve secret', maxHits: 100 }));
  assert.ok(!all.some((p) => p.includes('wallet')), all.join(', '));
  assert.ok(!all.some((p) => p.endsWith('host.md')));
});

test('hits carry canonical paths, term coverage and the expanded terms; answers in < 3 s', async () => {
  const t = Date.now();
  const r = await ctx.search({ query: 'tax reserve' });
  assert.ok(Date.now() - t < 3000);
  assert.match(r.hits[0].terms, /^2\/2$/);
  assert.equal(r.terms.length, 2);
  assert.ok(r.hits.every((h) => h.path.startsWith(home)));
});

test('notes mirror: copies only regular, allowed note files; search then reads the mirror under canonical paths', async () => {
  await notes.syncNotes(); // the first search may already have started one in the background
  assert.ok(notes.mirrorReady());
  assert.ok(fs.existsSync(path.join(mirror, 'sn92-owner-tranches-20261019/notes/ledger.md')));
  assert.ok(!fs.existsSync(path.join(mirror, 'unrelated-20261001/wallet')), 'deny-listed folder copied');
  assert.ok(!fs.existsSync(path.join(mirror, 'unrelated-20261001/host.md')), 'symlink copied');
  assert.equal(fs.readFileSync(path.join(mirror, 'sn92-owner-tranches-20261019/STATE.md'), 'utf8').includes('60-alpha'), true);
  assert.equal((await notes.syncNotes()).copied, 0, 'second sync is incremental');
  // Hits found in the mirror show under the canonical jobs path, never under the cache directory.
  const r = await ctx.search({ query: 'Geldbewegungen' });
  assert.deepEqual(paths(r), ['jobs/sn92-owner-tranches-20261019/notes/ledger.md']);
  fs.rmSync(path.join(home, 'jobs/sn92-owner-tranches-20261019/notes/ledger.md'));
  assert.equal((await notes.syncNotes()).removed, 1, 'deleted notes leave the mirror');
});

test('empty and stopword-only queries are refused', async () => {
  await assert.rejects(ctx.search({ query: '  ' }), /query required/);
  await assert.rejects(ctx.search({ query: 'der die das' }), /no searchable words/);
});
