import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The allowlist is rooted at BRIDGE_HOME, so the tests run against a throwaway home.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-home-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-outside-'));
process.env.BRIDGE_HOME = home;
const ctx = await import('../src/ctx.js');
const { resolveAllowed } = await import('../src/paths.js');

before(() => {
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'agents rules\n');
  fs.writeFileSync(path.join(home, 'DECISIONS.md'), `newest decision\n${'x'.repeat(5000)}\n`);
  fs.mkdirSync(path.join(home, 'desk-sessions', 'd1'), { recursive: true });
  fs.writeFileSync(path.join(home, 'desk-sessions', 'd1', 'notes.md'), Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
  fs.writeFileSync(path.join(home, 'desk-sessions', 'd1', 'token.txt'), 'nope');
  fs.mkdirSync(path.join(home, 'desk-sessions', '.ssh'));
  fs.writeFileSync(path.join(home, 'desk-sessions', '.ssh', 'id'), 'nope');
  fs.writeFileSync(path.join(outside, 'passwd'), 'root:x:0:0');
  fs.symlinkSync(path.join(outside, 'passwd'), path.join(home, 'desk-sessions', 'd1', 'link.md'));
  fs.symlinkSync(outside, path.join(home, 'desk-sessions', 'dirlink'));
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's.jsonl'), '{"a":1}\n');
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 's.txt'), 'x');
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const denied = (p) => assert.throws(() => resolveAllowed(p), /not allowed|not found/);

test('reads allowed files', async () => {
  const r = await ctx.read({ path: path.join(home, 'desk-sessions/d1/notes.md'), offset: 2, limit: 3 });
  assert.equal(r.text, 'line 2\nline 3\nline 4');
  assert.equal(r.truncated, true);
});

test('blocks ../ traversal', () => {
  denied(path.join(home, 'desk-sessions', '..', '..', '..', 'etc', 'passwd'));
  denied(`${home}/desk-sessions/d1/../../../../../../etc/passwd`);
});

test('blocks files outside the allowlist', () => {
  denied('/etc/passwd');
  denied(path.join(home, '.bashrc'));
  denied('relative/path.md');
  denied('');
  denied('/etc/passwd\0.md');
});

test('blocks symlinks that leave the allowed roots', () => {
  denied(path.join(home, 'desk-sessions/d1/link.md'));
  denied(path.join(home, 'desk-sessions/dirlink/passwd'));
});

test('blocks deny-listed names', () => {
  denied(path.join(home, 'desk-sessions/d1/token.txt'));
  denied(path.join(home, 'desk-sessions/.ssh/id'));
  denied(path.join(home, '.ssh/id_rsa'));
});

test('chat histories are limited to .jsonl', () => {
  assert.ok(resolveAllowed(path.join(home, '.claude/projects/p/s.jsonl')));
  denied(path.join(home, '.claude/projects/p/s.txt'));
});

test('core docs: DECISIONS returns the head capped by maxChars', async () => {
  const r = await ctx.core({ name: 'decisions', maxChars: 300 });
  assert.ok(r.text.startsWith('newest decision'));
  assert.equal(r.text.length, 300);
  assert.equal(r.truncated, true);
  await assert.rejects(ctx.core({ name: 'SHADOW' }), /unknown core doc/);
});

test('read redacts secrets inside allowed files', async () => {
  fs.writeFileSync(path.join(home, 'desk-sessions/d1/leak.md'), 'key sk-abcdefghijklmnop1234 end');
  const r = await ctx.read({ path: path.join(home, 'desk-sessions/d1/leak.md') });
  assert.equal(r.text, 'key [REDACTED] end');
});

test('list hides denied entries', async () => {
  const r = await ctx.list({ path: path.join(home, 'desk-sessions') });
  const names = r.entries.map((e) => e.name);
  assert.ok(names.includes('d1'));
  assert.ok(!names.includes('.ssh'));
  assert.ok(!names.includes('dirlink'));
});

test('read counts LINES: totalLines and nextOffset let the caller page', async () => {
  const file = path.join(home, 'desk-sessions/d1/notes.md');
  const first = await ctx.read({ path: file, offset: 0, limit: 20 });
  assert.equal(first.lines, 20);
  assert.equal(first.totalLines, 50);
  assert.equal(first.nextOffset, 20);
  const rest = await ctx.read({ path: file, offset: first.nextOffset, limit: 400 });
  assert.deepEqual([rest.lines, rest.truncated, rest.nextOffset], [30, false, undefined]);
  const past = await ctx.read({ path: file, offset: 4000, limit: 400 });
  assert.equal(past.lines, 0);
  assert.match(past.note, /LINES, not characters/);
});

test('core DECISIONS carries the newest-first hint', async () => {
  assert.match((await ctx.core({ name: 'DECISIONS' })).note, /newest-first/);
  assert.equal((await ctx.core({ name: 'AGENTS' })).note, undefined);
});

test('decisionsToday lists ALL of today\'s entries (shortened) before older days when the budget is tight', async () => {
  const file = path.join(home, 'DECISIONS.md');
  const original = fs.readFileSync(file);
  const entry = (date, n) => `## ${date} 09:00Z — Eintrag ${n}\n- ${'t'.repeat(900)}\n\n`;
  fs.writeFileSync(file, Array.from({ length: 13 }, (_, i) => entry('2026-10-24', i)).join('') + Array.from({ length: 40 }, (_, i) => entry('2026-10-23', i)).join(''));
  try {
    const r = await ctx.decisionsToday({ now: new Date('2026-10-24T12:00:00Z') });
    assert.equal(r.entriesToday, 13);
    assert.equal(r.entries.filter((e) => e.date === '2026-10-24').length, 13);
    assert.ok(r.omitted > 0 && r.entries.length < 53);
    assert.ok(JSON.stringify(r).length < 8192);
  } finally {
    fs.writeFileSync(file, original);
  }
});

test('decisionsToday returns only today and yesterday, newest first, within the size cap', async () => {
  const file = path.join(home, 'DECISIONS.md');
  const original = fs.readFileSync(file);
  const entry = (date, title, body) => `## ${date} 09:00Z — ${title}\n- ${body}\nresolved-keys: ${title.toLowerCase().replace(/\W+/g, '-')}\n\n`;
  const now = new Date('2026-10-24T12:00:00Z');
  fs.writeFileSync(file, '<!-- header -->\n'
    + entry('2026-10-24', 'Heute zwei', 'B'.repeat(4000))
    + entry('2026-10-24', 'Heute eins', 'A'.repeat(300))
    + entry('2026-10-23', 'Gestern', 'C'.repeat(300))
    + entry('2026-10-22', 'Vorgestern', 'D'.repeat(300)));
  try {
    const r = await ctx.decisionsToday({ now });
    assert.equal(r.today, '2026-10-24');
    assert.deepEqual(r.entries.map((e) => e.heading.slice(0, 27)), ['2026-10-24 09:00Z — Heute z', '2026-10-24 09:00Z — Heute e', '2026-10-23 09:00Z — Gestern']);
    assert.ok(JSON.stringify(r).length < 8192);
    assert.ok(!r.entries.some((e) => e.text.includes('resolved-keys')));
    assert.deepEqual((await ctx.decisionsToday({ now, days: 1 })).entries.length, 2);
    const tiny = await ctx.decisionsToday({ now, maxChars: 1000 });
    assert.ok(JSON.stringify(tiny.entries).length < 2000);
    assert.equal(r.entriesToday, 2);
  } finally {
    fs.writeFileSync(file, original);
  }
});
