import assert from 'node:assert/strict';
import { it } from 'node:test';
import { guardText, variantContext, termKeys, spokenNumber, apart, sentences, worthFormatting, parseBreaks, applyBreaks, sameWords, stitchWindows, numbered } from '../src/dictationGuard.js';

// Synthetic sentences of the classes found in a day of real recordings (10 Nov 2026). No real names, customers or prompts in here: the repository is public.
const terms = termKeys(['JevBench', 'Claude Code', 'Beispiel GmbH', 'REAX', 'LeChonk']);
const guard = (a, b, ctx = {}) => guardText(a, b, { terms, ...ctx });

it('punctuation, capitals and joined or split compounds may change: the false sentence end at a thinking pause goes', () => {
  const r = guard('Wir wollen Sichtbarkeit gegenüber potenzieller Kunden. Verbessern und es allen schmackhaft machen.', 'Wir wollen Sichtbarkeit gegenüber potenzieller Kunden verbessern und es allen schmackhaft machen.');
  assert.equal(r.text, 'Wir wollen Sichtbarkeit gegenüber potenzieller Kunden verbessern und es allen schmackhaft machen.'); assert.equal(r.undone, 0);
  assert.equal(guard('in Hinsicht Kunden, Sichtbarkeit und SEO', 'in Hinsicht Kunden-Sichtbarkeit und SEO').text, 'in Hinsicht Kunden-Sichtbarkeit und SEO');
  assert.equal(guard('einen schönen Gesamt- Kontext', 'einen schönen Gesamtkontext').text, 'einen schönen Gesamtkontext');
  assert.equal(guard('ein Speech-to-Text Modell', 'ein Speech-to-Text-Modell').text, 'ein Speech-to-Text-Modell');
});
it('a misheard word may become its near miss, a name its proper spelling', () => {
  assert.equal(guard('zu viele zielschlagende Abfragen', 'zu viele fehlschlagende Abfragen').text, 'zu viele fehlschlagende Abfragen');
  assert.equal(guard('ersetze. Sieh durch diese neue', 'ersetze sie durch diese neue').text, 'ersetze sie durch diese neue');
  assert.equal(guard('die Use Buttons in Jeff Bench', 'die Use Buttons in JevBench').text, 'die Use Buttons in JevBench');
  assert.equal(guard('mit Cloud Code auf Le Schonk', 'mit Claude Code auf LeChonk').text, 'mit Claude Code auf LeChonk');
  assert.equal(guard('bei einem falsch formulierten Stelle', 'bei einer falsch formulierten Stelle').text, 'bei einer falsch formulierten Stelle');
});
it('synonyms, reordering and style edits are undone: his words stay', () => {
  const before = 'Leute, die ein Angebot mit hosted in EU suchen würden, und wieso wir dort irgendwas stellen könnten';
  const r = guard(before, 'Leute, die ein Angebot mit Hosting in der EU suchen, und warum wir dort etwas anbieten könnten');
  assert.match(r.text, /hosted in/); assert.match(r.text, /wieso/); assert.match(r.text, /suchen würden/); assert.match(r.text, /stellen könnten/); assert(r.undone >= 3);
  const moved = guard('Kunden, an die wir uns wenden könnten mit einem Angebot', 'Kunden, an die wir uns mit einem Angebot wenden könnten');
  assert.equal(moved.text, 'Kunden, an die wir uns wenden könnten mit einem Angebot');
  assert.equal(guard('und Umsatz und Auslastung und Gewinn', 'Umsatz, Auslastung und Gewinn').text.match(/und/g).length, 3, 'his "und ... und ... und" is not style to fix');
});
it('text that was not said never gets in: an echo of the context, an invented ending', () => {
  const r = guard('es wäre schön, wenn jeden Tag neue Ideen hereinkämen', 'Des Weiteren könnte ich mir vorstellen, dass es wäre schön, wenn jeden Tag neue Ideen hereinkämen. Vielen Dank fürs Zuschauen.');
  assert.equal(r.text, 'es wäre schön, wenn jeden Tag neue Ideen hereinkämen'); assert.equal(r.undone, 2);
});
it('digits stay the digits he spoke; the same number may be written differently', () => {
  assert.equal(guard('wie zum Beispiel GPT 6 Astra', 'wie zum Beispiel GPT-4 6 Astra').text, 'wie zum Beispiel GPT 6 Astra');
  assert.equal(guard('Opus fünf fünf und zweiundneunzig Kunden', 'Opus 5.5 und 92 Kunden').text, 'Opus 5.5 und 92 Kunden');
  assert.equal(guard('ab dem zwölften Mai 30 Stück', 'ab dem zwölften Mai 300 Stück').text, 'ab dem zwölften Mai 30 Stück');
  assert.equal(spokenNumber('zweiundneunzig'), '92'); assert.equal(spokenNumber('ein'), null); assert.equal(spokenNumber('sieben'), '7');
});
it('a negation never appears or disappears', () => {
  assert.equal(guard('Wir haben kein Geld und eine Idee', 'Wir haben ein Geld und keine Idee').text, 'Wir haben kein Geld und eine Idee');
  assert.equal(guard('das ist nicht gut', 'das ist gut').text, 'das ist nicht gut');
  assert.equal(guard('das ist gut', 'das ist nicht gut').text, 'das ist gut');
});
it('fillers, stutters and spoken self-corrections may go', () => {
  assert.equal(guard('das ist äh nicht gut und und wir machen das', 'das ist nicht gut und wir machen das').text, 'das ist nicht gut und wir machen das');
  assert.equal(guard('wir machen das am Montag, nein, ich meine am Dienstag fertig', 'wir machen das am Dienstag fertig').text, 'wir machen das am Dienstag fertig');
  assert.equal(guard('um gute Ideen zu finden', 'gute Ideen zu finden').text, 'um gute Ideen zu finden', '"um" is a word, not a filler');
  assert.equal(guard('ob ich einverstanden bin und sie abschicken', 'ob ich einverstanden bin und sie abschicken will').text, 'ob ich einverstanden bin und sie abschicken will', 'one small grammar word may be added');
  assert.equal(guard('ob ich einverstanden bin', 'ob ich wirklich einverstanden bin').text, 'ob ich einverstanden bin');
});
it('merge: a reading another recogniser heard at that place may be taken, and words only the source has may go', () => {
  const src = 'Lass uns bei Schmitt noch warten und dann gehen. Okay.';
  const ctx = variantContext(src, [src, 'Lass uns bei Schmidt noch ein bisschen warten und dann gehen.', 'Lass uns bei Schmidt noch bisschen warten und dann gehen']);
  assert.equal(guard(src, 'Lass uns bei Schmidt noch ein bisschen warten und dann gehen.', ctx).text, 'Lass uns bei Schmidt noch ein bisschen warten und dann gehen.');
  // what no recogniser heard stays out, also in a merge
  assert.equal(guard(src, 'Lass uns bei Schmidt noch sehr lange warten und dann gehen. Okay.', ctx).text, 'Lass uns bei Schmidt noch warten und dann gehen. Okay.');
  // a word from elsewhere in another variant is not "heard here"
  const far = variantContext('wir gehen heute los', ['wir gehen heute los', 'wir gehen heute nicht los']);
  assert.equal(guard('wir gehen heute los', 'wir nicht gehen heute los', far).text, 'wir gehen heute los');
  assert.equal(guard('wir gehen heute los', 'wir gehen heute nicht los', far).text, 'wir gehen heute nicht los');
});
it('an answer that is something else entirely leaves the source', () => {
  const src = 'Kannst du mir bitte sagen, wie viele Anfragen heute gekommen sind?';
  assert.equal(guard(src, 'Heute sind 14 Anfragen eingegangen, die meisten am Vormittag.').text, src);
  assert.equal(guard(src, '').text, src);
  assert(apart('wieso', 'warum') > 0.4); assert(apart('sieh', 'sie') <= 0.34);
});
it('sentences: cut after . ? ! and before spoken list marks, never inside an abbreviation or a number', () => {
  assert.deepEqual(sentences('Das ist eins. Und zwei? Ja z.B. das hier erstens gehen wir los zweitens kommen wir an.'), ['Das ist eins.', 'Und zwei?', 'Ja z.B. das hier', 'erstens gehen wir los', 'zweitens kommen wir an.']);
  assert.deepEqual(sentences('Punkt 3. ist offen. Version 1.3 läuft.'), ['Punkt 3. ist offen.', 'Version 1.3 läuft.']);
  assert(!worthFormatting('Kurzer Text. Zwei Sätze.')); assert(worthFormatting(Array.from({ length: 5 }, (_, i) => `Das ist Satz Nummer ${i} mit einigen weiteren Wörtern darin.`).join(' ')));
  assert.equal(numbered(['A.', 'B.']), '[1] A.\n[2] B.');
});
it('breaks: only sentence numbers count; too many or a bad answer means none; the words never change', () => {
  const list = ['Eins.', 'Zwei.', 'Drei.', 'Vier.', 'Fünf.', 'Sechs.'];
  assert.deepEqual(parseBreaks('{"absatz":[3],"zeile":[5]}', 6), { para: [3], line: [5] });
  assert.deepEqual(parseBreaks('Hier: {"absatz":[1,3,3,99,"4"],"zeile":[3,2]} fertig', 6), { para: [3], line: [2] }, 'sentence 1, out of range, strings and doubles are dropped');
  assert.equal(parseBreaks('{"absatz":[2,3,4],"zeile":[5,6]}', 6), null, 'more than one break per two sentences is not light structure');
  assert.equal(parseBreaks('kein json', 6), null); assert.equal(parseBreaks('{"absatz":', 6), null);
  const out = applyBreaks(list, { para: [3], line: [5] });
  assert.equal(out, 'Eins. Zwei.\n\nDrei. Vier.\nFünf. Sechs.'); assert(sameWords(out, list.join(' '))); assert(!/[#*\-•]/.test(out));
  assert.equal(applyBreaks(list, null), list.join(' '));
});
it('windows cleaned with an overlap are stitched where both agree: a false sentence end at the edge of a window is fixed', () => {
  const w1 = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf gemeint.', w2 = 'Sein hätte können. Hier wäre es gut wenn wir alles hätten.';
  const lap = 4, sources = [w1, `${w1.split(' ').slice(-lap).join(' ')} ${w2}`];
  const cleaned = [w1, 'zehn elf zwölf gemeint sein hätte können. Hier wäre es gut, wenn wir alles hätten.'];
  assert.equal(stitchWindows(sources, cleaned, lap), 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf gemeint sein hätte können. Hier wäre es gut, wenn wir alles hätten.');
  // unchanged windows come back as the text, once
  assert.equal(stitchWindows(sources, sources, lap), `${w1} ${w2}`);
  assert.equal(stitchWindows([w1], [w1], lap), w1);
});
