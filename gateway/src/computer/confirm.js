// Confirmation of an R2 action (DESIGN-F "Confirmation"). The APP draws the 2 digit code and shows it only on its overlay; the gateway never sees it.
// The gateway's part: make the voice model say the app's text EXACTLY (the assistant transcript is compared), read his answer ("ja vier sieben"),
// forward the digits and nothing else, count asks and expiries. One ask is open at a time; a "ja" never confirms anything by itself.
export const ASK_MS = 60_000;
export const SAY_WAIT_MS = 15_000;
export const MAX_ASKS = 8; // E: 3 stopped a normal Gmail send (Compose, To, Subject, Body, Send); 2 expiries and "nein" still stop
export const MAX_EXPIRIES = 2;

export const norm = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---- the transcript compare (C). The voice model reads the app's text aloud and the vendor returns what it SAID, so "mail.google.com" arrives as
// "mail punkt google punkt com" from a vendor that transcribes the audio, and as "mail.google.com" from one that returns the model's own text. Both sides are brought to
// the spoken form before the compare; an added or missing word still voids. xAI returns the model's output text for an assistant turn (not a re-transcription),
// so for xAI the domain case only matters when the model itself writes "punkt"; Gemini's output transcription is the audio, hence the rule. Numerals ("14:30" / "vierzehn Uhr dreißig") are NOT normalised: such a text voids and is asked again.
const spoken = (t) => norm(String(t ?? '').toLowerCase()
  .replace(/@/g, ' at ')
  .replace(/(?<=[\p{L}\p{N}])\.(?=[\p{L}\p{N}])/gu, ' punkt ') // a dot inside a name: domains, file names
  .replace(/(?<![\p{L}\p{N}])dot(?![\p{L}\p{N}])/gu, 'punkt')
  .replace(/(?<![\p{L}\p{N}])ät(?![\p{L}\p{N}])/gu, 'at')
  .replace(/\//g, ' slash '));
// A short acknowledgement the model may put in front ("Okay. Ich lese vor: ..." is NOT allowed, "Okay, ..." / "Alles klar, ..." is); everything else voids.
const ACK = ['okay', 'ok', 'gut', 'klar', 'alles klar', 'in ordnung', 'verstanden', 'sicher', 'natürlich', 'gern', 'gerne', 'also', 'ja', 'moment', 'bitte', 'na gut'];
const stripAck = (a) => {
  for (let i = 0; i < 2; i += 1) {
    const hit = ACK.find((w) => a.startsWith(`${w} `));
    if (!hit) return a;
    a = a.slice(hit.length + 1);
  }
  return a;
};

/** The assistant said exactly the app's text (letters and digits only, case ignored, domains in their spoken form, one leading short acknowledgement allowed). A missing word or an added sentence is a mismatch. */
export const saidExactly = (assistantText, spokenText) => {
  const same = (x, y) => y.length > 0 && (x === y || stripAck(x) === y);
  return same(spoken(assistantText), spoken(spokenText)) || same(norm(assistantText), norm(spokenText)); // the plain letters-and-digits compare stays valid (a vendor that drops the dots)
};

/**
 * The go after hands-on or after the 25-step stop (N2, S2): the WHOLE sentence is a positive go phrase (at most 4 words, filler words around it allowed) and has no negation.
 * Any other sentence (a video, "warte kurz", "nein, lass das", "ich mach selber weiter", "es geht weiter") lifts nothing. "ja", "weiter" or "okay" alone are no go either.
 */
const FILL = '(?:bitte|jetzt|einfach|ruhig|dann|ok|okay|ja|so|gerne)';
const GO = new RegExp(`^(?:${FILL} )*(?:mach(?: ${FILL})* weiter|weiter ?machen|weiter so|du kannst (?:${FILL} )*weitermachen|fahr(?:e)? fort|setz(?:e)? fort|go on|keep going|continue)(?: ${FILL})*$`);
const NEGATION = /(?:^| )(?:nein|nee|nö|no|nicht|kein\p{L}*|nie|niemals|ohne|stopp?\p{L}*|halt|warte\p{L}*|moment|abbrech\p{L}*|abbruch|aufhör\p{L}*|lass|bloß|später|don|never|ich|selber|selbst|wir)(?= |$)/u;
export const isGoWord = (text) => { const t = norm(text); return t.split(' ').length <= 4 && GO.test(t) && !NEGATION.test(t); };

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
  const parts = words.map((w) => (/^\d{1,2}$/.test(w) ? w : DIGIT[w] ?? null)); // "47", "4 7", "4,7" (the speech-to-text writes it either way)
  if (!parts.length || parts.some((p) => p === null)) return { kind: 'other' }; // every word must be a digit
  const digits = parts.join('');
  if (!/^\d{2}$/.test(digits)) return { kind: 'other' };
  return { kind: 'digits', digits };
}

/** What the voice model is told to do. The app's text is quoted data; nothing else may be added. */
export const askInstruction = (spoken) => `[Hinweis vom Desk, nicht von Florian: Eine Aktion am Computer braucht Florians Bestätigung. Sage jetzt WÖRTLICH und ohne ein einziges Wort davor oder danach genau diesen Text, dann schweige und warte. Ändere nichts, ergänze nichts, nenne keine Zahlen außer den im Text.]\n${JSON.stringify({ text: spoken }).replaceAll('<', '\\u003c')}`;

// ---- ask_florian (F7): only FIXED forms. yes/no about a named thing, or a choice among options the loop lists. His answer is mapped to ja / nein / one of the loop's own
// options; no free text of his reaches the loop, and a spoken digit run never passes. A question that looks for a secret (or a number) is refused whole.
export const FORBIDDEN_ASK = /passwor|kennwort|\bpw\b|\bpin\b|\btan\b|push\s?tan|code|schlüssel|token|geheim|secret|api[-\s]?key|\bkey\b|\botp\b|2fa|zwei[-\s]?faktor|\biban\b|\bbic\b|kreditkarte|\bcvv\b|sicherheitsfrage|ziffer|zahl|nummer|\bnr\b|\bsms\b|login|anmeld|zugang|passphrase|konto|seed|mnemonic|wallet|authenticator|einmal|handy|telefon|sag(?:e|st|en)?\b|nenn\w*|vorles\w*|vorlies\w*|\blies\b|buchstabier\w*|diktier\w*|wiederhol\w*|ausspre\w*/i; // the last words: a topic is a thing to decide, never an instruction for the voice to say or read something
const SPELLED = /(?:\b(?:null|eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun)\b\W+){3,}/i;
const LETTERS = /(?<![\p{L}])(?:\p{L}\s+){2,}\p{L}(?![\p{L}])/u; // "T A N": letters spelled out one by one
const ASK_CHARS = /^[\p{L}\p{N} .,;:!'"„“()/+&-]{1,100}$/u;
const secretish = (t) => FORBIDDEN_ASK.test(t) || SPELLED.test(t) || LETTERS.test(t) || (t.match(/\d/g)?.length ?? 0) > 3 || !ASK_CHARS.test(t);

/** {ok:true, form, spoken, options} | {ok:false, rule}: the question the voice model is told to read, built from the fixed forms only. */
export function buildAsk({ form, topic, options } = {}) {
  const t = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim() : '';
  if (form === 'yesno') {
    if (!t || t.length > 80) return { ok: false, rule: 'ask-form' };
    if (secretish(t)) return { ok: false, rule: 'ask-secret' };
    return { ok: true, form, options: [], spoken: `Der Computer-Agent fragt: Soll ich ${t}? Antworte mit ja oder nein.` };
  }
  if (form === 'choice') {
    if (!Array.isArray(options) || options.length < 2 || options.length > 4 || options.some((o) => typeof o !== 'string' || !o.trim() || o.length > 40)) return { ok: false, rule: 'ask-form' };
    const opts = options.map((o) => o.replace(/\s+/g, ' ').trim());
    if (new Set(opts.map(norm)).size !== opts.length) return { ok: false, rule: 'ask-form' };
    if ((t && (t.length > 80 || secretish(t))) || opts.some(secretish)) return { ok: false, rule: 'ask-secret' };
    const letters = 'ABCD';
    return { ok: true, form, options: opts, spoken: `Der Computer-Agent fragt${t ? `: ${t}` : ''}. Welche Option? ${opts.map((o, i) => `${letters[i]}: ${o}.`).join(' ')} Antworte mit dem Buchstaben oder dem Namen der Option.` };
  }
  return { ok: false, rule: 'ask-form' };
}
const YES = new Set(['ja', 'jawohl', 'yes', 'klar', 'gern', 'gerne', 'ok', 'okay', 'mach', 'genau', 'richtig', 'bitte']);
const NOW = new Set(['nein', 'nee', 'nö', 'no', 'nicht', 'stopp', 'stop', 'abbrechen', 'lass']);
/** {kind:'yes'|'no'|'option'|'unclear', option?}. The loop receives only these; the words he said stay out. */
export function mapAnswer(form, options, text) {
  const words = norm(text).split(' ').filter(Boolean);
  if (!words.length || words.length > 12) return { kind: 'unclear' };
  if (form === 'yesno') {
    const y = words.some((w) => YES.has(w)), n = words.some((w) => NOW.has(w));
    return y && !n ? { kind: 'yes' } : n && !y ? { kind: 'no' } : { kind: 'unclear' };
  }
  const hits = new Set();
  options.forEach((o, i) => {
    const ow = norm(o).split(' ');
    if (words.includes('abcd'[i]) && words.length <= 3) hits.add(i); // "A", "Option B", "B bitte"
    else if (ow.every((w) => words.includes(w))) hits.add(i);
  });
  return hits.size === 1 ? { kind: 'option', option: options[[...hits][0]] } : { kind: 'unclear' };
}
