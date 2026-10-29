// Deterministic money visuals (docs/CANVAS.md "Geld-Visuals"): pie / bar / sankey items are built in code from the
// newest ledger_spend result, never typed by a model. The model only chooses kind, title, caption, highlight, the
// period and groupBy (by how it called ledger_spend). Pure functions, no I/O.
import { clean, LIMITS, parseNumber, slugify } from './canvas.js';
import { normalizeRef } from './sources.js';

export const EUR_UNIT = '€ (ca.)';
const SEPARATOR = '\n---\n';
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const round2 = (n) => Math.round(n * 100) / 100;
const norm = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim();

/** compactLedger's output ("{header json}\n---\nrow\nrow…") -> {header, rows, complete}; null when the header is unreadable. */
export function parseLedger(content) {
  const text = String(content ?? '');
  const cut = text.indexOf(SEPARATOR);
  let header;
  try { header = JSON.parse(cut < 0 ? text : text.slice(0, cut)); } catch { return null; }
  if (!header || typeof header !== 'object' || (!Array.isArray(header.totalsEurApprox) && !Array.isArray(header.totals))) return null;
  const rows = [];
  for (const line of (cut < 0 ? '' : text.slice(cut + SEPARATOR.length)).split('\n')) {
    const p = line.split(' | ');
    if (p.length < 5 || !/^\d{4}-\d{2}-\d{2}$/.test(p[0])) continue;
    const amount = /^(-?[\d.]+) ([A-Z]{3})(?: \(EUR ~(-?[\d.]+)\))?$/.exec(p[1].trim());
    if (!amount) continue;
    const kg = p.at(-1) === 'KG';
    const eur = amount[3] !== undefined ? Number(amount[3]) : amount[2] === 'EUR' ? Number(amount[1]) : null;
    rows.push({ date: p[0], counterparty: p[2], category: p.at(kg ? -2 : -1), eur });
  }
  const count = Number(header.entryCount ?? header.count);
  const complete = Number.isFinite(count) && rows.length === count && rows.length > 0;
  return { header, rows, complete, triples: triplesOf(header, rows, complete) };
}

/** Every (category, counterparty, EUR) the result carries: the header's full breakdown, else the rows when all are shown; null otherwise. */
function triplesOf(header, rows, complete) {
  if (Array.isArray(header.breakdown) && header.breakdown.length && header.breakdownComplete !== false) {
    const out = [];
    for (const c of header.breakdown) for (const [name, eur] of c.counterparties ?? []) if (Number.isFinite(eur)) out.push({ category: String(c.category), counterparty: String(name), eur });
    return out.length ? out : null;
  }
  if (!complete || rows.some((r) => r.eur === null)) return null;
  return rows.map((r) => ({ category: r.category, counterparty: r.counterparty, eur: r.eur }));
}

/**
 * The header field compactLedger adds to a ledger_spend result: for every category its counterparties with their EUR sum,
 * built from ALL entries (not only the rows that fit). At most `maxPairs` pairs; the smallest are folded into "weitere".
 * `entries` = bridge entries ({category, counterparty, eurApprox}). Returns {breakdown, breakdownComplete} or null.
 */
export function ledgerBreakdown(entries, maxPairs = 40) {
  const cats = new Map();
  for (const e of entries ?? []) {
    if (typeof e?.eurApprox !== 'number' || !Number.isFinite(e.eurApprox)) continue;
    const cat = String(e.category ?? '?');
    const cp = String(e.counterparty ?? '?');
    const m = cats.get(cat) ?? new Map();
    m.set(cp, (m.get(cp) ?? 0) + e.eurApprox);
    cats.set(cat, m);
  }
  if (!cats.size) return null;
  let pairs = [...cats].flatMap(([category, m]) => [...m].map(([name, eur]) => ({ category, name, eur: round2(eur) })));
  let complete = true;
  if (pairs.length > maxPairs) {
    complete = false;
    pairs.sort((a, b) => b.eur - a.eur);
    const rest = pairs.slice(maxPairs - 1);
    pairs = [...pairs.slice(0, maxPairs - 1), ...rest.map((p) => ({ ...p, name: `weitere (${p.category})` }))];
  }
  const out = new Map();
  for (const p of pairs) {
    const list = out.get(p.category) ?? [];
    const hit = list.find(([n]) => n === p.name);
    if (hit) hit[1] = round2(hit[1] + p.eur); else list.push([p.name, p.eur]);
    out.set(p.category, list);
  }
  const breakdown = [...out].map(([category, list]) => ({ category, sumEur: round2(list.reduce((s, [, v]) => s + v, 0)), counterparties: list.sort((a, b) => b[1] - a[1]) })).sort((a, b) => b.sumEur - a.sumEur);
  return { breakdown, breakdownComplete: complete };
}

