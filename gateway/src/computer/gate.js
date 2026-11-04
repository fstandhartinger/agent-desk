// Computer-use trigger (item F, DESIGN-F "Trigger"). Stricter than the two voice actions: ONLY his one latest SPOKEN final, verbatim.
// No yes-bridging, no typed turn, no echo, no older entry; the question filter applies. The loop later receives exactly this text.
import { ABOUT } from '../voiceActions.js';

export const TRIGGER_AGE_MS = 90_000;
// Openers anywhere in the sentence ("Übernimm mal den Computer"), imperatives only at the START of a clause. Every opener has a RIGHT boundary
// ("Er übernimmt die Kosten", "Übernimmst du das?", "Fernsteuerung" are no commands); \b is ASCII-only, so the boundary is spelled with \p{L}.
const END = '(?![\\p{L}\\p{N}_])';
const OPENER = new RegExp(`(?<![\\p{L}\\p{N}_])(?:übernimm|steuere|fernsteuer(?:e|n)?|computer[\\s-]?use|für\\s+mich\\s+(?:zu\\s+)?klick(?:en|e)?)${END}`, 'iu');
// "Mach das am Rechner" is an order; "Ich sitze am Rechner" is a report.
const AT_DESK = new RegExp(`(?<![\\p{L}\\p{N}_])(?:mach|erledige|arbeite|bedien|steuer)\\p{L}*[^.!?;\\n]{0,40}(?<![\\p{L}\\p{N}_])am\\s+rechner${END}`, 'iu');
const AT_DESK_START = new RegExp(`^\\s*(?:bitte\\s+)?am\\s+rechner${END}`, 'iu'); // "Am Rechner bitte den Dialog schließen."
const IMPERATIVE = /^(?:klick(?:e)?|öffne|tippe|übernehme(?!\s+ich)|geh(?:e)?\s+auf)(?![\p{L}\p{N}_])/iu; // "Übernehme den Computer" is how speech recognition hears "Übernimm"; "Ich übernehme ..." is a report and does not start the clause
const LEAD = /^(?:(?:und|dann|danach|bitte|mal|jetzt|noch|also|okay|ok|hey|so|na|aber|gut|nun)\b[\s,]*)+/i;
// "geh auf die Frage ein" answers a point, it clicks nothing
const GO_INTO = /^geh(?:e)?\s+auf\b(?:(?!\bein\b).){0,40}\bein\b/i;
// Anything that turns the sentence into something else than an order: a negation ("öffne die Mail nicht"), a doubt or report ("ich glaube, öffne gmail wäre falsch",
// "er sagt: öffne ..."), a wish or description ("ich möchte, dass der Agent ... fernsteuern kann"). A hit anywhere closes the whole sentence; he says it again plainly.
const NEGATION = /(?<![\p{L}\p{N}_])(?:nicht|nichts|kein(?:e|en|em|er|es)?|nie|niemals|ohne|don'?t|never|not)(?![\p{L}\p{N}_])/iu;
const DOUBT = /(?<![\p{L}\p{N}_])(?:glaub\p{L}*|denk\p{L}*|vielleicht|wäre|wären|würde|würdest|würden|könnte|könntest|sollte|sollten|soll|sollen|falls|wenn|ob|angenommen|beispiel|hypothetisch|sagt|sagte|sagen|meinte|meint|behauptet|fragt|möchte|möchten|will|wollen|dass|damit|idealerweise|feature|funktion|idee)(?![\p{L}\p{N}_])/iu;
const POLITE = /^\s*(?:und\s+)?(?:kannst|könntest|würdest)\s+du(?![\p{L}\p{N}_])/iu;
// "Kannst du ... für mich auf den Link klicken?": counts only behind POLITE. "Kannst du den Computer steuern?" alone stays a question about what it can do.
const POLITE_CLICK = /(?<![\p{L}\p{N}_])für\s+mich(?![\p{L}\p{N}_])[^.!?;\n]{0,100}(?<![\p{L}\p{N}_])klick(?:en|e)?(?![\p{L}\p{N}_])/iu;
const QUESTION_START = /^\s*(?:und\s+)?(?:kannst|könntest|darfst|sollst|willst|möchtest|würdest|hast|bist|ist|sind|kann|wird|kommst)(?![\p{L}\p{N}_])/iu;

export function isTrigger(text) {
  const t = String(text ?? '');
  if (ABOUT.test(t) || NEGATION.test(t) || DOUBT.test(t)) return false;
  const politeOrder = POLITE.test(t) && (OPENER.test(t) || POLITE_CLICK.test(t));
  if ((t.includes('?') || QUESTION_START.test(t)) && !politeOrder) return false; // a question opens nothing, except the polite order "Kannst du das für mich klicken?"
  if (politeOrder || OPENER.test(t) || AT_DESK.test(t) || AT_DESK_START.test(t)) return true;
  return t.split(/[.!;,\n]+/).some((clause) => {
    const c = clause.trim().replace(LEAD, '');
    return IMPERATIVE.test(c) && !GO_INTO.test(c);
  });
}

/** {ok, entries:[e], text} when his latest spoken final opens (or extends) a run, else {ok:false, why}. */
export function checkComputerTrigger(spoken, now = Date.now()) {
  const e = spoken.at(-1);
  if (!e) return { ok: false, why: 'no-trigger' };
  if (e.typed) return { ok: false, why: 'typed' };
  if (e.echo) return { ok: false, why: 'echo' };
  if (now - e.at > TRIGGER_AGE_MS) return { ok: false, why: 'old' };
  if (e.used?.computer_task) return { ok: false, why: 'used' };
  if (ABOUT.test(String(e.text ?? ''))) return { ok: false, why: 'question' };
  if (!isTrigger(e.text)) return { ok: false, why: 'no-trigger' };
  return { ok: true, entries: [e], text: String(e.text) };
}

// ---- scope words for the app (it resolves them to origins; the gateway names no origin itself) ----
// Host-like token (name.tld, optional path), bounded so the test stays linear; text is tokenised first, punctuation trimmed by loops (no `+$` regex).
const HOSTLIKE = /^[a-z0-9][a-z0-9.-]{0,78}\.[a-z]{2,24}(?:[/?#:].{0,200})?$/i;
const PUNCT = '.,;:!?)"\'»«(';
const trim = (t) => { let a = 0, b = t.length; while (a < b && PUNCT.includes(t[a])) a += 1; while (b > a && PUNCT.includes(t[b - 1])) b -= 1; return t.slice(a, b); };
export const looksLikeHost = (token) => { const t = trim(String(token).slice(0, 301)); return t.length <= 300 && HOSTLIKE.test(t); };
const hostOf = (tok) => { const t = trim(tok); let end = t.length; for (const c of '/?#:') { const i = t.indexOf(c); if (i >= 0 && i < end) end = i; } return t.slice(0, end).toLowerCase(); };
const hostsIn = (text) => String(text).split(/\s+/).slice(0, 400).filter(looksLikeHost).map(hostOf);
const WORDS = /\b(?:gmail|google\s+mail|telegram|board|github|twitter|x\.com|linkedin|discord|hier|diese[rn]?\s+(?:seite|tab)|dieser\s+seite)\b/gi;
export function scopeWordsOf(text) {
  const t = String(text ?? '');
  const out = new Set();
  for (const h of hostsIn(t)) out.add(h);
  for (const m of t.matchAll(WORDS)) out.add(m[0].toLowerCase().replace(/\s+/g, ' '));
  if (/\bx\b/i.test(t) && /\b(?:auf|bei|in)\s+x\b/i.test(t)) out.add('x');
  return [...out].filter((w) => w.length <= 80).slice(0, 12);
}

// ---- stop words: acted on partials, the echo filter is skipped (a false stop is safe) ----
const STOP = /\b(?:stopp?\w*|halt|abbrech\w+|abbruch|hör\s+auf|nicht\s+weiter|aufhören)\b/i;
export const isStopWord = (text) => STOP.test(String(text ?? ''));
