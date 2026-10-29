import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstructions } from '../src/prompt.js';
import { buildInstructions as voiceInstructions } from '../src/voice/instructions.js';

const SHARED = [
  'Du hast eine Canvas neben dem Gespräch und kannst darauf jederzeit zeichnen: Flussdiagramme, Architekturdiagramme, Sequenzdiagramme, Torten-, Balken- und Liniendiagramme, Tabellen, Zeitleisten, Sankey und freie SVG-Skizzen.',
  'Sag NIE, dass du nicht zeichnen oder keine Diagramme erstellen kannst.',
  "Zeichne von dir aus, sobald du einen Ablauf, eine Architektur, einen Vergleich oder Zahlen erklärst — ohne zu fragen. Sprich währenddessen weiter; sag kurz 'Ich zeichne dir das auf'.",
  'Für Geldfragen hole echte Zahlen mit ledger_spend, für Architektur code_outline/read_file — nie schätzen.',
  'nutze dieselbe id',
];

for (const [label, build, extra] of [
  ['text', () => buildInstructions(null), ['Nutze canvas_render, wenn du die Daten schon in der Hand hast', 'sonst canvas_draw']],
  ['voice', () => voiceInstructions(null), ['Nutze canvas_draw mit einer genauen Beschreibung (was, welche Teile, welche Zahlen aus welchen Tools)', 'rufe canvas_draw sofort auf, ohne vorher ledger_spend oder code_outline zu rufen']],
]) {
  test(`${label} prompt tells the agent it can draw, to do so unasked, and with which tools`, () => {
    const text = build();
    for (const sentence of [...SHARED, ...extra]) assert.ok(text.includes(sentence), `${label}: missing "${sentence}"`);
    assert.match(text, /\/home\/flori\/work\/agent-desk/);
  });
}

test('the text prompt no longer caps drawing under the two-research-tools rule', () => {
  assert.match(buildInstructions(null), /Zeichnen und ledger_spend\/code_outline für eine Zeichnung zählen nicht mit/);
});
