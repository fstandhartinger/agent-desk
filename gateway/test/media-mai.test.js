import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeviceMedia, dictationBudgetMs, phraseList, pcmToWav, wavDuration } from '../src/deviceMedia.js';
import { limits } from '../src/limits.js';

const wav = (seconds = 1) => pcmToWav(Buffer.alloc(seconds * 32000));
const ctx = { process: 'fake', fieldBefore: '', visibleIds: [], recentTerms: [], titles: ['Lock the Engine REAX 1.3', 'JevBench Rangliste'] };
const dict = { items: [{ term: 'Karpathy', replace_from: ['Karpati'] }, { term: 'Bittensor', replace_from: ['Bit Tensor'] }] };
const mai = (text, extra = {}) => Response.json({ text, usage: { seconds: 1, cost: 0.0000278 }, ...extra });
const isMai = (url) => String(url).includes('openrouter');

describe('MAI-Transcribe-2 as a dictation source', () => {
  it('sends the documented JSON with dictionary terms and title words as phrases (never replace_from) and reports providers', async () => {
    let seen;
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => { assert(isMai(url)); assert.equal(opts.headers.authorization, 'Bearer k'); if (String(url).includes('chat/completions')) return Response.json({ choices: [{ message: { content: 'Hallo Karpathy.' } }] }); seen = JSON.parse(opts.body); return mai('Hallo Karpathy'); } });
    const r = await media.dictate(wav(), ctx, dict);
    assert.equal(seen.model, 'microsoft/mai-transcribe-2');
    assert.equal(seen.language, 'de');
    assert.equal(seen.input_audio.format, 'wav');
    assert.equal(Buffer.from(seen.input_audio.data, 'base64').length, wav().length);
    const phrases = seen.provider.options.azure.phraseList.phrases;
    assert.deepEqual(phrases.slice(0, 2), ['Karpathy', 'Bittensor']);
    for (const w of ['Lock', 'Engine', 'REAX', 'JevBench', 'Rangliste']) assert(phrases.includes(w), w);
    assert(!phrases.includes('Karpati') && !phrases.includes('Bit Tensor'));
    assert.equal(r.text, 'Hallo Karpathy.', 'one source is cleaned up too');
    assert.equal(r.sources.mai, 'Hallo Karpathy');
    assert.equal(r.providers.mai.ok, true);
    assert.equal(typeof r.providers.mai.ms, 'number');
    assert.equal(r.merged, true); assert.equal(r.seconds, 1);
    assert.equal(r.degraded, false, 'one configured provider and it worked');
  });

  it('merges with the other sources and says so; one failed provider shows reason and status, degraded when fewer than two are usable', async () => {
    const media = createDeviceMedia({ geminiFallbackMs: 0, env: { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'g', GOOGLE_API_KEY: 'x' }, fetchImpl: async (url, opts) => {
      if (String(url).includes('chat/completions')) return Response.json({ choices: [{ message: { content: 'Hallo Welt!' } }] });
      if (isMai(url)) return mai('Hallo Welt');
      if (String(url).includes('groq')) return new Response('{}', { status: 503 });
      const text = JSON.parse(opts.body).contents[0].parts[0].text;
      return Response.json({ candidates: [{ content: { parts: [{ text: text?.includes('Erstelle EIN') ? 'Nicht dieser Weg' : 'Hallo Wält' }] } }] });
    } });
    const r = await media.dictate(wav(), ctx, dict);
    assert.equal(r.text, 'Hallo Welt!'); assert.equal(r.merged, true); assert.equal(r.degraded, false);
    assert.deepEqual(r.providers.groq, { ok: false, ms: r.providers.groq.ms, status: 503, reason: 'upstream' });
    assert.equal(r.providers.merge.ok, true);
    const only = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', GROQ_API_KEY: 'g' }, fetchImpl: async url => (isMai(url) ? mai('Hallo') : new Response('{}', { status: 500 })) });
    const r2 = await only.dictate(wav(), ctx, dict);
    assert.equal(r2.degraded, true); assert.equal(r2.merged, false);
  });

  it('a 4xx with a phrase list is retried once without the list and the retry is reported', async () => {
    const bodies = [];
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => { if (String(url).includes('chat/completions')) return Response.json({ choices: [{ message: { content: 'Ohne Liste' } }] }); const b = JSON.parse(opts.body); bodies.push(b); return b.provider ? new Response('{"error":"too long"}', { status: 400 }) : mai('Ohne Liste'); } });
    const r = await media.dictate(wav(), ctx, dict);
    assert.equal(bodies.length, 2); assert.equal(bodies[1].provider, undefined);
    assert.equal(r.text, 'Ohne Liste'); assert.equal(r.providers.mai.retried, true);
    const auth = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => new Response('{}', { status: 401 }) });
    await assert.rejects(auth.dictate(wav(), ctx, dict), e => e.code === 'all-providers-failed' && e.providers.mai.status === 401, '401 is not retried');
  });

  it('all providers failing: code, per-provider reasons and status, 502 for upstream errors and 504 for timeouts', async () => {
    const down = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k', OPENAI_API_KEY: 'o' }, fetchImpl: async url => new Response('private-body', { status: isMai(url) ? 502 : 429 }) });
    await assert.rejects(down.dictate(wav(), ctx, dict), e => {
      assert.equal(e.status, 502); assert.equal(e.code, 'all-providers-failed');
      assert.equal(e.providers.mai.status, 502); assert.equal(e.providers.openai.status, 429);
      assert.deepEqual(e.body, { error: e.message, code: 'all-providers-failed', providers: e.providers });
      assert(!JSON.stringify(e.body).includes('private-body'));
      return true;
    });
    const slow = createDeviceMedia({ budgetMs: 30, env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: () => new Promise(() => {}) });
    await assert.rejects(slow.dictate(wav(), ctx, dict), e => e.status === 504 && e.providers.mai.reason === 'timeout');
    await assert.rejects(createDeviceMedia({ env: {} }).dictate(wav(), ctx, dict), e => e.status === 503 && e.code === 'no-provider');
  });

  it('the budget scales with the audio: 4 s up to 45 s', () => {
    assert.equal(dictationBudgetMs(0), 4000); assert.equal(dictationBudgetMs(1), 4700);
    assert.equal(dictationBudgetMs(10), 11000); assert.equal(dictationBudgetMs(30), 25000); assert.equal(dictationBudgetMs(60), 45000);
  });

  it('a long clip gets time a short one would not: 6 s provider on 20 s audio works', async () => {
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => { await new Promise(r => setTimeout(r, 30)); return mai('lang '.repeat(10)); } });
    assert.match((await media.dictate(wav(20), ctx, dict)).text, /lang/);
  });

  it('Gemini failures keep the provider status (never the body) for the log', async () => {
    const media = createDeviceMedia({ env: { GOOGLE_API_KEY: 'x' }, fetchImpl: async () => new Response('secret detail', { status: 429 }) });
    await assert.rejects(media.highlight(Buffer.from('c'), null, {}, []), e => e.status === 502 && !e.message.includes('secret'));
    await assert.rejects(media.vision(Buffer.from('j'), { process: 'p', title: 't' }, null), e => e.upstream === 429 && !JSON.stringify(e).includes('secret'));
  });
});

