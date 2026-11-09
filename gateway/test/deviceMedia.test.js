import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, wavDuration, wavPeak, pcmToWav, applyCorrections, imageBytes, vocabularyPrompt, dictionaryEntry, STT_LEAD } from '../src/deviceMedia.js';
const pcmQuiet = seconds => { const pcm = Buffer.alloc(seconds * 32000); pcm.writeInt16LE(300, 100); return pcmToWav(pcm); }; // room noise: nothing louder than a click
function wav(seconds = 1) {
  const b = Buffer.alloc(44 + seconds * 32000); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); b.writeInt16LE(8000, 44); return b; // one loud sample: speech, not room noise
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
    if (String(url).includes('groq')) return Response.json({ text: 'Das ist ein Tesst' });
    if (String(url).includes('openai')) return new Promise(() => {});
    const parts = JSON.parse(opts.body).contents[0].parts;
    if (parts[0].text) { merge = parts[0].text; return gemini('Das ist ein Test.'); }
    return gemini('Das ist ein Test');
  } });
  const result = await media.dictate(wav(), { ...ctx, visibleArtifacts: '<artifact_data>screen title</artifact_data>' }, dict);
  assert.equal(result.text, 'Das ist ein Test.'); assert.equal(result.sources.openai, null);
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
  const media = createDeviceMedia({ graceMs: 20, env: { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', OPENROUTER_API_KEY: 'k', GOOGLE_API_KEY: 'x', DESK_DICTATE_MERGE_MODEL: 'test/fast', DESK_DICTATE_SOURCES: 'mai,openai,groq' }, fetchImpl: async (url, opts) => {
    const u = String(url);
    if (u.includes('groq')) return Response.json({ text: 'Hallo Karpati wie geht es' });
    if (u.includes('audio/transcriptions') && u.includes('openrouter')) return Response.json({ text: 'Hallo Karpathy, wie geht es?', usage: { seconds: 1 } });
    if (u.includes('openai.com')) return new Promise(() => {});
    if (u.includes('chat/completions')) { merged = JSON.parse(opts.body); return Response.json({ choices: [{ message: { content: 'Hallo\u00a0Karpathy, wie\u2011geht es?' } }] }); }
    throw Error(`unexpected ${u}`);
  } });
  const t = Date.now();
  const r = await media.dictate(wav(2), ctx, { items: [{ term: 'Karpathy', replace_from: ['Karpati', 'unrelated'] }, ...Array.from({ length: 400 }, (_, i) => ({ term: `Wort${i}` }))] });
  assert(Date.now() - t < 900, `took ${Date.now() - t} ms`);
  assert.equal(merged.model, 'test/fast'); assert.deepEqual(merged.reasoning, { effort: 'low', exclude: true });
  assert.match(merged.messages[0].content, /bereinigst ein Diktat/); assert.equal(merged.messages[0].role, 'system');
  const prompt = merged.messages[1].content; assert.match(prompt, /"glossar":/);
  assert.match(prompt, /"ersetze":\{"Karpathy":\["Karpati"\]\}/); assert(!prompt.includes('unrelated')); assert(!prompt.includes('Wort200'));
  assert.equal(r.text, 'Hallo Karpathy, wie-geht es?'); assert.equal(r.merged, true); assert.equal(r.sources.openai, null);
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
  const none = await media.dictate(wav(), ctx, { items: [{ term: 'Example' }, { term: 'Begriff' }, { term: 'Wort' }] });
  assert.equal(none.text, ''); assert.equal(none.silent, true); assert.equal(none.providers.groq.reason, 'empty'); // the only recogniser heard no words: an answer, not an outage
  const real = createDeviceMedia({ env: { GROQ_API_KEY: 'g' }, fetchImpl: async () => Response.json({ text: 'Example' }) });
  assert.equal((await real.dictate(wav(), ctx, { items: [{ term: 'Example' }] })).text, 'Example');
});

