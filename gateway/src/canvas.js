// Generative canvas (docs/CANVAS.md): the CanvasSpec validator and the pure text heuristics around it
// (auto-illustration trigger, refusal-to-draw guard). No I/O here.
import { redact } from './redact.js';

export const CANVAS_KINDS = ['flow', 'architecture', 'sequence', 'pie', 'bar', 'line', 'table', 'timeline', 'sankey', 'custom_svg'];
export const TONES = ['moss', 'papaya', 'violet', 'amber', 'red', 'neutral'];
export const LIMITS = { nodes: 24, edges: 40, groups: 8, actors: 8, messages: 24, items: 12, series: 4, points: 60, columns: 8, rows: 24, events: 16, links: 40, label: 40, detail: 90, title: 70, caption: 160, svg: 20_000, sources: 6 };
const SHAPES = ['box', 'pill', 'diamond', 'cylinder', 'person'];
const EDGE_STYLES = ['solid', 'dashed', 'pulse'];
const MESSAGE_STYLES = ['sync', 'reply', 'async'];
const SLUG = /^[a-z0-9-]{2,48}$/;
const UNSOURCED = [{ label: 'Gespräch', ref: 'Gespräch' }];

const fail = (error) => ({ ok: false, error });
class Invalid extends Error {}
const bad = (message) => { throw new Invalid(message); };

const GERMAN = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

/** "Wie der Video-Versand läuft" -> "wie-der-video-versand-laeuft" (<= 48 chars, never shorter than 2). */
export function slugify(text, fallback = 'skizze') {
  const slug = String(text ?? '').replace(/[äöüßÄÖÜ]/g, (c) => GERMAN[c]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|(?<!-)-+$/g, '').slice(0, 48).replace(/(?<!-)-+$/, '');
  return slug.length >= 2 ? slug : fallback;
}

/** Collapses whitespace, drops control characters and cuts at `max` with an ellipsis. Numbers become strings. */
export function clean(value, max) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = redact(value.replace(/[\u0000-\u001f\u007f]+/g, ' ')).replace(/\s+/g, ' ').trim(); // a secret that slipped into a model answer never reaches the browser
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Number from a number or a human string: "165,00 €" -> 165, "1.234,56" -> 1234.56, "$1,234.5" -> 1234.5, "12 %" -> 12.
 * A lone separator followed by exactly three digits after 1-3 leading digits is a thousands separator ("1.234" = 1234,
 * "0.123" stays decimal). Returns NaN when nothing numeric is left.
 */
