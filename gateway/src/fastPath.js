// The illustrator's fast path (round 6): for the question types where the data source is obvious, the tool calls are
// decided by code, so the first model round already sees the facts (saves one model round of ~3-5 s).
//   money question            -> ledger_spend (groupBy + period from the words)
//   architecture of agent desk -> code_outline of the repo directories
//   architecture/structure of X -> knowledge_read X
//   any other question         -> knowledge_read + search_files for its content words
import { knowledgeIndex } from './knowledge.js';

const MONEY_RE = /geld|ausgab|ausgeg|kosten|bezahl|zahlung|ledger|euro|€|budget|teuer|rechnung|buchung|überweis|einnahm|spend/i;
const ARCH_RE = /architektur|aufbau|struktur|komponenten|bausteine|zusammenspiel/i;
// tax / emission / conversion talk mentions "Euro" but is a process question, not a ledger one (critic r6, Florian's tax sentence)
const PROCESS_TOPIC_RE = /steuer|rücklage|emission|tranche|umwandel/i;
const SPEND_RE = /ausgab|ausgeg|wofür|kosten|bezahl|ledger|rechnung|buchung/i;
const DESK_RE = /desk|gateway|bridge|canvas|voice|illustrator|frontend|web-?client/i;
const REPO = '/home/flori/work/agent-desk';
const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];

