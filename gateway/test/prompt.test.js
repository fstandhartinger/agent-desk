import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInstructions, nowBerlin } from '../src/prompt.js';
import { buildInstructions as voiceInstructions } from '../src/voice/instructions.js';

const NOON_UTC = new Date('2026-10-24T10:34:00Z'); // 12:34 in Berlin (CEST)

test('nowBerlin names weekday, date and Berlin wall-clock time', () => {
  assert.equal(nowBerlin(NOON_UTC), 'Samstag, 24. Oktober 2026, 12:34 Uhr (Europe/Berlin)');
});

for (const [label, build] of [['chat', (now) => buildInstructions(null, { now })], ['voice', (now) => voiceInstructions(null, now)]]) {
  test(`${label} prompt carries today's date and the grounding rules`, () => {
    const text = build(NOON_UTC);
    assert.match(text, /Heute ist Samstag, 24\. Oktober 2026, 12:34 Uhr/);
    assert.match(text, /eigene[sn]? Datum/);
    assert.match(text, /niemals "heute"/);
    assert.match(text, /Zähle nur, was du auflistest/);
    assert.match(text, /list_jobs/);
  });
}
