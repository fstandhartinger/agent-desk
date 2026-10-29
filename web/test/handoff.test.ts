import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatTranscript, handoffDraft } from '../src/lib/handoff.ts';
import type { Msg } from '../src/lib/conversation.ts';

const m = (id: string, role: Msg['role'], text: string, status: Msg['status'] = 'done'): Msg => ({ id, role, via: 'text', parts: [{ kind: 'text', text }], ts: 0, status });

const thread: Msg[] = [
  m('u1', 'user', 'Welche Jobs laufen gerade?'),
  m('a1', 'assistant', 'Sieben Jobs, darunter reax2-next-steps (Phase 3/4).'),
  m('u2', 'user', 'Was blockiert reax2?'),
  m('a2', 'assistant', 'Das Batch-Ergebnis fehlt noch.'),
  m('u3', 'user', 'kaputt', 'error'),
];

test('handoff draft quotes the chosen answer, its question and the page, and carries the chat transcript', () => {
  const d = handoffDraft(thread, 'a1', { slug: 'engine-crowning', title: 'Engine-Krönung', t: 42 });
  assert.match(d.prompt, /Erklärseite „Engine-Krönung“ \(engine-crowning\) bei 0:42/);
  assert.match(d.prompt, /Frage im Desk-Chat: „Welche Jobs laufen gerade\?“/);
  assert.match(d.prompt, /> Sieben Jobs, darunter reax2-next-steps/);
  assert.ok(d.prompt.endsWith('Aufgabe: '));
  assert.equal(d.title, 'Weiter: Welche Jobs laufen gerade?');
  // Transcript stops at the chosen answer: later turns are not part of this context.
  assert.equal(d.chatContext, 'Florian: Welche Jobs laufen gerade?\n\nDesk: Sieben Jobs, darunter reax2-next-steps (Phase 3/4).');
});

test('transcript skips failed turns and stays under the gateway limit', () => {
  assert.ok(!chatTranscript(thread).includes('kaputt'));
  const long = Array.from({ length: 30 }, (_, i) => m(`x${i}`, i % 2 ? 'assistant' : 'user', 'x'.repeat(900)));
  const t = chatTranscript(long);
  assert.ok(t.length <= 6000, String(t.length));
  assert.ok(t.endsWith('x'.repeat(50)));
});
