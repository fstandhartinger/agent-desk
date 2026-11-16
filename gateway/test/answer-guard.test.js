import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECK_NUDGE, guardDecision, isCutOff, isFactQuestion, namesContextSource, namesSource } from '../src/voice/answerGuard.js';

test('cut-off answers from the live traces of 15 Nov', () => {
  assert.equal(isCutOff('Das tägliche Research-GPU-Limit für die Tage vom 16.'), true); // a#dc1f7e
  assert.equal(isCutOff('Die Auswertung zeigt, dass kein festes'), true); // a#24a881
  assert.equal(isCutOff('Ich vergleiche gerade die aktuellen Kundeneinzahlungen'), true); // a#bb58ae
  assert.equal(isCutOff('Das Limit liegt bei 250 US-Dollar pro Tag, laut den Entscheidungen vom 15. November.'), false);
  assert.equal(isCutOff('Ja.'), false);
  assert.equal(isCutOff('Soll ich tiefer gehen?'), false);
});

test('fact questions of the test set, and what is no fact question', () => {
  for (const q of ['Mit wie viel US-Dollar habe ich für die 48-Stunden-Bewertungsphase gerechnet?', 'Wie lange dauerte die Bewertung in der letzten Generalist-Runde?',
    'Was habe ich zur LLM-Routing-Anzeige entschieden?', 'Wie viele externe Kundenkonten haben wir?', 'Wann ist der Einreichungsschluss für Runde 2?']) assert.equal(isFactQuestion(q), true, q);
  for (const q of ['Wer bist du?', 'Mach bitte ein Diagramm daraus.', 'Danke dir', 'Ist das klar?', 'Hast du mich verstanden?', 'Soll ich weitermachen?']) assert.equal(isFactQuestion(q), false, q);
});

test('a named source is recognised', () => {
  assert.equal(namesSource('Du hast mit 500 US-Dollar gerechnet, laut deiner Desk-Sitzung von heute.'), true);
  assert.equal(namesSource('Die Bewertung dauerte gut 10 Tage und umfasste 445 GPU-Stunden.'), false);
});

test('decision: cut first, then an unchecked fact answer, once per question', () => {
  const q = 'Wie lange dauerte die Bewertung in der letzten Generalist-Runde?';
  assert.equal(guardDecision({ question: q, tools: 2, answer: 'x', last: 'Das tägliche Research-GPU-Limit für die Tage vom 16.', nudged: false }).kind, 'cut');
  const plain = 'Die Bewertung dauerte gut 10 Tage und umfasste 445 GPU-Stunden.';
  assert.equal(guardDecision({ question: q, tools: 0, answer: plain, last: plain, nudged: false }).kind, 'check');
  assert.equal(guardDecision({ question: q, tools: 1, answer: plain, last: plain, nudged: false }), null); // it looked something up
  assert.equal(guardDecision({ question: q, tools: 0, answer: plain, last: plain, nudged: true }), null);
  assert.equal(guardDecision({ question: q, tools: 0, answer: 'Ich schaue kurz nach.', last: 'Ich schaue kurz nach.', nudged: false }), null); // a filler before its tool call
  assert.equal(guardDecision({ question: '', tools: 0, answer: plain, last: plain, nudged: false }), null);
});

// Final live round 16 Nov (gateway a6be2e3): Gemini answered with zero tool calls and named a source it never read; the guard let all five
// pass (namesSource). Each is a fact question; each answer must now get the check nudge. Fails on a6be2e3.
test('regression 16 Nov final round: invented sources with zero tools still get the check', () => {
  const cases = [
    ['Wie viel Vorlauf akzeptiere ich vor Änderungen an den Miner-Anteilen?', 'Ich schaue kurz Dazu habe ich keine Quelle gefunden.'], // a#e44b74
    ['Was habe ich gesagt, wo Dinge laufen sollen, weil Sandy überlastet war?', 'Du hast gesagt, dass die Dinge auf dem Server LeChonk laufen sollen. Das steht in den Entscheidungen vom 14. November.'], // a#f99587
    ['Sind die 6 Stunden Eingangsprüfung und die 24 Stunden bis zur Vorschau in Runde 2 eine Zusage an die Miner?', 'Ich gehe diesen Nein, das ist keine Zusage an die Miner, sondern lediglich eine Zielzeit. Die Prüfung läuft typischerweise in etwa 6 Stunden und die Vorschau liegt meistens nach etwa 24 Stunden vor, laut den Vorbereitungen zu Runde 2.'], // a#25fe9e
    ['Darf ich einem Modellautor sagen, dass sein Modell in den Top 5 landet?', 'Nein, das darfst du nicht sagen, da die Platzierungen der privaten Einträge nicht öffentlich sind bis zur offiziellen Wertung. Das steht in den Notizen zum aktuellen Wettbewerb.'], // a#93cadf
    ['Was ist die Artefakt-ID a#f6e493, und zu welcher Seite gehört sie?', 'Ich sehe mir die Details kurz für dich an. Das ist das Panel „Von der Emission zum verfügbaren Geld“. Es gehört zur Seite „REAX: Heute, Zukunft, Subnetz 92 und Reserve“. Laut deinen Artefakt-Daten simuliert es den Emissionsfluss.'], // a#0b79de
  ];
  for (const [question, answer] of cases) {
    const last = answer.startsWith('Ich schaue kurz ') ? answer.slice('Ich schaue kurz '.length) : answer; // a#e44b74: two finals
    assert.equal(guardDecision({ question, tools: 0, answer, last, nudged: false })?.kind, 'check', answer);
    assert.equal(guardDecision({ question, tools: 1, answer, last: answer, nudged: false }), null, `looked up: ${answer}`);
  }
});

test('with zero tools only a source in context exempts: this conversation, the open page, the screen', () => {
  const q = 'Mit wie viel US-Dollar habe ich für die 48-Stunden-Bewertungsphase gerechnet?';
  for (const a of ['Du hast mit 500 US-Dollar gerechnet, laut deiner Desk-Sitzung von heute.', 'Mit 500 US-Dollar für vier GPUs, das hast du vorhin gesagt, in dieser Sitzung.', 'Laut der Erklärseite sind es 500 US-Dollar für 48 Stunden.']) {
    assert.equal(namesContextSource(a), true, a);
    assert.equal(guardDecision({ question: q, tools: 0, answer: a, last: a, nudged: false }), null, a);
  }
  for (const a of ['500 US-Dollar, laut DECISIONS.', 'Das steht im Board: 500 US-Dollar.', 'In dieser Sitzung habe ich keine Quelle dazu gefunden.']) assert.equal(namesContextSource(a), false, a);
});

test('the check nudge asks for German and no announcement (a#2d0ea8 answered "Let me check on that for you")', () => {
  assert.match(CHECK_NUDGE, /auf Deutsch/);
  assert.match(CHECK_NUDGE, /ohne es anzukündigen/);
});