export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  let s = value.replace(/[^\d.,-]/g, '');
  if (!/\d/.test(s)) return NaN;
  const negative = s.startsWith('-');
  s = s.replace(/-/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    s = s.split(thousands).join('').replace(decimal, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    const thousands = parts.length > 2 || (parts.length === 2 && /^[1-9]\d{0,2}$/.test(parts[0]) && /^\d{3}$/.test(parts[1]));
    s = thousands ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : NaN;
}

const round = (n) => Math.round(n * 10_000) / 10_000;

function amount(value, where) {
  const n = parseNumber(value);
  if (!Number.isFinite(n)) bad(`${where}: value must be a number (got ${JSON.stringify(value)?.slice(0, 40)})`);
  if (n < 0) bad(`${where}: value must be >= 0`);
  return round(n);
}

const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);
const tone = (value) => (TONES.includes(value) ? value : undefined);
const asArray = (value, name) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${name} must be an array`);
  return value;
};
const asObject = (value, where) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(`${where} must be an object`);
  return value;
};
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== ''));

/** Slug for node/actor/group ids: like slugify but one character is fine ("a", "b"). */
const idSlug = (text, fallback) => String(text ?? '').replace(/[äöüßÄÖÜ]/g, (c) => GERMAN[c]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|(?<!-)-+$/g, '').slice(0, 40).replace(/(?<!-)-+$/, '') || fallback;

/** Unique slug ids for nodes/actors/groups; the label is the source for a missing id. Remembers the model's raw ids. */
function idSet() {
  const seen = new Set();
  const byRaw = new Map(); // raw id the model wrote -> final id
  const clamped = new Set(); // raw ids of entries dropped by a size limit
  return {
    take(raw, label, prefix) {
      const key = typeof raw === 'string' ? raw.trim() : '';
      let id = idSlug(key || label, prefix);
      const base = id;
      for (let n = 2; seen.has(id); n += 1) id = `${base.slice(0, 36)}-${n}`;
      seen.add(id);
      if (key && !byRaw.has(key)) byRaw.set(key, id);
      return id;
    },
    skip(raw) { if (typeof raw?.id === 'string') clamped.add(raw.id.trim()); },
    resolve(raw) {
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (byRaw.has(key)) return byRaw.get(key);
      if (seen.has(key)) return key;
      const slug = idSlug(key, '');
      return slug && seen.has(slug) ? slug : undefined;
    },
    clamped: (raw) => clamped.has(typeof raw === 'string' ? raw.trim() : ''),
  };
}

function sources(raw) {
  const list = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const s = typeof entry === 'string' ? { label: entry, ref: entry } : entry;
    const label = clean(s?.label, 80);
    const ref = clean(s?.ref, 300);
    if (label || ref) list.push({ label: label || ref, ref: ref || label });
    if (list.length >= LIMITS.sources) break;
  }
  return list;
}

function groupsOf(spec) {
  const ids = idSet();
  const groups = asArray(spec.groups, 'groups').slice(0, LIMITS.groups).map((g, i) => {
    g = asObject(g, `groups[${i}]`);
    const label = clean(g.label, LIMITS.label) || clean(g.id, LIMITS.label) || `Gruppe ${i + 1}`;
    return compact({ id: ids.take(g.id, label, 'gruppe'), label, tone: tone(g.tone) });
  });
  return { groups, ids };
}

function nodesOf(raw, groupIds, { shapes }) {
  const ids = idSet();
  const list = asArray(raw, 'nodes');
  list.slice(LIMITS.nodes).forEach((n) => ids.skip(n));
  const nodes = list.slice(0, LIMITS.nodes).map((n, i) => {
    n = asObject(n, `nodes[${i}]`);
    const label = clean(n.label, LIMITS.label) || clean(n.id, LIMITS.label);
    if (!label) bad(`nodes[${i}] needs a label`);
    return compact({
      id: ids.take(n.id, label, 'knoten'),
      label,
      detail: clean(n.detail, LIMITS.detail),
      group: shapes ? groupIds.resolve(n.group) : undefined,
      tone: tone(n.tone),
      shape: shapes ? oneOf(n.shape, SHAPES, 'box') : undefined,
    });
  });
  return { nodes, ids };
}

/** Edge/message/link endpoints: unknown ids are an error, endpoints that were only clamped away drop the entry. */
function endpoint(raw, ids, where) {
  const id = ids.resolve(raw);
  if (id) return id;
  if (ids.clamped(raw)) return null;
  return bad(`${where}: unknown node "${String(raw).slice(0, 30)}" (use the ids you declared)`);
}

function flowLike(spec, kind) {
  const { groups, ids: groupIds } = kind === 'architecture' ? groupsOf(spec) : { groups: [], ids: idSet() };
  const { nodes, ids } = nodesOf(spec.nodes, groupIds, { shapes: true });
  if (!nodes.length) bad(`${kind} needs "nodes" (at least 1)`);
  const edges = [];
  asArray(spec.edges, 'edges').forEach((e, i) => {
    e = asObject(e, `edges[${i}]`);
    const from = endpoint(e.from, ids, `edges[${i}].from`);
    const to = endpoint(e.to, ids, `edges[${i}].to`);
    if (from && to && edges.length < LIMITS.edges) edges.push(compact({ from, to, label: clean(e.label, LIMITS.label), style: oneOf(e.style, EDGE_STYLES, 'solid') }));
  });
  return { direction: spec.direction === 'TB' || spec.direction === 'LR' ? spec.direction : (kind === 'architecture' ? 'TB' : 'LR'), ...(groups.length ? { groups } : {}), nodes, edges };
}

function sequence(spec) {
  const ids = idSet();
  const rawActors = asArray(spec.actors, 'actors');
  rawActors.slice(LIMITS.actors).forEach((a) => ids.skip(a));
  const actors = rawActors.slice(0, LIMITS.actors).map((a, i) => {
    a = asObject(a, `actors[${i}]`);
    const label = clean(a.label, LIMITS.label) || clean(a.id, LIMITS.label);
    if (!label) bad(`actors[${i}] needs a label`);
    return compact({ id: ids.take(a.id, label, 'akteur'), label, tone: tone(a.tone) });
  });
  if (actors.length < 2) bad('sequence needs "actors" (at least 2)');
  const messages = [];
  asArray(spec.messages, 'messages').forEach((m, i) => {
    m = asObject(m, `messages[${i}]`);
    const from = endpoint(m.from, ids, `messages[${i}].from`);
    const to = endpoint(m.to, ids, `messages[${i}].to`);
    if (from && to && messages.length < LIMITS.messages) messages.push(compact({ from, to, label: clean(m.label, LIMITS.label), style: oneOf(m.style, MESSAGE_STYLES, 'sync'), note: clean(m.note, LIMITS.detail) }));
  });
  if (!messages.length) bad('sequence needs "messages" (at least 1)');
  return { actors, messages };
}

function itemsOf(spec, kind) {
  const items = asArray(spec.items, 'items').slice(0, LIMITS.items).map((it, i) => {
    it = asObject(it, `items[${i}]`);
    const label = clean(it.label, LIMITS.label);
    if (!label) bad(`items[${i}] needs a label`);
    return compact({ label, value: amount(it.value, `items[${i}] "${label}"`), tone: tone(it.tone), detail: clean(it.detail, LIMITS.detail) });
  });
  if (!items.length) bad(`${kind} needs "items" (at least 1: {label, value})`);
  if (kind === 'pie' && items.every((it) => it.value === 0)) bad('pie: all values are 0');
  return { items, ...(clean(spec.unit, 12) ? { unit: clean(spec.unit, 12) } : {}) };
}

function lineOf(spec) {
  const series = asArray(spec.series, 'series').slice(0, LIMITS.series).map((s, i) => {
    s = asObject(s, `series[${i}]`);
    const name = clean(s.name, LIMITS.label) || `Reihe ${i + 1}`;
    const points = asArray(s.points, `series[${i}].points`).slice(0, LIMITS.points).map((p, j) => {
      p = asObject(p, `series[${i}].points[${j}]`);
      const x = clean(p.x, 30);
      if (!x) bad(`series "${name}" point ${j}: x is required`);
      return { x, y: amount(p.y, `series "${name}" point ${j}`) };
    });
    if (!points.length) bad(`series "${name}" needs points`);
    return compact({ name, tone: tone(s.tone), points });
  });
  if (!series.length) bad('line needs "series" (at least 1: {name, points:[{x,y}]})');
  return { series, ...(clean(spec.unit, 12) ? { unit: clean(spec.unit, 12) } : {}) };
}

function tableOf(spec) {
  const columns = asArray(spec.columns, 'columns').slice(0, LIMITS.columns).map((c) => clean(c, LIMITS.label));
  if (!columns.length || columns.some((c) => !c)) bad('table needs "columns" (strings, at least 1)');
  const rows = asArray(spec.rows, 'rows').slice(0, LIMITS.rows).map((row, i) => {
    if (!Array.isArray(row)) bad(`rows[${i}] must be an array of cells`);
    return columns.map((_, j) => clean(row[j], LIMITS.detail));
  });
  if (!rows.length) bad('table needs "rows" (at least 1)');
  return { columns, rows };
}

function timelineOf(spec) {
  const events = asArray(spec.events, 'events').slice(0, LIMITS.events).map((e, i) => {
    e = asObject(e, `events[${i}]`);
    const label = clean(e.label, LIMITS.label);
    if (!label) bad(`events[${i}] needs a label`);
    return compact({ date: clean(e.date, 30), label, detail: clean(e.detail, LIMITS.detail), tone: tone(e.tone) });
  });
  if (!events.length) bad('timeline needs "events" (at least 1: {date, label})');
  return { events };
}

function sankeyOf(spec) {
  const { nodes, ids } = nodesOf(spec.nodes, idSet(), { shapes: false });
  if (nodes.length < 2) bad('sankey needs "nodes" (at least 2)');
  const links = [];
  asArray(spec.links, 'links').forEach((l, i) => {
    l = asObject(l, `links[${i}]`);
    const from = endpoint(l.from, ids, `links[${i}].from`);
    const to = endpoint(l.to, ids, `links[${i}].to`);
    const value = amount(l.value, `links[${i}]`);
    if (from && to && links.length < LIMITS.links) links.push({ from, to, value });
  });
  if (!links.length) bad('sankey needs "links" (at least 1: {from, to, value})');
  return { nodes, links, ...(clean(spec.unit, 12) ? { unit: clean(spec.unit, 12) } : {}) };
}

const FORBIDDEN_SVG = /<\s*script|<\s*foreignObject|\son[a-z]+\s*=|javascript:|<\s*iframe|<\s*object|<\s*embed|<\s*image/i;
// `<use … href="external">`, tested per `>`-delimited piece: /<\s*use\b[^>]*href…/ rescanned to the next `>` from every `<use`
// (quadratic on "<use " x n, critic r7). The first <use of a piece is enough: a later one only sees less of it.
const USE_EXTERNAL = (svg) => svg.split('>').some((piece) => { const at = piece.search(/<\s*use\b/i); return at >= 0 && /href\s*=\s*["'](?!#)/i.test(piece.slice(at)); });

function svgOf(spec) {
  const svg = typeof spec.svg === 'string' ? redact(spec.svg).trim() : '';
  if (!svg) bad('custom_svg needs "svg" (a complete <svg viewBox="…">…</svg>)');
  if (svg.length > LIMITS.svg) bad(`svg is ${svg.length} characters, the limit is ${LIMITS.svg}: simplify it`);
  if (!/^<svg[\s>]/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) bad('svg must be one complete <svg>…</svg> element');
  if (!/^<svg[^>]*\sviewBox\s*=/i.test(svg)) bad('svg needs a viewBox attribute');
  if (FORBIDDEN_SVG.test(svg) || USE_EXTERNAL(svg)) bad('svg contains forbidden content (script, foreignObject, image, on* handlers, javascript:, external hrefs)');
  return { svg };
}

const BODY = {
  flow: (s) => flowLike(s, 'flow'),
  architecture: (s) => flowLike(s, 'architecture'),
  sequence,
  pie: (s) => itemsOf(s, 'pie'),
  bar: (s) => itemsOf(s, 'bar'),
  line: lineOf,
  table: tableOf,
  timeline: timelineOf,
  sankey: sankeyOf,
  custom_svg: svgOf,
};

/**
 * THE CanvasSpec validator (docs/CANVAS.md). Pure. Sizes are clamped, never rejected (except an over-long svg, which
 * cannot be cut); structural problems return a short English error a model can act on. Unknown fields are dropped.
 */
export function normalizeCanvas(input, { gate = false } = {}) {
  let spec = input;
  if (typeof spec === 'string') {
    try { spec = JSON.parse(spec); } catch { return fail('spec is not valid JSON'); }
  }
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return fail('spec must be a JSON object');
  try {
    const kind = typeof spec.kind === 'string' ? spec.kind.trim() : '';
    if (!CANVAS_KINDS.includes(kind)) bad(kind ? `unknown kind "${kind.slice(0, 30)}"; use one of: ${CANVAS_KINDS.join(', ')}` : `kind is required; use one of: ${CANVAS_KINDS.join(', ')}`);
    const title = clean(spec.title, LIMITS.title);
    if (!title) bad('title is required (max 70 characters)');
    const id = typeof spec.id === 'string' && SLUG.test(spec.id.trim()) ? spec.id.trim() : slugify(spec.id || title, `${kind}-skizze`);
    const body = BODY[kind](spec);
    const detail = spec.detail === undefined || spec.detail === null ? undefined : detailOf(spec.detail, kind, body, title);
    const given = sources(spec.sources);
    const result = {
      ok: true,
      spec: compact({
        v: 2,
        id,
        kind,
        title,
        caption: clean(spec.caption, LIMITS.caption),
        highlight: clean(spec.highlight, LIMITS.label),
        sources: given.length ? given : UNSOURCED,
        unsourced: !given.length || (spec.unsourced === true && given.every((x) => /^gespräch$/i.test(x.ref))) ? true : undefined, // enrichSpec re-validates a spec it left unsourced
        ...body,
        detail,
      }),
    };
    if (gate) {
      const problem = qualityError(result.spec) ?? (detail ? prefixed(qualityError(detailSpec(result.spec))) : undefined);
      if (problem) return fail(problem);
    }
    return result;
  } catch (err) {
    if (err instanceof Invalid) return fail(err.message);
    throw err;
  }
}

const prefixed = (problem) => (problem ? `detail: ${problem}` : undefined);

/**
 * Upgrades 28 Oct (docs/UPGRADES-1028.md §5): the optional `detail` = the detailed version of the SAME diagram (same kind,
 * full schema, existing limits). Stored as {kind, title?, caption?, highlight?, ...body}; title / caption only when they
 * differ from the simple view. A detail that shows exactly what the simple view shows is dropped.
 */
function detailOf(raw, kind, simpleBody, title) {
  const d = asObject(raw, 'detail');
  const own = typeof d.kind === 'string' ? d.kind.trim() : '';
  if (own && own !== kind) bad(`detail.kind must be "${kind}" (the detailed version of the same diagram)`);
  let body;
  try { body = BODY[kind](d); } catch (err) { if (err instanceof Invalid) bad(`detail: ${err.message}`); throw err; }
  if (JSON.stringify(body) === JSON.stringify(simpleBody) || !detailAdds(kind, simpleBody, body)) return undefined; // P2-5: no useless toggle
  const dTitle = clean(d.title, LIMITS.title);
  return compact({ kind, title: dTitle && dTitle !== title ? dTitle : undefined, caption: clean(d.caption, LIMITS.caption), highlight: clean(d.highlight, LIMITS.label), ...body });
}

/** The detailed version as a complete spec (id, sources, title of the simple one), or null when there is none. */
export function detailSpec(spec) {
  if (!spec?.detail || typeof spec.detail !== 'object') return null;
  const { detail, ...top } = spec;
  const out = { ...top, highlight: undefined, caption: undefined, ...detail, kind: top.kind };
  if (!detail.highlight) out.highlight = top.highlight;
  if (!detail.caption) out.caption = top.caption;
  return compact(out);
}

/** `top` (a spec) with the body of `full` (a complete spec of the same kind) as its detail. Sources are merged. */
export function attachDetail(top, full) {
  if (!full || full.kind !== top.kind) return top;
  const { v, id, sources: fullSources, unsourced, detail, ...rest } = full;
  const sources = [...(top.sources ?? [])];
  for (const s of fullSources ?? []) if (!sources.some((m) => m.ref === s.ref)) sources.push(s);
  const real = sources.filter((s) => !/^gespräch$/i.test(String(s.ref)));
  const out = { ...top, sources: real.length ? real : sources };
  if (real.length) delete out.unsourced;
  const body = compact({ ...rest, title: rest.title && rest.title !== top.title ? rest.title : undefined, caption: rest.caption && rest.caption !== top.caption ? rest.caption : undefined });
  const same = Object.keys(BODY_KEYS[top.kind] ?? {}).every((k) => JSON.stringify(body[k]) === JSON.stringify(top[k]));
  if (same || !detailAdds(top.kind, top, body)) { delete out.detail; return out; } // P2-5: a detail that adds nothing gets no toggle
  return { ...out, detail: body };
}

/**
 * Critic round 1, P2-5: a detail earns its "Details" button only when it shows MORE than the simple view: more boxes, arrows,
 * groups, actors, messages, items, series points, rows, columns, events or links - or the full text of a label the simple view
 * had to cut ("…"). Node notes or edge labels on the same boxes alone are no reason for a toggle.
 */
export function detailAdds(kind, simple, detail) {
  if (!simple || !detail) return false;
  if (kind === 'custom_svg') return detail.svg !== undefined && detail.svg !== simple.svg;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const points = (b) => (b.series ?? []).reduce((n, x) => n + len(x?.points), 0);
  for (const key of Object.keys(BODY_KEYS[kind] ?? {})) if (len(detail[key]) > len(simple[key])) return true;
  if (kind === 'line' && points(detail) > points(simple)) return true;
  const cut = (simple.nodes ?? simple.items ?? simple.events ?? simple.actors ?? []).filter((x) => /…$/.test(String(x?.label ?? '')));
  const full = new Map((detail.nodes ?? detail.items ?? detail.events ?? detail.actors ?? []).map((x) => [x?.id ?? x?.label, String(x?.label ?? '')]));
  return cut.some((x) => (full.get(x.id ?? x.label) ?? '').length > String(x.label).length);
}

const BODY_KEYS = {
  flow: { nodes: 1, edges: 1, groups: 1 }, architecture: { nodes: 1, edges: 1, groups: 1 }, sequence: { actors: 1, messages: 1 },
  pie: { items: 1 }, bar: { items: 1 }, line: { series: 1 }, table: { columns: 1, rows: 1 }, timeline: { events: 1 },
  sankey: { nodes: 1, links: 1 }, custom_svg: { svg: 1 },
};

// ---------------------------------------------------------------------------------------------------------------
// Simple view (upgrades 28 Oct, §5): the top-level spec is readable at a glance while talking. `simpleError` names a
// STRUCTURAL overflow (the illustrator repairs it once by moving the extra into `detail`); `simplifySpec` derives a simple
// view deterministically (keeps ids, <= 5 connected boxes, short labels) and keeps the original as `detail`.

export const SIMPLE = { nodes: 5, edges: 6, label: 28, edgeWords: 2, actors: 5, messages: 6, events: 5, items: 6, rows: 5 };

const outs = (edges, id) => edges.filter((e) => e.from === id).length;
const ins = (edges, id) => edges.filter((e) => e.to === id).length;
/**
 * Branching points: boxes with more than one outgoing (fork) / incoming (merge) arrow. "One main flow, at most one branch"
 * (§5) = at most one fork and one merge: a chain, one decision, or one hub fanning out stays simple.
 */
function branching(nodes, edges) {
  let fork = 0;
  let merge = 0;
  for (const n of nodes) { if (outs(edges, n.id) > 1) fork += 1; if (ins(edges, n.id) > 1) merge += 1; }
  return { fork, merge };
}

/** English reason when the top-level spec is structurally too big for the simple view; undefined when it fits. */
export function simpleError(spec) {
  const move = 'keep the main flow in the top-level spec and move the rest into "detail" (same kind, same ids, the full version)';
  switch (spec?.kind) {
    case 'flow': case 'architecture': {
      const nodes = spec.nodes ?? [];
      const edges = spec.edges ?? [];
      if (nodes.length > SIMPLE.nodes) return `the simple view has ${nodes.length} boxes (max ${SIMPLE.nodes}): ${move}`;
      if (edges.length > SIMPLE.edges) return `the simple view has ${edges.length} arrows (max ${SIMPLE.edges}): ${move}`;
      const { fork, merge } = branching(nodes, edges);
      if (fork > 1 || merge > 1) return `the simple view branches too much (one main flow, at most one branch): ${move}`;
      return undefined;
    }
    case 'sequence':
      if ((spec.actors ?? []).length > SIMPLE.actors) return `the simple view has ${spec.actors.length} actors (max ${SIMPLE.actors}): ${move}`;
      if ((spec.messages ?? []).length > SIMPLE.messages) return `the simple view has ${spec.messages.length} messages (max ${SIMPLE.messages}): ${move}`;
      return undefined;
    case 'timeline':
      return (spec.events ?? []).length > SIMPLE.events ? `the simple view has ${spec.events.length} events (max ${SIMPLE.events}): ${move}` : undefined;
    case 'pie': case 'bar':
      return (spec.items ?? []).length > SIMPLE.items ? `the simple view has ${spec.items.length} items (max ${SIMPLE.items}): ${move}` : undefined;
    case 'table':
      return (spec.rows ?? []).length > SIMPLE.rows ? `the simple view has ${spec.rows.length} rows (max ${SIMPLE.rows}): ${move}` : undefined;
    default:
      return undefined;
  }
}

const short28 = (text) => clean(text, SIMPLE.label);

/** Evenly spread picks of `count` indices out of 0..n-1, always with the first and the last (and `must`, if given). */
function spread(n, count, must = -1) {
  if (n <= count) return [...Array(n).keys()];
  const picked = new Set([0, n - 1]);
  if (must >= 0) picked.add(must);
  for (let k = 1; picked.size < count && k < count * 4; k += 1) {
    const free = count - 1;
    for (let j = 1; j < free && picked.size < count; j += 1) picked.add(Math.round((j * (n - 1)) / free));
  }
  for (let i = 0; picked.size < count && i < n; i += 1) picked.add(i);
  return [...picked].sort((a, b) => a - b).slice(0, count);
}

/** The longest simple path (by nodes) through the directed graph, through `through` when given. Bounded search. */
function mainPath(nodes, edges, through) {
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (next.has(e.from) && next.has(e.to) && e.from !== e.to) next.get(e.from).push(e.to);
  let best = [];
  let steps = 0;
  const walk = (path, seen) => {
    if (steps++ > 20_000) return;
    const ok = !through || path.includes(through);
    if (ok && (path.length > best.length)) best = [...path];
    for (const to of next.get(path.at(-1)) ?? []) {
      if (seen.has(to)) continue;
      seen.add(to); path.push(to);
      walk(path, seen);
      path.pop(); seen.delete(to);
    }
  };
  const starts = nodes.filter((n) => ins(edges, n.id) === 0);
  for (const s of (starts.length ? starts : nodes)) walk([s.id], new Set([s.id]));
  if (through && !best.length) return mainPath(nodes, edges, null);
  return best.length ? best : nodes.slice(0, 1).map((n) => n.id); // ties: the first start node in spec order wins
}

/** Short labels, no node details, edge labels only when <= 2 words (a cut phrase reads wrong; the detail keeps it), groups only with >= 2 of the kept boxes. */
function tidyGraph(spec, keep, chosen) {
  const byId = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const groupCount = new Map();
  for (const id of keep) { const g = byId.get(id)?.group; if (g) groupCount.set(g, (groupCount.get(g) ?? 0) + 1); }
  return {
    nodes: (spec.nodes ?? []).filter((n) => keep.has(n.id)).map((n) => compact({ ...n, detail: undefined, label: short28(n.label), group: (groupCount.get(n.group) ?? 0) >= 2 ? n.group : undefined })),
    edges: chosen.map((e) => compact({ from: e.from, to: e.to, label: e.label && e.label.trim().split(/\s+/).length <= SIMPLE.edgeWords ? short28(e.label) : undefined, style: e.style })),
    groups: (spec.groups ?? []).filter((g) => (groupCount.get(g.id) ?? 0) >= 2).map((g) => ({ ...g, label: short28(g.label) })),
    highlight: keep.has(spec.highlight) ? spec.highlight : undefined,
  };
}

/** The main path (longest, through the highlight), collapsed to <= 5 boxes, plus at most one branch. */
function simpleGraph(spec) {
  const nodes = spec.nodes ?? [];
  const edges = (spec.edges ?? []).filter((e) => e.from !== e.to);
  const through = nodes.some((n) => n.id === spec.highlight) ? spec.highlight : null;
  let path = mainPath(nodes, edges, through);
  let collapsed = new Set(); // consecutive kept nodes that had dropped nodes between them
  if (path.length > SIMPLE.nodes) {
    const picks = spread(path.length, SIMPLE.nodes, through ? path.indexOf(through) : -1);
    picks.forEach((p, i) => { if (i > 0 && p - picks[i - 1] > 1) collapsed.add(`${path[picks[i - 1]]}>${path[p]}`); });
    path = picks.map((i) => path[i]);
  }
  const kept = [...path];
  // one branch: the off-path neighbour with the most arrows, continued as a chain while there is room
  if (kept.length < SIMPLE.nodes) {
    const degree = (id) => edges.filter((e) => e.from === id || e.to === id).length;
    const touching = (id) => edges.filter((e) => (e.from === id && !kept.includes(e.to)) || (e.to === id && !kept.includes(e.from))).map((e) => (e.from === id ? e.to : e.from));
    const candidates = [...new Set(path.flatMap(touching))].sort((a, b) => degree(b) - degree(a) || nodes.findIndex((n) => n.id === a) - nodes.findIndex((n) => n.id === b));
    let tip = candidates[0];
    while (tip && kept.length < SIMPLE.nodes) {
      kept.push(tip);
      tip = touching(tip).sort((a, b) => degree(b) - degree(a))[0];
    }
  }
  // a graph without enough connections: fill up in spec order so the drawing still has 3 boxes
  for (const n of nodes) { if (kept.length >= Math.min(3, nodes.length)) break; if (!kept.includes(n.id)) kept.push(n.id); }
  const keep = new Set(kept);
  const chosen = [];
  const has = (a, b) => chosen.some((e) => e.from === a && e.to === b);
  // the main path first (a collapsed stretch becomes one dashed arrow), then the branch arrows
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1];
    const to = path[i];
    const real = edges.find((e) => e.from === from && e.to === to);
    if (real) chosen.push(real);
    else chosen.push({ from, to, style: collapsed.has(`${from}>${to}`) ? 'dashed' : 'solid' });
  }
  for (const e of edges) {
    if (chosen.length >= SIMPLE.edges) break;
    if (!keep.has(e.from) || !keep.has(e.to) || has(e.from, e.to)) continue;
    const trial = [...chosen, e];
    const { fork, merge } = branching(kept.map((id) => ({ id })), trial);
    if (fork <= 1 && merge <= 1) chosen.push(e);
  }
  return tidyGraph(spec, keep, chosen);
}

/** A simple view of `spec` (pure, deterministic). The original body goes to `detail` unless the spec already has one. */
export function simplifySpec(spec) {
  const { detail, ...full } = spec;
  let simple;
  switch (spec.kind) {
    case 'flow': case 'architecture': {
      // only cosmetic overflow: every box stays, labels / details / groups are tidied
      const g = simpleError(full) ? simpleGraph(full) : tidyGraph(full, new Set((full.nodes ?? []).map((n) => n.id)), full.edges ?? []);
      simple = { ...full, nodes: g.nodes, edges: g.edges, groups: g.groups.length ? g.groups : undefined, highlight: g.highlight };
      break;
    }
    case 'sequence': {
      const count = new Map((full.actors ?? []).map((a) => [a.id, 0]));
      for (const m of full.messages ?? []) { count.set(m.from, (count.get(m.from) ?? 0) + 1); count.set(m.to, (count.get(m.to) ?? 0) + 1); }
      const top = new Set([...(full.actors ?? [])].sort((a, b) => count.get(b.id) - count.get(a.id)).slice(0, SIMPLE.actors).map((a) => a.id));
      const messages = (full.messages ?? []).filter((m) => top.has(m.from) && top.has(m.to));
      simple = { ...full, actors: full.actors.filter((a) => top.has(a.id)).map((a) => ({ ...a, label: short28(a.label) })), messages: spread(messages.length, SIMPLE.messages).map((i) => compact({ ...messages[i], note: undefined, label: messages[i].label ? short28(messages[i].label) : undefined })) };
      if (!simple.messages.length) simple.messages = [compact({ ...full.messages[0], note: undefined })];
      break;
    }
    case 'timeline': {
      const events = full.events ?? [];
      const must = events.findIndex((e) => e.label === full.highlight);
      simple = { ...full, events: spread(events.length, SIMPLE.events, must).map((i) => compact({ ...events[i], detail: undefined, label: short28(events[i].label) })) };
      break;
    }
    case 'pie': {
      const items = [...(full.items ?? [])];
      if (items.length <= SIMPLE.items) { simple = { ...full, items: items.map((it) => compact({ ...it, detail: undefined, label: short28(it.label) })) }; break; }
      const ranked = [...items].sort((a, b) => b.value - a.value);
      const head = new Set(ranked.slice(0, SIMPLE.items - 1));
      const rest = items.filter((it) => !head.has(it));
      const sum = Math.round(rest.reduce((s, it) => s + it.value, 0) * 100) / 100; // the whole stays exact: shares do not change
      simple = { ...full, items: [...items.filter((it) => head.has(it)).map((it) => compact({ ...it, detail: undefined, label: short28(it.label) })), { label: `Sonstige (${rest.length})`, value: sum, tone: 'neutral' }] };
      break;
    }
    case 'bar': {
      const items = full.items ?? [];
      const top = new Set([...items].sort((a, b) => b.value - a.value).slice(0, SIMPLE.items));
      simple = { ...full, items: items.filter((it) => top.has(it)).map((it) => compact({ ...it, detail: undefined, label: short28(it.label) })) };
      break;
    }
    case 'table':
      simple = { ...full, rows: (full.rows ?? []).slice(0, SIMPLE.rows) };
      break;
    default:
      return spec;
  }
  simple = compact(simple);
  if (simple.highlight === undefined && full.highlight && spec.kind !== 'flow' && spec.kind !== 'architecture') simple.highlight = full.highlight;
  return attachDetail(simple, detail ? detailSpec(spec) : full);
}

/** Cosmetic simple rules that need no model (labels <= 28, edge labels <= 2 words, no node / event details, no 1-box groups). */
function tidyOverflow(spec) {
  const long = (t) => typeof t === 'string' && t.length > SIMPLE.label;
  switch (spec.kind) {
    case 'flow': case 'architecture': {
      const counts = new Map();
      for (const n of spec.nodes ?? []) if (n.group) counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
      return (spec.nodes ?? []).some((n) => long(n.label) || n.detail || (n.group && counts.get(n.group) < 2))
        || (spec.edges ?? []).some((e) => e.label && (long(e.label) || e.label.trim().split(/\s+/).length > SIMPLE.edgeWords))
        || (spec.groups ?? []).some((g) => !counts.get(g.id) || counts.get(g.id) < 2);
    }
    case 'sequence': return (spec.actors ?? []).some((a) => long(a.label)) || (spec.messages ?? []).some((m) => long(m.label) || m.note);
    case 'timeline': return (spec.events ?? []).some((e) => long(e.label) || e.detail);
    default: return false;
  }
}

/**
 * The spec as it is shown: structurally too big -> `simplifySpec`; only cosmetic overflow (long labels, node details,
 * one-box groups) -> the same deterministic tidy-up, the full version kept as `detail`. Returns {spec, simplified}.
 */
export function ensureSimple(spec) {
  if (!spec || typeof spec !== 'object') return { spec, simplified: false };
  spec = connectCanvas(spec).spec; // never loose boxes, in the simple view or behind Details
  if (simpleError(spec) || tidyOverflow(spec)) return { spec: connectCanvas(simplifySpec(spec)).spec, simplified: true };
  return { spec, simplified: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Connected graphs (fix 28 Oct, live: a detail with 3 boxes without arrows drawn as a loose column). A flow / architecture
// with >= 2 boxes has an arrow at every box. The illustrator repairs loose boxes in its repair round (quality gate);
// `connectCanvas` is the deterministic repair for specs that get no model round (canvas_render, Claude canvases, fallbacks).

const FLOW_KINDS = new Set(['flow', 'architecture']);

/** Ids of the boxes no arrow touches (a self-loop does not connect); [] for other kinds or fewer than 2 boxes. */
export function isolatedNodes(body) {
  const nodes = body?.nodes ?? [];
  if (!FLOW_KINDS.has(body?.kind) || nodes.length < 2) return [];
  const touched = new Set();
  for (const e of body.edges ?? []) if (e.from !== e.to) { touched.add(e.from); touched.add(e.to); }
  return nodes.filter((n) => !touched.has(n.id)).map((n) => n.id);
}

const LOOSE_NOTE = 'Ohne Verbindung weggelassen:';

/** `caption` plus `note`, the caption cut so the note always fits into the caption limit. */
function withNote(caption, note) {
  const room = LIMITS.caption - note.length - 1;
  if (!caption) return clean(note, LIMITS.caption);
  return room < 10 ? clean(note, LIMITS.caption) : `${clean(caption, room)} ${note}`;
}

/**
 * One flow / architecture body without loose boxes. When the connected boxes are a mostly linear chain in array order,
 * each run of loose boxes is spliced in at its array position: prev -> loose… -> next replaces the prev -> next arrow
 * (at the start of the chain: loose… -> first box; at its end: last box -> loose…). Every run that cannot be placed that
 * way is dropped and named in the caption. Pure; returns {body, spliced: ids, dropped: labels}.
 */
function connectBody(body) {
  const loose = new Set(isolatedNodes(body));
  if (!loose.size) return { body, spliced: [], dropped: [] };
  const nodes = body.nodes;
  let edges = (body.edges ?? []).map((e) => ({ ...e }));
  const connected = nodes.filter((n) => !loose.has(n.id));
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const real = edges.filter((e) => e.from !== e.to);
  const forward = real.filter((e) => at.get(e.from) < at.get(e.to)).length;
  const { fork, merge } = branching(connected, real);
  // "mostly linear": arrows mostly follow the array order, about one arrow per box, no hub (<= 2 arrows out / in per box),
  // at most two branch points each way
  const hub = connected.some((n) => outs(real, n.id) > 2 || ins(real, n.id) > 2);
  const linear = connected.length >= 2 && real.length > 0 && !hub && forward / real.length >= 0.75 && real.length <= connected.length + 1 && fork <= 2 && merge <= 2;
  const runs = [];
  nodes.forEach((n, i) => {
    if (!loose.has(n.id)) return;
    if (runs.length && runs.at(-1).end === i - 1) { runs.at(-1).ids.push(n.id); runs.at(-1).end = i; } else runs.push({ ids: [n.id], start: i, end: i });
  });
  const spliced = [];
  const drop = new Set();
  for (const run of runs) {
    const prev = [...nodes.slice(0, run.start)].reverse().find((n) => !loose.has(n.id) || spliced.includes(n.id))?.id;
    const next = nodes.slice(run.end + 1).find((n) => !loose.has(n.id))?.id;
    const chain = run.ids.slice(1).map((id, k) => ({ from: run.ids[k], to: id }));
    const direct = prev && next ? edges.findIndex((e) => e.from === prev && e.to === next) : -1;
    let added = null;
    if (!linear) added = null; // not a chain: there is no plausible place for the loose boxes
    else if (direct >= 0) {
      const { label, style } = edges[direct];
      added = { remove: direct, edges: [compact({ from: prev, to: run.ids[0], label, style }), ...chain.map((e) => compact({ ...e, style })), compact({ from: run.ids.at(-1), to: next, style })] };
    } else if (!prev && next && ins(real, next) === 0) added = { edges: [...chain, { from: run.ids.at(-1), to: next }] };
    else if (prev && !next && outs(real, prev) === 0) added = { edges: [{ from: prev, to: run.ids[0] }, ...chain] };
    if (added && edges.length - (added.remove >= 0 ? 1 : 0) + added.edges.length <= LIMITS.edges) {
      if (added.remove >= 0) edges.splice(added.remove, 1, ...added.edges); else edges.push(...added.edges);
      spliced.push(...run.ids);
    } else run.ids.forEach((id) => drop.add(id));
  }
  if (!drop.size) return { body: { ...body, edges }, spliced, dropped: [] };
  const dropped = nodes.filter((n) => drop.has(n.id)).map((n) => n.label);
  const kept = nodes.filter((n) => !drop.has(n.id));
  const groupsLeft = new Set(kept.map((n) => n.group).filter(Boolean));
  const out = { ...body, nodes: kept, edges, caption: withNote(body.caption, `${LOOSE_NOTE} ${dropped.join(', ')}.`) };
  if (body.groups) out.groups = body.groups.filter((g) => groupsLeft.has(g.id));
  if (out.groups && !out.groups.length) delete out.groups;
  return { body: out, spliced, dropped };
}

/** `spec` (a normalized CanvasSpec) with its simple view and its `detail` connected. Returns {spec, spliced, dropped, changed}. */
export function connectCanvas(spec) {
  if (!spec || typeof spec !== 'object' || !FLOW_KINDS.has(spec.kind)) return { spec, spliced: [], dropped: [], changed: false };
  const top = connectBody(spec);
  const detail = spec.detail && typeof spec.detail === 'object' ? connectBody({ ...spec.detail, kind: spec.kind, caption: spec.detail.caption || spec.caption }) : null;
  const spliced = [...top.spliced, ...(detail?.spliced ?? [])];
  const dropped = [...top.dropped, ...(detail?.dropped ?? [])];
  if (!spliced.length && !dropped.length) return { spec, spliced, dropped, changed: false };
  let d = detail?.body;
  if (d && !detail.dropped.length) d = { ...d, caption: spec.detail.caption }; // the borrowed caption only when a note was added
  return { spec: compact(d ? { ...top.body, detail: compact(d) } : top.body), spliced, dropped, changed: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Quality gate (round 6, critic r5 C3): a structurally valid spec can still be a stub. The illustrator, canvas_render
// and Claude canvases run it (`normalizeCanvas(spec, {gate: true})`); the error text is what the model repairs against.

const PLACEHOLDER_TEXT = /platzhalter|placeholder|lorem ipsum|\bTODO\b|\bTBD\b|^\s*(?:todo|tbd|xxx|n\/a|…|\.{2,})\s*$/i;

const PLACEHOLDER_FIELDS = { flow: 'nodes', architecture: 'nodes', pie: 'items', bar: 'items', sankey: 'nodes' };

/** A cell that carries no information: empty, one character, or a placeholder ("x", "y", "vexp: gemini", "-"). */
const JUNK_CELL = /^(?:[-–—.…?]+|x+|y+|z+|n\/a|tbd|todo|\.\.\.)$|^v?exp\s*:/i;
const junkCell = (cell) => { const t = String(cell ?? '').trim(); return !t || (t.length === 1 && !/\d/.test(t)) || JUNK_CELL.test(t); };

/** Table quality: >= 2 rows, >= 50 % real cells, no row that is only a first cell, no junk header. English reason or undefined. */
function tableError(spec) {
  if (spec.rows.length < 2) return `table has only ${spec.rows.length} row(s): give at least 2 real rows`;
  if (spec.columns.some((c) => !String(c).trim() || JUNK_CELL.test(String(c).trim()))) return 'table has placeholder column titles: name every column';
  const cells = spec.rows.flat();
  const real = cells.filter((c) => !junkCell(c));
  if (real.length < cells.length * 0.5) return `table is mostly empty or placeholder cells (${real.length} of ${cells.length} are real; no "x", "y", "vexp: …"): fill every cell from the facts`;
  const thin = spec.rows.findIndex((row) => row.length > 1 && row.slice(1).every((c) => !String(c).trim()));
  if (thin >= 0) return `table row ${thin + 1} has only its first cell filled: fill the other cells or drop the row`;
  return undefined;
}

/** Sankey quality: >= 2 distinct labelled nodes, links between them, and when it claims levels, more than one. */
function sankeyError(spec) {
  const labels = spec.nodes.map((n) => n.label);
  if (labels.some((l) => String(l).trim().length < 2)) return 'sankey has nodes without a real label';
  const sources = new Set(spec.links.map((l) => l.from));
  const targets = new Set(spec.links.map((l) => l.to));
  if (spec.links.length < 2) return 'sankey needs at least 2 flows';
  if (/(?:kategorie|gegenpartei|stufe|ebene)\w*\s+und\s+\w*|\bund\b(?:(?!\bund\b).)*(?:gegenpartei|kategorie)/i.test(spec.title ?? '') && ![...targets].some((t) => sources.has(t))) return 'sankey title promises two levels (e.g. category and counterparty) but all flows are on one level: add the second level';
  return undefined;
}

/** Short English reason when the spec is a placeholder or too thin to be worth showing; undefined when fine. */
export function qualityError(spec) {
  const texts = [['title', spec.title], ['caption', spec.caption]];
  const list = spec[PLACEHOLDER_FIELDS[spec.kind]];
  if (Array.isArray(list)) list.forEach((entry, i) => texts.push([`${PLACEHOLDER_FIELDS[spec.kind]}[${i}].label`, entry.label]));
  for (const [where, text] of texts) {
    if (typeof text === 'string' && PLACEHOLDER_TEXT.test(text)) return `${where} is a placeholder ("${text.slice(0, 30)}"): write the real content from the facts you have`;
  }
  if (spec.kind === 'flow' || spec.kind === 'architecture') {
    if (spec.nodes.length < 3) return `${spec.kind} has only ${spec.nodes.length} node(s): draw at least 3 real steps/parts from the facts`;
    if (!spec.edges.length) return `${spec.kind} has no edges: connect the nodes ("edges":[{"from","to"}])`;
    const loose = isolatedNodes(spec);
    if (loose.length) {
      const labels = loose.map((id) => `"${spec.nodes.find((n) => n.id === id)?.label ?? id}"`).slice(0, 6).join(', ');
      return `${spec.kind} has boxes without any arrow (${labels}): connect every box to the flow with an edge (in its place in the order), or leave it out`;
    }
    if (spec.kind === 'architecture' && spec.nodes.length >= 6 && !(spec.groups?.length)) return 'architecture with 6+ nodes needs "groups" (e.g. Browser / Gateway / Bridge / Vendors) and "group" on every node';
  }
  if ((spec.kind === 'pie' || spec.kind === 'bar') && spec.items.length < 2) return `${spec.kind} needs at least 2 items`;
  if (spec.kind === 'table') return tableError(spec);
  if (spec.kind === 'sankey') return sankeyError(spec);
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Heuristics (no LLM): when does the gateway draw although the agent did not, and what counts as a refusal to draw.

const EXPLAIN_RE = /\bwie\b|warum|wieso|erklär|zeig|architektur|aufbau|ablauf|funktioniert|wofür|wieviel|wie viel|kosten|geld|ausgaben|vergleich|diagramm|chart|grafik|skizze|übersicht|struktur|frage (?:über|zu|zum|zur)|steuer|rücklage|umwandeln|umwandlung|emission|tranche|wie läuft|was passiert/i;
const LONG_TURN = 60;
const REQUEST_RE = /\?|\b(?:frage|ich (?:möchte|will|würde|brauche|bräuchte|suche)|kannst du|könntest du|kann man|bitte|sag(?:e)? mir|gib mir|erzähl|beschreib|hilf|stell(?:e)? (?:mir|dir)|mach(?:e)? (?:mir|mal)|was|welche[rsmn]?|wo|wann|wer|wozu|weshalb)\b/i;
const CHITCHAT_RE = /^(?:danke|vielen dank|ok(?:ay)?|alles klar|super|prima|gut|hallo|hi|hey|tschüss|ja|nein|genau|stimmt|passt)\b[\s\S]{0,40}$/i;

/** True when a finished turn is explanatory enough to be illustrated: the question looks like one, or the answer is long / numeric. */
/**
 * Number of matches of /[^.!?]+[.!?]+(\s|$)/g, counted in one linear pass (r7, critic r6 P1-1: that regex rescanned the rest of
 * the text from every start position when no terminator followed, quadratic on a 20 kB answer). A sentence is a run of
 * non-terminators, a run of terminators and a blank (or the end); the blank after a counted sentence belongs to it.
 */
export function countSentences(text) {
  let n = 0;
  let pos = 0; // the first char not consumed by a counted sentence
  for (const m of String(text ?? '').matchAll(/[.!?]+/g)) {
    const end = m.index + m[0].length;
    const next = text[end];
    if (m.index > pos && (next === undefined || /\s/.test(next))) { n += 1; pos = next === undefined ? end : end + 1; }
  }
  return n;
}

export function isExplanatory(userText, answerText) {
  const user = String(userText ?? '').trim();
  if (EXPLAIN_RE.test(user)) return true;
  // any longer turn that asks or requests something is worth a picture (Florian's own phrasing: "Ich habe eine Frage über …")
  if (user.length >= LONG_TURN && REQUEST_RE.test(user) && !CHITCHAT_RE.test(user)) return true;
  const answer = String(answerText ?? '');
  const sentences = countSentences(answer);
  const numbers = (answer.match(/\d+(?:[.,]\d+)?/g) ?? []).length;
  return sentences >= 3 || numbers >= 3;
}

// Critic r3 P1-2: a request to WRITE (send / post / pay / transfer / deploy / notify / start a session) is refused by the desk
// (only a handoff card exists), so no automatic drawing may show the action as happening. DE + EN.
const WRITE_VERB = String.raw`(?:send|schick|sende|versende|verschick|poste|post|veröffentliche|publish|überweise|ueberweise|bezahle|zahle|pay|transfer|deploy|rolle|notify|benachrichtige|antworte|reply|tweet|starte|start|lösche|delete|push|merge)(?:en|n)?`;
const WRITE_OBJECT = String.raw`(?:mail|e-?mail|nachricht|message|dm|discord|kanal|channel|telegram|notification|benachrichtigung|tweet|überweisung|zahlung|payment|euro|eur|\$|€|coolify|redeploy|deployment|produktion|production|bridge|claude|sitzung|session|agent|board|kommentar|comment)`;
const WRITE_START = String.raw`(?:schick|sende|versende|verschick|poste?|überweise|ueberweise|bezahle|zahle|deploy|starte|lösche|veröffentliche|benachrichtige|notify|send|post|pay|transfer|publish|delete|start|mail)`;
const WRITE_INTENT_RE = new RegExp([
  // imperative + object ("Schick eine Mail ...", "Pay 5 EUR ...")
  String.raw`\b${WRITE_START}e?\b[^.!?\n]{0,60}\b${WRITE_OBJECT}\b`,
  // request form ("Kannst du ... eine Mail schicken?")
  String.raw`\b(?:kannst|könntest|kann|würdest|willst|can|could|would|please)\b[^.!?\n]{0,60}\b${WRITE_OBJECT}\b[^.!?\n]{0,40}\b${WRITE_VERB}\b`,
  String.raw`^\s*(?:bitte\s+|please\s+)?(?:deploy|redeploy|überweise|ueberweise)\w*\b|\b(?:deploy|redeploy)\w*\s+(?:bitte|jetzt|now|please)\b`,
  String.raw`\b(?:schick|sende|poste?|send|post|pay|bezahle|überweise|ueberweise|transfer)e?\s+(?:bitte\s+|mir\s+|jetzt\s+|please\s+|now\s+)*(?:eine?n?\s+|the\s+|an?\s+)?\S+\s+(?:an|to)\b`,
  // r6 P2-2: "Antworte Anna auf Discord", "Schreib ihr per Mail: ...", "Sag Ben auf Telegram Bescheid", "Reply to Anna on Discord"
  String.raw`\b(?:antworte|antworten|schreib|schreibe|schreiben|sag|sage|sagen|meld|melde|melden)\b[^.!?\n]{0,60}\b(?:auf|per|via|über|bei)\s+(?:discord|e-?mail|mail|telegram|x|slack|twitter|whatsapp|signal)\b`,
  String.raw`\b(?:reply|replying|answer|write|respond|message|ping|tell)\b[^.!?\n]{0,60}\b(?:on|via|to|by|over)\s+(?:discord|e-?mail|mail|telegram|x|slack|twitter|whatsapp|signal)\b`,
  String.raw`\bbescheid\s+(?:zu\s+)?(?:geb|sag)\w*|\b(?:geb|sag|gib|sage)\w*\b[^.!?\n]{0,40}\bbescheid\b`,
].join('|').replace(/\\b(?=\()/g, '(?<![\\p{L}\\p{N}_])'), 'iu');
// questions that merely ASK about such an action ("wie funktioniert der Versand?") are not requests to do it
const WRITE_QUESTION_RE = /^\s*(?:wie|was|warum|wieso|weshalb|wann|wer|wo|erklär\w*|how|what|why|when|who|where|explain)\b/i;
/** True when the user asks the desk to DO a write action (send / post / pay / deploy / notify ...), not to explain one. */
export function wantsWriteAction(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (WRITE_QUESTION_RE.test(t) && !/\b(?:bitte|please|jetzt|now)\b/i.test(t)) return false;
  return WRITE_INTENT_RE.test(t);
}

export const REFUSAL_RE = /(kann|könnte).{0,30}(keine|nicht).{0,30}(diagramm|zeichn|canvas|grafik)/i;
export const REFUSAL_REPLACEMENT = 'Ich zeichne es dir auf.';

export const refusesToDraw = (text) => REFUSAL_RE.test(String(text ?? ''));

/**
 * The user forbids a drawing for this turn ("zeichne nichts", "ohne Bild", "keine Grafik", "nicht zeichnen"). Only explicit
 * negations of the user's OWN request count: text in quotes and a sentence the agent is asked to repeat ("Ich kann leider keine
 * Diagramme …") is not a request, and "keine Werkzeuge" between the words is no drawing ban.
 */
const NO_DRAWING_RE = /\b(?:nicht|nichts|kein\w*|ohne)\s+((?:[\wäöüß-]+\s+){0,2}?)(?:zeichn\w*|bild\w*|grafik\w*|diagramm\w*|skizz\w*|canvas|visualisier\w*)|\b(?:zeichn\w*|visualisier\w*)\s+((?:[\wäöüß-]+\s+){0,2}?)(?:nicht|nichts)\b/gi;
// r7: an opener never occurs inside its own quote, so a run of unclosed openers ("„„„…") is not rescanned per opener
const QUOTED_RE = /"[^"]*"|„[^“”"„]*[“”"]|»[^«»]*«|«[^»«]*»|‚[^‘’'‚]*[‘’']|`[^`]*`|(?<![\wäöüß])'[^']*'(?![\wäöüß])/g;
export function wantsNoDrawing(text) {
  const own = String(text ?? '').replace(QUOTED_RE, ' ').split(/(?<=[.!?:\n])\s+/).filter((sentence) => !REFUSAL_RE.test(sentence)).join(' ');
  for (const m of own.matchAll(NO_DRAWING_RE)) if (!/werkzeug|tool|funktion|aufruf/i.test(`${m[1] ?? ''} ${m[2] ?? ''}`)) return true;
  return false;
}

