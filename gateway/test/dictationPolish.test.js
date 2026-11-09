import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, polishWindows, keptWords, withGlossaryTerms } from '../src/deviceMedia.js';
import { DICTATION_GLOSSARY, dictationGlossary, contentWords, FINAL_PROMPT, LIVE_PROMPT } from '../src/dictationContext.js';

const answer = content => Response.json({ choices: [{ message: { content } }] });
const sentence = (n, word = 'wort') => `${Array.from({ length: n - 1 }, (_, i) => `${word}${i}`).join(' ')} ende.`;

it('the glossary explains his world, stays public-safe and takes a private extension from the environment', () => {
  for (const t of ['JevBench', 'REAX', 'SN92', 'Bittensor', 'decisionmodels.io', 'Claude Code', 'Sandy', 'LeChonk']) assert(DICTATION_GLOSSARY.includes(t), t);
  assert(DICTATION_GLOSSARY.length < 4500);
  assert.equal(dictationGlossary({}), DICTATION_GLOSSARY);
  assert.match(dictationGlossary({ DESK_DICTATION_CONTEXT_EXTRA: 'Kunde Beispiel GmbH' }), /Weitere Namen aus seinem Umfeld: Kunde Beispiel GmbH$/);
  assert(dictationGlossary({ DESK_DICTATION_CONTEXT_EXTRA: 'x'.repeat(9000) }).length < DICTATION_GLOSSARY.length + 2500);
});
it('fillers do not count as his words', () => {
  assert.deepEqual(contentWords('Äh, ich ähm meine hm das'), ['ich', 'meine', 'das']);
});
it('dictionary words come first, then the glossary names, without duplicates', () => {
  const list = withGlossaryTerms({ items: [{ term: 'jevbench' }, { term: 'Karpathy' }] }).items.map(e => e.term);
  assert.deepEqual(list.slice(0, 2), ['jevbench', 'Karpathy']); assert(!list.includes('JevBench')); assert(list.includes('LeChonk'));
});
it('windows end at a sentence and are about 90 words; a short rest joins the last window', () => {
  const text = [sentence(95), sentence(95), sentence(10)].join(' ');
  const w = polishWindows(text);
  assert.equal(w.length, 2); assert(w.every(x => x.endsWith('ende.'))); assert.equal(w.join(' '), text);
  assert.equal(polishWindows('ohne satzende '.repeat(100)).length, 2, 'hard cut at 1.6 x');
});
it('a clean-up that drops or invents too much is not his text', () => {
  const before = 'Wir wollen Sichtbarkeit gegenüber potenzieller Kunden. Verbessern und es allen schmackhaft machen.';
  assert(keptWords(before, 'Wir wollen die Sichtbarkeit gegenüber potenziellen Kunden verbessern und es allen schmackhaft machen.'));
  assert(!keptWords(before, 'Mehr Sichtbarkeit.'));
  assert(!keptWords(before, ''));
  assert(!keptWords(before, 'Ganz andere Wörter stehen hier jetzt drin, gar nichts davon passt mehr zusammen.'));
});
it('final: windows run side by side with the end of the previous window; a failed or unfaithful window stays as it was', async () => {
  const seen = [];
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => {
    assert(String(url).includes('chat/completions'));
    const body = JSON.parse(opts.body); seen.push(body);
    assert.equal(body.messages[0].content, FINAL_PROMPT);
    const data = JSON.parse(body.messages[1].content.replace(/^<artifact_data>\n|\n<\/artifact_data>$/g, ''));
    assert(data.glossar.includes('JevBench'));
    if (data.diktat.startsWith('b')) return answer('Kurz.');               // drops his words: rejected
    if (data.diktat.startsWith('c')) return new Response('{}', { status: 502 });
    return answer(data.diktat.replace('wort0', 'Wort0'));
  } });
  const text = [sentence(95, 'a'), sentence(95, 'b'), sentence(95, 'c')].join(' ').replace('a0', 'wort0');
  const r = await media.polish(text, { process: 'Code', fieldBefore: 'Davor steht das.' }, { mode: 'final', dictionary: { items: [{ term: 'Ende', replace_from: ['ende'] }] } });
  assert.equal(seen.length, 3); assert.equal(r.windows, 3); assert.equal(r.changed, 1); assert.equal(r.failed, 2);
  assert(r.text.startsWith('Wort0 a1')); assert(r.text.includes('b1 b2')); assert(r.text.includes('c1 c2')); assert(r.text.endsWith('Ende.'), 'dictionary corrections still apply');
  const first = JSON.parse(seen.find(b => b.messages[1].content.includes('"diktat":"Wort0') || b.messages[1].content.includes('"diktat":"wort0')).messages[1].content.replace(/^<artifact_data>\n|\n<\/artifact_data>$/g, ''));
  assert.equal(first.davor, 'Davor steht das.');
  const second = seen.map(b => JSON.parse(b.messages[1].content.replace(/^<artifact_data>\n|\n<\/artifact_data>$/g, ''))).find(d => d.diktat.startsWith('b'));
  assert(second.davor.endsWith('a93 ende.') && second.davor.split(' ').length === 25);
});
it('final: a hung model does not hold the text: after the budget the windows stay as they were', async () => {
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: (_u, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(Error('t'), { name: 'TimeoutError' })))) });
  const t = Date.now(), r = await media.polish('Hallo Welt, das ist ein Test.', {}, { mode: 'final', timeoutMs: 80 });
  assert(Date.now() - t < 500); assert.equal(r.text, 'Hallo Welt, das ist ein Test.'); assert.equal(r.failed, 1);
});
it('live: one fast call with the live prompt, on the caption ledger; without a key 503', async () => {
  let body;
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => { body = JSON.parse(opts.body); return answer('über die Use Buttons in JevBench'); } });
  const r = await media.polish('über die Use Buttons in Jeff Bench', {}, { mode: 'live', deviceId: 'd-live-test' });
  assert.equal(body.messages[0].content, LIVE_PROMPT); assert.equal(body.max_tokens, 900);
  assert.equal(r.text, 'über die Use Buttons in JevBench'); assert.equal(r.changed, 1);
  await assert.rejects(createDeviceMedia({ env: {} }).polish('x', {}, { mode: 'live' }), e => e.status === 503 && e.code === 'no-key');
  assert.deepEqual(await createDeviceMedia({ env: {} }).polish('  ', {}, { mode: 'final' }), { text: '', ms: 0, windows: 0, changed: 0, failed: 0 });
});
