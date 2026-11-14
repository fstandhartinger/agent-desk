// Canvas forms (14 Nov 2026, Florian in session a#36e5fa): the picture's JOB picks its form, and low reading load is a
// checked rule. Pure helpers, no model calls:
// - formOf({question, answer}): what the picture has to do (points, distribution, comparison, trend, number, process, ...)
// - numberFacts(text): the numbers of the conversation as digits ("fünfundsiebzig Prozent" -> 75 %) with their context and,
//   for a split in percent, the remainder to 100 %, so the drawing model gets the numbers instead of inventing shapes
// - readingLoad(spec): word budgets per label / per picture; formError(spec, form): a flow where no process is explained
// - pointsFromAnswer(answer): a deterministic points list from "erstens / zweitens / drittens" (fallback, tests)
// - attachCues(spec, answer): keeps a point's cue only when the spoken answer contains it (speech-synced reveal)

// ---------------------------------------------------------------------------------------------------------------
// German number words -> numbers ("tausend", "fünfundsiebzig", "zweihundertfünfzig", "dreißig")

const UNITS = { null: 0, ein: 1, eins: 1, eine: 1, zwei: 2, zwo: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9 };
const TEENS = { zehn: 10, elf: 11, zwölf: 12, dreizehn: 13, vierzehn: 14, fünfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18, neunzehn: 19 };
const TENS = { zwanzig: 20, dreißig: 30, dreissig: 30, vierzig: 40, fünfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };

/** 0..99 from a word ("fünfundsiebzig", "siebzehn", "drei"), or null. */
function below100(w) {
  if (w in TEENS) return TEENS[w];
  if (w in TENS) return TENS[w];
  if (w in UNITS) return UNITS[w];
  const m = /^(ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun)und(zwanzig|dreißig|dreissig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig)$/.exec(w);
  return m ? UNITS[m[1]] + TENS[m[2]] : null;
}
/** 0..999 ("zweihundertfünfzig", "hundert", "dreizehn"), or null. */
function below1000(w) {
  if (!w) return 0;
  const at = w.indexOf('hundert');
  if (at < 0) return below100(w);
  const head = w.slice(0, at);
  const tail = w.slice(at + 7);
  const h = head ? below100(head) : 1;
  const t = tail ? below100(tail.replace(/^und/, '')) : 0;
  return h === null || t === null || h > 9 ? null : h * 100 + t;
}
/** A whole German number word up to 999 999 ("tausend", "zweitausendfünfhundert"), or null. "ein"/"eine" alone are no numbers. */
export function germanNumber(word) {
  const w = String(word ?? '').toLowerCase();
  if (!w || /^(?:ein|eine|eins)$/.test(w)) return w === 'eins' ? 1 : null;
  const at = w.indexOf('tausend');
  if (at < 0) return below1000(w);
  const head = w.slice(0, at);
  const k = head ? below1000(head) : 1;
  const rest = below1000(w.slice(at + 7));
  return k === null || rest === null ? null : k * 1000 + rest;
}

const NUMBER_WORD_RE = /(?<![\p{L}])(?:(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|und|zwanzig|dreißig|dreissig|vierzig|fünfzig|sechzig|siebzig|achtzig|neunzig|null|zwo)+|siebzehn|sechzehn|eins)(?![\p{L}])/giu;

