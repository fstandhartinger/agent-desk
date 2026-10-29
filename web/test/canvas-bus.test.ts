import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, applyHistory, backoff, createCanvasBus, FOLLOW_PAUSE_MS, initialCanvasState, selectCanvas } from '../src/canvas/bus.ts';
import type { CanvasBusEvent, CanvasSpec } from '../src/canvas/types.ts';

const spec = (id: string, title = id): CanvasSpec => ({ v: 2, id, kind: 'bar', title, sources: [{ label: 'x', ref: 'x' }], items: [{ label: 'a', value: 1 }] });
const ev = (over: Partial<CanvasBusEvent>): CanvasBusEvent => ({ type: 'canvas', phase: 'ready', id: 'a', by: 'text', at: '2026-10-24T10:00:00Z', spec: spec('a'), ...over });

test('the same event twice (same id + at) changes nothing', () => {
  const s1 = applyEvent(initialCanvasState(), ev({}));
  const s2 = applyEvent(s1, ev({}));
  assert.equal(s2.entries, s1.entries);
  assert.equal(s2.order, s1.order);
  assert.deepEqual(s1.order, ['a']);
});

test('an older event for the same id is ignored; a newer one updates', () => {
  let s = applyEvent(initialCanvasState(), ev({ at: '2026-10-24T10:00:05Z', spec: spec('a', 'neu') }));
  s = applyEvent(s, ev({ at: '2026-10-24T10:00:01Z', spec: spec('a', 'alt') }));
  assert.equal(s.entries.a.spec?.title, 'neu');
  s = applyEvent(s, ev({ at: '2026-10-24T10:00:09Z', spec: spec('a', 'neuer') }));
  assert.equal(s.entries.a.spec?.title, 'neuer');
});

test('pending keeps the last ready spec (update in progress); error keeps it too and carries the message', () => {
  let s = applyEvent(initialCanvasState(), ev({}));
  s = applyEvent(s, ev({ phase: 'pending', spec: undefined, at: '2026-10-24T10:01:00Z', by: 'voice', provider: 'gemini' }));
  assert.equal(s.entries.a.phase, 'pending');
  assert.equal(s.entries.a.spec?.id, 'a');
  assert.equal(s.entries.a.provider, 'gemini');
  s = applyEvent(s, ev({ phase: 'error', spec: undefined, at: '2026-10-24T10:01:05Z', message: 'Zeichnung fehlgeschlagen: kaputt' }));
  assert.equal(s.entries.a.phase, 'error');
  assert.equal(s.entries.a.spec?.id, 'a');
  assert.match(s.entries.a.message!, /kaputt/);
});

test('a ready event without spec and non-canvas data are rejected', () => {
  const s0 = initialCanvasState();
  assert.equal(applyEvent(s0, ev({ spec: undefined })), s0);
  assert.equal(applyEvent(s0, { type: 'tool' } as unknown as CanvasBusEvent), s0);
});

test('new canvases come to the front and the screen follows them, unless the user just picked one from history', () => {
  let s = applyEvent(initialCanvasState(), ev({ id: 'a', spec: spec('a') }), 1000);
  s = applyEvent(s, ev({ id: 'b', spec: spec('b'), at: 2 }), 2000);
  assert.deepEqual(s.order, ['b', 'a']);
  assert.equal(s.current, 'b');
  s = selectCanvas(s, 'a', 3000);
  s = applyEvent(s, ev({ id: 'c', spec: spec('c'), at: 3 }), 4000);
  assert.equal(s.current, 'a', 'pinned for a while');
  s = applyEvent(s, ev({ id: 'd', spec: spec('d'), at: 4 }), 3000 + FOLLOW_PAUSE_MS + 1);
  assert.equal(s.current, 'd', 'follows again after the pause');
});

test('history fills unknown ids without stealing the screen and never overwrites newer bus state', () => {
  let s = applyEvent(initialCanvasState(), ev({ id: 'live', spec: spec('live', 'vom Bus'), at: '2026-10-24T12:00:00Z' }));
  s = applyHistory(s, [
    { id: 'live', kind: 'bar', v: 2, title: 'alt', sources: [], at: '2026-10-24T11:00:00Z' },
    { spec: spec('old1', 'Alt 1'), by: 'claude', at: '2026-10-24T09:00:00Z' },
  ]);
  assert.equal(s.entries.live.spec?.title, 'vom Bus');
  assert.equal(s.entries.old1.by, 'claude');
  assert.equal(s.current, 'live');
  const fresh = applyHistory(initialCanvasState(), [{ spec: spec('newest'), at: 3 }, { spec: spec('older'), at: 2 }, { spec: spec('oldest'), at: 1 }]);
  assert.deepEqual(fresh.order, ['newest', 'older', 'oldest']);
  assert.equal(fresh.current, 'newest', 'a fresh page shows the newest canvas');
});

