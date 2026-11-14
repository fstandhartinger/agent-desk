// Speech-synced reveal: revealCount (pure), the speech cursor tracker (audio seconds → spoken characters, ~10 updates/s) and
// the wiring in VoiceSession (user final / barge-in start a new turn). Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDLE_ALL_MS, LOOKAHEAD_CHARS, UNCUED_GAP_CHARS, normalize, normalizeWithMap, revealCount } from '../src/canvas/reveal.ts';
import { PUBLISH_MS, SpeechTracker, noteSpecTurn, specTurnOf, speechCursor, type SpeechCursor, type SpeechCursorState } from '../src/lib/speechCursor.ts';
import { createStore } from '../src/lib/store.ts';
import { VoiceSession, VOICE_OPTIONS } from '../src/lib/voice.ts';
import { canvasBus } from '../src/canvas/bus.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';
import pointsFx from '../src/canvas/fixtures/points-three-reasons.json' with { type: 'json' };

const spec = pointsFx as unknown as CanvasSpec;
const TEXT = 'Es gibt drei Gründe dafür. Erstens, die Prüfbarkeit: ein Eintrag, ein Start. Zweitens: Die Belohnung ist fest, niemand rechnet nach. Und drittens die Vorfahren, sie werden nicht bezahlt.';
const at = (needle: string) => TEXT.indexOf(needle);
const cursor = (over: Partial<SpeechCursor> = {}): SpeechCursor => ({ turn: 4, text: TEXT, spokenChars: 0, speaking: true, ...over });
// specTurn: 4 unless `null` (= the canvas has no turn: loaded from the history)
const count = (over: Partial<SpeechCursor> = {}, sinceMs = 0, specTurn: number | null = 4, s: CanvasSpec = spec) => revealCount(s, cursor(over), sinceMs, specTurn ?? undefined);

test('normalize: lowercase, punctuation to spaces, whitespace collapsed; the map points into the original text', () => {
  assert.equal(normalize('  Zweitens:   Die\nBelohnung! '), 'zweitens die belohnung');
  assert.equal(normalize('Prüfbarkeit — 1.000 Alpha'), 'prüfbarkeit 1 000 alpha');
  const { norm, map } = normalizeWithMap('Ein  Satz, ja.');
  assert.equal(norm, 'ein satz ja');
  assert.equal('Ein  Satz, ja.'[map[norm.indexOf('satz')]], 'S');
  assert.equal(normalize(''), '');
});

test('revealCount: not a sync points spec -> every point (or 0 without points)', () => {
  assert.equal(count({}, 0, 4, { ...spec, sync: undefined }), 3);
  assert.equal(count({}, 0, 4, { ...spec, kind: 'bar', items: [] }), 3, 'points field still counted');
  assert.equal(count({}, 0, 4, { ...spec, kind: 'bar', points: undefined }), 0);
  assert.equal(count({}, 0, 4, { ...spec, kind: 'pie', points: undefined, sync: undefined }), 0);
});

test('revealCount: another turn began, or the canvas has no turn (history) -> every point', () => {
  assert.equal(count({ turn: 5 }, 0, 4), 3);
  assert.equal(count({ turn: 3 }, 0, 4), 3);
  assert.equal(count({}, 0, null), 3);
});

test('revealCount: points appear when their cue is being spoken (cue found at p, due when p ≤ spokenChars + 12)', () => {
  const p1 = at('Erstens'), p2 = at('Zweitens'), p3 = at('Und drittens') + 4; // "drittens die Vorfahren"
  assert.equal(count({ spokenChars: 0 }), 1, 'the first point is always there');
  assert.equal(count({ spokenChars: p1 - LOOKAHEAD_CHARS - 1 }), 1);
  assert.equal(count({ spokenChars: p1 - LOOKAHEAD_CHARS }), 1);
  assert.equal(count({ spokenChars: p2 - LOOKAHEAD_CHARS - 1 }), 1, 'second point not due one char early');
  assert.equal(count({ spokenChars: p2 - LOOKAHEAD_CHARS }), 2, 'due exactly at p - 12');
  assert.equal(count({ spokenChars: p2 + 20 }), 2);
  assert.equal(count({ spokenChars: p3 - LOOKAHEAD_CHARS - 1 }), 2);
  assert.equal(count({ spokenChars: p3 - LOOKAHEAD_CHARS }), 3);
  assert.equal(count({ spokenChars: TEXT.length }), 3);
});

