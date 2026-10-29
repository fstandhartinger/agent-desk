import test from 'node:test';
import assert from 'node:assert/strict';
import { matchThread, parseThreads } from '../src/board.js';

const LIST = `#22 System1 Models + REAX [s1m] · 1234 entries · 2026-10-24T11:00:05Z · latest #1300 decision
#15 Ops & security [ops, security] · 321 entries · 2026-10-24T10:58:39Z · latest #1299 answer
#11 JevBench releases [jevbench, release] · 654 entries · 2026-10-24T10:55:44Z · latest #1298 note
#8 Site & deploy (benchmarkheaven.com) [jevbench, site] · 87 entries · 2026-10-24T04:12:17Z · latest #1250 handoff`;

test('threads output is parsed into id, title and tags', () => {
  const list = parseThreads(LIST);
  assert.deepEqual(list.map((t) => t.id), ['22', '15', '11', '8']);
  assert.deepEqual(list[1], { id: '15', title: 'Ops & security', tags: 'ops, security' });
});

test('a misheard thread name resolves to its id; an unclear one lists candidates', () => {
  const list = parseThreads(LIST);
  assert.equal(matchThread('Ops und Security', list).id, '15');
  assert.equal(matchThread('jev bench releases', list).id, '11');
  assert.throws(() => matchThread('jevbench', list), /did you mean .*#11 .*#8 /);
  assert.throws(() => matchThread('quantum cooking', list), /call board_threads/);
});
