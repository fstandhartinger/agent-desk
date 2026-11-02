// Early research noise (trace a#7f54a5): only a real question about a topic researches or draws. All of Florian's real sentences, plus topic questions of the old tests.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({});
const { askKind } = await import('../src/ask.js');
const { fastCalls } = await import('../src/fastPath.js');
const { createCanvasSession, createIllustrator } = await import('../src/illustrator.js');
const { createCanvasBus } = await import('../src/canvasBus.js');

const REAL = {
  'Was siehst du auf dem Bildschirm?': 'screen',
  'Und jetzt?': 'none',
  'Okay, warte. Eigentlich stimmt das nicht, inzwischen ist was anderes am Bildschirm, aber ist egal. Was mich mehr interessiert ist, kannst du die Agent Artifact IDs sehen?': 'screen',
  'Naja, jetzt sind am Bildschirm wieder solche IDs.': 'screen',
  'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir': 'session',
  'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir eine Fehlerbehebung vornehmen müssen, damit all diese': 'session',
  'Nein, wir nehmen dieses Protokoll jetzt auf, weil wir eine Fehlerbehebung vornehmen müssen, damit all diese Dinge besser funktionieren in Zukunft.': 'session',
  'Lass uns lieber was anderes ausprobieren. Was passiert, wenn ich versuche, etwas auf dem Bildschirm zu zeichnen? Ich habe jetzt die Shift-Taste gedrückt und jetzt einen Kreis gezeichnet.': 'screen',
  'Lass uns lieber was anderes ausprobieren.': 'none',
  'Okay, warte. Eigentlich stimmt das nicht': 'none',
};
it('every real sentence of the session: no knowledge search, no early drawing', () => {
  for (const [text, kind] of Object.entries(REAL)) {
    assert.equal(askKind(text), kind, text);
    assert.deepEqual(fastCalls(text, { utterance: true }), [], text);
  }
});
it('real topic questions still research (kinds and fast path)', () => {
  for (const q of ['Wie funktioniert die Video-Sendeblockierung?', 'Wofür geben wir das Geld aus?', 'Wie ist der Aufbau von JevBench?', 'Welche Server haben wir?', 'Ich habe eine Frage über unsere Steuerrücklagen und über die Notwendigkeit, ständig erhaltene Honoraremissionen überweisen zu müssen.', 'Es geht darum, dass unser Subnetz Honoraremissionen emittiert und ich davon regelmäßig in Euro umwandeln muss, wegen der Steuerlast.', 'Hmm, was steckt da dahinter genau', 'Wie funktioniert die Bildschirmerfassung des Screen Agents?']) assert.equal(askKind(q), 'topic', q);
  assert.deepEqual(fastCalls('Wie funktioniert die Video-Sendeblockierung?', { utterance: true }).map((c) => c.name), ['knowledge_read', 'search_files']);
  assert.deepEqual(fastCalls('Wofür geben wir das Geld aus?', { utterance: true }).map((c) => c.name), ['ledger_spend']);
});
it('screen-deictic and session questions are answered by look_at_screen / session_trace', () => {
  for (const q of ['Was steht hier?', 'Was ist das da?', 'Kannst du die IDs sehen?', 'Hast du gesehen, was ich markiert habe?', 'Was bedeutet diese Zahl?']) assert.equal(askKind(q), 'screen', q);
  for (const q of ['Warum hat das nicht geklappt?', 'Schau dir das Protokoll an.', 'Warum kam eben keine Antwort?']) assert.equal(askKind(q), 'session', q);
});

const ctx = () => {
  const bus = createCanvasBus();
  const illustrator = createIllustrator({ bus, hub: {}, complete: async () => { throw new Error('no model call expected'); }, run: async () => { throw new Error('no tool expected'); }, audit: () => {} });
  return { bus, s: createCanvasSession({ bus, illustrator, by: 'voice', provider: 'xai', emit: () => {}, ctx: {}, debounceMs: () => 20, researchMs: () => 30 }) };
};
it('the illustrator session decides "no early drawing" for each of his sentences (no model call, nothing published)', async () => {
  const { bus, s } = ctx();
  for (const text of Object.keys(REAL)) {
    s.startTurn(); s.noteTurn({ role: 'user', text });
    const d = s.userTurn(text);
    assert(['screen', 'session', 'not-explanatory'].includes(d), `${text} -> ${d}`);
    s.toolStarted('look_at_screen'); s.toolStarted('look_at_screen');
  }
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(bus.replay(0).length, 0, 'no drawing, no model call');
});
