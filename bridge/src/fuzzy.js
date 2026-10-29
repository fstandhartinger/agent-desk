// Forgiving name lookup for speech-to-text slips ("Rags to Next Steps" for reax2-next-steps-20261024).
const STOPWORDS = new Set(['to', 'the', 'job', 'der', 'die', 'das', 'und', 'von', 'vom', 'of', 'a']);
const MIN_SIMILARITY = 0.7; // per token, 1 = identical
const MIN_CANDIDATE = 0.3; // overall score below this is noise, not a candidate

export const slugify = (text) => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|(?<!-)-+$/g, '');

const tokensOf = (text) => slugify(text).split('-').filter((t) => t && !STOPWORDS.has(t));

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

function similarity(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.9; // partial words: "next" vs "nextgen"
  const score = 1 - editDistance(a, b) / Math.max(a.length, b.length);
  return score >= MIN_SIMILARITY ? score : 0;
}

/** Share of the query's words that appear (up to small typos) in the candidate; 0..1. */
export function score(query, candidate) {
  const wanted = tokensOf(query);
  if (!wanted.length) return 0;
  const have = tokensOf(candidate);
  const squashed = wanted.join('');
  if (squashed.length >= 5 && have.join('').includes(squashed)) return 1; // "jev bench" for "jevbench"
  const hit = wanted.reduce((sum, w) => sum + Math.max(0, ...have.map((h) => similarity(w, h))), 0);
  return hit / wanted.length;
}

/** Best `count` candidates above the noise floor, best first; ties keep the input order (newest first for jobs). */
export function rank(query, items, nameOf = (x) => x, count = 3) {
  return items
    .map((item) => ({ item, score: score(query, nameOf(item)) }))
    .filter((r) => r.score >= MIN_CANDIDATE)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

/** A single clear winner: strong score and a visible lead over the runner-up. */
export function clearWinner(ranked) {
  const [first, second] = ranked;
  return first && first.score >= 0.65 && first.score - (second?.score ?? 0) >= 0.2 ? first : null;
}
