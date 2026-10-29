// Query → term groups for ctx.search. Florian speaks German, most notes are English: every word is expanded with a
// small DE<->EN synonym table, German compounds are split on known stems ("Steuerrücklagen" → Steuer + Rücklage), and a
// multiword query becomes an OR of its terms, ranked by how many groups a file matches (never one literal phrase).

// Each row is one meaning. A query word that contains one of a row's stems (≥ 4 chars) or equals one of its words
// pulls in the whole row as one group.
const SYNONYMS = [
  ['steuer', 'tax', 'steuern', 'finanzamt'],
  ['rücklage', 'reserve', 'ruecklage', 'rückstellung'],
  ['emission', 'emissions', 'emittier', 'emit'],
  ['honorar', 'owner', 'owner share', 'owner emission'],
  ['umwand', 'convert', 'conversion', 'swap', 'sell', 'verkauf', 'tausch'],
  ['überweis', 'transfer', 'ueberweis', 'payout', 'auszahl'],
  ['geld', 'money', 'spend', 'budget', 'kosten', 'cost'],
  ['euro', 'eur'],  // short variants only match at word starts (see variantPattern)
  ['server', 'host', 'sandy', 'lechonk'],
  ['kunde', 'customer', 'kunden', 'client'],
  ['rechnung', 'invoice', 'billing'],
  ['zahlung', 'payment', 'paid', 'bezahl'],
  ['wallet', 'coldkey', 'talisman'],
  ['subnetz', 'subnet', 'netuid'],
  ['vertrag', 'contract'],
  ['partner', 'partners', 'partnerschaft'],
  ['entscheid', 'decision', 'decided'],
  ['benchmark', 'jevbench', 'bench'],
  ['grenze', 'limit', 'limits', 'quota', 'kontingent'],
  ['konto', 'account'],
  ['regel', 'rule', 'rules'],
  ['wissen', 'knowledge'],
  ['erklär', 'explainer'],
  ['video', 'videos'],
  ['nachricht', 'message', 'notify'],
  ['buchung', 'ledger', 'geldbewegung'],
  ['krypto', 'crypto', 'alpha', 'tao'],
];

const STOPWORDS = new Set(`
der die das den dem des ein eine einen einem einer und oder aber auch nur noch schon mal mir mich mein meine meinen
ich du er sie es wir ihr uns unser unsere unseren unserem euer was wie wo wer wann warum ist sind war waren bin bist
hat haben habe hast wird werden kann können muss müssen soll sollen will wollen über ueber für fuer mit von vom zu zum
zur auf aus bei nach in im an am als dass da dann denn doch so ganz sehr immer ständig gerade bitte frage stand
the a an and or of to in on at for with from by is are was were be it this that what how which who about our my me i
you we they there here any some do does did can should would will please question status
`.split(/\s+/).filter(Boolean));

const MAX_GROUPS = 8;
const MAX_VARIANTS = 8;

function stemOf(word) {
  // German/English inflection: "Rücklagen" → "rücklag", "Emissionen" → "emission"; short words stay whole.
  for (const suffix of ['ungen', 'en', 'er', 'es', 'e', 's', 'n']) {
    if (word.length - suffix.length >= 5 && word.endsWith(suffix)) return word.slice(0, -suffix.length);
  }
  return word;
}

function rowsFor(word) {
  const rows = [];
  for (const row of SYNONYMS) {
    const hit = row.some((w) => w === word || (w.length >= 4 && !w.includes(' ') && word.includes(w)) || (word.length >= 4 && w.startsWith(word)));
    if (hit) rows.push(row);
  }
  return rows;
}

/**
 * Splits a query into term groups: [{word, variants:[...]}]. A file matches a group when it contains any variant
 * (case-insensitive substring). "Subnetz 92" / "subnet 92" / "netuid 92" also yield the SN92 group.
 */
export function expandQuery(query) {
  const groups = [];
  const seen = new Set();
  const add = (word, variants) => {
    const clean = [...new Set(variants.map((v) => v.toLowerCase()).filter((v) => v.length >= 2))].slice(0, MAX_VARIANTS);
    const key = clean.slice().sort().join('|');
    if (!clean.length || seen.has(key) || groups.length >= MAX_GROUPS) return;
    seen.add(key);
    groups.push({ word, variants: clean });
  };
  let text = String(query ?? '').toLowerCase();
  text = text.replace(/\b(?:sub-?netz|subnetz|subnet|netuid|sn)[\s#=-]*(\d{1,3})\b/g, (_, n) => {
    add(`sn${n}`, [`sn${n}`, `subnet ${n}`, `netuid ${n}`, `netuid=${n}`, `sn-${n}`, `sn ${n}`]);
    return ' ';
  });
  const words = text.split(/[^\p{L}\p{N}_.-]+/u).map((w) => w.replace(/^[.-]+|(?<![.-])[.-]+$/g, '')).filter((w) => w.length >= 2 && !STOPWORDS.has(w));
  for (const word of words) {
    const rows = rowsFor(word);
    const base = stemOf(word);
    if (!rows.length) { add(word, [base]); continue; }
    // Compound words: each matched meaning is its own group; the word itself joins the first.
    rows.forEach((row, i) => add(i === 0 ? word : row[0], i === 0 ? [base, ...row] : row));
  }
  return groups;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ripgrep pattern for one variant. Variants of up to 4 characters must start at a word boundary ("tax" not in
 * "syntax", "eur" not in "neural"); up to 3 characters they must also end there. Longer ones match anywhere, which
 * is what German compounds need ("Steuerrücklage" contains "rücklage").
 */
export function variantPattern(v) {
  if (v.length > 4) return escape(v);
  // ASCII boundaries: ripgrep's Unicode \b disables its fast DFA (2 s instead of 0.1 s over the notes mirror).
  return `(?-u:\\b)${escape(v)}${v.length <= 3 ? '(?-u:\\b)' : ''}`;
}

const NOT_WORD = '[^\\p{L}\\p{N}_]';
const matcherCache = new Map();
function matcher(v) {
  let re = matcherCache.get(v);
  if (!re) {
    re = v.length > 4 ? null : new RegExp(`(?<!\\p{L}|\\p{N}|_)${escape(v)}${v.length <= 3 ? `(?=${NOT_WORD}|$)` : ''}`, 'iu');
    matcherCache.set(v, re);
  }
  return re;
}

/** Which groups (indexes) a line of text matches; the same rules as variantPattern. */
export function groupsIn(text, groups) {
  const lower = String(text).toLowerCase();
  const out = [];
  groups.forEach((g, i) => {
    if (g.variants.some((v) => { const re = matcher(v); return re ? re.test(lower) : lower.includes(v); })) out.push(i);
  });
  return out;
}
