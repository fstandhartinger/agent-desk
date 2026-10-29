import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex, buildTopic, keywordMatcher, parseBoard, parseDecisions, TOPIC_MAX } from '../scripts/knowledge/build.mjs';

const NOW = new Date('2026-10-24T05:30:00Z');
const DECISIONS = `<!-- header -->
## 2026-10-24 09:00Z — SN92 owner tranches
- Owner emission tranches stay at 60 alpha; tax reserve 30 %.
resolved-keys: x

## 2026-10-23 08:00Z — Mint pricing
- PDFMint price unchanged.

## 2026-10-10 10:00Z — Old SN92 note
- Too old for "Neu seit gestern".
`;
const BOARD = `header line
#25001 [2026-10-23T20:00:00Z] claude:reax-job · note
TAX line: 60 alpha tranche converted, api_key=abcdefghijklmnopqrstuvwxyz posted
#25002 [2026-10-23T21:00:00Z] codex:mint · finding
MailMint deploy green.`;
const TOPIC = `# Owner emissions and tax
<!-- keywords: owner emission, tax, tranche, steuer -->
<!-- curated:start -->
## Key facts
- 250-alpha tranches, 3 per day (DECISIONS 2026-10-19).
<!-- curated:end -->
`;

const opts = () => ({ decisions: parseDecisions(DECISIONS), board: parseBoard(BOARD).map((e) => ({ thread: '22', ...e })), now: NOW });

test('parseBoard / parseDecisions read the real formats', () => {
  const b = parseBoard(BOARD);
  assert.deepEqual(b.map((e) => [e.id, e.author]), [[25001, 'claude:reax-job'], [25002, 'codex:mint']]);
  const d = parseDecisions(DECISIONS);
  assert.equal(d.length, 3);
  assert.ok(!d[0].text.includes('resolved-keys'));
});

test('keywordMatcher: short keywords match whole words only', () => {
  const m = keywordMatcher(['tax', 'tranche']);
  assert.equal(m('syntax error'), 0);
  assert.equal(m('TAX line'), 1);
  assert.equal(m('Tranchen with tax'), 2, 'counts distinct keywords');
});

