import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMessage, convStore, upsertHandoff, type HandoffCard } from '../src/lib/conversation.ts';
import { fallbackNote, handedOverLabel, submitHandoff, whereOf } from '../src/lib/handoff.ts';

// a#41d6d2 (14 Nov 2026): the card must show the gateway's real reason, keep the button only when another click can help,
// and say where a fallback post went.
const card = (id: string) => {
  for (const m of convStore.get().messages) for (const p of m.parts) if (p.kind === 'handoff' && p.card.id === id) return p.card as HandoffCard;
  return undefined;
};
const fresh = (id: string) => upsertHandoff(addMessage('assistant', 'text'), { type: 'handoff', id, title: 'Regel ändern', task: 'Bitte Regel 2 anpassen.' });
const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;

test('a retryable refusal shows the server reason verbatim and keeps the card clickable', async () => {
  fresh('r1');
  const real = globalThis.fetch;
  globalThis.fetch = answer(502, { error: 'Die Werkstatt auf Sandy ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken.', retry: true });
  await submitHandoff('r1');
  globalThis.fetch = real;
  assert.equal(card('r1')?.state, 'error');
  assert.equal(card('r1')?.error, 'Die Werkstatt auf Sandy ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken.');
  assert.equal(card('r1')?.retry, true);
});

test('retry:false (unclear whether it arrived) is kept on the card so the button disappears', async () => {
  fresh('r2');
  const real = globalThis.fetch;
  globalThis.fetch = answer(502, { error: 'Unklar, ob die Übergabe angekommen ist – bitte nicht noch einmal klicken; ich prüfe das Board.', retry: false });
  await submitHandoff('r2');
  globalThis.fetch = real;
  assert.match(card('r2')?.error ?? '', /^Unklar, ob die Übergabe angekommen ist/);
  assert.equal(card('r2')?.retry, false);
});

test('a 404 with the gateway reason shows it; a bare 404 keeps the old "abgelaufen" text and is not retryable', async () => {
  fresh('r3');
  const real = globalThis.fetch;
  globalThis.fetch = answer(404, { error: 'Diese Übergabe ist schon angekommen (Board-Eintrag #4242) – nichts mehr zu tun.', retry: false });
  await submitHandoff('r3');
  assert.match(card('r3')?.error ?? '', /schon angekommen \(Board-Eintrag #4242\)/);
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  await submitHandoff('r3');
  assert.match(card('r3')?.error ?? '', /abgelaufen/);
  assert.equal(card('r3')?.retry, false);
  globalThis.fetch = real;
});

test('an old gateway without a retry flag stays retryable (as before); a dropped connection too', async () => {
  fresh('r4');
  const real = globalThis.fetch;
  globalThis.fetch = answer(502, { error: 'Die Übergabe an die Agenten hat nicht geklappt' });
  await submitHandoff('r4');
  assert.equal(card('r4')?.retry, true);
  globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
  await submitHandoff('r4');
  assert.equal(card('r4')?.state, 'error');
  assert.equal(card('r4')?.retry, true);
  assert.equal(card('r4')?.error, 'Keine Verbindung zum Server.');
  globalThis.fetch = real;
});

test('success after a refusal clears the error; a fallback post says which thread it went to', async () => {
  fresh('r5');
  const real = globalThis.fetch;
  globalThis.fetch = answer(502, { error: 'Das Board hat die Übergabe abgelehnt, es wurde nichts gepostet – in ein paar Minuten noch einmal klicken.', retry: true });
  await submitHandoff('r5');
  assert.equal(card('r5')?.state, 'error');
  globalThis.fetch = answer(200, { ok: true, entryId: 5151, fallback: true, thread: 'Ops & security', threadId: 15, intendedThreadId: 31 });
  await submitHandoff('r5');
  globalThis.fetch = real;
  const c = card('r5');
  assert.equal(c?.state, 'done');
  assert.equal(c?.error, undefined);
  assert.equal(handedOverLabel(c?.entryId), 'Übergeben (Board #5151)');
  assert.equal(fallbackNote(c?.where), 'im Thema #15 (Ops & security) statt #31 gepostet');
});

test('a normal post has no fallback note; partial fallback info still reads sensibly', () => {
  assert.equal(whereOf({ ok: true, entryId: 1 }), undefined);
  assert.equal(fallbackNote(undefined), undefined);
  assert.equal(fallbackNote({ fallback: true, threadId: 15 }), 'im Thema #15 statt im Übergabe-Thema gepostet');
  assert.equal(fallbackNote({ fallback: true, thread: 'Ops & security' }), 'im Thema „Ops & security“ statt im Übergabe-Thema gepostet');
  assert.equal(fallbackNote({ fallback: true }), 'in einem anderen Thema statt im Übergabe-Thema gepostet');
  assert.deepEqual(whereOf({ fallback: true, thread: '  Ops  ', threadId: 15.5, intendedThreadId: 31 }), { fallback: true, thread: 'Ops', threadId: undefined, intendedThreadId: 31 });
});
