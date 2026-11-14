import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { receiveVoiceTranscript, stopVoice, voiceSpeechActive, voiceSpeechStarted, SPEAKING_TIMEOUT_MS } from '../src/lib/voiceController.ts';
import { addMessage, convStore, finish, textOf } from '../src/lib/conversation.ts';
import { voiceStore } from '../src/lib/voice.ts';
import { ACTIVE_EVERY_FRAMES, HOLD_LEVEL, ONSET_FRAMES, ONSET_LEVEL, SpeechOnset } from '../src/lib/speechOnset.ts';
import { meterText } from '../src/lib/sessionMeter.ts';

// a#41d6d2 (14 Nov): while he speaks the history must show it; the bubble is replaced in place by his words.
beforeEach(() => {
  stopVoice();
  voiceStore.set((s) => ({ ...s, muted: false }));
  convStore.set({ id: 'speaking-test', messages: [] });
});
const roles = () => convStore.get().messages.map((m) => m.role + (m.speaking ? '*' : ''));

test('speech start puts an empty "speaking" bubble after the agent message; the final text replaces it in place', () => {
  const a = addMessage('assistant', 'voice', 'Soll ich Bescheid geben?');
  finish(a);
  voiceSpeechStarted();
  assert.deepEqual(roles(), ['assistant', 'user*']);
  const id = convStore.get().messages[1].id;
  voiceSpeechStarted(); // a second signal (server + local onset) is the same bubble
  assert.equal(convStore.get().messages.length, 2);
  receiveVoiceTranscript('user', 'Ja, bitte.', true, false);
  const m = convStore.get().messages;
  assert.equal(m.length, 2);
  assert.equal(m[1].id, id, 'same message, text arrives in place');
  assert.equal(textOf(m[1]), 'Ja, bitte.');
  assert.equal(m[1].speaking, undefined);
  assert.equal(m[1].status, 'done');
});

test('no transcript: the empty bubble disappears 5 s after the last sign of speech, and the mic level keeps it alive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  voiceSpeechStarted();
  t.mock.timers.tick(SPEAKING_TIMEOUT_MS - 1000);
  voiceSpeechActive(); // still voiced
  t.mock.timers.tick(SPEAKING_TIMEOUT_MS - 1000);
  assert.deepEqual(roles(), ['user*']);
  t.mock.timers.tick(1000);
  assert.deepEqual(roles(), [], 'no empty message left behind');
  voiceSpeechActive(); // never opens a bubble by itself
  assert.deepEqual(roles(), []);
});

test('muted: no placeholder, and muting removes an open empty one', () => {
  voiceStore.set((s) => ({ ...s, muted: true }));
  voiceSpeechStarted();
  assert.deepEqual(roles(), []);
  voiceStore.set((s) => ({ ...s, muted: false }));
  voiceSpeechStarted();
  assert.deepEqual(roles(), ['user*']);
  voiceStore.set((s) => ({ ...s, muted: true }));
  assert.deepEqual(roles(), []);
});

test('assistant deltas arriving while the placeholder is open go AFTER it; his transcript then fills the placeholder, not the answer', () => {
  voiceSpeechStarted(); // barge-in: the old answer is still streaming for a moment
  receiveVoiceTranscript('assistant', 'Der Job steht ', false, true);
  receiveVoiceTranscript('assistant', 'in Phase drei.', false, true);
  assert.deepEqual(roles(), ['user*', 'assistant']);
  receiveVoiceTranscript('user', 'Moment, stopp.', true, false);
  const m = convStore.get().messages;
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant']);
  assert.equal(textOf(m[0]), 'Moment, stopp.');
  assert.equal(textOf(m[1]), 'Der Job steht in Phase drei.');
  assert.equal(m[0].speaking, undefined);
});

test('a streaming answer is closed by his speech start; its late deltas open a new message after the bubble', () => {
  receiveVoiceTranscript('assistant', 'Erste Antwort', false, true);
  voiceSpeechStarted();
  assert.deepEqual(roles(), ['assistant', 'user*']);
  assert.equal(convStore.get().messages[0].status, 'done');
  receiveVoiceTranscript('assistant', 'Rest', false, true);
  assert.deepEqual(roles(), ['assistant', 'user*', 'assistant']);
});

test('provider partials (Gemini/GPT-Live) show live in the same bubble; the final replaces them', () => {
  voiceSpeechStarted();
  const id = convStore.get().messages[0].id;
  receiveVoiceTranscript('user', 'Wie ist ', false, true);
  receiveVoiceTranscript('user', 'der Stand', false, true);
  let m = convStore.get().messages;
  assert.equal(m.length, 1);
  assert.equal(m[0].id, id);
  assert.equal(textOf(m[0]), 'Wie ist der Stand');
  assert.equal(m[0].speaking, true, 'pulse stays while the transcript grows');
  receiveVoiceTranscript('user', 'Wie ist der Stand?', true, false);
  m = convStore.get().messages;
  assert.equal(m.length, 1);
  assert.equal(textOf(m[0]), 'Wie ist der Stand?');
  assert.equal(m[0].speaking, undefined);
});