test('revealCount: case, punctuation and spacing do not matter; a cue seen in the text before the audio reaches it waits', () => {
  const loud = { ...spec, points: spec.points!.map((p, i) => ({ ...p, cue: ['ERSTENS!!  die   prüfbarkeit', 'zweitens … die belohnung', '(Drittens) die Vorfahren'][i] })) };
  assert.equal(count({ spokenChars: at('Zweitens') }, 0, 4, loud), 2);
  assert.equal(count({ spokenChars: at('Zweitens') - 40 }, 0, 4, loud), 1);
  // the transcript is ahead of the audio: only the first sentence has been spoken
  assert.equal(count({ spokenChars: 10 }), 1);
});

test('revealCount: a point without a cue, or whose cue is not in the text, follows its predecessor one sentence later (never at once)', () => {
  const noCue = { ...spec, points: spec.points!.map((p) => ({ label: p.label })) };
  assert.equal(count({ spokenChars: 0 }, 0, 4, noCue), 1, 'point 0 without a cue is due at once');
  assert.equal(count({ spokenChars: UNCUED_GAP_CHARS - 1 }, 0, 4, noCue), 1);
  assert.equal(count({ spokenChars: UNCUED_GAP_CHARS }, 0, 4, noCue), 2);
  assert.equal(count({ spokenChars: UNCUED_GAP_CHARS * 2 }, 0, 4, noCue), 3);
  // cue never said: it trails the cued point before it
  const lost = { ...spec, points: spec.points!.map((p, i) => (i === 1 ? { ...p, cue: 'ganz andere Worte' } : p)) };
  const p1 = at('Erstens');
  assert.equal(count({ spokenChars: p1 - LOOKAHEAD_CHARS + UNCUED_GAP_CHARS - 1 }, 0, 4, lost), 1);
  assert.equal(count({ spokenChars: p1 - LOOKAHEAD_CHARS + UNCUED_GAP_CHARS }, 0, 4, lost), 2);
  // empty transcript: just the first point
  assert.equal(count({ text: '', spokenChars: 0 }), 1);
});

test('revealCount: cues are searched in order (a repeated phrase does not pull a point forward)', () => {
  const twice = { ...spec, points: [{ label: 'A', cue: 'der Grund' }, { label: 'B', cue: 'der Grund' }] };
  const text = 'Der Grund eins ist klar. Und der Grund zwei kommt später.';
  const second = text.toLowerCase().lastIndexOf('der grund');
  assert.equal(revealCount(twice, { turn: 1, text, spokenChars: 5, speaking: true }, 0, 1), 1);
  assert.equal(revealCount(twice, { turn: 1, text, spokenChars: second, speaking: true }, 0, 1), 2);
});

test('revealCount: no speech for 1.5 s shows everything (the answer is over or never started)', () => {
  assert.equal(count({ speaking: false, spokenChars: 0 }, IDLE_ALL_MS - 1), 1);
  assert.equal(count({ speaking: false, spokenChars: 0 }, IDLE_ALL_MS), 3);
  assert.equal(count({ speaking: false, spokenChars: 0 }, 60_000), 3);
  assert.equal(count({ speaking: true, spokenChars: 0 }, 60_000), 1, 'while speaking the stale time does not matter');
});

// ---------------------------------------------------------------- the tracker (speech cursor store)
function rig() {
  const store = createStore<SpeechCursorState>({ turn: 0, text: '', spokenChars: 0, speaking: false, active: false });
  let now = 1000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  const deps = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const t = { at: now + ms, fn, id: nextId++ }; timers.push(t); return t.id; },
    clearTimeout: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = (ms: number) => { now += ms; for (const t of timers.filter((x) => x.at <= now).sort((a, b) => a.at - b.at)) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
  let publishes = 0;
  store.subscribe(() => { publishes++; });
  return { tracker: new SpeechTracker(store, deps), store, advance, timers, publishes: () => publishes };
}
const SEC = 24000 * 2; // bytes of one second of PCM16 / 24 kHz

