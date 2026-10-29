// Critic round 6, slice r7: P2-2 (outcome claims of auto drawings), P2-3 (CJK names from tool results stay), P2-4 (reformatted
// dates are known). All data synthetic.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cjkRuns, stripCjk } from '../src/canvas.js';
import { sourceIsoDates, unknownIdentifiers } from '../src/proseGuard.js';
import { unsupportedOutcome } from '../src/illustrator.js';

describe('P2-3 stripCjk keeps CJK runs that a tool result carries', () => {
  const tool = '{"dms":[{"label":"测试","id":"@me/1"},{"label":"Beispiel Nutzer"}]}';
  it('a DM label from the tool result stays, a stray glyph goes', () => {
    assert.equal(stripCjk('Der neueste Verlauf ist mit 测试 (Beispiel-Miner).', [tool]), 'Der neueste Verlauf ist mit 测试 (Beispiel-Miner).');
    assert.equal(stripCjk('ohne弛 Payload, mit 测试', [tool]), 'ohne Payload, mit 测试');
    assert.equal(stripCjk('ohne弛 Payload'), 'ohne Payload');
  });
  it('a name split over two stream pieces stays (each half is a substring)', () => {
    assert.equal(stripCjk('mit 测', [tool]) + stripCjk('试 geschrieben', [tool]), 'mit 测试 geschrieben');
  });
  it('a run that only partly matches is a slip', () => {
    assert.equal(stripCjk('mit 测试弛', [tool]), 'mit ');
  });
  it('cjkRuns lists the runs of a tool result (the voice session keeps these)', () => {
    assert.deepEqual(cjkRuns(tool), ['测试']);
    assert.equal(stripCjk('Antwort an 测试', cjkRuns(tool)), 'Antwort an 测试');
  });
});

describe('P2-4 the identifier guard knows RFC-2822 and German dates in ISO form', () => {
  it('an ISO date written for an RFC / DD.MM.YYYY / DD Mon YYYY / Mon DD, YYYY source date is known', () => {
    for (const src of ['date: tue, 28 oct 2026 19:04:00 +0000', 'am 28.10.2026 kam die mail', 'am 28. oktober 2026', 'received 28 okt. 2026', 'on oct 28, 2026'])
      assert.deepEqual(unknownIdentifiers('Die Mail kam am 2026-10-28 an.', src), [], src);
  });
  it('another day is still unknown, impossible dates are not normalised', () => {
    assert.deepEqual(unknownIdentifiers('Die Mail kam am 2026-10-29 an.', 'date: tue, 28 oct 2026 19:04:00'), ['2026-10-29']);
    assert.deepEqual([...sourceIsoDates('13.13.2026 und 0.1.2026 und 1.2.2026')], ['2026-02-01']);
  });
});

describe('P2-2 an automatic drawing claims no outcome the agent results do not state', () => {
  it('"blockt" / "wehrt ... ab" / "HTTP 403" without an agent result that says so is flagged, title before caption', () => {
    assert.deepEqual(unsupportedOutcome({ title: 'web_read blockt internes Redirect-Ziel', caption: 'antwortet mit HTTP 403' }, ''), { claim: 'blockt', where: 'title' });
    assert.deepEqual(unsupportedOutcome({ title: 'SSRF-Test', caption: 'web_read wehrt interne Adressen ab' }, ''), { claim: 'wehrt interne Adressen ab', where: 'caption' });
    assert.deepEqual(unsupportedOutcome({ title: 'Ablauf', caption: 'HTTP 403 vom Server' }, '{"status":200}'), { claim: 'HTTP 403', where: 'caption' });
  });
  it('a claim the agent result carries passes; nouns like Blockchain / Code-Block are no claims', () => {
    assert.equal(unsupportedOutcome({ title: 'Wie web_read prüft', caption: 'link-local wird blockiert' }, '{"error":"address not allowed (link-local)"}'), null);
    assert.equal(unsupportedOutcome({ title: 'Antwort', caption: 'httpbin antwortet mit HTTP 403' }, '{"status":403}'), null);
    assert.equal(unsupportedOutcome({ title: 'Blockchain-Überblick', caption: 'Code-Block und Blocks' }, ''), null);
  });
});
