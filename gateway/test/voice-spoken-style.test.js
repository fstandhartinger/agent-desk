import assert from 'node:assert/strict';
import { it } from 'node:test';
import { buildInstructions as voice, SPOKEN_STYLE_LINES, SPOKEN_STYLE_REMINDER } from '../src/voice/instructions.js';
import { buildInstructions as text, screenLines, TAX_RULE, TAX_RULE_SPOKEN } from '../src/prompt.js';
// Florian, 16 Nov 2026 (session a#7ab1cd): the voice read out an a#-ID, a card number and a whole job slug. IDs and number runs are useless when spoken.
const now = new Date('2026-11-16T16:00:00Z');
const page = { slug: 'x', title: 'Seite', t: 3, pointId: 'p', point: { title: 'Punkt', short: 's' } };

for (const [label, opts] of [['Desk voice', { provider: 'xai' }], ['Desk voice (openai)', { provider: 'openai' }], ['Desk voice (gemini)', { provider: 'gemini' }], ['Screen Agent voice', { provider: 'xai', screenAgent: true }]]) {
  it(`${label}: the spoken-style rules and the late reminder are in the prompt`, () => {
    const p = voice(page, now, opts);
    for (const l of SPOKEN_STYLE_LINES) assert.ok(p.includes(l));
    assert.match(p, /Lies keine Kennungen vor: keine a#-IDs, Karten- oder Board-Nummern, Job-Namen/);
    const r = p.indexOf(SPOKEN_STYLE_REMINDER);
    assert.ok(r > 0, 'reminder present');
    const pack = p.indexOf('## Aktuelle Erklärseite');
    assert.ok(pack === -1 || r < pack, 'reminder before the page pack (page budget)');
    assert.ok(r > p.indexOf('Du kannst NICHTS verändern'), 'reminder after the tool rules');
    // the spoken grounding variants replace the "name the path / number / UTC date" rules
    assert.ok(p.includes(TAX_RULE_SPOKEN));
    assert.ok(!p.includes(TAX_RULE));
    assert.doesNotMatch(p, /Nenne Daten so, wie sie in der Quelle stehen/);
    assert.doesNotMatch(p, /nenne den Pfad genau so/);
    assert.doesNotMatch(p, /nenne nur den Dateinamen oder den Jobnamen/);
    // verbatim confirmation texts (computer/confirm.js) still go through unchanged
    assert.match(p, /WÖRTLICH sagen sollst .* sagst du unverändert/);
    if (opts.screenAgent) assert.match(p, /nenne die Karten mit ihrem Titel \(im Gespräch, ohne die IDs selbst vorzulesen/);
  });
}

it('the text chat prompt keeps its written-source rules and gets none of the spoken ones', () => {
  const t = text(page, { now });
  assert.ok(t.includes(TAX_RULE));
  assert.match(t, /Nenne Daten so, wie sie in der Quelle stehen/);
  assert.match(t, /nenne den Pfad genau so, wie das Werkzeugergebnis ihn liefert/);
  assert.ok(!t.includes(TAX_RULE_SPOKEN));
  assert.ok(!t.includes(SPOKEN_STYLE_REMINDER));
  for (const l of SPOKEN_STYLE_LINES) assert.ok(!t.includes(l));
});

it('the screen lines keep "nenne die IDs mit Titel" for the text chat and drop it for the voice', () => {
  assert.match(screenLines(true).join('\n'), /nenne die IDs mit Titel/);
  assert.doesNotMatch(screenLines(true, { spoken: true }).join('\n'), /nenne die IDs mit Titel/);
});