// ---- 10 Nov 2026: the recogniser set, the no-speech verdict, the word guard on the merge ----
const allKeys = { OPENROUTER_API_KEY: 'k', OPENAI_API_KEY: 'o', ELEVENLABS_API_KEY: 'e', GROQ_API_KEY: 'g', GOOGLE_API_KEY: 'x' };
/** One fake for every provider: texts by source name; a missing name hangs. Records who was called and with what. */
function world(texts, merge = null) {
  const calls = [], bodies = {};
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    let name;
    if (u.includes('chat/completions')) { calls.push('merge'); return merge === null ? new Response('{}', { status: 502 }) : Response.json({ choices: [{ message: { content: typeof merge === 'function' ? merge(JSON.parse(opts.body)) : merge } }] }); }
    if (u.includes('openrouter')) { const b = JSON.parse(opts.body); name = b.model.includes('mai-transcribe') ? 'mai' : b.model.includes('assemblyai') ? 'assembly' : b.model.includes('voxtral') ? 'voxtral' : b.model; bodies[name] = b; }
    else if (u.includes('elevenlabs')) { name = 'scribe'; bodies.scribe = opts.body; }
    else if (u.includes('groq')) { name = 'groq'; bodies.groq = opts.body; }
    else if (u.includes('openai.com')) { name = 'openai'; bodies.openai = opts.body; }
    else if (u.includes('generateContent')) name = 'gemini';
    calls.push(name);
    if (!(name in texts)) return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }))));
    if (typeof texts[name] === 'number') return new Response('{}', { status: texts[name] });
    return name === 'gemini' ? gemini(texts[name]) : Response.json({ text: texts[name], usage: { seconds: 1, cost: 0.0001 } });
  };
  return { calls, bodies, fetchImpl };
}
it('three recognisers hear a dictation: MAI, gpt-transcribe and AssemblyAI; Whisper and Gemini are the reserve and stay silent when those answer', async () => {
  const w = world({ mai: 'Hallo Welt, das ist ein Test', openai: 'Hallo Welt das ist ein Test', assembly: 'Hallo Welt das ist ein Test.' }, 'Hallo Welt, das ist ein Test.');
  const r = await createDeviceMedia({ env: allKeys, fetchImpl: w.fetchImpl }).dictate(wav(), ctx, {});
  assert.deepEqual(w.calls.filter(c => c !== 'merge').sort(), ['assembly', 'mai', 'openai']);
  assert.equal(w.bodies.openai.get('model'), 'gpt-transcribe'); assert.equal(w.bodies.assembly.model, 'assemblyai/universal-3-6-pro'); assert.equal(w.bodies.mai.model, 'microsoft/mai-transcribe-2');
  assert.equal(r.text, 'Hallo Welt, das ist ein Test.'); assert.equal(r.merged, true); assert.equal(r.degraded, false);
  assert.deepEqual(Object.keys(r.providers).sort(), ['assembly', 'gemini', 'groq', 'mai', 'merge', 'openai']);
  assert.equal(r.providers.groq.reason, 'skipped'); assert.equal(r.providers.gemini.reason, 'skipped');
});
it('the set follows the keys and DESK_DICTATE_SOURCES: Scribe with key terms, Whisper turbo as the third voice when one is not configured', async () => {
  const a = world({ openai: 'Guten Morgen zusammen', scribe: 'Guten Morgen zusammen', groq: 'Guten Morgen zusammen' });
  await createDeviceMedia({ env: { OPENAI_API_KEY: 'o', ELEVENLABS_API_KEY: 'e', GROQ_API_KEY: 'g' }, fetchImpl: a.fetchImpl }).dictate(wav(), ctx, { items: [{ term: 'Karpathy' }] });
  assert.deepEqual(a.calls.sort(), ['groq', 'openai', 'scribe']);
  assert.equal(a.bodies.groq.get('model'), 'whisper-large-v3-turbo'); assert.equal(a.bodies.scribe.get('model_id'), 'scribe_v2'); assert.equal(a.bodies.scribe.get('language_code'), 'deu');
  const terms = a.bodies.scribe.getAll('keyterms'); assert.equal(terms[0], 'Karpathy'); assert(terms.includes('JevBench')); assert(terms.length <= 100);
  const b = world({ scribe: 'Nur einer', voxtral: 'Nur einer' });
  const r = await createDeviceMedia({ env: { ...allKeys, DESK_DICTATE_SOURCES: 'scribe, voxtral, unknown', DESK_DICTATION_TERMS_EXTRA: 'Beispiel GmbH' }, fetchImpl: b.fetchImpl }).dictate(wav(), ctx, {});
  assert.deepEqual(b.calls.filter(c => c !== 'merge').sort(), ['scribe', 'voxtral']); assert.equal(r.text, 'Nur einer');
  assert(b.bodies.scribe.getAll('keyterms').includes('Beispiel GmbH'), 'private names reach the recogniser');
  const retry = []; // a 4xx with key terms is retried once without
  const s = createDeviceMedia({ env: { ELEVENLABS_API_KEY: 'e' }, fetchImpl: async (_u, opts) => { retry.push(opts.body.getAll('keyterms').length); return retry.length === 1 ? new Response('{}', { status: 422 }) : Response.json({ text: 'Ohne Begriffe' }); } });
  assert.equal((await s.dictate(wav(), ctx, {})).text, 'Ohne Begriffe'); assert(retry[0] > 0); assert.equal(retry[1], 0);
});
it('no speech is an answer, not an outage: two recognisers that heard nothing end it at once, without the reserve', async () => {
  const w = world({ mai: '', openai: '', assembly: '', groq: 'Vielen Dank fürs Zuschauen.', gemini: 'Untertitel der Amara-Community' });
  const t = Date.now(), r = await createDeviceMedia({ env: allKeys, fetchImpl: w.fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(r.text, ''); assert.equal(r.silent, true); assert.equal(r.degraded, false); assert(Date.now() - t < 1000, 'no wait for the reserve');
  assert(!w.calls.includes('groq') && !w.calls.includes('gemini') && !w.calls.includes('merge'));
  // one says a word, two heard nothing: the two are right
  const lone = world({ mai: 'Okay.', openai: '', assembly: '' });
  const r2 = await createDeviceMedia({ env: allKeys, fetchImpl: lone.fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(r2.text, ''); assert.equal(r2.silent, true); assert.equal(r2.providers.mai.dropped, 'noise');
});
it('a few words nobody agrees on in a quiet clip are noise; the same words agreed on, or a loud clip, are his', async () => {
  const quiet = pcmQuiet(2);
  const noise = world({ mai: 'Okay.', openai: 'Ja.', assembly: '' });
  const r = await createDeviceMedia({ env: allKeys, fetchImpl: noise.fetchImpl }).dictate(quiet, ctx, {});
  assert.equal(r.text, ''); assert.equal(r.silent, true); assert(!noise.calls.includes('merge'));
  const agreed = world({ mai: 'Okay.', openai: 'Okay', assembly: '' }, 'Okay.');
  assert.equal((await createDeviceMedia({ env: allKeys, fetchImpl: agreed.fetchImpl }).dictate(quiet, ctx, {})).text, 'Okay.');
  const loud = world({ mai: 'Ja genau', openai: 'Jawohl', assembly: 'Ja genau.' }, 'Ja genau.');
  assert.equal((await createDeviceMedia({ env: allKeys, fetchImpl: loud.fetchImpl }).dictate(wav(), ctx, {})).text, 'Ja genau.');
  assert.equal(wavPeak(wav()), 8000); assert.equal(wavPeak(quiet), 300);
});
it('providers that fail are still an outage: the reserve runs and an error says so', async () => {
  const w = world({ mai: 503, openai: 500, assembly: 502, groq: 'Die Reserve hat es gehört' });
  const r = await createDeviceMedia({ env: allKeys, geminiFallbackMs: 20, fetchImpl: w.fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(r.text, 'Die Reserve hat es gehört'); assert.equal(r.degraded, true); assert(w.calls.includes('groq'));
  const dead = world({ mai: 503, openai: 500, assembly: 502, groq: 500, gemini: 500 });
  await assert.rejects(createDeviceMedia({ env: allKeys, geminiFallbackMs: 20, fetchImpl: dead.fetchImpl }).dictate(wav(), ctx, {}), e => e.status === 502 && e.code === 'all-providers-failed');
});
it('a chunk while he still talks waits for every recogniser; the last one goes when two are in', async () => {
  const slow = { mai: 'Erster Teil vom Satz', openai: 'Erster Teil vom Satz' };
  const mk = () => { const w = world(slow, 'Erster Teil vom Satz'); const inner = w.fetchImpl; w.fetchImpl = async (url, opts) => { if (String(url).includes('assemblyai') || (typeof opts.body === 'string' && opts.body.includes('assemblyai'))) { await new Promise(r => setTimeout(r, 250)); return Response.json({ text: 'Erster Teil vom Satz.' }); } return inner(url, opts); }; return w; };
  const last = await createDeviceMedia({ env: allKeys, graceMs: 20, fetchImpl: mk().fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(last.sources.assembly, null, 'the last chunk does not wait for the third');
  const mid = await createDeviceMedia({ env: allKeys, graceMs: 20, fetchImpl: mk().fetchImpl }).dictate(wav(), ctx, {}, { patient: true });
  assert.equal(mid.sources.assembly, 'Erster Teil vom Satz.'); assert(mid.ms >= 240);
});
it('the merge passes the word guard: what no recogniser heard is undone and counted, the rest of the clean-up stands', async () => {
  const w = world({ mai: 'Wir wollen die Kunden. Verbessern und fragen wieso das so ist', openai: 'Wir wollen die Kunden verbessern und fragen, wieso das so ist', assembly: 'Wir wollen die Kunden verbessern und fragen wieso das so ist.' },
    'Wir möchten unbedingt die Kunden verbessern und fragen, warum das so ist.');
  const r = await createDeviceMedia({ env: allKeys, fetchImpl: w.fetchImpl }).dictate(wav(4), ctx, {});
  assert.equal(r.text, 'Wir wollen die Kunden verbessern und fragen wieso das so ist.'); assert.equal(r.merged, true); assert.equal(r.providers.merge.undone, 2); // next to an undone change the source's own punctuation stays
});
it('a 200 without a transcript is an outage, not "he said nothing"; and with no key for the named sources whatever has one hears him', async () => {
  const fetchImpl = async (url) => { const u = String(url); if (u.includes('groq')) return Response.json({ text: 'Die Reserve hat ihn gehört' }); if (u.includes('openai.com')) return new Response('{}', { status: 500 }); return Response.json({ error: { message: 'upstream busy' } }); };
  const r = await createDeviceMedia({ env: allKeys, geminiFallbackMs: 2000, fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(r.text, 'Die Reserve hat ihn gehört'); assert.notEqual(r.silent, true); assert.equal(r.providers.mai.reason, 'bad-reply'); assert.equal(r.providers.assembly.reason, 'bad-reply');
  assert(r.ms < 1000, 'the reserve starts as soon as every source has ended without words, not after the fallback wait');
  const w = world({ groq: 'Nur Groq hat einen Schlüssel' });
  const only = await createDeviceMedia({ env: { GROQ_API_KEY: 'g', DESK_DICTATE_SOURCES: 'mai,openai' }, fetchImpl: w.fetchImpl }).dictate(wav(), ctx, {});
  assert.equal(only.text, 'Nur Groq hat einen Schlüssel'); assert.deepEqual(w.calls, ['groq']);
});
it('after the soft limit the first recogniser with words ends the wait, not the last one to give up', async () => {
  const fetchImpl = async (url, opts) => { const u = String(url); if (u.includes('openai.com')) { await new Promise(r => setTimeout(r, 2100)); return Response.json({ text: 'Spät, aber da' }); } return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))); };
  const t = Date.now(), r = await createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', OPENAI_API_KEY: 'o' }, fetchImpl }).dictate(wav(2), ctx, {});
  assert.equal(r.text, 'Spät, aber da'); assert(Date.now() - t < 3500, `took ${Date.now() - t} ms`);
});