test('buildTopic: curated part byte-identical, "Neu seit gestern" from the last 48 h matching the keywords, secrets scrubbed', () => {
  const { text, count } = buildTopic(TOPIC, opts());
  assert.ok(text.startsWith(TOPIC), 'curated part changed');
  assert.match(text, /## Neu seit gestern/);
  assert.match(text, /DECISIONS 2026-10-24: .*SN92 owner tranches/);
  assert.match(text, /Board #25001 \(thread #22/);
  assert.ok(!text.includes('Old SN92 note'), 'older than 48 h');
  assert.ok(!text.includes('Mint pricing') && !text.includes('MailMint'), 'not this topic');
  assert.ok(!text.includes('abcdefghijklmnop'), 'secret leaked');
  assert.equal(count, 2);
});

test('buildTopic is idempotent (the auto block is replaced, not appended) and stays within 8,000 chars', () => {
  const once = buildTopic(TOPIC, opts()).text;
  assert.equal(buildTopic(once, opts()).text, once);
  const big = TOPIC.replace('## Key facts', `## Key facts\n${'- fact\n'.repeat(1000)}`.slice(0, 7600));
  const many = { ...opts(), board: Array.from({ length: 50 }, (_, i) => ({ id: i, ts: '2026-10-23T22:00:00Z', author: 'a', thread: '22', text: `tax ${'x'.repeat(200)}` })) };
  assert.ok(buildTopic(big, many).text.length <= TOPIC_MAX + 50);
});

test('buildIndex keeps the curated index and names the topics with news', () => {
  const idx = buildIndex('# Index\n## SN92\n', [{ slug: 'owner-emissions-tax', count: 2 }, { slug: 'servers', count: 0 }], NOW);
  assert.ok(idx.startsWith('# Index\n## SN92\n'));
  assert.match(idx, /Neu seit gestern \(2026-10-24\): owner-emissions-tax \(2\)\./);
  assert.equal(buildIndex(idx, [], NOW).match(/auto:start/g).length, 1);
});

test('CLI run on a folder: writes topics + INDEX, 0600 files, deterministic for the same --now', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-'));
  try {
    fs.mkdirSync(path.join(dir, 'topics'));
    fs.writeFileSync(path.join(dir, 'topics', 'owner-emissions-tax.md'), TOPIC);
    fs.writeFileSync(path.join(dir, 'INDEX.md'), '# Index\n');
    fs.writeFileSync(path.join(dir, 'DECISIONS.md'), DECISIONS);
    fs.writeFileSync(path.join(dir, 'board.txt'), BOARD);
    const run = () => execFileSync(process.execPath, ['scripts/knowledge/build.mjs', '--dir', dir, '--decisions', path.join(dir, 'DECISIONS.md'), '--board-file', path.join(dir, 'board.txt'), '--now', NOW.toISOString()], { encoding: 'utf8' });
    const out = JSON.parse(run());
    assert.equal(out.topics[0].count, 2);
    const first = fs.readFileSync(path.join(dir, 'topics', 'owner-emissions-tax.md'), 'utf8');
    run();
    assert.equal(fs.readFileSync(path.join(dir, 'topics', 'owner-emissions-tax.md'), 'utf8'), first);
    assert.match(fs.readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), /owner-emissions-tax \(2\)/);
    assert.equal(fs.statSync(path.join(dir, 'topics', 'owner-emissions-tax.md')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('systemd timer: daily 07:30 Europe/Berlin, persistent; service runs the installed copy, not ~/apps', () => {
  const timer = fs.readFileSync(new URL('../systemd/desk-knowledge.timer', import.meta.url), 'utf8');
  assert.match(timer, /^OnCalendar=\*-\*-\* 07:30:00 Europe\/Berlin$/m);
  assert.match(timer, /^Persistent=true$/m);
  const service = fs.readFileSync(new URL('../systemd/desk-knowledge.service', import.meta.url), 'utf8');
  assert.match(service, /ExecStart=%h\/desk-knowledge\/\.generator\/refresh\.sh/);
  assert.doesNotMatch(service, /apps/);
});

test('news-keywords narrow "Neu seit gestern" (broad search keywords would match everything) and rank by hits', () => {
  const topic = TOPIC.replace('-->\n<!-- curated:start -->', '-->\n<!-- news-keywords: tranche, owner emission -->\n<!-- curated:start -->');
  const board = [
    { id: 1, ts: '2026-10-23T20:00:00Z', author: 'a', thread: '22', text: 'TAX: USD 20 xAI top-up' },
    { id: 2, ts: '2026-10-23T21:00:00Z', author: 'b', thread: '22', text: 'tranche 15 sold, owner emission arrived' },
    { id: 3, ts: '2026-10-23T22:00:00Z', author: 'c', thread: '22', text: 'tranche skipped' },
  ];
  const { text, count } = buildTopic(topic, { ...opts(), board });
  assert.ok(!text.includes('xAI top-up'), 'tax alone is not in the news list');
  assert.ok(text.indexOf('Board #3') > 0 && text.indexOf('Board #2') > text.indexOf('Board #3'), 'newest first within the kept set');
  assert.equal(count, 3); // 1 decision (owner emission tranches) + 2 board
});

test('digest full logs (thread #28) never fill "Neu seit gestern"', () => {
  const board = [{ id: 9, ts: '2026-10-23T22:00:00Z', author: 'agent:flori', thread: '28', text: 'Digest full log abc — tax tranche owner emission steuer' }];
  const { text } = buildTopic(TOPIC, { ...opts(), board });
  assert.ok(!text.includes('Board #9'));
});