export const isMoneyQuestion = (text) => MONEY_RE.test(String(text ?? '')) && !(PROCESS_TOPIC_RE.test(String(text ?? '')) && !SPEND_RE.test(String(text ?? '')));
const DESK_STATUS_RE = /voice[- ]?provider|sprach[- ]?provider|(?:provider|anbieter)\W.{0,40}(?:status|guthaben|läuft|laufen|funktionier)|(?:status|guthaben|credit)\W.{0,40}(?:provider|grok|gpt-?live|gemini|xai|openai)|welche modelle|modelle?\W.{0,30}(?:desk|voice|stimme|zeichner)|(?:grok|gpt-?live|gemini|xai|openai)\W.{0,40}(?:guthaben|credit|status|läuft|funktioniert|verfügbar)|bridge[n]?\W.{0,30}(?:verbunden|status|läuft|online)|desk[- ]?status|status (?:vom|des|von) (?:agent[- ]?)?desk/i;
export const isDeskStatusQuestion = (text) => DESK_STATUS_RE.test(String(text ?? ''));
export const isArchitectureQuestion = (text) => ARCH_RE.test(String(text ?? ''));

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const monthRange = (year, month) => ({ from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(lastDay(year, month))}` });

/** {from?, to?} for "im Oktober", "diesen Monat", "letzten Monat", "heute"; {} for all time. `today` = {year, month, day} (Berlin). */
export function periodOf(text, today) {
  const t = String(text ?? '').toLowerCase();
  const name = MONTHS.findIndex((m) => t.includes(m));
  if (name >= 0) {
    const year = Number(/\b(20\d{2})\b/.exec(t)?.[1]) || (name + 1 > today.month ? today.year - 1 : today.year);
    return monthRange(year, name + 1);
  }
  if (/(letzten?|vergangenen?|vorigen?) monat/.test(t)) {
    const month = today.month === 1 ? 12 : today.month - 1;
    return monthRange(today.month === 1 ? today.year - 1 : today.year, month);
  }
  if (/(diesen?|aktuellen?|laufenden?) monat/.test(t)) return monthRange(today.year, today.month);
  if (/\bheute\b/.test(t)) {
    const day = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
    return { from: day, to: day };
  }
  return {};
}

export function groupByOf(text) {
  const t = String(text ?? '').toLowerCase();
  if (/gegenpartei|empfänger|an wen|lieferant|anbieter|firmen|wer bekommt|pro (?:firma|anbieter)/.test(t)) return 'counterparty';
  if (/pro monat|monatlich|je monat|verlauf|entwicklung|monat für monat|über die monate/.test(t)) return 'month';
  return 'category';
}

/** The Berlin calendar day of `date`. */
export function berlinToday(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const STOP = new Set('wie was wer wo wann warum wieso weshalb wozu welche welcher welches welchen der die das den dem des ein eine einen einem einer und oder aber auch noch nur mal mir mich dir dich uns wir ich du ist sind war waren wird werden hat haben kann können soll sollen funktioniert funktionieren erklär erkläre erklären zeig zeige zeichne zeichnen bitte kurz genau eigentlich denn doch dann diese dieser dieses vom von für mit bei nach über unter auf aus zum zur zur im in an am es sich als wie viel viele wieviel'.split(' '));

/** Search words of a question: the content words, at most 4 ("Wie funktioniert die Video-Sendeblockierung?" -> "video sendeblockierung"). */
export function keywordsOf(question) {
  const words = String(question ?? '').toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 4).join(' ');
}

// Round 10 (critic r9 C3): questions about the desk's own features have their source in the desk's own code; a word search
// found another project's magic-link brief (System1) for "Login-Link-Ablauf".
const DESK_FEATURES = [
  { re: /log-?in[- ]?link|anmelde[- ]?link|magic[- ]?link|zugangscode|access[- ]?code|einlogg|desk[- ]?login|login\W{0,3}(?:vom|des|beim) (?:agent[- ]?)?desk/i, files: ['gateway/src/auth.js'] },
];
const OTHER_PROJECT_RE = /system ?1|\bs1m?\b|pdfmint|docmint|mailmint|benchmark ?heaven|jevbench/i;
export const deskFeatureFiles = (text) => (OTHER_PROJECT_RE.test(String(text ?? '')) ? [] : DESK_FEATURES.find((f) => f.re.test(String(text ?? '')))?.files.map((f) => `${REPO}/${f}`) ?? []);

// Round 11 (critic r10 defect 2): "Es geht darum, dass unser Subnetz … Honoraremissionen emittiert …" searched the knowledge
// for "geht darum dass unser" and the early drawing came from the transcript alone (with invented names). The topic
// is found in the knowledge index instead: its sections ("## slug — title" + summary) are scored by the question's words.
const TOPIC_STOP = new Set([...STOP, ...'geht darum dass unser unsere unseren meine meinen meinem meiner muss müssen momentan ungefähr regelmäßig damit davon dabei immer gerade also eben ganz sehr etwas weil wenn dann sowie andere anderen frage fragen über habe hast hat ständig erhalten erhaltene notwendigkeit sich ihre ihren seine seinen'.split(' ')]);
const stem = (w) => w.slice(0, 5);
/** The knowledge topic (index slug) a question is about, or null: score >= 2 and a clear winner. */
export function knowledgeTopicOf(question, index = knowledgeIndex()) {
  const split = (t) => String(t).toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => w.length >= 4 || /^\d{2,}$/.test(w));
  const sections = [...String(index ?? '').matchAll(/^##\s+([a-z0-9-]+)\s+[—–-]+\s+(\S.*)?\n([\s\S]*?)(?=^##\s|(?![\s\S]))/gm)].map((m) => ({ slug: m[1], head: split(`${m[1].replace(/-/g, ' ')} ${m[2] ?? ''}`), words: split(m[3]) }));
  if (!sections.length) return null;
  const words = [...new Set(String(question ?? '').toLowerCase().split(/[^a-z0-9äöüß]+/).filter((w) => (w.length >= 4 && !TOPIC_STOP.has(w)) || /^\d{2,}$/.test(w)))];
  if (!words.length) return null;
  const hit = (w, s) => (/^\d+$/.test(w) ? s.some((x) => new RegExp(`(?<!\\d)${w}(?!\\d)`).test(x)) : s.some((x) => x.length >= 5 && (w.includes(x) || x.includes(w) || (w.length >= 5 && stem(x) === stem(w)))));
  // a word of the topic's name / title counts twice ("Server" -> servers), one of its summary once
  const ranked = sections.map((sec) => ({ slug: sec.slug, score: words.reduce((n, w) => n + (hit(w, sec.head) ? 2 : hit(w, sec.words) ? 1 : 0), 0) })).sort((a, b) => b.score - a.score);
  return ranked[0].score >= 2 && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].slug : null;
}

/** [{name, args}] the illustrator runs before its first model call; [] when the question has no obvious source. */
export function fastCalls(question, { now = new Date(), index } = {}) {
  const text = String(question ?? '');
  const featureFiles = deskFeatureFiles(text);
  if (featureFiles.length) return featureFiles.map((path) => ({ name: 'read_file', args: { path } }));
  if (isArchitectureQuestion(text)) {
    if (DESK_RE.test(text)) {
      const dirs = [];
      if (/gateway/i.test(text)) dirs.push('gateway/src');
      if (/bridge/i.test(text)) dirs.push('bridge/src');
      if (/frontend|web|canvas|client/i.test(text)) dirs.push('web/src');
      if (!dirs.length) dirs.push('gateway/src', 'bridge/src', 'web/src');
      // the gateway first, and the desk's real model facts (desk_status) next to the code (critic r8 C3)
      return [...dirs.map((d) => ({ name: 'code_outline', args: { path: `${REPO}/${d}` } })), { name: 'desk_status', args: {} }];
    }
    const topic = (/\b(?:von|vom)\s+(?:dem\s+|der\s+|den\s+)?([^?.!]{3,60})/i.exec(text) ?? /\b(?:des|der|für|zu|über)\s+(?:dem\s+|der\s+|den\s+)?([^?.!]{3,60})/i.exec(text))?.[1]?.trim();
    return topic ? [{ name: 'knowledge_read', args: { topic } }] : [];
  }
  if (isDeskStatusQuestion(text)) return [{ name: 'desk_status', args: {} }];
  if (isMoneyQuestion(text)) {
    return [{ name: 'ledger_spend', args: { groupBy: groupByOf(text), ...periodOf(text, berlinToday(now)) } }];
  }
  // Any other explanatory question: the desk knowledge and a file search for its words, in parallel (what the agent would call first anyway).
  // A question about a topic of the knowledge index reads that topic (round 11), so the early drawing starts from its facts.
  const words = keywordsOf(text);
  const topic = knowledgeTopicOf(text, index);
  if (topic) return [{ name: 'knowledge_read', args: { topic } }, ...(words ? [{ name: 'search_files', args: { query: words, scope: 'all', maxHits: 8 } }] : [])];
  return words ? [{ name: 'knowledge_read', args: { topic: words } }, { name: 'search_files', args: { query: words, scope: 'all', maxHits: 8 } }] : [];
}