test('backoff grows 1 s, 2 s, 4 s … and caps at 15 s', () => {
  const mid = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 8].map((a) => backoff(a, mid)), [1000, 2000, 4000, 8000, 15000, 15000]);
});

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('the bus reconnects with Last-Event-ID after the stream drops and dedupes the replay', async () => {
  const calls: { url: string; lastId: string | null }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const e1 = JSON.stringify(ev({ id: 'x', spec: spec('x'), at: 't1' }));
  const e2 = JSON.stringify(ev({ id: 'y', spec: spec('y'), at: 't2' }));
  const streams = [
    [`id: 7\ndata: ${e1}\n\n`, `: ping\n\n`],
    [`id: 7\ndata: ${e1}\n\n`, `id: 8\ndata: ${e2}\n\n`], // server replays 7 (ring) + new 8
  ];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (url === '/api/canvas') return new Response(JSON.stringify({ canvases: [] }), { headers: { 'content-type': 'application/json' } });
    calls.push({ url, lastId: h.get('Last-Event-ID') });
    const next = streams.shift();
    return next ? sseResponse(next) : new Promise<Response>(() => {});
  }) as typeof fetch;
  const seen: string[] = [];
  const bus = createCanvasBus({ fetch: fakeFetch, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout: () => {}, random: () => 0.5, onEvent: (e) => seen.push(e.id) });
  bus.start();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lastId, null);
  assert.equal(bus.store.get().lastEventId, '7');
  assert.equal(bus.store.get().conn, 'retry');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  timers.shift()!.fn();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls[1].lastId, '7', 'resumes from the last seen event');
  assert.deepEqual(bus.store.get().order, ['y', 'x']);
  assert.deepEqual(seen, ['x', 'y'], 'the replayed event 7 did not fire twice');
  bus.stop();
  assert.equal(bus.store.get().conn, 'stopped');
});

test('a 401 on the event stream stops the bus and signals the gate', async () => {
  let unauthorized = 0;
  const on = () => unauthorized++;
  addEventListener('desk:unauthorized', on);
  const timers: unknown[] = [];
  const bus = createCanvasBus({ fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch, setTimeout: (fn) => timers.push(fn), clearTimeout: () => {} });
  bus.start();
  await new Promise((r) => setTimeout(r, 20));
  removeEventListener('desk:unauthorized', on);
  assert.equal(unauthorized, 1);
  assert.equal(timers.length, 0, 'no reconnect loop against a logged-out session');
  assert.equal(bus.store.get().conn, 'stopped');
});

test('focus:false (a late draw of an earlier turn) lands in the history but does not take the stage; later events of that id follow again', () => {
  let s = applyEvent(initialCanvasState(), ev({ id: 'geld', spec: spec('geld'), at: 1 }), 1000);
  s = applyEvent(s, ev({ id: 'arch', spec: spec('arch'), at: 2, focus: false } as Partial<CanvasBusEvent>), 2000);
  assert.deepEqual(s.order, ['arch', 'geld']);
  assert.equal(s.current, 'geld', 'the stage stays on the current question');
  assert.equal(s.entries.arch.spec?.id, 'arch');
  s = applyEvent(s, ev({ id: 'arch', phase: 'pending', spec: undefined, at: 3, focus: false } as Partial<CanvasBusEvent>), 2500);
  assert.equal(s.current, 'geld', 'a pending marker of a late draw does not switch either');
  s = applyEvent(s, ev({ id: 'geld', spec: spec('geld', 'neu'), at: 4 }), 3000);
  assert.equal(s.current, 'geld');
  s = applyEvent(s, ev({ id: 'neu', spec: spec('neu'), at: 5 }), 4000);
  assert.equal(s.current, 'neu', 'normal events follow as before');
});

test('focus:false on the very first event still shows it (an empty stage has nothing to protect)', () => {
  const s = applyEvent(initialCanvasState(), ev({ id: 'x', spec: spec('x'), focus: false } as Partial<CanvasBusEvent>));
  assert.equal(s.current, 'x');
});

test('dropped: a new pending id disappears, an id with a spec shows its last drawing again', () => {
  let s = applyEvent(initialCanvasState(), ev({ id: 'old', at: '2026-10-24T10:00:00Z', spec: spec('old') }));
  s = applyEvent(s, ev({ id: 'new', phase: 'pending', spec: undefined, at: '2026-10-24T10:00:01Z' }));
  assert.equal(s.current, 'new');
  s = applyEvent(s, ev({ id: 'new', phase: 'dropped', spec: undefined, at: '2026-10-24T10:00:02Z' }));
  assert.equal(s.entries.new, undefined);
  assert.deepEqual(s.order, ['old']);
  assert.equal(s.current, 'old');
  s = applyEvent(s, ev({ id: 'old', phase: 'pending', spec: undefined, at: '2026-10-24T10:00:03Z' }));
  s = applyEvent(s, ev({ id: 'old', phase: 'dropped', spec: undefined, at: '2026-10-24T10:00:04Z' }));
  assert.equal(s.entries.old.phase, 'ready');
  assert.equal(s.entries.old.spec?.id, 'old');
});
