// Start briefing read methods (item G): board.recent, notify.cardsRecent, state.current. Synthetic data only: this repository is public.
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-briefing-'));
process.env.BRIDGE_HOME = home;
const db = path.join(home, 'board.db');
process.env.AGENT_BOARD_DB = db;
for (const [n, body] of [['ask', 'echo "A1 in-progress first ask api_key=abcdefghijkl"; echo "A2 waiting second ask"'], ['systemctl', '']]) {
  fs.mkdirSync(path.join(home, 'stubs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'stubs', n), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}
fs.writeFileSync(path.join(home, 'stubs', 'jobs'), '#!/bin/sh\necho "job-a.service loaded active running A"\necho "job-b.service loaded active running B"\n', { mode: 0o755 });
process.env.BRIDGE_OPS_BIN_ASK = path.join(home, 'stubs', 'ask');
const { recent } = await import('../src/board.js');
const { cardsRecent } = await import('../src/notify.js');
const { autoBlock, newestHeadings, current } = await import('../src/state.js');
const { buildMethods } = await import('../src/bridge.js');
const { METHOD_PARAMS } = await import('../src/params.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const iso = (agoH) => new Date(Date.now() - agoH * 3600_000).toISOString().slice(0, 19);
test('board.recent: newest first over all threads, cut by hours, text clipped and redacted, database untouched', async () => {
  const rows = [[1, 1, 'a:old', 'note', iso(30), 'too old'], [2, 1, 'a:one', 'note', iso(5), 'x'.repeat(500)], [3, 2, 'a:two', 'decision', iso(1).replace('T', ' '), 'token=abcdefghijklmnop and <b>text</b>']];
  execFileSync('python3', ['-c', `import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1])
c.executescript("CREATE TABLE threads(id INTEGER,title TEXT); CREATE TABLE entries(id INTEGER,thread_id INTEGER,author TEXT,kind TEXT,created_at TEXT,body TEXT); INSERT INTO threads VALUES(1,'One'); INSERT INTO threads VALUES(2,'Two')")
c.executemany("INSERT INTO entries VALUES(?,?,?,?,?,?)", json.loads(sys.argv[2]))
c.commit()`, db, JSON.stringify(rows)]);
  const before = fs.readFileSync(db);
  const r = await recent({ hours: 6, limit: 40 });
  assert.deepEqual(r.entries.map((e) => e.id), [3, 2]);
  assert.equal(r.entries[0].thread, 'Two'); assert.equal(r.entries[0].kind, 'decision');
  assert.ok(r.entries[1].text.length <= 240);
  assert.ok(!r.entries[0].text.includes('abcdefghijklmnop'));
  assert.equal((await recent({ hours: 6, limit: 1 })).entries.length, 1);
  assert.equal((await recent({ hours: 48 })).entries.length, 3);
  assert.deepEqual(fs.readFileSync(db), before, 'read-only');
});

const cardsDir = path.join(home, '.notify', 'cards');
test('notify.cardsRecent: card files of the last hours, newest first, status line + headline + answered + aid, nothing else', async () => {
  fs.mkdirSync(cardsDir, { recursive: true });
  const put = (id, card, agoH) => { const f = path.join(cardsDir, `${id}.json`); fs.writeFileSync(f, JSON.stringify(card)); const t = new Date(Date.now() - agoH * 3600_000); fs.utimesSync(f, t, t); };
  put(101, { text: "🧑 DU BIST DRAN\nWorum geht's: Approve the fake spend of EUR 5?\nWhy: reason", aid: 'abc123', answered: true }, 0.5);
  put(102, { text: '<b>🤖 LÄUFT</b>\n<b>Fake agents are working</b>\nsecret=abcdefghijklmnop', parse_mode: 'HTML' }, 3);
  put(103, { text: '✅ ERLEDIGT\nWorum geht\'s: old one' }, 40);
  fs.writeFileSync(path.join(cardsDir, 'notacard.json'), '{}');
  fs.writeFileSync(path.join(cardsDir, '104.json'), 'not json');
  const r = await cardsRecent({ hours: 12, limit: 20 });
  assert.deepEqual(r.cards.map((c) => c.card), ['101', '102']);
  assert.equal(r.cards[0].status, '🧑 DU BIST DRAN');
  assert.equal(r.cards[0].headline, 'Approve the fake spend of EUR 5?');
  assert.equal(r.cards[0].answered, true); assert.equal(r.cards[0].aid, 'a#abc123');
  assert.equal(r.cards[1].answered, false);
  assert.ok(!JSON.stringify(r).includes('abcdefghijklmnop'));
  assert.ok(!JSON.stringify(r).includes('reason'), 'no card body beyond the headline');
  assert.equal((await cardsRecent({ hours: 12, limit: 1 })).cards.length, 1);
  assert.deepEqual(await cardsRecent({ hours: 1, limit: 5 }).then((x) => x.cards.map((c) => c.card)), ['101']);
});

test('state.current helpers: auto block only, newest three decision headings by date whatever the file order', () => {
  const text = 'intro\n<!-- auto:start --> (generated)\n## Machines (auto)\n- Sandy ok\n\n<!-- auto:end -->\nhand written';
  assert.equal(autoBlock(text), '(generated)\n## Machines (auto)\n- Sandy ok'.replace('(generated)', '(generated)'));
  assert.equal(autoBlock('nothing'), '');
  const d = '# D\n## 2026-10-30 08:52Z — b\n## 2026-11-02 10:00Z — newest\n## 2026-10-28 22:18Z — a\n## 2026-11-01 01:00Z — mid\ntext';
  assert.deepEqual(newestHeadings(d, 3), ['2026-11-02 10:00Z — newest', '2026-11-01 01:00Z — mid', '2026-10-30 08:52Z — b']);
});

test('state.current: STATE block, headings, open asks (redacted), running jobs; a failing part is named in missing', async () => {
  fs.writeFileSync(path.join(home, 'STATE.md'), '# S\n<!-- auto:start --> (gen)\n- fake line password=hunter2hunter2\n<!-- auto:end -->\n');
  fs.writeFileSync(path.join(home, 'DECISIONS.md'), '## 2026-11-02 10:00Z — fake\n## 2026-11-03 09:00Z — newer\n');
  const r = await current();
  assert.match(r.state, /fake line/); assert.ok(!r.state.includes('hunter2hunter2'));
  assert.equal(r.decisions[0], '2026-11-03 09:00Z — newer');
  assert.equal(r.asksOpen, 2); assert.ok(!r.asks.join().includes('abcdefghijkl'));
  assert.ok(r.missing?.includes('jobs') || typeof r.jobsRunning === 'number');
  fs.rmSync(path.join(home, 'DECISIONS.md'));
  assert.ok((await current()).missing.includes('decisions'));
});

test('registered on the Sandy bridge only, with parameters', () => {
  const sandy = buildMethods({}, 'sandy'), lechonk = buildMethods({}, 'lechonk');
  for (const m of ['board.recent', 'notify.cardsRecent', 'state.current']) { assert.ok(sandy[m], m); assert.ok(!lechonk[m], m); assert.ok(METHOD_PARAMS[m], m); }
  assert.deepEqual(METHOD_PARAMS['board.recent'], { hours: 'integer', limit: 'integer' });
});
