// Round 11 (critic r10 defect 1): the browser tells the gateway which canvas it shows, so "zeichne das" refers to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasBus, focusedCanvasId, watchFocusedCanvas } from '../src/canvas/bus.ts';
import { sendChat } from '../src/lib/chat.ts';
import { VoiceSession, VOICE_OPTIONS } from '../src/lib/voice.ts';
import type { CanvasBusEvent, CanvasSpec } from '../src/canvas/types.ts';

const spec = (id: string): CanvasSpec => ({ v: 2, id, kind: 'bar', title: id, sources: [{ label: 'x', ref: 'x' }], items: [{ label: 'a', value: 1 }] });
const ready = (id: string, at: string): CanvasBusEvent => ({ type: 'canvas', phase: 'ready', id, by: 'text', at, spec: spec(id) });
const doneSse = () => new Response(`data: ${JSON.stringify({ type: 'delta', text: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'done', model: 'x' })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });

test('focusedCanvasId follows the stage; every /api/chat request carries it', async () => {
  const bus = canvasBus();
  assert.equal(focusedCanvasId(), null);
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return doneSse(); }) as typeof fetch;
  await sendChat('Erste Frage ohne Canvas');
  assert.equal(bodies[0].focusedCanvasId, null, 'nothing shown: null, not missing');
  assert.ok(Object.hasOwn(bodies[0], 'focusedCanvasId'));
  bus.push(ready('video-ablauf', '2026-10-24T10:00:00Z'));
  assert.equal(focusedCanvasId(), 'video-ablauf');
  await sendChat('Kannst du mir dazu ein Diagramm zeichnen?');
  assert.equal(bodies[1].focusedCanvasId, 'video-ablauf');
  assert.equal(typeof bodies[1].conversationId, 'string');
});

test('watchFocusedCanvas reports stage changes once each', () => {
  const bus = canvasBus();
  const seen: (string | null)[] = [];
  const off = watchFocusedCanvas((id) => seen.push(id));
  bus.push(ready('tabelle-engines', '2026-10-24T10:01:00Z'));
  bus.push(ready('tabelle-engines', '2026-10-24T10:01:05Z')); // same id updated: no change of focus
  bus.select('video-ablauf');
  off();
  bus.push(ready('danach', '2026-10-24T10:02:00Z'));
  assert.deepEqual(seen, ['tabelle-engines', 'video-ablauf']);
});

test('voice: start and typed text carry the focused canvas id, stage changes go out as {type:"focus"}', () => {
  const bus = canvasBus();
  bus.select('video-ablauf');
  const sent: Record<string, unknown>[] = [];
  class FakeWs {
    static OPEN = 1; static CONNECTING = 0;
    readyState = 1; binaryType = ''; onopen: (() => void) | null = null; onmessage = null; onerror = null; onclose = null;
    constructor(public url: string) { queueMicrotask(() => this.onopen?.()); }
    send(d: string) { sent.push(JSON.parse(d)); }
    close() { this.readyState = 3; }
  }
  Object.assign(globalThis, { WebSocket: FakeWs, location: { protocol: 'http:', host: 'desk.test' } });
  const handlers = { onTranscript() {}, onTool() {}, onViz() {}, onHandoff() {}, onClaudeProposal() {}, onFallback() {}, onError() {}, onUsage() {} };
  const s = new VoiceSession(VOICE_OPTIONS[0], undefined, handlers) as unknown as { connect(): void; sendText(t: string): void; stop(n?: boolean): void };
  s.connect();
  return new Promise<void>((resolve, reject) => queueMicrotask(() => { try {
    assert.equal(sent[0].type, 'start');
    assert.equal(sent[0].focusedCanvasId, 'video-ablauf');
    bus.push(ready('neue-zeichnung', '2026-10-24T10:03:00Z'));
    bus.select('neue-zeichnung'); // Florian picks it (the stage was pinned by the earlier pick)
    assert.deepEqual(sent.at(-1), { type: 'focus', focusedCanvasId: 'neue-zeichnung' });
    s.sendText('zeichne das');
    assert.deepEqual(sent.at(-1), { type: 'text', text: 'zeichne das', focusedCanvasId: 'neue-zeichnung' });
    s.stop(false);
    const n = sent.length;
    bus.push(ready('nach-dem-ende', '2026-10-24T10:04:00Z'));
    assert.equal(sent.length, n, 'no focus messages after the session ended');
    resolve();
  } catch (e) { s.stop(false); reject(e); } }));
});
