import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { VOICES, DEFAULT_VOICE, resolveVoice, voiceCatalog } from '../src/voice/voices.js';
import { runVoiceSession } from '../src/voice/session.js';
import { setEnv, startGateway, login } from './helpers/env.js';

test('voice catalog contains exactly the supported names, shared Gemini variants and valid defaults', () => {
  assert.deepEqual(Object.keys(voiceCatalog().providers), ['xai', 'openai', 'gemini']);
  assert.equal(VOICES.xai.length, 28);
  assert.equal(VOICES.openai.length, 13);
  assert.equal(VOICES.gemini.length, 30);
  assert.equal(VOICES.gemini, VOICES['gemini-fast']);
  for (const [p, list] of Object.entries(VOICES)) {
    assert.equal(new Set(list.map((v) => v.id)).size, list.length);
    assert.ok(list.some((v) => v.id === DEFAULT_VOICE[p]));
    for (const v of list) assert.equal(resolveVoice(p, v.id), v.id);
    for (const bad of [undefined, null, '', 'unknown', '../evil', {}, ['marin'], '__proto__']) assert.equal(resolveVoice(p, bad), DEFAULT_VOICE[p]);
  }
  assert.equal(resolveVoice('openai', 'nuri'), 'nuri');
  assert.equal(resolveVoice('openai', 'bossa'), 'marin');
  assert.equal(resolveVoice('gemini', 'sulafat'), DEFAULT_VOICE.gemini);
  assert.equal(resolveVoice('__proto__', 'evil'), undefined);
});

test('GET /api/voices requires the same session auth as the other API routes', async (t) => {
  setEnv();
  const gw = await startGateway();
  t.after(() => gw.close());
  assert.equal((await fetch(`${gw.base}/api/voices`)).status, 401);
  const { cookie } = await login(gw.base);
  const r = await fetch(`${gw.base}/api/voices`, { headers: { cookie } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), voiceCatalog());
});

for (const [provider, requested, expected] of [['openai', 'juni', 'juni'], ['openai', 'untrusted', 'marin'], ['xai', undefined, 'eve'], ['gemini', 'Achernar', 'Achernar'], ['gemini', {}, DEFAULT_VOICE.gemini]]) {
  test(`session passes resolved ${provider} voice to adapter and trace (${String(requested)})`, (t) => {
    const ws = new EventEmitter();
    Object.assign(ws, { OPEN: 1, readyState: 1, send() {}, close() {} });
    let opts;
    const events = [];
    runVoiceSession(ws, {
      sid: 'test', toolDefs: [], audit() {}, makeCtx: () => ({}), speechDictionary: () => null,
      limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ close() {} }),
      openTrace: () => ({ event: (type, data) => events.push({ type, data }), close() {}, ready: Promise.resolve(null) }),
    }, { provider, apiKey: 'test', create: (o) => { opts = o; return { close() {} }; } });
    t.after(() => ws.emit('message', Buffer.from('{"type":"stop"}'), false));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', voice: requested })), false);
    assert.equal(opts.voice, expected);
    assert.equal(events.find((e) => e.type === 'session.start')?.data.voice, expected);
  });
}