/** [{label, key, value}] of the ledger's own aggregation, plus the unit. Prefers the EUR approximation. */
export function ledgerSeries(ledger) {
  const { header } = ledger;
  const pretty = (key) => {
    const m = header.groupBy === 'month' ? /^(\d{4})-(\d{2})$/.exec(String(key)) : null;
    return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : String(key);
  };
  let list;
  let unit;
  if (header.totalsEurApprox?.length) {
    list = header.totalsEurApprox.map((t) => ({ key: t.key, value: round2(t.sumEur) }));
    unit = EUR_UNIT;
  } else {
    const currencies = new Set((header.totals ?? []).map((t) => t.currency));
    if (currencies.size !== 1) return null;
    list = header.totals.map((t) => ({ key: t.key, value: round2(t.sum) }));
    unit = [...currencies][0];
  }
  list = list.filter((t) => Number.isFinite(t.value) && t.value > 0);
  if (header.groupBy === 'month') list.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return list.length ? { unit, list: list.map((t) => ({ ...t, label: clean(pretty(t.key), LIMITS.label) })) } : null;
}

/**
 * The ledger regrouped by `by` ("category" | "counterparty"): the header's own aggregation when it is that grouping, else
 * the (category, counterparty, EUR) triples of the result - only when they add up to the header's total. Null when the
 * result cannot carry that grouping.
 */
export function seriesBy(ledger, by) {
  const { header, triples } = ledger;
  if (!by || by === header.groupBy) return ledgerSeries(ledger);
  if (header.groupBy === 'month' || !triples || !header.totalsEurApprox?.length) return null;
  const own = ledgerSeries(ledger);
  const sums = new Map();
  for (const t of triples) sums.set(t[by], (sums.get(t[by]) ?? 0) + t.eur);
  const list = [...sums].map(([key, value]) => ({ key, value: round2(value) })).filter((t) => t.value > 0).sort((a, b) => b.value - a.value);
  const total = round2(list.reduce((sum, t) => sum + t.value, 0));
  if (!own || !list.length || Math.abs(total - round2(own.list.reduce((sum, t) => sum + t.value, 0))) > 0.05) return null;
  return { unit: EUR_UNIT, list: list.map((t) => ({ ...t, label: clean(t.key, LIMITS.label) })) };
}

/** Folds the tail into "Sonstige" so that `max` entries remain; the sum stays exact. */
function fold(list, max) {
  if (list.length <= max) return list;
  const head = list.slice(0, max - 1);
  const rest = list.slice(max - 1);
  return [...head, { key: 'Sonstige', label: 'Sonstige', value: round2(rest.reduce((s, t) => s + t.value, 0)), folded: rest.map((t) => t.key) }];
}

function topNames(rows, pick, filter, limit = 3) {
  const sums = new Map();
  for (const r of rows) {
    if (!filter(r)) continue;
    const name = pick(r);
    if (name) sums.set(name, (sums.get(name) ?? 0) + (r.eur ?? 0));
  }
  return [...sums].sort((a, b) => b[1] - a[1]).map(([name]) => name).slice(0, limit);
}

