// Tolerant matching of what Florian said against artifacts: speech recognition mishears words ("Log the Engine" for "lock the engine").
// Pure and small: a phonetic fold plus edit distance, no dependencies.

const STOP = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'und', 'oder', 'ist', 'sind', 'war', 'von', 'vom', 'mit', 'für', 'auf', 'bei', 'zum', 'zur', 'über', 'wo', 'wie', 'was', 'wer', 'wenn', 'dass', 'geht', 'gehts', 'um', 'es', 'sie', 'er', 'ich', 'du', 'mir', 'mich', 'dir', 'diese', 'dieser', 'dieses', 'diesen', 'meine', 'meinen', 'karte', 'karten', 'card', 'cards', 'kachel', 'id', 'ids', 'artefakt', 'äh', 'ähm', 'ehm', 'also', 'mal', 'noch', 'nach', 'the', 'and', 'for', 'about', 'with', 'that', 'this', 'where', 'what', 'schau', 'schaue', 'kannst', 'bitte', 'dort', 'hier', 'sitzung']);
const TOKEN = /[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu;

/** Lower case, no diacritics, voiced/unvoiced and c/k/g/ck confusions folded: "log" and "lock" both become "lok". */
export function fold(word) {
  return String(word ?? '').toLowerCase()
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 's')
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/ck/g, 'k').replace(/[cg]/g, 'k').replace(/d/g, 't').replace(/b/g, 'p').replace(/z/g, 's').replace(/v/g, 'f')
    .replace(/(\p{L})\1+/gu, '$1');
}

/** Levenshtein distance with an early exit above `max`. */
export function distance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < best) best = row[j];
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

export const wordsOf = (text) => String(text ?? '').match(TOKEN) ?? [];

/** The words of a query that carry meaning (no filler, no "Karte"), de-duplicated. */
export function significantTokens(text) {
  const out = [];
  for (const w of wordsOf(text)) {
    const lower = w.toLowerCase();
    if (STOP.has(lower) || (lower.length < 3 && !/\d/.test(lower)) || out.includes(lower)) continue;
    out.push(lower);
  }
  return out.slice(0, 12);
}

/** How well one query token fits a list of folded words: 1 = same sound, 0.7-0.99 = close, 0 = no. */
function tokenFit(token, folded) {
  const t = fold(token);
  let best = 0;
  for (const w of folded) {
    if (w === t) return 1;
    if (t.length >= 4 && w.length >= 4 && (w.startsWith(t) || t.startsWith(w))) { best = Math.max(best, 0.85); continue; }
    if (t.length < 4 || /\d/.test(t)) continue; // short words and numbers must match exactly
    const d = distance(t, w, 2);
    const sim = 1 - d / Math.max(t.length, w.length);
    if (d <= 2 && sim >= 0.7) best = Math.max(best, sim);
  }
  return best;
}

/** Score 0..1 of a query against title and summary (title counts fully, summary 0.6); also whether at least one token fits well. */
export function fuzzyScore(tokens, { title = '', summary = '' }) {
  if (!tokens.length) return 0;
  const titleWords = wordsOf(title).map(fold);
  const bodyWords = wordsOf(String(summary).slice(0, 800)).map(fold);
  let sum = 0, strong = 0;
  for (const token of tokens) {
    const fit = Math.max(tokenFit(token, titleWords), 0.6 * tokenFit(token, bodyWords));
    sum += fit;
    if (fit >= 0.7) strong += 1;
  }
  return strong ? sum / tokens.length : 0;
}

/** What a query is when it names an artifact directly: {id} for a# / six hex with a digit, {card} for a card number. */
export function directRef(text) {
  const t = String(text ?? '').trim();
  const id = /^(?:a\s?#\s?)?([0-9a-f]{6})$/i.exec(t);
  if (id && (/^a\s?#/i.test(t) || (/\d/.test(id[1]) && /[a-f]/i.test(id[1])))) return { id: id[1].toLowerCase() };
  const card = /^(?:(?:urgent[- ]?)?(?:karte|card)\s*(?:nummer|nr\.?|number|#)?\s*#?\s*)?(\d{1,12})$/i.exec(t);
  if (card) return { card: card[1], ...(card[1].length === 6 ? { id: card[1] } : {}) };
  return null;
}
