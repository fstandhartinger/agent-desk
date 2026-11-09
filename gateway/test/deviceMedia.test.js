import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, wavDuration, applyCorrections, imageBytes, vocabularyPrompt, dictionaryEntry, STT_LEAD } from '../src/deviceMedia.js';
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
      if (body.systemInstruction) { assert.match(body.systemInstruction.parts[0].text, /bereinigst ein Diktat/); assert.match(opts.body, /Example/); assert.match(opts.body, /JevBench/); assert.equal(called.length, 3); }
      return gemini('Exampel');
    }
    assert(opts.body instanceof FormData); return Response.json({ text: 'Exampel' });
  } });
  const result = await media.dictate(wav(), ctx, dict);
  // two sources word for word the same: still one clean-up call (both can share a misheard name), and Gemini (the slow fallback) never runs as a source
  assert.equal(result.text, 'Example'); assert.deepEqual(result.sources, { groq: 'Exampel', openai: 'Exampel', gemini: null }); assert.equal(called.length, 3); assert(signals.every(s => s.aborted));
  assert.equal(result.providers.merge.ok, true); assert.equal(result.providers.gemini.reason, 'skipped'); assert.equal(result.degraded, false);
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
  const media = createDeviceMedia({ budgetMs: 160, geminiFallbackMs: 0, env: { GROQ_API_KEY: 'fake', OPENAI_API_KEY: 'fake', GOOGLE_API_KEY: 'fake' }, fetchImpl: async (url, opts) => {
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
it('STT requests carry a vocabulary prompt of corrected terms only, at most 800 chars', async () => {
  const prompts = [];
  const items = [{ term: 'Example', replace_from: ['Exampel'] }, { term: 'Example' }, ...Array.from({ length: 200 }, (_, i) => ({ term: `Begriff${i}` }))];
  const media = createDeviceMedia({ env: { GROQ_API_KEY: 'fake', OPENAI_API_KEY: 'fake' }, fetchImpl: async (_url, opts) => { prompts.push(opts.body.get('prompt')); return Response.json({ text: 'Hallo' }); } });
  await media.dictate(wav(), ctx, { items }); await new Promise(r => setTimeout(r, 20));
  assert.equal(prompts.length, 2);
  for (const p of prompts) { assert(p.startsWith(`${STT_LEAD} Begriffe: Example, Begriff0, Begriff1`)); assert(p.length <= STT_LEAD.length + 12 + 700 && p.length > 650); assert(!p.includes('Exampel')); assert.equal(p.replace(`${STT_LEAD} Begriffe: `, '').split(', ').filter(t => t === 'Example').length, 1); }
  assert.equal(vocabularyPrompt({}), ''); assert.equal(vocabularyPrompt(null), '');
});
it('a slow dictionary is waited for at most 300 ms, then STT goes without prompt', async () => {
  const prompts = [], started = Date.now(); let sentAt = 0;
  const media = createDeviceMedia({ env: { GROQ_API_KEY: 'fake' }, fetchImpl: async (_url, opts) => { sentAt = Date.now() - started; prompts.push(opts.body.get('prompt')); return Response.json({ text: 'Hallo' }); } });
  const slow = new Promise(resolve => setTimeout(() => resolve({ items: [{ term: 'Spät' }] }), 1500));
  const result = await media.dictate(wav(), ctx, slow);
  // without his dictionary the request still carries the glossary names
  assert.equal(prompts.length, 1); assert(prompts[0].startsWith(`${STT_LEAD} Begriffe: JevBench, REAX`)); assert(!prompts[0].includes('Spät'));
  assert(sentAt >= 250 && sentAt < 700, `sent after ${sentAt} ms`); assert.equal(result.text, 'Hallo');
});
it('fast dictionary adds no latency and the overall budget still applies', async () => {
  const media = createDeviceMedia({ budgetMs: 100, env: { GROQ_API_KEY: 'fake' }, fetchImpl: async (_url, opts) => { assert(opts.body.get('prompt').startsWith(`${STT_LEAD} Begriffe: Example, JevBench`)); return Response.json({ text: 'Hallo' }); } });
  const result = await media.dictate(wav(), ctx, Promise.resolve({ items: [{ term: 'Example' }] })); assert(result.ms < 50);
  const hung = createDeviceMedia({ budgetMs: 100, env: { GROQ_API_KEY: 'fake' }, fetchImpl: () => new Promise(() => {}) });
  const t = Date.now(); await assert.rejects(hung.dictate(wav(), ctx, new Promise(() => {})), e => e.status === 504); assert(Date.now() - t < 400);
});

it('the fast path: two sources plus a short grace, the fast merge model, nothing waits for a slow third', async () => {
  let merged;
  const media = createDeviceMedia({ graceMs: 20, env: { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'k', GOOGLE_API_KEY: 'x', DESK_DICTATE_MERGE_MODEL: 'test/fast' }, fetchImpl: async (url, opts) => {
    const u = String(url);
    if (u.includes('groq')) return Response.json({ text: 'Hallo Karpati wie geht es' });
    if (u.includes('audio/transcriptions') && u.includes('openrouter')) return Response.json({ text: 'Hallo Karpathy, wie geht es?', usage: { seconds: 1 } });
    if (u.includes('openai.com')) return new Promise(() => {});
    if (u.includes('chat/completions')) { merged = JSON.parse(opts.body); return Response.json({ choices: [{ message: { content: 'Hallo\u00a0Karpathy, wie geht es? Test\u2011Wort' } }] }); }
    throw Error(`unexpected ${u}`);
  } });
  const t = Date.now();
  const r = await media.dictate(wav(2), ctx, { items: [{ term: 'Karpathy', replace_from: ['Karpati', 'unrelated'] }, ...Array.from({ length: 400 }, (_, i) => ({ term: `Wort${i}` }))] });
  assert(Date.now() - t < 900, `took ${Date.now() - t} ms`);
  assert.equal(merged.model, 'test/fast'); assert.deepEqual(merged.reasoning, { effort: 'low', exclude: true });
  assert.match(merged.messages[0].content, /bereinigst ein Diktat/); assert.equal(merged.messages[0].role, 'system');
  const prompt = merged.messages[1].content; assert.match(prompt, /"glossar":/);
  assert.match(prompt, /"ersetze":\{"Karpathy":\["Karpati"\]\}/); assert(!prompt.includes('unrelated')); assert(!prompt.includes('Wort200'));
  assert.equal(r.text, 'Hallo Karpathy, wie geht es? Test-Wort'); assert.equal(r.merged, true); assert.equal(r.sources.openai, null);
});
it('a merge that is too slow does not hold the text back: the source most others agree with goes out', async () => {
  const media = createDeviceMedia({ graceMs: 1, env: { GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => {
    const u = String(url);
    if (u.includes('groq')) return Response.json({ text: 'Eins zwei drei' });
    if (u.includes('audio/transcriptions')) return Response.json({ text: 'Eins zwei vier', usage: { seconds: 1 } });
    return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  } });
  const t = Date.now(), r = await media.dictate(wav(1), ctx, {});
  assert(Date.now() - t < 2500, `took ${Date.now() - t} ms`); assert.equal(r.merged, false); assert.equal(r.providers.merge.ok, false); assert(r.text.startsWith('Eins zwei'));
});
it('dictionary entries from the app are validated', () => {
  assert.deepEqual(dictionaryEntry({ term: 'Karpathy', replace_from: ['Karpati', 'Karpati', 'Karpathy'] }), { term: 'Karpathy', replace_from: ['Karpati'] });
  assert.deepEqual(dictionaryEntry({ term: 'Neu', previous: 'Alt' }), { term: 'Neu', replace_from: [], previous: 'Alt' });
  for (const bad of [{}, { term: '' }, { term: ' x' }, { term: 'a\nb' }, { term: 'x'.repeat(101) }, { term: 'x', replace_from: 'y' }, { term: 'x', replace_from: Array(41).fill(0).map((_, i) => `a${i}`) }, { term: 'x', previous: '' }]) assert.throws(() => dictionaryEntry(bad), JSON.stringify(bad));
});

it('a transcript that only reads the vocabulary prompt back is not a source', async () => {
  const media = createDeviceMedia({ env: { GROQ_API_KEY: 'g' }, fetchImpl: async () => Response.json({ text: 'Example, Begriff, Wort.' }) });
  await assert.rejects(media.dictate(wav(), ctx, { items: [{ term: 'Example' }, { term: 'Begriff' }, { term: 'Wort' }] }), e => e.status === 504 || e.status === 502);
  const real = createDeviceMedia({ env: { GROQ_API_KEY: 'g' }, fetchImpl: async () => Response.json({ text: 'Example' }) });
  assert.equal((await real.dictate(wav(), ctx, { items: [{ term: 'Example' }] })).text, 'Example');
});
