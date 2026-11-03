// Pure decisions of the no-answer watchdog and the stale check (incident 2 Nov 2026: a question got silence for five minutes).
import { isFiller } from './transcript.js';

export const RECOVERY_LEAD = '(Hinweis vom Desk, nicht von Florian: Florian wartet noch auf eine Antwort. Beantworte jetzt seine Frage kurz auf Deutsch. Fehlt dir etwas, rufe das passende Werkzeug jetzt wirklich auf, statt es nur anzukündigen.)';

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}_.-]{2,}/gu;
const STOP = new Set(['der', 'die', 'das', 'und', 'oder', 'ist', 'ein', 'eine', 'was', 'wie', 'wer', 'von', 'mit', 'für', 'the', 'and', 'for', 'query', 'topic', 'name', 'path', 'limit']);
const words = (text) => new Set((String(text ?? '').toLowerCase().match(TOKEN) ?? []).filter((w) => !STOP.has(w)));
const overlaps = (a, b) => [...a].some((w) => b.has(w));

/**
 * Only positive evidence makes a call old: its arguments fit the previous question and not the current one. No previous question (the
 * greeting was interrupted), an empty argument list or anything unclear counts as current: an answer too many beats a question left in silence.
 */
export function belongsToOldQuestion(args, previous, current) {
  const given = words(Object.values(args ?? {}).filter((v) => typeof v === 'string' || typeof v === 'number').join(' '));
  if (!given.size) return false;
  const prev = words(previous);
  if (!prev.size) return false;
  return overlaps(given, prev) && !overlaps(given, words(current));
}

/** The assistant text names something of the question. */
export const fitsQuestion = (text, question) => overlaps(words(text), words(question));

const CLOSING = /^(?:ja|nein|ok|okay|gut|danke|genau|hm+|mhm|ah|aha|ach so|alles klar|passt|super|tschüss|ciao|bye|hallo|hi)(?:\s+(?:danke|schön|gut|klar|genau))?[.!?]*$/i;
/** Short acknowledgements and noise need no answer; everything else with at least two words, or a question mark, does. */
export function needsAnswer(text) {
  const t = String(text ?? '').trim();
  if (!t || CLOSING.test(t)) return false;
  return /\?/.test(t) || t.split(/\s+/).length >= 2;
}

const ACK = /^(?:(?:okay|ok|gut|alles klar|verstanden|klar|gerne|natürlich)[,.!]?|ich habe (?:deine|die) frage\b[^.!?]{0,80}[.!?…]?|ich (?:kümmere|mache) mich\b[^.!?]{0,80}[.!?…]?)$/i;
const PROMISE = /\b(?:ich\s+(?:schaue?|seh[e]?|prüfe?|lese?|suche?|hole?|checke?|recherchiere?|gucke?|werfe?|zeichne?|male?|lade?|öffne?)|lass\s+mich|einen\s+moment|moment|kommt\s+gleich)\b/i;
// A finished announcement is no answer either (a#624670: "Ich zeichne dir das auf." / "Ich lese den Volltext." ended the turn). Only a BARE
// announcement counts: short, no comma/colon, no conjunction, no negation, no digit ("Ich zeichne kein Diagramm, weil ..." is an answer).
const ANNOUNCED = /^(?:ich\s+(?:schaue?|prüfe?|lese?|suche?|hole?|checke?|recherchiere?|gucke?|werfe?|zeichne?|male?|lade?|öffne?)\b|[^.!?…]{0,30}\bkommt\s+gleich)/i;
const FAILED_STEP = /^die\s+suche\s+(?:lieferte|ergab|brachte)\s+(?:nichts|keine?\b)/i;
const NOT_BARE = /[,;:]|\b(?:nicht|kein\w*|nie|niemals|weil|aber|denn|dass|damit|sondern|obwohl|und|oder|sie|er|es)\b|\d/i;
const LEAD_IN = /^(?:ok|okay|gut|alles klar|ja)[,.!]?\s*/i;
const bareAnnouncement = (part) => { const p = part.replace(LEAD_IN, ''); return p.length <= 45 && ANNOUNCED.test(p) && !NOT_BARE.test(p); };

/** Nothing but announcements so far ("Ich habe deine Frage verstanden. Ich schaue sofort, was in der neuesten Mail…"), no matter whether cut off. */
export function isPromiseOnly(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const parts = t.slice(0, 600).match(/[^.!?…]+[.!?…]*/g) ?? [t];
  return parts.every((p, i) => {
    const part = p.trim();
    if (ACK.test(part) || isFiller(part.slice(0, 200))) return true;
    if (bareAnnouncement(part)) return true;
    if (parts.length > 1 && FAILED_STEP.test(part)) return true; // a failed search is no answer only while more of the turn follows or precedes it
    const open = i === parts.length - 1 && !/[.!?…]$/.test(part);
    return open && (part.length < 25 || (part.length < 90 && PROMISE.test(part))); // an unfinished sentence: too short to judge, or a promise being spoken
  });
}

/** "Which is the newest mail from X" belongs to mail_search + mail_read (knowledge_read knows no mails). */
export function routingHint(question) {
  if (!/\b(?:e-?mails?|mails?)\b/i.test(String(question ?? ''))) return '';
  return 'HINWEIS: Bei dieser Frage geht es um eine Mail. Rufe jetzt mail_search mit dem Absender oder Thema als query auf (neueste zuerst) und dann mail_read mit account und uid des obersten Treffers.';
}