test('partials without any final: the pulse stops after the timeout but his words stay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  receiveVoiceTranscript('user', 'Hallo', false, true); // no speech_started at all (GPT-Live): the first partial opens the bubble
  assert.deepEqual(roles(), ['user*']);
  t.mock.timers.tick(SPEAKING_TIMEOUT_MS);
  assert.deepEqual(roles(), ['user']);
  assert.equal(textOf(convStore.get().messages[0]), 'Hallo');
});

test('an empty final transcript (noise) leaves no empty bubble', () => {
  voiceSpeechStarted();
  receiveVoiceTranscript('user', '  ', true, false);
  assert.deepEqual(roles(), []);
  receiveVoiceTranscript('user', '', true, false);
  assert.deepEqual(roles(), []);
});

test('a grown fragment (replace) overwrites the earlier message and removes the placeholder opened for the continuation', () => {
  receiveVoiceTranscript('user', 'Wir nehmen das jetzt auf, weil', true, false);
  voiceSpeechStarted(); // he kept talking
  assert.deepEqual(roles(), ['user', 'user*']);
  receiveVoiceTranscript('user', 'Wir nehmen das jetzt auf, weil wir einen Fehler suchen', true, false, false, true);
  const m = convStore.get().messages;
  assert.equal(m.length, 1);
  assert.equal(textOf(m[0]), 'Wir nehmen das jetzt auf, weil wir einen Fehler suchen');
});

test('a typed turn is not his speech: it removes an empty placeholder and stays a "typed" message', () => {
  voiceSpeechStarted();
  receiveVoiceTranscript('user', 'Welche Jobs?', true, false, true);
  const m = convStore.get().messages;
  assert.equal(m.length, 1);
  assert.equal(m[0].via, 'typed');
  assert.equal(textOf(m[0]), 'Welche Jobs?');
});

test('session end / error / fallback cleanup never leaves an empty user message', () => {
  voiceSpeechStarted();
  stopVoice();
  assert.deepEqual(roles(), []);
  receiveVoiceTranscript('user', 'halb', false, true);
  stopVoice(); // a bubble with words is kept and finished
  assert.deepEqual(roles(), ['user']);
  assert.equal(convStore.get().messages[0].status, 'done');
});

test('SpeechOnset: needs a run of loud frames, ignores clicks, reports "active" while voiced, re-arms after silence', () => {
  const d = new SpeechOnset();
  for (let i = 0; i < ONSET_FRAMES - 1; i++) assert.equal(d.feed(ONSET_LEVEL), null);
  assert.equal(d.feed(0), null, 'a click is not speech');
  for (let i = 0; i < ONSET_FRAMES - 1; i++) assert.equal(d.feed(0.5), null);
  assert.equal(d.feed(0.5), 'onset');
  const seen: (string | null)[] = [];
  for (let i = 0; i < ACTIVE_EVERY_FRAMES; i++) seen.push(d.feed(HOLD_LEVEL));
  assert.equal(seen.filter(Boolean).length, 1);
  assert.equal(seen.at(-1), 'active');
  assert.equal(d.feed(HOLD_LEVEL - 0.01), null); // silence ends the utterance
  for (let i = 0; i < ONSET_FRAMES - 1; i++) d.feed(0.5);
  assert.equal(d.feed(0.5), 'onset', 'a new utterance fires again');
  d.reset();
  assert.equal(d.feed(0.5), null);
});

test('meterText: timer, session cost and day total; parts are left out until known', () => {
  assert.equal(meterText(192, { costUsd: 0.16, dayUsd: 1.57 }), '3:12 · $0.16 · heute $1.57');
  assert.equal(meterText(5, null), '0:05');
  assert.equal(meterText(65, { costUsd: 0.0123 }), '1:05 · $0.01');
});

test('VoiceSession: speech_started reaches the controller even when barge-in is blocked (muted); usage lands in the dock store with the day total', async () => {
  const { VoiceSession, VOICE_OPTIONS } = await import('../src/lib/voice.ts');
  let started = 0;
  const used: unknown[] = [];
  const s = new VoiceSession(VOICE_OPTIONS[0], undefined, { onSpeechStart: () => started++, onUsage: (...a: unknown[]) => used.push(a) } as never) as unknown as { handle(m: unknown): void; gate: { muted: boolean } };
  s.handle({ type: 'speech_started' });
  s.gate.muted = true; // allowBargeIn() is false: the old code broke out before anything else
  s.handle({ type: 'speech_started' });
  assert.equal(started, 2);
  s.handle({ type: 'usage', seconds: 192, costUsd: 0.1594, dayUsd: 1.57 });
  assert.deepEqual(voiceStore.get().usage, { seconds: 192, costUsd: 0.1594, dayUsd: 1.57 });
  assert.deepEqual(used[0], [192, 0.1594, 1.57]);
  s.handle({ type: 'usage', seconds: 202, costUsd: 0.17 }); // older gateway without dayUsd
  assert.deepEqual(voiceStore.get().usage, { seconds: 202, costUsd: 0.17 });
});
