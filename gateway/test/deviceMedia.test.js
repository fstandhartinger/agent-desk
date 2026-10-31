import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, wavDuration, applyCorrections, imageBytes } from '../src/deviceMedia.js';
function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
const ctx = { process: 'fake', fieldBefore: '', visibleIds: [], recentTerms: [] };
const dict = { items: [{ term: 'Example', replace_from: ['Exampel'] }] };
const gemini = text => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
it('WAV parser rejects non-PCM, wrong sample rate/channels, malformed chunks and >60 seconds', () => {
  assert.equal(wavDuration(wav()), 1); assert.equal(wavDuration(wav(60)), 60);
  assert.throws(() => wavDuration(wav(61)), e => e.status === 413);
  for (const [pos, value] of [[20, 3], [22, 2], [24, 8000], [28, 10], [32, 1], [34, 8], [40, 9999999]]) { const b = wav(); b.writeUInt32LE(value, pos); assert.throws(() => wavDuration(b)); }
  assert.throws(() => wavDuration(Buffer.from('not audio')));
});
it('parallel ensemble reconciles variants and applies dictionary replace_from', async () => {
  const called = [], signals = [];
  const media = createDeviceMedia({ env: { GROQ_API_KEY: 'fake', OPENAI_API_KEY: 'fake', GOOGLE_API_KEY: 'fake' }, fetchImpl: async (url, opts) => {
    called.push(String(url)); signals.push(opts.signal); assert.equal(opts.redirect, 'error');
    if (String(url).includes('generateContent')) {
      const body = JSON.parse(opts.body);
      if (body.contents[0].parts[0].text?.includes('Erstelle EIN')) { assert.match(opts.body, /Wörterbuch|Example/); assert.equal(called.length, 4); }
      return gemini('Exampel');
    }
    assert(opts.body instanceof FormData); return Response.json({ text: 'Exampel' });
  } });
  const result = await media.dictate(wav(), ctx, dict);
  assert.equal(result.text, 'Example'); assert.deepEqual(result.sources, { groq: 'Exampel', openai: 'Exampel', gemini: 'Exampel' }); assert.equal(called.length, 4); assert(signals.every(s => s.aborted));
});
it('deadline returns first transcript even when another provider ignores cancellation', async () => {
  const media = createDeviceMedia({ budgetMs: 40, env: { GROQ_API_KEY: 'fake', OPENAI_API_KEY: 'fake' }, fetchImpl: async url => String(url).includes('groq') ? Response.json({ text: 'Exampel' }) : new Promise(() => {}) });
  const result = await media.dictate(wav(), ctx, dict); assert.equal(result.text, 'Example'); assert.equal(result.sources.openai, null); assert(result.ms < 250);
});
it('slow reconciliation falls back, missing keys skip providers, no transcript returns bounded error', async () => {
  const media = createDeviceMedia({ budgetMs: 40, env: { GROQ_API_KEY: 'fake', GOOGLE_API_KEY: 'fake' }, fetchImpl: async (url, opts) => {
    if (!String(url).includes('generateContent')) return Response.json({ text: 'First' });
    return JSON.parse(opts.body).contents[0].parts[0].text ? new Promise(() => {}) : gemini('Second');
  } });
  assert.equal((await media.dictate(wav(), ctx, {})).text, 'First');
  await assert.rejects(createDeviceMedia({ env: {} }).dictate(wav(), ctx, {}), e => e.status === 503);
  await assert.rejects(createDeviceMedia({ budgetMs: 20, env: { OPENAI_API_KEY: 'fake' }, fetchImpl: () => new Promise(() => {}) }).dictate(wav(), ctx, {}), e => e.status === 504);
});
it('short clip hallucinations are rejected and errors never contain audio/provider response', async () => {
  const media = createDeviceMedia({ env: { GOOGLE_API_KEY: 'fake' }, fetchImpl: async () => gemini('invented '.repeat(100)) });
  await assert.rejects(media.dictate(wav(), ctx, {}), e => e.status === 504);
  await assert.rejects(createDeviceMedia({ env: { GOOGLE_API_KEY: 'fake' }, fetchImpl: async () => { throw Error('private-media-marker'); } }).highlight(Buffer.from('fake'), null, {}, []), e => e.status === 502 && !e.message.includes('private-media-marker'));
});
it('vision sends only in-memory PNG/JPEG to Gemini and requests German summary', async () => {
  let payload;
  const media = createDeviceMedia({ env: { GEMINI_API_KEY: 'fake' }, fetchImpl: async (_url, opts) => { payload = JSON.parse(opts.body); assert.equal(opts.headers['x-goog-api-key'], 'fake'); return gemini('Eine Markierung.'); } });
  assert.equal(await media.highlight(Buffer.from('crop'), Buffer.from('context'), { x: -1, y: 0, w: 1, h: 1 }, ['abcdef']), 'Eine Markierung.');
  const parts = payload.contents[0].parts; assert.equal(parts[0].inline_data.mime_type, 'image/png'); assert.equal(parts[1].inline_data.mime_type, 'image/jpeg'); assert.match(parts[2].text, /Deutsch in 1–3 Sätzen/);
  assert.throws(() => imageBytes('not-base64', 100, 'png'));
  assert.equal(applyCorrections('Exampel, anExampel.', dict), 'Example, anExampel.');
});
it('maximum-size base64 is validated without recursive regex stack growth', () => {
  const png = Buffer.alloc(2 * 1024 * 1024); Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  assert.equal(imageBytes(png.toString('base64'), png.length, 'png').length, png.length);
  assert.throws(() => imageBytes('aaaa===a', 100, 'png'));
});
it('soft deadline merges completed sources while a third provider hangs; bounded context and spend are shared', async () => {
  const { limits } = await import('../src/limits.js');
  const before = limits.costToday(); let merge;
  const media = createDeviceMedia({ budgetMs: 160, env: { GROQ_API_KEY: 'fake', OPENAI_API_KEY: 'fake', GOOGLE_API_KEY: 'fake' }, fetchImpl: async (url, opts) => {
    if (String(url).includes('groq')) return Response.json({ text: 'One' });
    if (String(url).includes('openai')) return new Promise(() => {});
    const parts = JSON.parse(opts.body).contents[0].parts;
    if (parts[0].text) { merge = parts[0].text; return gemini('Merged'); }
    return gemini('Two');
  } });
  const result = await media.dictate(wav(), { ...ctx, visibleArtifacts: '<artifact_data>screen title</artifact_data>' }, dict);
  assert.equal(result.text, 'Merged'); assert.equal(result.sources.openai, null);
  assert(result.ms >= 80 && result.ms < 160); assert.match(merge, /screen title/);
  assert(!merge.includes('visibleArtifacts":"<artifact_data>'));
  assert(limits.costToday() > before);
  const old = process.env.DESK_DAILY_USD_CAP; process.env.DESK_DAILY_USD_CAP = '0'; let calls = 0;
  try {
    await assert.rejects(createDeviceMedia({ env: { GOOGLE_API_KEY: 'fake' }, fetchImpl: async () => { calls++; return gemini('Should not call'); } }).highlight(Buffer.from('fake'), null, {}, []), e => e.status === 429);
    assert.equal(calls, 0);
  } finally { if (old === undefined) delete process.env.DESK_DAILY_USD_CAP; else process.env.DESK_DAILY_USD_CAP = old; }
});
