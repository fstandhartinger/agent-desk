import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, pcmToWav, REVISE_PROMPT } from '../src/deviceMedia.js';
// 16 Nov 2026: the live subtitle's last seconds re-read by the stronger recognisers and merged with the fast text and his context (media.revise).
const speech = seconds => { const pcm = Buffer.alloc(seconds * 32000); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(4000 * Math.sin(i / 20)), i); return pcmToWav(pcm); };
const env = { OPENROUTER_API_KEY: 'fake', OPENAI_API_KEY: 'fake' };
function fake({ mai = 'wir haben das Jeff Bench Ergebnis gestern', openai = 'wir haben das JevBench Ergebnis gestern', model = 'wir haben das JevBench-Ergebnis gestern', seen = [] } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.includes('/audio/transcriptions') && u.includes('openrouter')) { seen.push('mai'); return mai instanceof Error ? Promise.reject(mai) : Response.json({ text: mai, usage: { cost: 0.0004, seconds: 10 } }); }
    if (u.includes('api.openai.com')) { seen.push('openai'); return Response.json({ text: openai }); }
    if (u.includes('/chat/completions')) { const body = JSON.parse(opts.body); seen.push({ model: body.model, system: body.messages[0].content, user: body.messages[1].content }); return model === null ? new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(Error('late'), { name: 'AbortError' })))) : Response.json({ choices: [{ message: { content: model } }] }); }
    throw Error('unexpected ' + u);
  };
}
it('re-reads with MAI by default and merges with the shown text and his context; the end stays open', async () => {
  const seen = [];
  const media = createDeviceMedia({ env, fetchImpl: fake({ seen, model: 'wir haben das JevBench Ergebnis gestern.' }) });
  const r = await media.revise(speech(10), { shown: 'wir haben das Jeff Bench Ergebnis, gestern', before: 'Das war gut.', screenNames: ['Nordgatan'], turns: ['Wie lief der Test?'] }, { deviceId: 'rev-1' });
  assert.equal(r.text, 'wir haben das JevBench Ergebnis gestern');   // the model's full stop at the open end is gone
  assert.equal(r.merged, true);
  assert.deepEqual(seen.filter(s => typeof s === 'string'), ['mai']);
  const call = seen.find(s => typeof s === 'object');
  assert.equal(call.system, REVISE_PROMPT);
  assert.match(call.user, /"angezeigt":"wir haben das Jeff Bench Ergebnis, gestern"/); assert.match(call.user, /"davor":"Das war gut\."/);
  assert.match(call.user, /Nordgatan/); assert.match(call.user, /Wie lief der Test\?/); assert.match(call.user, /JevBench/);   // glossary
  assert.ok(r.cost > 0);
});
it('a second recogniser joins when configured', async () => {
  const seen = [];
  const media = createDeviceMedia({ env: { ...env, DESK_CAPTION_REVISE_SOURCES: 'mai,openai' }, fetchImpl: fake({ seen }) });
  await media.revise(speech(5), { shown: 'x' }, { deviceId: 'rev-2' });
  assert.deepEqual(seen.filter(s => typeof s === 'string').sort(), ['mai', 'openai']);
});
it('the guard undoes what nobody heard: an invented negation or digit never reaches the subtitle', async () => {
  const media = createDeviceMedia({ env, fetchImpl: fake({ mai: 'wir haben das Ergebnis gestern gesehen', model: 'wir haben das Ergebnis gestern nicht gesehen' }) });
  assert.equal((await media.revise(speech(5), { shown: 'wir haben das Ergebnis gestern gesehen' }, { deviceId: 'rev-3' })).text, 'wir haben das Ergebnis gestern gesehen');
  const m2 = createDeviceMedia({ env, fetchImpl: fake({ mai: 'wir haben drei Modelle getestet', model: 'wir haben 4 Modelle getestet' }) });
  assert.equal((await m2.revise(speech(5), {}, { deviceId: 'rev-4' })).text, 'wir haben drei Modelle getestet');
});
it('a late or failing model leaves the recogniser reading; no recogniser is an error the app ignores', async () => {
  const media = createDeviceMedia({ env, fetchImpl: fake({ model: null }) });
  const r = await media.revise(speech(5), { shown: 'x' }, { deviceId: 'rev-5', modelMs: 50 });
  assert.equal(r.merged, false); assert.equal(r.text, 'wir haben das Jeff Bench Ergebnis gestern'); assert.equal(r.providers.model.ok, false);
  const down = createDeviceMedia({ env, fetchImpl: fake({ mai: Object.assign(Error('down'), { upstream: 503 }) }) });
  await assert.rejects(down.revise(speech(5), {}, { deviceId: 'rev-6' }), e => e.status === 503 && e.code === 'revise-down');
  await assert.rejects(createDeviceMedia({ env: {} }).revise(speech(5), {}, {}), e => e.code === 'no-key');
});
it('an answer that lost his words is not taken', async () => {
  const media = createDeviceMedia({ env, fetchImpl: fake({ mai: 'eins zwei drei vier fünf sechs sieben acht neun zehn', model: 'ja' }) });
  const r = await media.revise(speech(5), {}, { deviceId: 'rev-7' });
  assert.equal(r.merged, false); assert.equal(r.text, 'eins zwei drei vier fünf sechs sieben acht neun zehn');
});
it('closed end (open:false) keeps the sentence end', async () => {
  const media = createDeviceMedia({ env, fetchImpl: fake({ mai: 'das ist fertig', model: 'Das ist fertig.' }) });
  assert.equal((await media.revise(speech(3), { open: false }, { deviceId: 'rev-8' })).text, 'Das ist fertig.');
});