// CJK glyphs inside a German answer are a model slip ("ohne弛 Payload", critic r6): dropped from German text.
const GERMAN_RE = /[äöüß]|\b(?:der|die|das|und|ist|wie|was|ich|nicht|mit|für|zu|ein|eine|auf|den|dem|wir|hast|habe)\b/i;
/** True when the conversation is German: the user's text has German words and no CJK itself. */
export const isGermanText = (text) => !/[\u3400-\u9FFF]/.test(String(text ?? '')) && GERMAN_RE.test(String(text ?? ''));
const CJK_RUN = /[\u3400-\u9FFF]+/g;
/** The CJK runs of a text ("测试" in a Discord DM label): what stripCjk keeps when a tool result carries it. */
export const cjkRuns = (text) => String(text ?? '').match(CJK_RUN) ?? [];
/**
 * Removes CJK glyphs (U+3400–U+9FFF) from text of a German conversation. Critic r6 P2-3: a run that occurs verbatim in one of
 * `keep` (the tool results of the turn, or their CJK runs) is a real name and stays; a run split over two stream pieces stays
 * too, since each half is a substring of the source.
 */
export const stripCjk = (text, keep = []) => String(text ?? '').replace(CJK_RUN, (run) => (keep.some((k) => String(k ?? '').includes(run)) ? run : ''));