/** "u. a. Hub, UpCloud" for a category (rows may be partial), "Kategorie: GPU" for a counterparty. */
function detailOf(entry, by, ledger) {
  const { rows, complete, triples } = ledger;
  if (entry.folded) return undefined;
  const source = triples ?? rows;
  if (!source.length) return undefined;
  const exact = triples !== null || complete;
  if (by === 'category') {
    const names = topNames(source, (r) => r.counterparty, (r) => r.category === entry.key);
    const more = triples !== null && source.filter((r) => r.category === entry.key).length > names.length;
    return names.length ? clean(`${exact && !more ? '' : 'u. a. '}${names.join(', ')}`, LIMITS.detail) : undefined;
  }
  if (by === 'counterparty') {
    const names = topNames(source, (r) => r.category, (r) => r.counterparty === entry.key, 2);
    return names.length ? clean(`Kategorie: ${names.join(', ')}`, LIMITS.detail) : undefined;
  }
  return undefined;
}

function sankeyOf(series, ledger, by) {
  const { triples } = ledger;
  const total = round2(series.list.reduce((s, t) => s + t.value, 0));
  const used = new Set(['gesamt']);
  const nodeId = (label) => {
    const base = slugify(label, 'knoten').slice(0, 36);
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
  const nodes = [{ id: 'gesamt', label: `Gesamt ${total.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }];
  const links = [];
  const level1 = fold(series.list, 8);
  const deep = by === 'category' && triples !== null;
  level1.forEach((entry, index) => {
    const id = nodeId(entry.label);
    nodes.push({ id, label: entry.label });
    links.push({ from: 'gesamt', to: id, value: entry.value });
    if (!deep || entry.folded || index >= 4) return;
    const sums = new Map();
    for (const r of triples) if (r.category === entry.key) sums.set(r.counterparty, (sums.get(r.counterparty) ?? 0) + r.eur);
    const ranked = [...sums].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 2);
    const rest = round2(entry.value - top.reduce((s, [, v]) => s + round2(v), 0));
    if (!top.length || Math.abs(round2([...sums.values()].reduce((s, v) => s + v, 0)) - entry.value) > 0.05) return; // rows do not add up to the total: stay on level 1
    for (const [name, value] of top) {
      const child = nodeId(name);
      nodes.push({ id: child, label: clean(name, LIMITS.label) });
      links.push({ from: id, to: child, value: round2(value) });
    }
    if (rest > 0.01) {
      const child = nodeId(`weitere ${entry.label}`);
      nodes.push({ id: child, label: clean(`Weitere (${entry.label})`, LIMITS.label) });
      links.push({ from: id, to: child, value: rest });
    }
  });
  return { nodes, links, unit: series.unit };
}

/**
 * The deterministic body for a money chart, or null when the ledger result cannot carry it.
 * `kind` ∈ pie | bar | sankey; the result replaces items / links / nodes / unit of the model's spec.
 * `by` = the grouping to show (default: the ledger's own); a sankey with `by` "category" gets the counterparty level.
 */
export function moneyBody(ledger, kind, { by } = {}) {
  const grouping = by ?? ledger.header.groupBy;
  const series = seriesBy(ledger, grouping) ?? (by ? null : ledgerSeries(ledger));
  if (!series) return null;
  if (kind === 'sankey') return sankeyOf(series, ledger, grouping);
  const list = fold(series.list, LIMITS.items);
  return { items: list.map((e) => ({ label: e.label, value: e.value, ...(detailOf(e, grouping, ledger) ? { detail: detailOf(e, grouping, ledger) } : {}) })), unit: series.unit };
}

// ---------------------------------------------------------------------------------------------------------------
// Which grouping does a chart want, and how do title / caption follow the rebuilt body (critic r6: C3 g, f).

const CATEGORY_WORD = /kategori/i;
const COUNTERPARTY_WORD = /gegenpart|empfänger|anbieter|lieferant|firmen/i;

/** "category" | "counterparty" when the title names exactly one of them, "both" for both, else null. */
export function groupingOfTitle(title) {
  const cat = CATEGORY_WORD.test(String(title ?? ''));
  const cp = COUNTERPARTY_WORD.test(String(title ?? ''));
  return cat && cp ? 'both' : cat ? 'category' : cp ? 'counterparty' : null;
}

/** The title says Kategorie but the chart shows Gegenparteien (or the other way round): the title follows the data. */
function retitle(title, by) {
  const named = groupingOfTitle(title);
  if (by === 'category' && named === 'counterparty') return title.replace(/gegenparteien/i, 'Kategorien').replace(/gegenpartei/i, 'Kategorie');
  if (by === 'counterparty' && named === 'category') return title.replace(/kategorien/i, 'Gegenparteien').replace(/kategorie/i, 'Gegenpartei');
  return title;
}

/**
 * Drops caption sentences that contradict a rebuilt chart: another currency than the unit, "getrennt / nicht addiert" for a
 * combined EUR chart, an entry count that is not the ledger's. An emptied caption is replaced by a plain, true sentence.
 */
export function sanitizeCaption(caption, ledger, series, by) {
  const text = String(caption ?? '').trim();
  if (!text) return text;
  const entryCount = Number(ledger.header.entryCount ?? ledger.header.count);
  const combined = series.unit === EUR_UNIT;
  const contradicts = (sentence) => {
    if (combined && /\b(?:usd|dollar|us-dollar)\b|getrennt|nicht addiert|nicht zusammen|je währung|pro währung/i.test(sentence)) return true;
    if (!combined && /\b(?:eur|euro)\b|€/i.test(sentence) && series.unit !== 'EUR') return true;
    for (const m of sentence.matchAll(/(\d[\d.]{0,24})\s*(?:einträge|buchungen|zeilen|transaktionen|positionen|zahlungen)/gi)) if (Number(m[1].replace(/\./g, '')) !== entryCount) return true;
    return false;
  };
  const kept = text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x && !contradicts(x)); // a dot inside "4.321" is no sentence end
  if (kept.length) return kept.join(' ');
  const total = round2(series.list.reduce((sum, t) => sum + t.value, 0)).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Summe ${total} ${series.unit}, ${series.list.length} ${by === 'counterparty' ? 'Gegenparteien' : 'Kategorien'}.`;
}

const keySet = (series) => new Set((series?.list ?? []).flatMap((t) => [norm(t.key), norm(t.label)]));

/**
 * Applies the ledger to a model spec of kind pie/bar/sankey. `ledgers` = the parsed ledger_spend results, newest first
 * (one is fine). Returns {spec, rebuilt, dropped} - or null when the spec is not about the ledger (its labels are not
 * ledger keys and nothing money-like is said).
 * - the grouping comes from the title (Kategorie / Gegenpartei), else from the labels, else from the ledger; the newest
 *   result that can carry it is used (the header's aggregation, or the regrouped triples);
 * - labels mostly known (>= 50 %), a title that names the grouping, or a sankey -> rebuilt completely from the ledger
 *   (ALL groups, the sum is the total), title and caption follow;
 * - else items whose label does not occur in the ledger text are dropped (no invented counterparties); with fewer than
 *   2 left the chart is rebuilt completely.
 */
export function applyLedger(spec, ledgers, { moneyHint = false, ledgerText = '' } = {}) {
  if (!['pie', 'bar', 'sankey'].includes(spec.kind)) return null;
  const list = (Array.isArray(ledgers) ? ledgers : [ledgers]).filter(Boolean);
  const newest = list[0];
  if (!newest || !list.some((l) => ledgerSeries(l))) return null;
  const labels = spec.kind === 'sankey' ? (spec.nodes ?? []).map((n) => n.label) : (spec.items ?? []).map((i) => i.label);
  const unitIsMoney = /eur|€|euro/i.test(String(spec.unit ?? ''));
  const first = (by) => { for (const l of list) { const series = seriesBy(l, by); if (series) return { ledger: l, series }; } return null; };
  const options = { category: first('category'), counterparty: first('counterparty'), own: first(undefined) };
  const hitsOf = (choice) => (choice ? labels.filter((l) => keySet(choice.series).has(norm(l))).length : 0);
  const anyHit = Math.max(hitsOf(options.category), hitsOf(options.counterparty), hitsOf(options.own));
  if (!anyHit && !moneyHint && !unitIsMoney) return null;

  // 1. the title names the grouping, 2. the labels do, 3. the ledger's own
  const named = groupingOfTitle(spec.title);
  const both = named === 'both';
  let by = named === 'category' || named === 'counterparty' ? named : null;
  const titleDriven = Boolean(by) || both;
  if (!by && !both) {
    const catHits = hitsOf(options.category);
    const cpHits = hitsOf(options.counterparty);
    if (labels.length && catHits / labels.length >= 0.5 && catHits >= cpHits) by = 'category';
    else if (labels.length && cpHits / labels.length >= 0.5) by = 'counterparty';
  }
  if (!by) by = both ? 'category' : ['category', 'counterparty'].includes(newest.header.groupBy) ? newest.header.groupBy : null;
  const choice = (by && options[by]) || options.own;
  if (!choice) return null;
  const shown = by && options[by] ? by : choice.ledger.header.groupBy;

  const rebuild = () => {
    const body = moneyBody(choice.ledger, spec.kind, { by: shown });
    if (!body) return null;
    const rebuilt = { ...spec, ...(spec.kind === 'sankey' ? { nodes: undefined, links: undefined } : { items: undefined }), ...body };
    rebuilt.title = retitle(spec.title ?? '', shown);
    if (spec.caption) rebuilt.caption = sanitizeCaption(spec.caption, choice.ledger, choice.series, shown);
    return { spec: rebuilt, rebuilt: true, dropped: 0 };
  };
  const hits = hitsOf(choice);
  // payee labels on a category ledger without a grouping word in the title: a drill-down, not the whole picture -> keep the known ones
  const subset = !titleDriven && by === 'counterparty' && choice.ledger.header.groupBy !== 'counterparty' && spec.kind !== 'sankey';
  if (!subset && labels.length && hits / labels.length >= 0.5) return rebuild();
  if (spec.kind === 'sankey' || titleDriven) return rebuild();
  const haystack = norm(ledgerText || '');
  const known = keySet(choice.series);
  const kept = (spec.items ?? []).filter((i) => known.has(norm(i.label)) || (norm(i.label).length > 2 && haystack.includes(norm(i.label))));
  if (kept.length >= 2 && kept.length === (spec.items ?? []).length) return { spec, rebuilt: false, dropped: 0 };
  if (kept.length >= 2) return { spec: { ...spec, items: kept }, rebuilt: false, dropped: (spec.items ?? []).length - kept.length };
  return rebuild();
}

/** Sources for a ledger result: its own source.ref (never an export path unless source.kind is "export") and the FX note. */
export function ledgerSources(ledger) {
  const { source, fxNote } = ledger.header;
  const out = [];
  if (source?.ref) out.push({ label: source.kind === 'export' ? 'Ledger-Export' : 'Board #22 (Buchungen)', ref: normalizeRef(source.ref) ?? clean(source.ref, 300) });
  else out.push({ label: 'Ledger', ref: 'Board #22 / Ledger-Export' });
  if (fxNote) out.push({ label: 'Wechselkurs (ca.)', ref: clean(fxNote, 300) });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Round 8 (critic r7 F2): deterministic prose. The chart is exact; the sentences around it must list the SAME values,
// not a model's recollection ("Moment, das stimmt nicht ...").

const de = (n) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TIDY = /(?<!\s)\s+[—–]\s+[\s\S]*$/; // [\s\S]*$ always matches: no backtracking into \s+ (critic r7)
const tidy = (label) => String(label ?? '').replace(TIDY, '').trim();

/**
 * The lines a money answer lists, from the ledger header's own aggregation: "GPU: 1.234,56 € (ca.), 4 Einträge", the tail
 * folded into "Sonstige" exactly like the chart (at most LIMITS.items entries), then the total. Null without a usable aggregation.
 */
export function answerList(header) {
  const eur = Array.isArray(header?.totalsEurApprox) && header.totalsEurApprox.length;
  const raw = eur ? header.totalsEurApprox : header?.totals;
  if (!Array.isArray(raw) || !raw.length) return null;
  const currencies = new Set(raw.map((t) => t.currency));
  if (!eur && currencies.size !== 1) return null;
  const unit = eur ? '€ (ca.)' : [...currencies][0];
  let rows = raw.map((t) => ({ key: header.groupBy === 'counterparty' ? tidy(t.key) : String(t.key), value: Number(eur ? t.sumEur : t.sum), count: Number(t.count) || 0 }))
    .filter((t) => Number.isFinite(t.value) && t.value > 0);
  if (header.groupBy === 'counterparty') { // "Hub — pro forma PF/1" and "Hub — pro forma PF/2" are one payee
    const merged = new Map();
    for (const r of rows) { const m = merged.get(r.key) ?? { ...r, value: 0, count: 0 }; m.value += r.value; m.count += r.count; merged.set(r.key, m); }
    rows = [...merged.values()];
  }
  if (header.groupBy === 'month') rows.sort((a, b) => a.key.localeCompare(b.key)); else rows.sort((a, b) => b.value - a.value);
  if (!rows.length) return null;
  const total = round2(rows.reduce((sum, r) => sum + r.value, 0));
  const count = rows.reduce((sum, r) => sum + r.count, 0);
  if (rows.length > LIMITS.items) {
    const rest = rows.slice(LIMITS.items - 1);
    rows = [...rows.slice(0, LIMITS.items - 1), { key: 'Sonstige', value: round2(rest.reduce((sum, r) => sum + r.value, 0)), count: rest.reduce((sum, r) => sum + r.count, 0) }];
  }
  const line = (r) => `${r.key}: ${de(round2(r.value))} ${unit}${r.count ? `, ${r.count} ${r.count === 1 ? 'Eintrag' : 'Einträge'}` : ''}`;
  return { rows, unit, total, lines: [...rows.map(line), `Summe: ${de(total)} ${unit}${count ? `, ${count} Einträge` : ''}`] };
}

/** The block appended to a ledger_spend result: the model lists exactly this. */
export function answerBlock(list) {
  return list ? `\n=== ANTWORT-LISTE (liste genau diese Werte, mit diesen Namen; keine eigenen Zahlen, keine Korrekturen, kein "Moment") ===\n${list.lines.join('\n')}` : '';
}

const SELF_CORRECTION = /\bKorrekt(?:e[rsn]?)? (?:aus dem|ist|wäre)\b|\bgenauer:|\bMoment\b[,.!]?|stimmt nicht|stimmt so nicht|ich vermische|vermische gerade|mein erster Satz war falsch|war falsch|Entschuldig(?:e|ung)|Verzeihung|ich korrigiere|korrigiere mich|das war ein Fehler|Ich merke,? (?:dass )?ich|ich habe mich (?:geirrt|verrechnet|vertan)/i;
// Critic round 7: digit runs are bounded (an unbounded `\d[\d.]*` rescanned a long run of digits from every digit).
const EURO_AMOUNT = /(\d[\d.]{0,24}(?:,\d{1,6})?)\s*(?:€|eur\b|euro\b)|€\s*(\d[\d.]{0,24}(?:,\d{1,6})?)/gi;
// Critic round 7: the label is looked for in the 120 chars before each amount (anchored at the amount), not by a lazy
// 2-70 char label tried from every position of the text (linear, but ~600 ms on 64 kB of blanks).
const AMOUNT_AT = /(?<![\d.])\d[\d.]{0,24}(?:,\d{1,6})?\s{0,8}(?:€|eur\b|euro\b)/gi;
const LABEL_BEFORE = /([^\n.!?:;–—]{2,70}?)\s{0,8}[:–—-]\s{0,8}(?:ca\.?\s{0,4}|rund\s{0,4}|etwa\s{0,4})?\*{0,2}$/i;
function* labelsBeforeAmounts(text) {
  let end = 0; // like matchAll: a label never reaches back into the previous match
  for (const a of text.matchAll(AMOUNT_AT)) {
    const from = Math.max(end, a.index - 120);
    const m = LABEL_BEFORE.exec(text.slice(from, a.index));
    if (!m) continue;
    end = a.index + a[0].length;
    yield m;
  }
}
const NEUTRAL_LABELS = /^(?:summe|gesamt|insgesamt|total|zusammen|ausgaben|gesamtausgaben|davon|rest|sonstige)$/i;

const MONEY_SENTENCE = /\d|%|\b(?:ca|bzw|usw|z\. ?B|d\. ?h|u\. ?a)\.$|€|\beur(?:o)?\b|\d[\d.]*,\d|\d{1,3}(?:\.\d{3})+\b|\d{4,}|\||Laut Ledger|^\s*(?:[-*•]|\d+\.)\s|:\s*$/i;
/** The sentences of a model's money text that carry no amount, table cell, list item or self-correction (a fragment like "21:04 UTC)." after "24.10." is dropped too). */
function modelSentences(body) {
  return body.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => /^[\p{Lu}„"'*_]/u.test(x) && !MONEY_SENTENCE.test(x) && (x.match(/\(/g)?.length ?? 0) === (x.match(/\)/g)?.length ?? 0) && !SELF_CORRECTION.test(x));
}

/**
 * Checks a finished money answer against the ledger result it was written from. `content` = the ledger_spend tool result.
 * guard.check(text) -> {ok, reasons[]}; guard.fix(text) -> the text with every sentence that carries money (or a
 * self-correction) removed and the deterministic list appended. Null when the result carries no usable aggregation.
 */
export function createMoneyGuard(content) {
  const ledger = parseLedger(content);
  const list = ledger ? answerList(ledger.header) : null;
  if (!list) return null;
  const haystack = norm(String(content));
  const known = new Set();
  for (const token of String(content).match(/\d[\d.,]*\d|\d/g) ?? []) {
    const a = parseNumber(token);
    const b = Number(token.replace(/,/g, ''));
    for (const n of [a, b]) if (Number.isFinite(n)) known.add(n);
  }
  for (const n of [list.total, ...list.rows.map((r) => r.value)]) known.add(n);
  const exact = new Set([...known].map((n) => n.toFixed(2)));
  const whole = new Set([...known].map((n) => Math.round(n)));
  const tenth = new Set([...known].map((n) => n.toFixed(1)));
  const grounded = (v) => exact.has(v.toFixed(2)) || (Number.isInteger(v) && whole.has(v)) || tenth.has(v.toFixed(1));
  const labels = new Set(list.rows.map((r) => norm(r.key)));

  const reasonsOf = (text) => {
    const reasons = [];
    if (SELF_CORRECTION.test(text)) reasons.push('self-correction');
    for (const m of text.matchAll(EURO_AMOUNT)) {
      const v = parseNumber(m[1] ?? m[2]);
      if (Number.isFinite(v) && !grounded(v)) { reasons.push(`amount ${m[0].trim()}`); break; }
    }
    for (const m of labelsBeforeAmounts(text)) {
      const label = norm(m[1].replace(/[*_`#>\-•]+/g, ' ').replace(/^(?:\d+\.\s*)/, ''));
      if (!label || NEUTRAL_LABELS.test(label)) continue;
      const inList = [...labels].some((l) => l && label.includes(l)) || haystack.includes(label);
      if (!inList) { reasons.push(`name ${label}`); break; }
    }
    return reasons;
  };

  return {
    list,
    block: answerBlock(list),
    check(text) { const reasons = reasonsOf(String(text ?? '')); return { ok: !reasons.length, reasons }; },
    fix(text) {
      const body = String(text ?? '');
      if (!reasonsOf(body).length) return body;
      const kept = modelSentences(body);
      const intro = kept.length ? `${kept.join(' ')}\n\n` : '';
      return `${intro}Laut Ledger:\n${list.lines.map((l) => `- ${l}`).join('\n')}`;
    },
    /**
     * Round 9 (critic r8 F2): the answer of a turn in which ledger_spend ran. Model text never carries numbers there: only
     * its sentences without money (at most `max`), then, if `withList`, the deterministic list exactly once.
     */
    compose(text, { max = 2, withList = true } = {}) {
      const kept = modelSentences(String(text ?? '')).slice(0, Math.max(0, max));
      const head = kept.join(' ');
      if (!withList) return head;
      return `${head ? `${head}\n\n` : ''}Laut Ledger:\n${list.lines.map((l) => `- ${l}`).join('\n')}`;
    },
  };
}
