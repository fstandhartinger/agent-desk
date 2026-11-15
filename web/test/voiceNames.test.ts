import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { applyVoiceNameEntry, installVoiceCatalog, selectedVoiceName, setVoiceName, voiceNamesStore, VOICE_NAMES_KEY } from '../src/lib/voiceNames.ts';
import { VoiceSession, optionByKey, type VoiceHandlers } from '../src/lib/voice.ts';

const catalog = { providers: Object.fromEntries([
  ['xai', 'eve', ['eve', 'ara']], ['openai', 'marin', ['marin', 'juni']], ['gemini', 'Sulafat', ['Sulafat', 'Charon']],
].map(([p, def, ids]) => [p, { default: def as string, voices: (ids as string[]).map((id) => ({ id, label: id, note: '', sample: null })) }])) };
beforeEach(() => { localStorage.clear(); installVoiceCatalog(catalog); });

test('remembers each provider independently across reload, with one shared Gemini choice', () => {
  assert.equal(selectedVoiceName('openai'), 'marin');
  assert.ok(setVoiceName('openai', 'juni'));
  assert.ok(setVoiceName('xai', 'ara'));
  assert.ok(setVoiceName('gemini-fast', 'Charon'));
  assert.equal(selectedVoiceName('gemini'), 'Charon');
  assert.equal(selectedVoiceName('gemini-fast'), 'Charon');
  voiceNamesStore.set({ catalog: null, names: {} });
  installVoiceCatalog(catalog);
  assert.equal(selectedVoiceName('openai'), 'juni');
  assert.equal(selectedVoiceName('xai'), 'ara');
  assert.deepEqual(JSON.parse(localStorage.getItem(VOICE_NAMES_KEY)!), { openai: 'juni', xai: 'ara', gemini: 'Charon' });
});

test('ignores invalid storage, wrong-provider names, and unknown companion URL names', () => {
  for (const value of ['null', '[]', '"bad"', '{', '{"openai":"eve"}']) {
    localStorage.setItem(VOICE_NAMES_KEY, value); installVoiceCatalog(catalog);
    assert.equal(selectedVoiceName('openai'), 'marin');
  }
  assert.equal(setVoiceName('openai', 'eve'), false);
  assert.equal(applyVoiceNameEntry('?companion=1&voice=gemini-fast&voiceName=Charon'), true);
  assert.equal(applyVoiceNameEntry('?companion=1&voice=gemini&voiceName=unlisted'), false);
  assert.equal(applyVoiceNameEntry('?companion=1&voice=__proto__&voiceName=unlisted'), false);
  assert.equal(applyVoiceNameEntry('?voice=openai&voiceName=juni'), false);
  assert.equal(selectedVoiceName('gemini'), 'Charon');
});

test('real VoiceSession start captures provider voice and sends it in the WebSocket start message', async (t) => {
  const original = { WebSocket: globalThis.WebSocket, location: globalThis.location };
  const sent: Record<string, unknown>[] = [];
  let socket: { onopen?: () => void };
  class Socket {
    static OPEN = 1; readyState = 1; onopen?: () => void;
    constructor() { socket = this; }
    send(data: string) { sent.push(JSON.parse(data)); }
    close() {}
  }
  Object.assign(globalThis, { WebSocket: Socket, location: { protocol: 'https:', host: 'desk.test', search: '', pathname: '/' } });
  t.after(() => Object.assign(globalThis, original));
  setVoiceName('openai', 'juni');
  const s = new VoiceSession(optionByKey('openai'), undefined, {} as VoiceHandlers);
  // Audio capture is stubbed; the real start/connect/onopen path constructs the protocol message.
  const internals = s as unknown as { setupAudio(): Promise<void>; stream: unknown };
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }) } } });
  t.after(() => { if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator); });
  internals.setupAudio = async () => {};
  await s.start();
  setVoiceName('openai', 'marin'); // next session only, even if the socket is still connecting
  socket!.onopen!();
  const start = sent.find((m) => m.type === 'start');
  assert.equal(start?.voice, 'juni');
  assert.equal(start?.lang, 'de');
  s.stop();
});