/** Asks for secrets / key files: nobody wants a drawing for that, the agent refuses it. */
const SECRET_ASK_RE = /secrets?\.env|\.env\b|api[- ]?key|passwort|password|private key|schlüssel|credential|zugangsdaten|\btoken\b|id_ed25519|seed phrase/i;
export const asksForSecrets = (text) => SECRET_ASK_RE.test(String(text ?? ''));

/** An answer that is a refusal or a "nothing found" report: there is nothing to illustrate. */
const META_ANSWER_RE = /ich habe (?:leider |dazu |hierzu |dort )*(?:nichts|keine?n?)\b.{0,40}(?:gefunden|finden)|nichts gefunden|(?:kann|darf|werde|möchte) ich (?:dir )?(?:das |diese |die |den |dir )?(?:\w+ )?(?:nicht|keine?n?)\b.{0,50}(?:lesen|ausgeben|zeigen|preisgeben|nennen|vorlesen|herausgeben)|keine verlässliche antwort|(?:geheim|secret|schlüssel|passwort|token).{0,90}?(?:nicht|keine)\b.{0,30}(?:ausgeben|lesen|zeigen|nennen|preisgeben)/i; // one lazy .{0,90}?: `\w*.{0,60}` backtracked 8 s on 16 kB of "TOKEN" (critic r7)
export const isMetaAnswer = (text) => META_ANSWER_RE.test(String(text ?? ''));