/** The text with German number words written as digits ("tausend Alpha" -> "1000 Alpha"). */
export function digitize(text) {
  return String(text ?? '').replace(NUMBER_WORD_RE, (m) => {
    const n = germanNumber(m);
    return n === null || /^und$/i.test(m) ? m : String(n);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Numbers of the conversation for the drawing model

// a change or a rate, not a share: "stieg um 5 %", "lag 2023 bei 6 Prozent", "von 3 auf 5 %"
const CHANGE_RE = /(?<![\p{L}])(?:stieg\w*|steigt|gestiegen|fiel|fällt|gefallen|sank|sinkt|gesunken|wuchs|wächst|gewachsen|lag\b|lagen|inflation|rendite|zins\w*|quote|rate|marge|von\s+\d[\d.,]*\s*(?:%|prozent)?\s+auf)(?![\p{L}])/iu;
// "75 Prozent an den Champion", "10 % für den Zweiten": a share that goes to someone
const PCT_TO_RE = /\d\s*(?:%|prozent)\s+(?:an|für|gehen an|geht an)\s/i;
const PCT_RE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(?:%|prozent\b)/gi;
const sentencesOf = (text) => String(text ?? '').replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+(?=[A-ZÄÖÜ0-9„"])/).map((s) => s.trim()).filter(Boolean);
const num = (s) => Number(String(s).replace(',', '.'));

/**
 * The sentences of `text` that carry numbers, with number words as digits, plus a remainder line for a split in percent
 * whose parts stay under 100 % ("70 %, 10 %, 5 %" -> "Summe 85 %, Rest bis 100 %: 15 %"). '' when the text has no numbers.
 */
export function numberFacts(text, { max = 8, split = false } = {}) {
  const lines = [];
  for (const raw of sentencesOf(text)) {
    const s = digitize(raw);
    if (!/\d/.test(s)) continue;
    let line = `- ${s.length > 240 ? `${s.slice(0, 239)}…` : s}`;
    const pcts = [...s.matchAll(PCT_RE)].map((m) => num(m[1])).filter((n) => n > 0 && n <= 100);
    // a sentence that lists parts after "N Prozent": "75 % an den Champion, 17 an den zuletzt Entthronten, 8 an den davor"
    const after = pcts.length === 1 ? [...s.slice(s.search(PCT_RE)).matchAll(/(?:,|und)\s*(\d+(?:[.,]\d+)?)\s+(?:an|für|bekomm|erhält|geh)/gi)].map((m) => num(m[1])) : [];
    const parts = [...pcts, ...after];
    const sum = Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100;
    const share = (split || SPLIT_RE.test(s) || PCT_TO_RE.test(s)) && !CHANGE_RE.test(s);
    if (share && parts.length >= 2 && sum < 100 && sum > 0) line += ` [Desk gerechnet: Summe ${sum} %, Rest bis 100 %: ${Math.round((100 - sum) * 100) / 100} % - als "Rest offen" zeigen, außer das Gespräch sagt, wer ihn bekommt]`;
    else if (share && parts.length >= 2 && Math.abs(sum - 100) < 0.01) line += ' [Desk gerechnet: Summe 100 %]';
    lines.push(line);
    if (lines.length >= max) break;
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The picture's job

const ORDINAL_RE = /(?<![\p{L}])(?:erstens|zweitens|drittens|viertens|fünftens|zum einen|zum anderen|zum dritten|first(?:ly)?|second(?:ly)?|third(?:ly)?)(?![\p{L}])/giu;
const COUNTED_RE = /(?<![\p{L}])(?:zwei|drei|vier|fünf|2|3|4|5)\s+(?:(?:wichtige|zentrale|einfache|gute|klare|kurze|große|einzelne|konkrete|weitere|zentralen|wichtigen)\s+)?(?:gründe|punkte|vorteile|nachteile|argumente|aspekte|dinge|regeln|ideen|kernpunkte|überlegungen|ziele|bedingungen|lehren|probleme|unterschiede|säulen|bausteine|teile)(?![\p{L}])|(?<![\p{L}])(?:zweifach|dreifach|vierfach)(?![\p{L}])/iu;
const WHY_RE = /(?<![\p{L}])(?:warum|wieso|weshalb|weswegen|gründe?|begründ\w*|überlegung\w*|vorteile?|nachteile?|argument\w*|was spricht|wofür ist|worauf (?:muss|sollte)|was bringt|was ist (?:genau )?der (?:vorteil|sinn|punkt)|was sind die|was heißt das|was bedeutet das|kernpunkte|zusammenfass\w*|worum geht)(?![\p{L}])/iu;
const PROCESS_RE = /(?<![\p{L}])(?:wie funktioniert|wie läuft|ablauf\w*|was passiert(?:,)? wenn|schritt(?:e|en)?|prozess\w*|reihenfolge|workflow|wie geht (?:das|man)|wie kommt|entsteh\w*|wie (?:wird|werden)\b|was passiert)(?![\p{L}])/iu;
const BRANCH_RE = /(?<![\p{L}])(?:wenn\b[^.]{3,80}\b(?:sonst|ansonsten|andernfalls)|falls\b[^.]{3,80}\b(?:sonst|ansonsten|andernfalls)|entweder\b[^.]{3,80}\boder|je nachdem|bei (?:ja|nein)|im fehlerfall|scheitert\w*|abgelehnt|verzweig\w*)(?![\p{L}])/iu;
const SPLIT_STRONG_RE = /(?<![\p{L}])(?:verteil\w*|aufteil\w*|aufgeteilt|anteile?n?|aufschlüssel\w*|zusammensetz\w*|wohin geht|wofür geht|wie viel (?:geht|bekommt)|töpfe|split|podium)(?![\p{L}])/iu;
const SPLIT_WEAK_RE = /(?<![\p{L}])(?:geteilt|geht an|gehen an|bekommt|bekommen|erhält|erhalten|fließ\w*|share|platz (?:zwei|drei|2|3))(?![\p{L}])/iu;
const SPLIT_RE = new RegExp(`${SPLIT_STRONG_RE.source}|${SPLIT_WEAK_RE.source}`, 'iu');
const COMPARE_RE = /(?<![\p{L}])(?:vergleich\w*|gegenüber|versus|vs\.?|im unterschied|unterschied\w*|mehr als|weniger als|besser als|schlechter als|günstiger|teurer|schneller|langsamer)(?![\p{L}])/iu;
const TREND_RE = /(?<![\p{L}])(?:verlauf|entwicklung|entwickelt|über die zeit|pro (?:tag|woche|monat|jahr)|monatlich|seit (?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|\d)|gestiegen|gesunken|trend|wachstum)(?![\p{L}])/iu;
const AMOUNT_Q_RE = /(?<![\p{L}])(?:wie hoch|wie viel\w*|wieviel\w*|wie groß|wie lange|welche summe|welcher betrag|wie teuer|was kostet|wie viele)(?![\p{L}])/iu;
const TIMELINE_RE = /(?<![\p{L}])(?:zeitleiste|zeitplan|termine|meilensteine|chronolog\w*|wann (?:passiert|kommt|ist)|bis wann|deadline)(?![\p{L}])/iu;
const ARCH_RE = /(?<![\p{L}])(?:architektur|aufbau|bestandteile|komponenten|module|wie ist .{0,30} aufgebaut|struktur)(?![\p{L}])/iu;

export const FORMS = ['points', 'distribution', 'comparison', 'trend', 'number', 'process', 'architecture', 'timeline'];
/** The kinds that do a form's job (first = default). */
export const FORM_KINDS = {
  points: ['points'],
  distribution: ['bar', 'pie', 'sankey', 'stat'],
  comparison: ['bar', 'table', 'stat', 'points'],
  trend: ['line', 'bar', 'timeline'],
  number: ['stat', 'bar', 'pie', 'sankey', 'points'],
  process: ['flow', 'sequence', 'timeline', 'points'],
  architecture: ['architecture', 'flow'],
  timeline: ['timeline', 'line', 'points'],
};

const countMatches = (re, text) => (String(text ?? '').match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;
const pctCount = (text) => [...digitize(text).matchAll(PCT_RE)].length;
const numberCount = (text) => (digitize(text).match(/(?<![\w.])\d[\d.,]*(?![\w])/g) ?? []).filter((t) => !/^(?:19|20)\d{2}$/.test(t)).length;

const ASK_RE = /\?|(?<![\p{L}])(?:erklär\w*|sag mir|zeig\w*|beschreib\w*|kannst du|könntest du|wie hoch|wie viel\w*|wieviel\w*)(?![\p{L}])/iu;
/**
 * The part of Florian's turn that asks: a long spoken turn (a monologue with a request at the end) is judged by its asking
 * sentences and its last two sentences, not by every word in it (his canvas critique named "Verteilung" as a wish, not as data).
 */
export function questionPart(text) {
  const t = String(text ?? '').trim();
  if (t.length <= 220) return t;
  const list = sentencesOf(t);
  const asking = list.filter((x) => ASK_RE.test(x));
  return [...new Set([...asking, ...list.slice(-2)])].join(' ');
}

/**
 * What the picture has to do for this turn: { form, strong, why } (form null = the words do not say).
 * `strong` = the ANSWER shows the form (an enumeration, a split in percent): a drawing of another form is rejected.
 */
export function formOf({ question = '', answer = '' } = {}) {
  const q = questionPart(question);
  const a = String(answer ?? '');
  // 1. the answer (what Florian hears) decides first
  if (a) {
    // review F3/F4: a split needs a split word (three changes or rates in percent are no split) and wins over "erstens 75 % ..."
    const pcts = pctCount(a);
    if (pcts >= 2 && (SPLIT_RE.test(a) || SPLIT_RE.test(q) || PCT_TO_RE.test(digitize(a))) && !CHANGE_RE.test(a)) return { form: 'distribution', strong: true, why: 'answer splits a whole in percent' };
    const ordinals = countMatches(ORDINAL_RE, a);
    if (ordinals >= 2 || (COUNTED_RE.test(a) && ordinals >= 1)) return { form: 'points', strong: true, why: 'answer enumerates points' };
    if (COUNTED_RE.test(a) && !PROCESS_RE.test(q)) return { form: 'points', strong: true, why: 'answer announces counted points' };
  }
  // 2. the question
  if (ARCH_RE.test(q)) return { form: 'architecture', strong: false, why: 'question about a structure' };
  if (TIMELINE_RE.test(q)) return { form: 'timeline', strong: false, why: 'question about dates' };
  if (TREND_RE.test(q)) return { form: 'trend', strong: false, why: 'question about change over time' };
  // a split without numbers in what was said (Florian wishing for "Verteilungen" in a critique) is no split to draw
  const noNumbers = Boolean(a) && numberCount(`${q} ${a}`) < 2;
  if ((pctCount(q) >= 2 || SPLIT_STRONG_RE.test(q)) && !noNumbers) return { form: 'distribution', strong: pctCount(q) >= 2, why: 'question about a split' };
  // live 14 Nov: "Nenn mir drei Gründe, warum die 1000 Alpha gleich geteilt werden" asks for reasons; "geteilt" alone is no split
  if (COUNTED_RE.test(q) || WHY_RE.test(q)) return { form: 'points', strong: false, why: 'question asks for reasons' };
  if (SPLIT_WEAK_RE.test(q) && numberCount(q) >= 2 && !noNumbers) return { form: 'distribution', strong: false, why: 'question about a split' };
  if (COMPARE_RE.test(q)) return { form: 'comparison', strong: false, why: 'question compares' };
  if (PROCESS_RE.test(q)) return { form: 'process', strong: false, why: 'question about a process' };
  if (AMOUNT_Q_RE.test(q)) {
    if (a && pctCount(a) >= 2) return { form: 'distribution', strong: true, why: 'amount answered as a split' };
    return { form: 'number', strong: false, why: 'question asks for an amount' };
  }
  if (WHY_RE.test(q)) return { form: 'points', strong: false, why: 'question asks for reasons' };
  // 3. the answer's shape when the question says nothing
  if (a && numberCount(a) >= 3 && SPLIT_RE.test(a)) return { form: 'distribution', strong: false, why: 'answer splits an amount' };
  if (a && BRANCH_RE.test(a) && PROCESS_RE.test(a)) return { form: 'process', strong: false, why: 'answer describes a process with a branch' };
  return { form: null, strong: false, why: 'no form words' };
}

/** A question whose picture should be drawn from the ANSWER (reasons, explanations): no early drawing from the question alone. */
export function answerFirst(question) {
  return formOf({ question }).form === 'points'; // a question without form words still draws early (fast); the answer may reform it
}

const FORM_DE = {
  points: 'Kernpunkte (kind "points": 2-5 Punkte, je 1-4 Wörter, nummeriert wenn gezählt wird)',
  distribution: 'Aufteilung einer Menge (kind "bar" mit "layout":"stacked" für EIN Ganzes mit <= 6 Teilen, "bar" zum Vergleichen der Teile, "sankey" für eine Aufteilung in mehreren Stufen, "pie" nur bei 2-4 Teilen)',
  comparison: 'Vergleich (kind "bar", sortiert; "table" nur bei mehreren Merkmalen)',
  trend: 'Verlauf über die Zeit (kind "line")',
  number: 'eine Zahl (kind "stat": 1-3 große Zahlen mit je 1-5 Wörtern)',
  process: 'Ablauf (kind "flow" nur mit echter Verzweigung; ein Ablauf ohne Abzweigung ist eine nummerierte Liste: kind "points")',
  architecture: 'Aufbau eines Systems (kind "architecture")',
  timeline: 'Zeitleiste (kind "timeline")',
};
/** The form line for the drawing model's request. */
export function formHint(f) {
  if (!f?.form) return 'Form: frei, nach dem Zweck des Bildes wählen (kein Ablaufdiagramm ohne echten Ablauf mit Abzweigung).';
  return `Form: ${FORM_DE[f.form]}${f.strong ? ' - die gesprochene Antwort hat genau diese Form, halte dich daran' : ''}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks on the drawing

const words = (text) => String(text ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
/** Word budgets of the SIMPLE view (Florian: "nur drei Wörter ... sehr, sehr kurze Sätze"). */
export const BUDGET = { title: 8, caption: 14, label: 4, note: 8, statLabel: 5, edge: 2, total: 45 };

/** Every visible text of the simple view with its budget: [{where, text, max}] (ids, sources and detail excluded). */
function visibleTexts(spec) {
  const out = [['title', spec.title, BUDGET.title], ['caption', spec.caption, BUDGET.caption]];
  (spec.points ?? []).forEach((p, i) => { out.push([`points[${i}].label`, p.label, BUDGET.label], [`points[${i}].note`, p.note, BUDGET.note]); });
  (spec.stats ?? []).forEach((s, i) => out.push([`stats[${i}].label`, s.label, BUDGET.statLabel]));
  (spec.items ?? []).forEach((it, i) => out.push([`items[${i}].label`, it.label, BUDGET.label]));
  (spec.nodes ?? []).forEach((n, i) => out.push([`nodes[${i}].label`, n.label, BUDGET.label]));
  (spec.edges ?? []).forEach((e, i) => out.push([`edges[${i}].label`, e.label, BUDGET.edge]));
  (spec.events ?? []).forEach((e, i) => out.push([`events[${i}].label`, e.label, BUDGET.label]));
  (spec.actors ?? []).forEach((a, i) => out.push([`actors[${i}].label`, a.label, BUDGET.label]));
  (spec.messages ?? []).forEach((m, i) => out.push([`messages[${i}].label`, m.label, BUDGET.label]));
  return out.filter(([, t]) => typeof t === 'string' && t.trim()).map(([where, text, max]) => ({ where, text, max }));
}

/** Words of the simple view (titles, captions, labels, notes; not table cells). */
export function wordCount(spec) {
  // review F6: table cells are not counted (a table is the form for many short cells; its size is limited to 5 rows)
  return visibleTexts(spec).reduce((n, t) => n + words(t.text), 0);
}

/** Short English reason when the simple view reads too long, else undefined. custom_svg is not counted. */
export function readingLoad(spec) {
  if (!spec || spec.kind === 'custom_svg') return undefined;
  for (const t of visibleTexts(spec)) {
    const n = words(t.text);
    if (n > t.max) return `${t.where} has ${n} words ("${t.text.slice(0, 40)}"), the budget is ${t.max}: say it in ${t.max} words or fewer, like a good slide`;
  }
  const total = wordCount(spec);
  if (total > BUDGET.total) return `the picture has ${total} words, the budget is ${BUDGET.total}: one idea per picture, shorter labels, drop notes or the caption (the full version can go into "detail")`;
  return undefined;
}

/** `text` without trailing characters of `chars` (no regex: a "[,:;.]+$" rescans a long run of them from every start). */
function trimTail(text, chars) {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

const clipWords = (text, n) => {
  const list = String(text ?? '').split(/\s+/).filter(Boolean);
  return list.length <= n ? text : trimTail(list.slice(0, n).join(' '), ',:;–-');
};
/** Deterministic fallback: every text cut to its budget, then notes and caption dropped until the total fits. */
export function trimLoad(spec) {
  if (!spec || spec.kind === 'custom_svg') return spec;
  const out = { ...spec, title: clipWords(spec.title, BUDGET.title) };
  if (out.caption) out.caption = words(out.caption) > BUDGET.caption ? undefined : out.caption;
  const cut = (list, key, max) => list?.map((x) => (x?.[key] ? { ...x, [key]: clipWords(x[key], max) } : x));
  if (out.points) out.points = cut(cut(out.points, 'label', BUDGET.label), 'note', BUDGET.note);
  if (out.stats) out.stats = cut(out.stats, 'label', BUDGET.statLabel);
  for (const key of ['items', 'nodes', 'events', 'actors', 'messages']) if (out[key]) out[key] = cut(out[key], 'label', BUDGET.label);
  if (out.edges) out.edges = cut(out.edges, 'label', BUDGET.edge);
  if (wordCount(out) > BUDGET.total && out.points) out.points = out.points.map(({ note, ...p }) => p);
  if (wordCount(out) > BUDGET.total) delete out.caption;
  if (wordCount(out) > BUDGET.total && out.edges) out.edges = out.edges.map(({ label, ...e }) => e);
  return out;
}

/** Has a flow a real branch (a decision box, or a box with two ways out)? */
export function hasBranch(spec) {
  const nodes = spec?.nodes ?? [];
  const edges = spec?.edges ?? [];
  return nodes.some((n) => n.shape === 'diamond') || nodes.some((n) => edges.filter((e) => e.from === n.id).length > 1);
}

/**
 * Short English reason when the drawing's kind does not do the picture's job, else undefined. Rules: a form shown by the
 * answer (strong) must be kept; a flow is only for a process (or has a real branch); a pie has at most 4 parts.
 */
export function formError(spec, f = {}) {
  if (!spec?.kind) return undefined;
  const allowed = f.form ? FORM_KINDS[f.form] : null;
  if (f.strong && allowed && !allowed.includes(spec.kind)) {
    return f.form === 'points'
      ? `the spoken answer is a list of points: draw kind "points" (2-5 points, each 1-4 words, "cue" = the words of the answer that start the point), not a ${spec.kind}`
      : `the spoken answer splits a whole (${f.why}): draw kind "bar" with "layout":"stacked" (one whole, <= 6 parts), "bar", "pie" (<= 4 parts) or "sankey" with the numbers from "Zahlen", not a ${spec.kind}`;
  }
  if (spec.kind === 'pie' && (spec.items?.length ?? 0) > 4) return 'a pie with more than 4 parts is hard to read: use kind "bar" ("layout":"stacked" for one whole)';
  return undefined;
}

/** A flow chart that explains no process and has no branch is a list in disguise (14 of 14 drawings on 14 Nov). */
export const isLinearNonProcess = (spec, f = {}) => spec?.kind === 'flow' && !['process', 'architecture'].includes(f.form) && !hasBranch(spec);

/**
 * The same content as a numbered points list: the boxes in the order of the arrows (start = the box nobody points to), edge
 * labels dropped, the highlight kept. Deterministic, no model round.
 */
export function flowToPoints(spec) {
  const nodes = spec.nodes ?? [];
  const edges = spec.edges ?? [];
  const next = new Map(edges.map((e) => [e.from, e.to]));
  const start = nodes.find((n) => !edges.some((e) => e.to === n.id)) ?? nodes[0];
  const order = [];
  for (let id = start?.id; id && !order.includes(id); id = next.get(id)) order.push(id);
  for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const points = order.map((id) => byId.get(id)).filter(Boolean).slice(0, 5).map((n) => ({ label: n.label, ...(n.tone && n.tone !== 'neutral' ? { tone: n.tone } : {}) }));
  const hi = spec.highlight && byId.get(spec.highlight)?.label;
  const { nodes: _n, edges: _e, direction: _d, groups: _g, detail: _detail, ...rest } = spec;
  return { ...rest, kind: 'points', style: 'numbered', points, ...(hi ? { highlight: hi } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------
// Points from the spoken answer

const norm = (text) => String(text ?? '').toLowerCase().replace(/[„“"'’.,:;!?()–—-]+/g, ' ').replace(/\s+/g, ' ').trim();
const ARTICLES = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'also', 'ist', 'sind', 'geht', 'es']);
const STRIP_START = /^(?:und\s+)?(?:erstens|zweitens|drittens|viertens|fünftens|zum einen|zum anderen|zum dritten)\b[\s,:]*/i;

/** A deterministic points spec body from an enumerating answer ("Erstens die Prüfbarkeit: ..."), or null (< 2 points). */
export function pointsFromAnswer(answer) {
  const text = String(answer ?? '').replace(/\s+/g, ' ');
  const starts = [...text.matchAll(ORDINAL_RE)];
  if (starts.length < 2) return null;
  const points = starts.slice(0, 5).map((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    const piece = text.slice(m.index, end);
    const cue = trimTail(piece.split(/\s+/).slice(0, 3).join(' '), ',:;.');
    const body = piece.replace(STRIP_START, '');
    const head = body.split(/[:.;—–]|,\s/)[0];
    const label = head.split(/\s+/).filter((w) => w && !ARTICLES.has(w.toLowerCase())).slice(0, 4).join(' ');
    const clean = trimTail(label, ',:;.');
    return clean ? { label: clean.charAt(0).toUpperCase() + clean.slice(1), cue } : null;
  }).filter(Boolean);
  return points.length >= 2 ? { kind: 'points', style: 'numbered', points } : null;
}

/** The spec with each point's cue kept only when the spoken answer contains it; sync "speech" when at least one cue is left. */
export function attachCues(spec, answer) {
  if (spec?.kind !== 'points' || !Array.isArray(spec.points)) return spec;
  const said = norm(answer);
  const points = spec.points.map((p) => {
    const cue = norm(p.cue);
    if (!cue || !said || !said.includes(cue)) { const { cue: _drop, ...rest } = p; return rest; }
    return p;
  });
  const synced = points.some((p) => p.cue);
  const { sync: _old, ...rest } = spec;
  return { ...rest, points, ...(synced ? { sync: 'speech' } : {}) };
}
