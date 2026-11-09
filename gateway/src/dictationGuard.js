// The word guard of the dictation clean-up (10 Nov 2026). A language model cleans his text; this decides, change by change, what of that may stand.
// Measured on a day of his recordings: the model pass reworded ("wieso" -> "warum"), reordered, repeated its context and once invented a digit.
// So every change is checked on its own and an unexplained one is undone: the words of the source stay. Deterministic, no model, no network.
//
// A change may stand when it is one of these:
//   - punctuation or capitals only, or the same letters split or joined differently ("Kunden, Sichtbarkeit" -> "Kunden-Sichtbarkeit")
//   - a reading another recogniser heard at that place (merge only)
//   - a near miss in sound and spelling ("zielschlagende" -> "fehlschlagende", "Sieh" -> "sie", "einem" -> "einer")
//   - a known name written properly ("Jeff Bench" -> "JevBench")
//   - a filler, a stutter or a spoken self-correction taken out
//   - one small grammar word added
// Never: a digit that was not spoken, a negation that appears or disappears, text that was not said.

const FILLER = /^(äh+m?|ähm+|öh+m?|hm+|mhm|ehm+|uh+m?)$/i; // "um" is a German word, never a filler here
const NEGATION = new Set(['nicht', 'nichts', 'kein', 'keine', 'keinen', 'keinem', 'keiner', 'keines', 'nie', 'niemals', 'ohne', 'weder']);
const GRAMMAR = new Set(['zu', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'es', 'ist', 'sind', 'wird', 'werden', 'hat', 'haben', 'will', 'um', 'und', 'dass', 'in', 'an', 'auf', 'mit', 'von', 'für', 'sich']);
const CORRECTION = new Set(['nein', 'quatsch', 'korrektur', 'streich', 'streiche', 'vielmehr', 'sorry', 'entschuldigung', 'falsch']);
const CORRECTION_PAIRS = [['ich', 'meine'], ['ich', 'meinte'], ['besser', 'gesagt'], ['ich', 'korrigiere'], ['genauer', 'gesagt'], ['nicht', 'sondern']];
const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
const TENS = { zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };
const NUMBER_WORDS = new Map([...ONES.map((w, i) => [w, i]), ['ein', 1], ['eine', 1], ['sechs', 6], ['sieben', 7], ...Object.entries(TENS), ['hundert', 100], ['tausend', 1000]]);

