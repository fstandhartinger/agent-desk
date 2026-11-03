// Confirmation of an R2 action (DESIGN-F "Confirmation"). The APP draws the 2 digit code and shows it only on its overlay; the gateway never sees it.
// The gateway's part: make the voice model say the app's text EXACTLY (the assistant transcript is compared), read his answer ("ja vier sieben"),
// forward the digits and nothing else, count asks and expiries. One ask is open at a time; a "ja" never confirms anything by itself.
export const ASK_MS = 60_000;
export const SAY_WAIT_MS = 15_000;
export const MAX_ASKS = 3;
export const MAX_EXPIRIES = 2;

export const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The assistant said exactly the app's text (letters and digits only, case ignored). A missing word or an added sentence is a mismatch. */
export const saidExactly = (assistantText, spoken) => {
  const a = norm(assistantText), s = norm(spoken);
  return s.length > 0 && a === s;
};

const DIGIT = { null: '0', zero: '0', eins: '1', ein: '1', eine: '1', zwei: '2', zwo: '2', drei: '3', vier: '4', fünf: '5', fuenf: '5', sechs: '6', sieben: '7', acht: '8', neun: '9' };
const NO = /^(?:nein|no|nee|nö|stopp?|abbrechen|abbruch|nicht|lass das|bloß nicht|halt)\b/;

/**
 * His whole final, parsed: {kind:'no'} | {kind:'digits', digits:'47'} | {kind:'other'}.
 * Digits are exactly two, spoken ("vier sieben", "vier-sieben", "47") with an optional leading "ja". Anything else is 'other':
 * it ends the ask and confirms nothing. "bitte", "mach", "los" are NOT a yes.
 */
export function parseAnswer(text) {
  const t = norm(text);
  if (!t) return { kind: 'other' };
  if (NO.test(t)) return { kind: 'no' };
  const words = t.split(' ');
  if (['ja', 'jawohl', 'okay', 'ok', 'yes'].includes(words[0])) words.shift();
  const parts = words.map((w) => (/^\d{2}$/.test(w) ? w : DIGIT[w] ?? null));
  if (!parts.length || parts.some((p) => p === null)) return { kind: 'other' }; // every word must be a digit
  const digits = parts.join('');
  if (!/^\d{2}$/.test(digits)) return { kind: 'other' };
  return { kind: 'digits', digits };
}

/** What the voice model is told to do. The app's text is quoted data; nothing else may be added. */
export const askInstruction = (spoken) => `[Hinweis vom Desk, nicht von Florian: Eine Aktion am Computer braucht Florians Bestätigung. Sage jetzt WÖRTLICH und ohne ein einziges Wort davor oder danach genau diesen Text, dann schweige und warte. Ändere nichts, ergänze nichts, nenne keine Zahlen außer den im Text.]\n${JSON.stringify({ text: spoken }).replaceAll('<', '\\u003c')}`;
