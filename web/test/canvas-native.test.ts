import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasPendingNotifier } from '../src/canvas/nativeNotify.ts';
import { createCanvasBus } from '../src/canvas/bus.ts';
import { addMessage, convStore, dismissMainAgentPrompt, upsertMainAgentPrompt, type MainPromptCard } from '../src/lib/conversation.ts';
import { VoiceSession, VOICE_OPTIONS } from '../src/lib/voice.ts';
import type { CanvasBusEvent } from '../src/canvas/types.ts';

const ev = (o: Partial<CanvasBusEvent> & { id: string; phase: CanvasBusEvent['phase'] }) => ({ type: 'canvas', by: 'text', at: 1, ...o }) as CanvasBusEvent;

test('canvas-pending is posted once per drawing id, on pending or on a first ready', () => {
  const sent: unknown[] = [];
  const host = { postMessage: (m: unknown) => sent.push(m) };
  const n = canvasPendingNotifier(() => host, () => 1);
  n(ev({ id: 'a', phase: 'pending', title: '  Ablauf  ' }));
  n(ev({ id: 'a', phase: 'ready', title: 'Ablauf' }));
  n(ev({ id: 'a', phase: 'pending', title: 'Ablauf' }));
  n(ev({ id: 'b', phase: 'ready', title: 'x'.repeat(200) }));
  n(ev({ id: 'c', phase: 'error' }));
  n(ev({ id: 'd', phase: 'dropped' }));
  assert.deepEqual(sent[0], { type: 'canvas-pending', title: 'Ablauf' });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { type: 'canvas-pending', title: 'x'.repeat(80) });
});

test('a replayed old drawing does not announce itself', () => {
  const sent: unknown[] = [];
  const n = canvasPendingNotifier(() => ({ postMessage: (m: unknown) => sent.push(m) }), () => 10_000_000);
  n(ev({ id: 'old', phase: 'ready', at: 1 }));
  assert.equal(sent.length, 0);
  n(ev({ id: 'new', phase: 'pending', at: 9_999_000 }));
  assert.equal(sent.length, 1);
});

test('outside the native host nothing is posted, and a later host still gets the drawing', () => {
  let host: { postMessage(m: unknown): void } | undefined;
  const sent: unknown[] = [];
  const n = canvasPendingNotifier(() => host, () => 1);
  n(ev({ id: 'a', phase: 'pending' }));
  host = { postMessage: (m) => sent.push(m) };
  n(ev({ id: 'b', phase: 'pending', title: 'B' }));
  assert.deepEqual(sent, [{ type: 'canvas-pending', title: 'B' }]);
});

const cards = () => convStore.get().messages.flatMap((m) => m.parts).filter((p) => p.kind === 'mainPrompt').map((p) => (p as { card: MainPromptCard }).card);

test('main_agent_prompt becomes one open plain-text card; dismiss settles it; empty text is ignored', () => {
  const id = addMessage('assistant', 'voice');
  assert.equal(upsertMainAgentPrompt(id, { type: 'main_agent_prompt', text: '   ' }), null);
  assert.equal(upsertMainAgentPrompt(id, { type: 'main_agent_prompt', text: 'Bitte <b>prüfe</b> den Job\nund melde dich' }), cards()[0].id);
  assert.equal(cards().length, 1);
  assert.deepEqual([cards()[0].state, cards()[0].text], ['open', 'Bitte <b>prüfe</b> den Job\nund melde dich']);
  dismissMainAgentPrompt(cards()[0].id);
  assert.equal(cards()[0].state, 'dismissed');
});

test('the voice session hands main_agent_prompt to its handler', () => {
  const got: unknown[] = [];
  const s = new VoiceSession(VOICE_OPTIONS[0], undefined, { onMainAgentPrompt: (p: unknown) => got.push(p) } as never) as unknown as { handle(m: unknown): void };
  s.handle({ type: 'main_agent_prompt', text: 'hallo' });
  assert.deepEqual(got, [{ type: 'main_agent_prompt', text: 'hallo' }]);
});

test('an event pushed from the voice stream reaches the callback once, also when the SSE copy follows', () => {
  const seen: string[] = [];
  const bus = createCanvasBus({ fetch: async () => new Response(''), setTimeout: () => 0, clearTimeout: () => {}, onEvent: (e) => seen.push(`${e.id}:${e.phase}`) });
  const e = ev({ id: 'voice', phase: 'pending', at: 5 });
  bus.push(e);
  bus.push(e);
  assert.deepEqual(seen, ['voice:pending']);
});