test('tracker: spokenChars = text × (received − buffered) / received; speaking = buffered > 0.02 s', () => {
  const { tracker, store, advance } = rig();
  tracker.start();
  tracker.transcript('a'.repeat(100), false, true);
  tracker.audio(4 * SEC); // 4 s received
  tracker.player(3); // 3 s still to play -> 1 s spoken
  advance(PUBLISH_MS);
  assert.deepEqual({ ...store.get() }, { turn: 0, text: 'a'.repeat(100), spokenChars: 25, speaking: true, active: true });
  tracker.player(0.01);
  advance(PUBLISH_MS);
  assert.equal(store.get().speaking, false, '0.01 s is below the threshold');
  assert.equal(store.get().spokenChars, 100 - Math.round(100 * 0.01 / 4), 'nearly everything spoken');
  tracker.player(0);
  advance(PUBLISH_MS);
  assert.equal(store.get().spokenChars, 100);
  assert.equal(tracker.snapshot().spokenChars, 100);
});

test('tracker: no audio = 0 spoken characters; the played share never exceeds the text', () => {
  const { tracker } = rig();
  tracker.transcript('hallo welt', false, true);
  assert.equal(tracker.snapshot().spokenChars, 0);
  tracker.audio(SEC);
  tracker.player(-5); // junk is clamped
  assert.equal(tracker.snapshot().spokenChars, 10);
  tracker.player(9);
  assert.equal(tracker.snapshot().spokenChars, 0);
});

test('tracker: deltas append, a longer final replaces, a shorter final is ignored, a later segment starts after a space', () => {
  const { tracker } = rig();
  tracker.transcript('Erstens ', false, true);
  tracker.transcript('die Prüfbarkeit.', false, true);
  assert.equal(tracker.snapshot().text, 'Erstens die Prüfbarkeit.');
  tracker.transcript('Erstens die Prüfbarkeit. Zweitens die Belohnung.', true, false);
  assert.equal(tracker.snapshot().text, 'Erstens die Prüfbarkeit. Zweitens die Belohnung.');
  tracker.transcript('kurz', true, false);
  assert.equal(tracker.snapshot().text, 'Erstens die Prüfbarkeit. Zweitens die Belohnung.');
  tracker.transcript('Danach geht es weiter.', false, true);
  assert.equal(tracker.snapshot().text, 'Erstens die Prüfbarkeit. Zweitens die Belohnung. Danach geht es weiter.');
});

test('tracker: reset starts a new turn (text, received audio and buffer cleared)', () => {
  const { tracker, store } = rig();
  tracker.start();
  tracker.transcript('abc', false, true);
  tracker.audio(SEC);
  tracker.player(0);
  const turn = tracker.snapshot().turn;
  tracker.reset();
  assert.equal(store.get().turn, turn + 1, 'published at once');
  assert.deepEqual(tracker.snapshot(), { turn: turn + 1, text: '', spokenChars: 0, speaking: false });
  tracker.stop();
  assert.equal(store.get().active, false);
  assert.equal(store.get().turn, turn + 2, 'a stopped session never matches an older canvas turn');
});

test('tracker: the store is updated at most ~10×/s (leading edge at once, the rest folded into one trailing update), O(1) per message', () => {
  const { tracker, store, advance, timers, publishes } = rig();
  tracker.start();
  const before = publishes();
  for (let i = 0; i < 300; i++) { tracker.audio(960); tracker.player(0.5); tracker.transcript('x', false, true); } // 900 messages inside one instant
  assert.ok(publishes() - before <= 2, `${publishes() - before} store updates for 900 messages in 0 ms`);
  assert.equal(timers.length, 1, 'one trailing update is pending');
  advance(PUBLISH_MS);
  assert.equal(store.get().text.length, 300, 'the trailing update carries the newest state');
  // 3 s of 30 Hz player messages = ~90 messages
  const t0 = publishes();
  for (let i = 0; i < 90; i++) { tracker.audio(1600); tracker.player(1 + (i % 3) * 0.1); advance(33); }
  advance(PUBLISH_MS);
  const rate = (publishes() - t0) / 3;
  assert.ok(rate <= 11, `${rate.toFixed(1)} updates/s`);
  assert.ok(rate >= 5, 'still updates regularly');
});

test('tracker: an unchanged snapshot is not published again', () => {
  const { tracker, advance, publishes } = rig();
  tracker.start();
  advance(PUBLISH_MS);
  const n = publishes();
  tracker.player(0);
  advance(PUBLISH_MS);
  tracker.player(0);
  advance(PUBLISH_MS * 3);
  assert.equal(publishes(), n);
});