/**
 * Streaming guard for the text agent: holds text back until a sentence is complete (or 200 characters passed) and
 * swaps a sentence that refuses to draw for REFUSAL_REPLACEMENT. `refused` tells the caller to draw itself.
 */
export class RefusalFilter {
  #buffer = '';
  #replaced = false;
  refused = false;

  #release(text) {
    if (!REFUSAL_RE.test(text)) return text;
    this.refused = true;
    // replace the sentence(s) that match, keep the rest; the replacement is said once per filter (= per turn), later ones are dropped
    const parts = text.split(/(?<=[.!?\n])\s+/).map((sentence) => {
      if (!REFUSAL_RE.test(sentence)) return sentence;
      if (this.#replaced) return '';
      this.#replaced = true;
      return REFUSAL_REPLACEMENT;
    });
    return parts.filter(Boolean).join(' ');
  }

  push(piece) {
    this.#buffer += piece;
    const end = Math.max(this.#buffer.lastIndexOf('. '), this.#buffer.lastIndexOf('! '), this.#buffer.lastIndexOf('? '), this.#buffer.lastIndexOf('\n'));
    if (end >= 0) {
      const out = this.#buffer.slice(0, end + 1);
      this.#buffer = this.#buffer.slice(end + 1);
      return this.#release(out);
    }
    if (this.#buffer.length > 200 && !REFUSAL_RE.test(this.#buffer)) {
      const out = this.#buffer.slice(0, this.#buffer.length - 80);
      this.#buffer = this.#buffer.slice(-80);
      return out;
    }
    return '';
  }

  flush() {
    const out = this.#buffer;
    this.#buffer = '';
    return out ? this.#release(out) : '';
  }
}
