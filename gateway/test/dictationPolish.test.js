import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceMedia, polishWindows, keptWords, withGlossaryTerms, carryBreaks, guardTerms } from '../src/deviceMedia.js';
import { DICTATION_GLOSSARY, dictationGlossary, contentWords, privateTerms, FINAL_PROMPT, FORMAT_PROMPT, LIVE_PROMPT } from '../src/dictationContext.js';

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
const dataOf = body => JSON.parse(body.messages[1].content.replace(/^<artifact_data>\n|\n<\/artifact_data>$/g, ''));
it('final: windows run side by side, each with the last words of the one before it; a failed or unfaithful window stays as it was', async () => {
  const seen = [];
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (url, opts) => {
    assert(String(url).includes('chat/completions'));
    const body = JSON.parse(opts.body); seen.push(body);
    assert.equal(body.messages[0].content, FINAL_PROMPT);
    const data = dataOf(body);
    assert(data.glossar.includes('JevBench'));
    if (data.diktat.includes(' b0 ')) return answer('Kurz.');               // drops his words: rejected
    if (data.diktat.includes(' c0 ')) return new Response('{}', { status: 502 });
    return answer(data.diktat.replace('wort0', 'Wort0'));
  } });
  const text = [sentence(95, 'a'), sentence(95, 'b'), sentence(95, 'c')].join(' ').replace('a0', 'wort0');
  const r = await media.polish(text, { process: 'Code', fieldBefore: 'Davor steht das.' }, { mode: 'final', dictionary: { items: [{ term: 'Ende', replace_from: ['ende'] }] } });
  assert.equal(seen.length, 3); assert.equal(r.windows, 3); assert.equal(r.changed, 1); assert.equal(r.failed, 2); assert.equal(r.breaks, 0);
  assert(r.text.startsWith('Wort0 a1')); assert(r.text.includes('b1 b2')); assert(r.text.includes('c1 c2')); assert(r.text.endsWith('Ende.'), 'dictionary corrections still apply');
  assert.equal(r.text.split(' ').length, text.split(' ').length, 'the overlap is taken out again: every word once');
  const all = seen.map(dataOf), first = all.find(d => d.diktat.toLowerCase().startsWith('wort0')), second = all.find(d => d.diktat.includes(' b0 '));
  assert.equal(first.davor, 'Davor steht das.'); assert.equal(first.danach.split(' ').length, 12); assert(first.danach.startsWith('b0 b1'));
  assert(second.diktat.startsWith('a85 '), 'the last ten words of the window before lead the next one'); assert(second.diktat.includes('a93 ende. b0 b1'));
  assert(second.davor.endsWith('a84') && second.davor.split(' ').length === 25);
});
it('final: the word guard undoes a rewording inside a window and counts it', async () => {
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => answer(dataOf(JSON.parse(opts.body)).diktat.replace('wieso wir', 'warum wir').replace('Kunden. Verbessern', 'Kunden verbessern')) });
  const r = await media.polish('Wir wollen die Kunden. Verbessern und fragen, wieso wir das nicht früher getan haben.', {}, { mode: 'final' });
  assert.equal(r.text, 'Wir wollen die Kunden verbessern und fragen, wieso wir das nicht früher getan haben.'); assert.equal(r.undone, 1); assert.equal(r.changed, 1);
});
const para = n => Array.from({ length: n }, (_, i) => `Das ist der Satz Nummer ${i + 1} mit ein paar Wörtern.`).join(' ');
it('format: the model only names sentence numbers; line breaks land between sentences and the words stay the same', async () => {
  const calls = [];
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    if (body.messages[0].content === FORMAT_PROMPT) { assert.match(body.messages[1].content, /^\[1\] Das ist der Satz Nummer 1/); assert.equal(body.max_tokens, 300); return answer('{"absatz":[4],"zeile":[6]}'); }
    return answer(dataOf(body).diktat);
  } });
  const text = para(7);
  const r = await media.polish(text, {}, { mode: 'final', format: true });
  assert.equal(calls.length, 2, 'the clean-up and the structure run side by side');
  assert.equal(r.breaks, 2); assert(r.text.includes('Nummer 3 mit ein paar Wörtern.\n\nDas ist der Satz Nummer 4')); assert(r.text.includes('Wörtern.\nDas ist der Satz Nummer 6'));
  assert.equal(r.text.replace(/\s+/g, ' '), text); assert(!/[#*•]/.test(r.text));
  const only = await media.polish(text, {}, { mode: 'format' });
  assert.equal(only.windows, 0); assert.equal(only.breaks, 2); assert.equal(only.text.replace(/\s+/g, ' '), text);
  const plain = await media.polish(text, {}, { mode: 'final' });
  assert(!plain.text.includes('\n'), 'without format: one line, as before');
});
it('format: a short text, a late model or a nonsense answer leave the text one block', async () => {
  let calls = 0;
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async (_u, opts) => { calls += 1; const body = JSON.parse(opts.body); return answer(body.messages[0].content === FORMAT_PROMPT ? '{"absatz":[2,3,4,5,6,7]}' : dataOf(body).diktat); } });
  assert.equal((await media.polish(para(7), {}, { mode: 'format' })).text, para(7), 'a break before every sentence is not light structure');
  const before = calls;
  assert.equal((await media.polish('Kurzer Text. Nur zwei Sätze.', {}, { mode: 'format' })).text, 'Kurzer Text. Nur zwei Sätze.'); assert.equal(calls, before, 'no call for a short text');
  const down = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => new Response('{}', { status: 502 }) });
  assert.equal((await down.polish(para(7), {}, { mode: 'format' })).text, para(7));
});
it('format: a break chosen on the raw text only lands where the cleaned text really ends a sentence', () => {
  const raw = 'Wir wollen die Kunden. Verbessern und mehr. Dann kommt das Nächste. Und noch eins.';
  const cleaned = 'Wir wollen die Kunden verbessern und mehr. Dann kommt das Nächste. Und noch eins.';
  assert.equal(carryBreaks(raw, cleaned, { para: [2, 3], line: [] }), 'Wir wollen die Kunden verbessern und mehr.\n\nDann kommt das Nächste. Und noch eins.');
  assert.equal(carryBreaks(raw, cleaned, { para: [], line: [] }), cleaned); assert.equal(carryBreaks(raw, cleaned, null), cleaned);
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
it('private names come from the environment only: into the recogniser hints and the guard, never into the repository', () => {
  const env = { DESK_DICTATION_TERMS_EXTRA: 'Beispiel GmbH, Musterkunde;Musterkunde\nX' + 'y'.repeat(80), DESK_DICTATION_CONTEXT_EXTRA: 'Kunden: Nordwind AG (gesprochen "Nordwind").' };
  assert.deepEqual(privateTerms(env), ['Beispiel GmbH', 'Musterkunde']); assert.deepEqual(privateTerms({}), []);
  const list = withGlossaryTerms({ items: [{ term: 'Eigenes' }] }, privateTerms(env)).items.map(e => e.term);
  assert.deepEqual(list.slice(0, 3), ['Eigenes', 'Beispiel GmbH', 'Musterkunde']); assert(list.includes('JevBench'));
  const keys = guardTerms({ items: [{ term: 'Eigenes' }] }, env);
  for (const k of ['beispielgmbh', 'musterkunde', 'nordwind', 'eigenes', 'jevbench', 'lechonk', 'sn92']) assert(keys.has(k), k);
  assert(!keys.has('gründer'), 'ordinary words of the glossary are not names');
});
it('format: the lines of a spoken list land before "erstens", "zweitens" although no sentence ends there; a start inside a changed run gets no break', () => {
  const raw = 'Wir machen heute drei Dinge, erstens schreiben wir den Text, zweitens prüfen wir ihn, drittens liefern wir alles aus. Danach ist Schluss für heute.';
  assert.equal(carryBreaks(raw, raw, { para: [], line: [2, 3, 4] }), 'Wir machen heute drei Dinge,\nerstens schreiben wir den Text,\nzweitens prüfen wir ihn,\ndrittens liefern wir alles aus. Danach ist Schluss für heute.');
  const cleaned = raw.replace('prüfen wir ihn', 'prüfen wir ihn genau');
  assert.equal(carryBreaks(raw, cleaned, { para: [5], line: [2, 3, 4] }), 'Wir machen heute drei Dinge,\nerstens schreiben wir den Text,\nzweitens prüfen wir ihn genau,\ndrittens liefern wir alles aus.\n\nDanach ist Schluss für heute.');
  // the start of sentence 3 was rewritten: no position, no break (never one sentence early)
  assert.equal(carryBreaks('Punkt eins ist fertig. Jeff Bench leuft. Scream Agent ist das nächste Thema.', 'Punkt eins ist fertig. JevBench läuft. Screen Agent ist das nächste Thema.', { para: [3], line: [] }), 'Punkt eins ist fertig. JevBench läuft. Screen Agent ist das nächste Thema.');
  assert.equal(carryBreaks('Wir liefern am 3. Mei. Dan sehen wir weiter.', 'Wir liefern am 3. Mai, dann sehen wir weiter.', { para: [], line: [2] }), 'Wir liefern am 3. Mai, dann sehen wir weiter.');
});
