// What an utterance is about, decided without a model call: only a real question about a topic starts research or an early drawing.
// Florian's chatter ("Okay, warte. Eigentlich stimmt das nicht ...") and talk about the screen or the session itself do not (trace a#7f54a5).
//   'screen'  -> look_at_screen answers; no knowledge search, no drawing
//   'session' -> session_trace answers (protocol, troubleshooting, "warum hat das nicht geklappt")
//   'topic'   -> a real question: research and the early drawing may start
//   'none'    -> chatter, an acknowledgement or a fragment
const SCREEN_RE = /\bbildschirm\b|\bmonitor\b|\bsiehst du\b|\bsehen kannst\b|\bkannst du\b.{0,40}\b(?:sehen|erkennen|lesen)\b|\b(?:agent[- ]?)?(?:artifact|artefakt)[- ]?ids?\b|\bids?\b.{0,30}\b(?:sehen|siehst|sichtbar|lesen)\b|\ba#[0-9a-f]{6}\b|\bmarkier\w*|\bwas (?:ist|steht|bedeutet|sind)\b.{0,15}\b(?:hier|da|dort)\b|\bdiese[rsmn]? (?:zahl|id|seite|stelle|zeile|tabelle|spalte|grafik|meldung|fehlermeldung)\b|\bwas ich (?:hier |gerade )?sehe\b|\bshift-taste\b|\bkreis (?:gezeichnet|malen|zeichnen)\b/i;
const SESSION_RE = /\bprotokoll\w*|\bfehlerbehebung\b|\bablaufprotokoll\b|\bsession[- ]?trace\b|\b(?:diese|die|unsere|der) (?:sitzung|session)\b|\bwarum\b.{0,40}\b(?:nicht geklappt|nicht funktioniert|hakte|keine antwort|kam .{0,15}keine)\b|\bwieso\b.{0,40}\b(?:nicht geklappt|nicht funktioniert)\b/i;
// a sentence that opens like this and neither asks nor requests anything is talk, not a question
const CHATTER_START = /^\s*(?:okay|ok|naja|na ja|nein|ja|doch|also|hm+|ähm|äh|ach|genau|gut|so|stopp?|warte|moment|lass uns|lass mal|egal|jetzt|und|aber|dann|eigentlich)\b/i;
const CLAUSE_Q = /(?:^|[.!?,]\s*)(?:hm+\W+)?(?:was|wie|warum|wieso|wofür|wozu|welche[rsmn]?|wer|wo|wann)\b/i;
const REQUEST_RE = /\?|\bfrage\b|\berkl[aä]r\w*|\bzeig\w*|\bzeichn\w*|\bwie funktioniert|\bwas (?:ist|sind|bedeutet|macht|passiert)\b|\bwarum\b|\bwieso\b|\bwofür\b|\bwozu\b|\bwelche[rsmn]?\b|\bwer\b|\bwo\b|\bwann\b|\bwie (?:viel|viele|lang|oft|groß)\b|\bes geht darum\b|\bich möchte wissen\b|\bsag mir\b/i;

/** @returns {'screen'|'session'|'topic'|'none'} */
export function askKind(text) {
  const t = String(text ?? '').trim();
  if (!t) return 'none';
  if (SCREEN_RE.test(t)) return 'screen';
  if (SESSION_RE.test(t)) return 'session';
  if (t.split(/\s+/).length < 3) return 'none'; // "Und jetzt?", "Ja.", "Genau"
  if (CHATTER_START.test(t) && !/\?/.test(t) && !CLAUSE_Q.test(t) && !/\b(?:frage|erkl[aä]r\w*|zeig\w*|zeichn\w*)\b/i.test(t)) return 'none';
  return REQUEST_RE.test(t) || CLAUSE_Q.test(t) || t.length >= 60 ? 'topic' : 'none';
}

/** Research (knowledge_read, search_files, ...) or an early drawing makes sense only for a real question about a topic. */
export const worthResearch = (text) => askKind(text) === 'topic';
