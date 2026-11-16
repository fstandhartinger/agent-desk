import test from 'node:test';
import assert from 'node:assert/strict';
import { guardDecision, isCutOff, isFactQuestion, namesSource } from '../src/voice/answerGuard.js';

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
  for (const q of ['Wer bist du?', 'Mach bitte ein Diagramm daraus.', 'Danke dir']) assert.equal(isFactQuestion(q), false, q);
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
