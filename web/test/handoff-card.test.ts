import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMessage, convStore, finish, patchHandoff, textOf, upsertHandoff, type HandoffCard } from '../src/lib/conversation.ts';
import { discardHandoff, entryIdOf, handedOverLabel, submitHandoff } from '../src/lib/handoff.ts';
import { argSummary, hostLabel, toolLabel } from '../src/lib/activity.ts';
import { isFullscreenKey, isTypingTarget } from '../src/lib/fullscreen.ts';

const ev = { type: 'handoff' as const, id: 'h1', title: 'Job prüfen', task: 'Zeile 1\nZeile 2', why: 'nur lesen' };
const card = (id = 'h1') => {
  for (const m of convStore.get().messages) for (const p of m.parts) if (p.kind === 'handoff' && p.card.id === id) return p.card as HandoffCard;
  return undefined;
};

test('a handoff event becomes a pending card and is never submitted by itself', () => {
  const calls: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...a: unknown[]) => (calls.push(a), new Response('{}'))) as typeof fetch;
  const id = addMessage('assistant', 'text');
  upsertHandoff(id, ev);
  upsertHandoff(id, ev); // duplicate event: still one card
  assert.equal(convStore.get().messages.find((m) => m.id === id)!.parts.filter((p) => p.kind === 'handoff').length, 1);
  assert.equal(card()?.state, 'pending');
  assert.equal(card()?.title, 'Job prüfen');
  assert.equal(calls.length, 0);
  globalThis.fetch = realFetch;
});

test('clicking posts {id} once with same-origin credentials and shows the board entry', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ ok: true, entryId: 4711 }), { headers: { 'content-type': 'application/json' } }))) as typeof fetch;
  await Promise.all([submitHandoff('h1'), submitHandoff('h1')]);
  globalThis.fetch = realFetch;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/handoff');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id: 'h1' });
  assert.equal(card()?.state, 'done');
  assert.equal(handedOverLabel(card()?.entryId), 'Übergeben (Board #4711)');
});

test('a refusal shows the German error and allows another try', async () => {
  const id = addMessage('assistant', 'text');
  upsertHandoff(id, { ...ev, id: 'h2' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Tageslimit für Übergaben erreicht.' }), { status: 429 })) as typeof fetch;
  await submitHandoff('h2');
  assert.equal(card('h2')?.state, 'error');
  assert.match(card('h2')?.error ?? '', /Tageslimit/);
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  await submitHandoff('h2');
  assert.match(card('h2')?.error ?? '', /abgelaufen/);
  globalThis.fetch = (async () => { throw new TypeError('network'); }) as typeof fetch;
  await submitHandoff('h2');
  assert.equal(card('h2')?.state, 'error');
  globalThis.fetch = (async () => new Response('{}')) as typeof fetch;
  await submitHandoff('h2');
  assert.equal(card('h2')?.state, 'done');
  assert.equal(handedOverLabel(card('h2')?.entryId), 'Übergeben');
  globalThis.fetch = realFetch;
});

test('discarding settles the card, drops it on the gateway too (critic r2 P2-3), and a card-only voice turn survives finish()', async () => {
  const id = addMessage('assistant', 'voice');
  upsertHandoff(id, { ...ev, id: 'h3' });
  finish(id);
  assert.ok(convStore.get().messages.some((m) => m.id === id), 'voice turn with a card is kept');
  assert.equal(textOf(convStore.get().messages.find((m) => m.id === id)!), '');
  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); throw new Error('offline'); }) as typeof fetch;
  await discardHandoff('h3'); // a failed call still leaves the card discarded
  globalThis.fetch = realFetch;
  assert.equal(card('h3')?.state, 'discarded');
  assert.deepEqual(calls.map((c) => [c.url, c.init.method, c.init.credentials, c.init.body]), [['/api/handoff/discard', 'POST', 'same-origin', JSON.stringify({ id: 'h3' })]]);
  patchHandoff('nope', { state: 'done' }); // unknown id is a no-op
});

test('entryIdOf accepts the usual shapes', () => {
  assert.equal(entryIdOf({ entryId: 12 }), 12);
  assert.equal(entryIdOf({ id: '#34' }), '#34');
  assert.equal(handedOverLabel('#34'), 'Übergeben (Board #34)');
  assert.equal(entryIdOf({}), undefined);
  assert.equal(entryIdOf(null), undefined);
});

test('new read tools get German labels, a target and a host label', () => {
  const want: Record<string, string> = {
    web_read: 'liest Webseite', chats_search: 'durchsucht Agenten-Chats', discord_read: 'liest Discord', mail_search: 'liest Mails',
    mail_read: 'liest Mails', explainer_context: 'liest Hintergrunddokument',
  };
  for (const [k, v] of Object.entries(want)) assert.equal(toolLabel(k), v);
  for (const k of ['chat_read', 'skills_list', 'skill_read', 'run_readonly', 'handoff_propose']) assert.notEqual(toolLabel(k), k.replace(/_/g, ' '));
  assert.equal(argSummary({ url: 'https://example.org/a' }), 'https://example.org/a');
  assert.equal(argSummary({ command: 'quota-pace status' }), 'quota-pace status');
  assert.equal(hostLabel('sandy'), 'Sandy');
  assert.equal(hostLabel('LeChonk'), 'LeChonk');
  assert.equal(hostLabel('evil<script>'), undefined);
  assert.equal(hostLabel(undefined), undefined);
});

test('F toggles fullscreen only outside text fields and without modifiers', () => {
  const key = (k: string, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, ...extra });
  assert.equal(isFullscreenKey(key('f'), null), true);
  assert.equal(isFullscreenKey(key('F'), null), true);
  assert.equal(isFullscreenKey(key('g'), null), false);
  assert.equal(isFullscreenKey(key('f', { ctrlKey: true }), null), false);
  assert.equal(isFullscreenKey(key('f', { metaKey: true }), null), false);
  assert.equal(isFullscreenKey(key('f'), { tagName: 'TEXTAREA' } as unknown as Element), false);
  assert.equal(isFullscreenKey(key('f'), { tagName: 'INPUT' } as unknown as Element), false);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as Element), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' } as unknown as Element), false);
});