test('spec turns: noted per canvas id when its event arrives through the bus; unknown ids have none', () => {
  noteSpecTurn('x-1', 7);
  assert.equal(specTurnOf('x-1'), 7);
  assert.equal(specTurnOf('never-seen'), undefined);
  for (let i = 0; i < 80; i++) noteSpecTurn(`many-${i}`, i);
  assert.equal(specTurnOf('x-1'), undefined, 'the oldest are forgotten');
  assert.equal(specTurnOf('many-79'), 79);
  const bus = canvasBus();
  speechCursor.set((s) => ({ ...s, turn: 41 }));
  bus.push({ type: 'canvas', phase: 'ready', id: 'from-bus-1114', by: 'voice', at: '2026-11-14T10:00:00Z', spec: { ...spec, id: 'from-bus-1114' } });
  assert.equal(specTurnOf('from-bus-1114'), 41);
  bus.push({ type: 'canvas', phase: 'pending', id: 'pending-1114', by: 'voice', at: '2026-11-14T10:00:01Z' });
  assert.equal(specTurnOf('pending-1114'), undefined, 'only a ready spec has a turn');
});

// ---------------------------------------------------------------- VoiceSession wiring
class FakeWs {
  static OPEN = 1; static CONNECTING = 0;
  readyState = 1; binaryType = ''; onopen: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null; onerror = null; onclose = null;
  sent: unknown[] = [];
  constructor(public url: string) { queueMicrotask(() => this.onopen?.()); }
  send(d: unknown) { this.sent.push(d); }
  close() { this.readyState = 3; }
}

test('VoiceSession: audio chunks, assistant transcripts and player reports feed the cursor; the user final and a barge-in start a new turn', async () => {
  Object.assign(globalThis, { WebSocket: FakeWs, location: { protocol: 'http:', host: 'desk.test' } });
  const handlers = { onTranscript() {}, onTool() {}, onViz() {}, onHandoff() {}, onClaudeProposal() {}, onFallback() {}, onError() {}, onUsage() {} };
  const s = new VoiceSession(VOICE_OPTIONS[0], undefined, handlers) as unknown as {
    connect(): void; ws: FakeWs; handle(m: unknown): void; cursor: SpeechTracker; player: { port: { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null; close(): void } } | null; stop(n?: boolean): void;
    gate: { allowBargeIn(): boolean };
  };
  const posted: unknown[] = [];
  s.player = { port: { postMessage: (m) => posted.push(m), onmessage: null, close() {} } };
  s.gate.allowBargeIn = () => true;
  s.connect();
  await new Promise((r) => queueMicrotask(() => r(null)));
  const turn0 = speechCursor.get().turn;
  s.handle({ type: 'ready', model: 'm' });
  assert.equal(speechCursor.get().active, true, 'a running session marks the cursor active');
  // a 1 s binary chunk + transcript delta
  const chunk = new ArrayBuffer(SEC);
  s.ws.onmessage!({ data: chunk });
  assert.equal(posted.length, 1, 'the chunk still reaches the player');
  s.handle({ type: 'transcript', role: 'assistant', delta: 'Erstens die Prüfbarkeit.', final: false });
  const snap = s.cursor.snapshot();
  assert.equal(snap.text, 'Erstens die Prüfbarkeit.');
  assert.equal(snap.turn, turn0);
  // the user's final transcript starts the next turn
  s.handle({ type: 'transcript', role: 'user', text: 'Und warum?', final: true });
  assert.equal(s.cursor.snapshot().turn, turn0 + 1);
  assert.equal(s.cursor.snapshot().text, '');
  // a barge-in flush too (only when it really flushes)
  s.handle({ type: 'transcript', role: 'assistant', delta: 'Antwort', final: false });
  s.gate.allowBargeIn = () => false;
  s.handle({ type: 'speech_started' });
  assert.equal(s.cursor.snapshot().turn, turn0 + 1, 'a ignored barge-in changes nothing');
  s.gate.allowBargeIn = () => true;
  s.handle({ type: 'speech_started' });
  assert.equal(s.cursor.snapshot().turn, turn0 + 2);
  assert.ok(posted.includes('flush'));
  s.stop(false);
  assert.equal(speechCursor.get().active, false, 'the cursor goes inactive with the session');
});