/** Letters and digits of a word, lower case: "Kunden." and "kunden" are the same word. */
export const wordKey = w => (String(w ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
export const splitWords = text => String(text ?? '').split(/\s+/).filter(Boolean);
const toks = text => splitWords(text).map(raw => ({ raw, key: wordKey(raw) }));

/** A spoken German number up to 99 ("zweiundneunzig") as digits, or null. "ein"/"eine" count only inside a compound: alone they are articles. */
export function spokenNumber(key) {
  if (/^\d+$/.test(key)) return key;
  if (key === 'ein' || key === 'eine') return null;
  if (NUMBER_WORDS.has(key)) return String(NUMBER_WORDS.get(key));
  const m = /^(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun)und(zwanzig|dreißig|dreissig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)$/.exec(key);
  return m ? String(TENS[m[2]] + (m[1] === 'ein' ? 1 : ONES.indexOf(m[1]))) : null;
}
/** The digits a run of words says, sorted: what may not change. */
const numeric = t => spokenNumber(t.key) !== null || /^\d[\d.,]*$/.test(t.raw.replace(/[^\d.,]/g, '')) && /^\d+$/.test(t.key) || t.key === 'komma' || t.key === 'punkt';
const digitsOf = list => list.map(t => spokenNumber(t.key) ?? (t.key.match(/\d/g) ?? []).join('')).join('').split('').sort().join('');

function distance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** 0 = the same letters, 1 = nothing in common. */
export const apart = (a, b) => distance(a, b) / Math.max(1, a.length, b.length);

/** Word alignment by the longest common run of keys: [{op: 'equal'|'change', a0, a1, b0, b1}]. */
export function alignWords(a, b) {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i].key && a[i].key === b[j].key ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0, a0 = 0, b0 = 0;
  const flush = (ai, bj) => { if (ai > a0 || bj > b0) ops.push({ op: 'change', a0, a1: ai, b0, b1: bj }); };
  while (i < n && j < m) {
    if (a[i].key && a[i].key === b[j].key) {
      flush(i, j);
      const s = i, t = j; while (i < n && j < m && a[i].key && a[i].key === b[j].key) { i++; j++; }
      ops.push({ op: 'equal', a0: s, a1: i, b0: t, b1: j }); a0 = i; b0 = j;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  flush(n, m);
  return ops;
}

/** Term keys from names: every word of at least three letters and every whole name ("claude code" -> claude, code, claudecode). */
export function termKeys(names) {
  const out = new Set();
  for (const name of names) {
    const words = splitWords(name).map(wordKey).filter(Boolean);
    for (const w of words) if (w.length >= 3) out.add(w);
    if (words.length > 1) out.add(words.join(''));
  }
  return out;
}

/**
 * What the other recognisers heard, relative to the source the clean-up started from:
 * alts = where one of them differs ({a0, a1} = the source words it replaces, keys = what it wrote there), contested[i] = some recogniser did not write source word i.
 */
export function variantContext(source, variants) {
  const src = toks(source), alts = [], contested = new Array(src.length).fill(false);
  for (const v of variants) {
    if (v === source) continue;
    const t = toks(v); if (!t.length) continue;
    for (const o of alignWords(src, t)) {
      if (o.op === 'equal') continue;
      for (let k = o.a0; k < o.a1; k++) contested[k] = true;
      alts.push({ a0: o.a0, a1: o.a1, keys: t.slice(o.b0, o.b1).map(w => w.key).filter(Boolean) });
    }
  }
  return { alts, contested };
}

function hasCorrection(list) {
  const keys = list.map(t => t.key);
  return keys.some(k => CORRECTION.has(k)) || CORRECTION_PAIRS.some(([x, y]) => keys.some((k, i) => k === x && keys.slice(i + 1, i + 4).includes(y)));
}

/** May this one change stand? d = the source words it replaces (from position `at`), ins = the new words (both without bare punctuation). */
function changeOk(d, ins, at, src, ctx) {
  if (!d.length && !ins.length) return true;
  const dk = d.map(t => t.key), ik = ins.map(t => t.key), dj = dk.join(''), ij = ik.join('');
  if (dj === ij) return true; // split, joined or hyphenated differently
  // what another recogniser wrote at this very place
  const there = new Set();
  for (const alt of ctx.alts ?? []) if (alt.a0 <= at + d.length && alt.a1 >= at) for (const k of alt.keys) there.add(k);
  const heard = ins.length > 0 && ik.every(k => there.has(k));
  const contested = d.length > 0 && d.every((_, k) => ctx.contested?.[at + k]);
  const backed = heard || (!ins.length && contested);
  // a negation never appears or disappears, and the digits he spoke stay the digits he gets, unless a recogniser heard it that way
  const neg = l => l.filter(k => NEGATION.has(k)).sort().join(' ');
  if (!backed && (neg(dk) !== neg(ik) || digitsOf(d) !== digitsOf(ins))) return false;
  if (d.length && ins.length && d.every(numeric) && ins.every(numeric)) return true; // the same number written differently ("fünf fünf" -> "5.5"): the digits were compared above
  if (!ins.length) { // words taken out
    if (dk.every((k, i) => FILLER.test(k) || ctx.contested?.[at + i])) return true;
    const after = src.slice(at + d.length, at + 2 * d.length).map(t => t.key).join(' '), before = src.slice(Math.max(0, at - d.length), at).map(t => t.key).join(' ');
    if (dk.join(' ') === after || dk.join(' ') === before) return true; // a stutter or a restart: the same words stand next to it
    return d.length <= 14 && hasCorrection([...d, ...src.slice(at + d.length, at + d.length + 3)]);
  }
  if (!d.length) return heard || (ins.length === 1 && GRAMMAR.has(ik[0])); // new words: heard by a recogniser there, or one small grammar word
  if (heard) return true; // the reading of another recogniser
  if (d.length <= 14 && hasCorrection(d) && ik.every(k => dk.includes(k))) return true; // a spoken correction applied
  const far = apart(dj, ij), isTerm = ctx.terms?.has(ij) || ik.every(k => ctx.terms?.has(k));
  if (isTerm && far <= 0.7) return true; // a known name, close enough in sound
  return far <= (Math.min(dj.length, ij.length) >= 5 ? 0.4 : 0.34); // a near miss: inflection, a letter or two
}

/**
 * The cleaned text with every unexplained change undone. source = what the clean-up started from, cleaned = the model's answer.
 * ctx: {alts, contested} from variantContext (merge) or {} (final pass), plus terms = termKeys(...).
 * Returns {text, changes, undone}. Line breaks in `cleaned` are not kept: structure is the formatter's job.
 */
export function guardText(source, cleaned, ctx = {}) {
  const a = toks(source), b = toks(cleaned);
  if (!a.length || !b.length) return { text: String(source ?? '').trim(), changes: 0, undone: b.length ? 1 : 0 };
  const out = []; let changes = 0, undone = 0, grammarAdded = 0;
  const ops = alignWords(a, b).map(o => {
    if (o.op === 'equal') return o;
    const d = a.slice(o.a0, o.a1).filter(t => t.key), ins = b.slice(o.b0, o.b1).filter(t => t.key);
    let ok = changeOk(d, ins, o.a0, a, ctx);
    if (ok && !d.length && ins.length === 1 && GRAMMAR.has(ins[0].key)) ok = ++grammarAdded <= Math.max(1, Math.floor(a.length / 50));
    if (d.length || ins.length) { changes += 1; if (!ok) undone += 1; }
    return { ...o, ok, pure: !ins.length };
  });
  ops.forEach((o, n) => {
    if (o.op === 'equal') {
      // next to an undone change the source's own punctuation and capitals stay too: "suchen würden, wieso" must not become "suchen, würden, wieso"
      const first = ops[n - 1]?.ok === false, last = ops[n + 1]?.ok === false;
      for (let k = 0; k < o.b1 - o.b0; k++) out.push((k === 0 && first) || (k === o.b1 - o.b0 - 1 && last) ? a[o.a0 + k].raw : b[o.b0 + k].raw);
    } else if (o.ok) for (const t of b.slice(o.b0, o.b1)) out.push(t.raw);
    else for (const t of a.slice(o.a0, o.a1)) { if (!(o.pure && FILLER.test(t.key))) out.push(t.raw); } // a filler may always go, also inside a run that stays
  });
  return { text: out.join(' '), changes, undone };
}

// ---- windows that overlap: no sentence is judged at the edge of what the model can see ----

/** Where source word k of a window ended up in its cleaned text (index of the first cleaned word for it). */
function positions(src, out) {
  const at = new Array(src.length + 1).fill(out.length), solid = new Array(src.length + 1).fill(false);
  for (const o of alignWords(src, out)) {
    if (o.op === 'equal') for (let k = 0; k < o.a1 - o.a0; k++) { at[o.a0 + k] = o.b0 + k; solid[o.a0 + k] = true; }
    else for (let k = o.a0; k < o.a1; k++) at[k] = o.b0;
  }
  solid[src.length] = true;
  return { at, solid };
}
/**
 * Windows cleaned side by side, put together again. Window i was cleaned together with the last `lap` words of window i-1 in front of it, so the place
 * where two windows meet lies inside a text the model saw both sides of; each window gives up its own last `lap` words to the next one.
 * sources[i] = the words the model got for window i (with that lead), cleaned[i] = its guarded answer. The cut moves a few words to a place both agree on.
 */
export function stitchWindows(sources, cleaned, lap) {
  const out = [];
  let from = 0; // source index in window i where its part starts
  for (let i = 0; i < sources.length; i++) {
    const src = toks(sources[i]), cl = toks(cleaned[i]), here = positions(src, cl);
    let to = src.length;
    if (i + 1 < sources.length) {
      const next = toks(sources[i + 1]), nextPos = positions(next, toks(cleaned[i + 1]));
      const lead = Math.min(lap, src.length); // the next window starts with our last `lead` words
      // a cut both sides agree on: the word before and the word after it stand unchanged in both cleaned texts
      let cut = null;
      for (const d of [0, 1, -1, 2, -2, 3, -3]) {
        const k = Math.floor(lead / 2) + d, mine = src.length - lead + k; // k words of the lead stay with us
        if (k < 1 || k >= lead || mine < 1) continue;
        if (here.solid[mine - 1] && here.solid[mine] && nextPos.solid[k - 1] && nextPos.solid[k]) { cut = k; break; }
      }
      cut ??= Math.floor(lead / 2);
      to = src.length - lead + cut;
      for (const t of cl.slice(here.at[from], here.at[to])) out.push(t.raw);
      from = cut;
    } else for (const t of cl.slice(here.at[from])) out.push(t.raw);
  }
  return out.join(' ');
}

// ---- light structure: the model only names where a line break goes; the words are put together here ----

const LIST_MARK = /^(erstens|zweitens|drittens|viertens|fünftens|sechstens)$/i;
/** His text in sentences (cut after . ? ! and before a spoken list mark), each with its words untouched. */
export function sentences(text) {
  const out = []; let cur = [];
  for (const w of splitWords(text)) {
    if (cur.length && LIST_MARK.test(wordKey(w)) && cur.length >= 3) { out.push(cur.join(' ')); cur = []; }
    cur.push(w);
    if (/[.?!]["“”»)]*$/.test(w) && !/^\d+\.$/.test(w) && !/\b(z\.B|bzw|ca|usw|etc|ggf|inkl|Nr|d\.h|u\.a)\.$/i.test(w)) { out.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}
/** Is a text long enough to deserve structure? Under about 45 words or three sentences it stays one block. */
export const worthFormatting = text => { const s = sentences(text); return s.length >= 3 && splitWords(text).length >= 45; };
/** The numbered sentences the model reads. */
export const numbered = list => list.map((s, i) => `[${i + 1}] ${s}`).join('\n');
/**
 * Break positions from the model's answer: {"absatz":[4,9],"zeile":[6]} = a blank line before sentence 4 and 9, a line break before 6.
 * Anything else in the answer is ignored; too many breaks (more than one per two sentences) means the answer is not light structure: none are used.
 */
export function parseBreaks(answer, count) {
  const raw = String(answer ?? ''), open = raw.indexOf('{'), close = raw.lastIndexOf('}');
  let j; try { j = JSON.parse(raw.slice(open, close + 1)); } catch { return null; /* malformed answer: the text stays one block */ }
  if (!j || typeof j !== 'object') return null;
  const pick = v => [...new Set((Array.isArray(v) ? v : []).filter(n => Number.isInteger(n) && n >= 2 && n <= count))];
  const para = pick(j.absatz), line = pick(j.zeile).filter(n => !para.includes(n));
  if (para.length + line.length > Math.max(1, Math.ceil(count / 2))) return null;
  return { para, line };
}
/** His sentences with the breaks put in. Plain text: "\n" and "\n\n" only, never markup. */
export function applyBreaks(list, breaks) {
  if (!breaks) return list.join(' ');
  let out = '';
  list.forEach((s, i) => { out += i === 0 ? s : (breaks.para.includes(i + 1) ? '\n\n' : breaks.line.includes(i + 1) ? '\n' : ' ') + s; });
  return out;
}
/** The same words in the same order, whatever the white space? The last check before formatted text leaves. */
export const sameWords = (a, b) => splitWords(a).join(' ') === splitWords(b).join(' ');