describe('phraseList', () => {
  it('dictionary first, then title words, unique, at most 200, long entries dropped', () => {
    const items = Array.from({ length: 300 }, (_, i) => ({ term: `Term${i}`, replace_from: [`x${i}`] }));
    const list = phraseList({ items }, ['Alpha Beta', 'alpha Gamma'], ['Extra']);
    assert(list.length <= 200); assert.equal(list[0], 'Term0');
    assert(!list.includes('x0'));
    assert.equal(list.filter(p => p.toLowerCase() === 'alpha').length, 1);
    const small = phraseList({ items: [{ term: 'A'.repeat(101) }, { term: 'Ok' }] }, ['Titel Wort']);
    assert.deepEqual(small, ['Ok', 'Titel', 'Wort']);
  });
});

describe('caption (MAI only)', () => {
  it('returns text, ms and seconds, meters the real cost into the daily cap, and times out at 3 s', async () => {
    const before = limits.costToday(), capBefore = limits.captionToday();
    let signal;
    const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => { signal = opts.signal; return Response.json({ text: ' Guten Tag ', usage: { seconds: 2, cost: 0.01 } }); } });
    const r = await media.caption(wav(2), ['Karpathy'], 'dev-cost');
    assert.equal(r.text, 'Guten Tag'); assert.equal(r.seconds, 2); assert.equal(typeof r.ms, 'number');
    assert.ok(Math.abs(limits.captionToday() - capBefore - 0.01) < 1e-9, 'metered into the caption ledger');
    assert.equal(limits.costToday(), before, 'not into the shared daily cap');
    assert(signal instanceof AbortSignal);
  });
  it('503 with a code when the key is missing or MAI is down; the status of the provider rides along', async () => {
    await assert.rejects(createDeviceMedia({ env: {} }).caption(wav(), []), e => e.status === 503 && e.code === 'no-key');
    await assert.rejects(createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => new Response('x', { status: 500 }) }).caption(wav(), []), e => e.status === 503 && e.code === 'mai-down' && e.upstream === 500);
  });
  it('pcmToWav makes a valid 16 kHz mono WAV', () => {
    assert.equal(wavDuration(pcmToWav(Buffer.alloc(64000))), 2);
  });
});
