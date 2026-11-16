// Answer guard for Gemini Live (job agent-desk-context-discovery-20261115, round 2, 16 Nov 2026). Live runs of 15 Nov: Gemini was right
// on 48 % of 27 fact questions and named a source in 19 %. Two causes, both seen in the traces:
// 1. CUT: after tool results the extended-thinking model spent 5,000-18,000 thinking tokens and its spoken answer ended mid-sentence
//    ("Das tägliche Research-GPU-Limit für die Tage vom 16.", a#dc1f7e; a#24a881, a#bb58ae). The turn was complete, nothing followed.
// 2. UNCHECKED: fact questions answered from the start overview without any tool, without a source, sometimes wrong ("6 Konten", q45).
// The session asks the model once per question to finish (1) or to check and name the source (2). Pure decisions, tested.

import { isPromiseOnly } from './noAnswer.js';

const END = /[.!?…]["”'»)\]]*$/;
// "vom 16." / "am 3." / "bis 18." ends with a dot but is a date in the middle of a sentence
const ORDINAL_END = /\b(?:vom|am|bis|zum|ab|seit|den|dem|der|zwischen|und)\s+\d{1,2}\.$/i;

/** The model's last words of a finished turn stop in the middle of a sentence. */
export function isCutOff(text) {
  const t = String(text ?? '').trim();
  if (t.length < 12) return false; // a lone word or a fragment of noise: the no-answer watchdog's business
  return !END.test(t) || ORDINAL_END.test(t);
}

const FACT = /\b(?:wie\s+(?:viele?|lange|hoch|oft|teuer|groß|weit|spät)|wann|welche[rsmn]?|wer|wo(?:mit|für|rauf)?|was\s+(?:habe|hab|hat|haben|hatte|hatten|ist|war|waren|sind|steht|stand|kostet|kostete|genau)|wieviele?|entschieden|beschlossen|gerechnet|vereinbart|abgemacht|gesagt)\b/i;
const SELF = /\b(?:wie\s+geht'?s|wer\s+bist\s+du|was\s+kannst\s+du|hörst\s+du\s+mich)\b/i;

// Yes/no questions about a rule or a figure (final round 16 Nov: "Sind die 6 Stunden ... eine Zusage an die Miner?" a#25fe9e, "Darf ich einem
// Modellautor sagen, dass ..." a#93cadf): a yes/no opening plus a number or a rule word. "Ist das klar?" stays no fact question.
const YES_NO = /^(?:sind|ist|war|waren|gilt|galt|darf|dürfen|muss|müssen|soll|sollen|habe|hab|hat|haben|hatte|hatten|gibt\s+es)\b/i;
const RULE_OR_FIGURE = /\d|\b(?:zusage|zugesagt|regel|erlaubt|verboten|darf|dürfen|entscheidung|entschieden|limit|grenze|frist|budget|kosten|preis|termin|vorlauf|freigabe|sagen|versprechen)\b/i;

/** A question about a fact of his work (number, date, decision, something said earlier): one the Desk should look up, not recall. */
export function isFactQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 400 || SELF.test(t)) return false;
  return FACT.test(t) || (YES_NO.test(t) && RULE_OR_FIGURE.test(t));
}

const SOURCE = /\b(?:laut|steht\s+(?:in|im|so)|aus\s+(?:der|dem|den|deiner|deinem|deinen|unserer|unserem)|quelle|entscheidungen?\s+vom|im\s+board|auf\s+dem\s+board|in\s+der\s+datenbank|datenbank|decisions|notiz|wissensnotiz|sitzung|protokoll|export|ledger|job-?ordner|state|result|chat|karte\s+\d+|festgehalten|nachgelesen)\b/i;

/** The answer says where it comes from. */
export const namesSource = (text) => SOURCE.test(String(text ?? ''));

// Sources the model really has without a tool: this conversation (the memory seed), the open explainer page and the screen. Every other
// source (decisions, board, notes, ledger, files) needs a lookup in this turn.
const CONTEXT_SOURCE = /\b(?:(?:in|aus|laut)\s+(?:diese[rm]?|unserer?|unserem|deiner?|deinem)\s+(?:sitzung|gespräch|unterhaltung|desk-sitzung)|(?:diese[rm]?|unserer?|unserem|deiner?|deinem|heutigen?)\s+(?:desk-)?sitzung|vorhin\s+gesagt|(?:auf|in|laut)\s+(?:der|dieser|deiner)\s+(?:erklär)?seite|(?:auf|laut)\s+(?:dem|deinem)\s+bildschirm)\b/i;
const NEGATED_SOURCE = /\bkeine\s+(?:genauen?\s+)?(?:quelle|informationen|angaben|daten)\b/i;

/**
 * The answer names a source that it can have without a tool call. Final live round of 16 Nov (gateway a6be2e3, traces a#e44b74 a#f99587
 * a#25fe9e a#93cadf a#0b79de): after PR #51 ("nenne die Quelle beim Namen") Gemini answered fact questions with NO tool and still named a
 * source ("Das steht in den Entscheidungen vom 14. November", "laut den Vorbereitungen zu Runde 2", "keine Quelle gefunden"); namesSource
 * let all five pass. A source the model did not read is invented, so with zero tools only these in-context sources count.
 */
export const namesContextSource = (text) => { const t = String(text ?? ''); return CONTEXT_SOURCE.test(t) && !NEGATED_SOURCE.test(t); };

export const CUT_NUDGE = (tail) => `(Hinweis vom Desk, nicht von Florian: Deine letzte Antwort brach mitten im Satz ab („…${String(tail ?? '').trim().slice(-60)}“). Sag Florian jetzt die vollständige Antwort in ein bis zwei kurzen Sätzen auf Deutsch, mit der Quelle am Ende, ohne Ankündigung. Rufe kein Werkzeug mehr auf, außer dir fehlt wirklich etwas.)`;
export const CHECK_NUDGE = '(Hinweis vom Desk, nicht von Florian: Du hast diese Faktenfrage ohne Nachschlagen beantwortet. Prüfe es jetzt mit search, bei mehreren Schritten mit research, ohne es anzukündigen. Sag dann auf Deutsch in einem Satz, ob es stimmt, und woher es stammt (nur eine Quelle, die das Werkzeug geliefert hat); stimmt es nicht, sag klar „Korrektur:“ und die richtige Antwort. Findest du nichts, sag das ehrlich.)';

/**
 * What to ask after a finished Gemini turn, or null. `state`: {question, tools, answer, last, nudged}.
 * Only once per question; only when nothing else runs and Florian is not speaking (checked by the caller).
 */
export function guardDecision(state) {
  if (!state?.question || state.nudged) return null;
  if (isCutOff(state.last)) return { kind: 'cut', text: CUT_NUDGE(state.last) };
  const answer = String(state.answer ?? '').trim();
  // tools === 0: a looked-up source ("laut DECISIONS", "steht im Board") cannot be true, so only a source in context exempts the answer
  // the session joins finals without punctuation ("Ich schaue kurz" + "Dazu habe ich keine Quelle gefunden.", a#e44b74): the last final alone counts too
  const substantive = !isPromiseOnly(answer) || (String(state.last ?? '').trim().length >= 20 && !isPromiseOnly(state.last));
  if (state.tools === 0 && answer.length >= 20 && substantive && isFactQuestion(state.question) && !namesContextSource(answer)) return { kind: 'check', text: CHECK_NUDGE };
  return null;
}
