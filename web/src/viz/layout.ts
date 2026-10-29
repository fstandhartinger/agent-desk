// Deterministic layered layout for a VizSpec. Same spec + size → same positions, so a spec update only moves what
// actually changed and the renderer can tween every node from its old to its new place (keyed by id).
import type { VizEdge, VizNode, VizSpec } from '../lib/types';
import { FONT } from './theme';

/** `text`/`sub` are the label/value as drawn: ellipsised to the card width so text never spills out of a card. */
export interface Box { id: string; x: number; y: number; w: number; h: number; layer: number; band: number; round: boolean; text: string; sub?: string }
/**
 * `scale` is the zoom to draw at. Normally the fit; when the fit would shrink text below READABLE_SCALE the layout is
 * drawn at a readable size instead and `scroll` is set: it then fits the width and scrolls vertically.
 * `side` holds the keys of edges that enter their target from the side because the direct path crosses another card.
 */
export interface Layout { boxes: Map<string, Box>; width: number; height: number; horizontal: boolean; scale: number; scroll: boolean; side: Set<string> }
type Draft = Omit<Layout, 'scale' | 'scroll' | 'side'>;
export interface Avail { width: number; height: number }

/** `compact` = narrower cards and tighter gaps, used when the normal layout would have to shrink the text. */
type Density = 'normal' | 'compact';
const CARDS: Record<Density, { minW: number; maxW: number; pad: number; h: number; hValue: number }> = {
  normal: { minW: 136, maxW: 248, pad: 66, h: 50, hValue: 64 },
  compact: { minW: 112, maxW: 196, pad: 62, h: 48, hValue: 60 },
};
const GAPS: Record<Density, { layer: number; layerLabelled: number; sibling: number; vLayer: number; vLayerLabelled: number; vSibling: number; band: number }> = {
  normal: { layer: 84, layerLabelled: 128, sibling: 20, vLayer: 56, vLayerLabelled: 66, vSibling: 16, band: 64 },
  compact: { layer: 60, layerLabelled: 104, sibling: 14, vLayer: 44, vLayerLabelled: 56, vSibling: 12, band: 40 },
};
/** Below this canvas width only top→bottom layouts are tried (phones). */
export const NARROW = 500;
/** Text is drawn at 1:1 up to this zoom. */
export const MAX_SCALE = 1.15;
/** Smallest zoom that keeps text readable: 15 px labels → 12.9 px, 14 px values and edge labels → 12 px. */
export const READABLE_SCALE = 0.86;

let ctx: CanvasRenderingContext2D | null = null;
const widthCache = new Map<string, number>();
export function textWidth(text: string, font: string): number {
  const key = `${font}|${text}`;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (!ctx && typeof document !== 'undefined') ctx = document.createElement('canvas').getContext('2d');
    if (ctx) { ctx.font = font; w = ctx.measureText(text).width; } else w = text.length * 8.2;
    if (widthCache.size > 2000) widthCache.clear();
    widthCache.set(key, w);
  }
  return w;
}

/** Drop web-font metrics measured before the font loaded (the caller re-lays out afterwards). */
export const resetTextWidths = () => widthCache.clear();

/** `text` shortened with "…" so it is at most `max` px wide in `font`. */
export function ellipsize(text: string, font: string, max: number): string {
  if (textWidth(text, font) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${text.slice(0, mid).trimEnd()}…`, font) <= max) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

export const LABEL_FONT = `600 15px ${FONT}`;
export const VALUE_FONT = `500 14px ${FONT}`;
export const NUMBER_FONT = `700 22px ${FONT}`;
export const EDGE_FONT = `500 14px ${FONT}`;

type Size = { w: number; h: number; round: boolean; text: string; sub?: string };

function size(n: VizNode, density: Density): Size {
  const card = CARDS[density];
  if (n.kind === 'number' && n.value) {
    const d = Math.min(116, Math.max(76, textWidth(n.value, NUMBER_FONT) + 30));
    const text = ellipsize(n.label, VALUE_FONT, card.maxW - 8);
    return { w: Math.max(d, textWidth(text, VALUE_FONT) + 8), h: d + 26, round: true, text, sub: ellipsize(n.value, NUMBER_FONT, d - 12) };
  }
  const text = ellipsize(n.label, LABEL_FONT, card.maxW - card.pad);
  const sub = n.value ? ellipsize(n.value, VALUE_FONT, card.maxW - card.pad) : undefined;
  const tw = Math.max(textWidth(text, LABEL_FONT), sub ? textWidth(sub, VALUE_FONT) : 0);
  return { w: Math.min(card.maxW, Math.max(card.minW, tw + card.pad)), h: sub ? card.hValue : card.h, round: false, text, sub };
}

/** Longest-path layering; back edges of cycles are ignored (DFS in node order, deterministic). */
function layers(nodes: VizNode[], edges: VizEdge[]): Map<string, number> {
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const dag: [string, string][] = [];
  const visit = (id: string) => {
    state.set(id, 1);
    for (const to of out.get(id) ?? []) {
      if (state.get(to) === 1) continue; // back edge
      dag.push([id, to]);
      if (!state.has(to)) visit(to);
    }
    state.set(id, 2);
  };
  const hasIn = new Set(edges.map((e) => e.to));
  for (const n of nodes) if (!hasIn.has(n.id) && !state.has(n.id)) visit(n.id);
  for (const n of nodes) if (!state.has(n.id)) visit(n.id);

  const layer = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const [a, b] of dag) {
      if (layer.get(b)! < layer.get(a)! + 1) { layer.set(b, layer.get(a)! + 1); changed = true; }
    }
  }
  // Unconnected nodes go to the last layer (the "result" side) unless the whole spec has no edges.
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const max = Math.max(0, ...layer.values());
  if (linked.size) for (const n of nodes) if (!linked.has(n.id)) layer.set(n.id, max);
  return layer;
}

type Sizes = Map<string, Size>;
type Placed = { boxes: Map<string, Box>; width: number; height: number };

/** Zoom at which `layout` fits `avail` (text is drawn at 1:1 up to MAX_SCALE). */
export const fitScale = (layout: Draft, avail: Avail) => Math.min(MAX_SCALE, avail.width / layout.width, avail.height / layout.height);

/**
 * Tries left→right and top→bottom (only top→bottom on narrow canvases), each with the layer sequence wrapped into 1–3
 * bands (long chains read like lines of text), in normal and compact density, and keeps the candidate that can be drawn
 * largest. Once a candidate reaches 1:1, simpler wins: left→right, fewer bands, normal density, fewer edges across a
 * band break. If even the best one would shrink text below READABLE_SCALE, the shortest candidate that fits the width
 * at a readable size is used and scrolls.
 */
export function layoutSpec(spec: VizSpec, avail: Avail): Layout {
  const cands: { l: Draft; score: number }[] = [];
  const narrow = avail.width < NARROW;
  for (const density of ['normal', 'compact'] as const) {
    for (const horizontal of narrow ? [false] : [true, false]) {
      // Top→bottom layouts also try wrapping wide layers (fan-outs) at a few widths.
      for (const wrap of horizontal ? [1] : [1.6, 1, 0.6]) {
        // Side-by-side columns make no sense on a phone; one column reads top to bottom.
        for (let bands = 1; bands <= (narrow ? 1 : 3); bands++) {
          const l = build(spec, avail, horizontal, bands, wrap, density);
          if (!l) break;
          const s = Math.min(1, avail.width / l.width, avail.height / l.height);
          const breaks = spec.edges.filter((e) => l.boxes.get(e.from)?.band !== l.boxes.get(e.to)?.band).length;
          const crossing = crossings(spec.edges, l);
          const score = (s * (horizontal ? 1.1 : 1) * (density === 'normal' ? 1.04 : 1))
            / (1 + (bands - 1) * 0.12) / (1 + breaks * 0.04) / (1 + crossing * 0.2);
          cands.push({ l, score });
        }
      }
    }
  }
  const best = cands.reduce((a, b) => (b.score > a.score ? b : a));
  let pick = best.l;
  let scale = fitScale(pick, avail);
  if (scale < READABLE_SCALE) {
    const readable = cands
      .filter((c) => avail.width / c.l.width >= READABLE_SCALE)
      .sort((a, b) => a.l.height - b.l.height || b.score - a.score)[0];
    // Exactly readable, not larger: keeps the scroll distance short.
    if (readable) { pick = readable.l; scale = Math.max(READABLE_SCALE, fitScale(pick, avail)); }
  }
  return { ...pick, scale, scroll: pick.height * scale > avail.height + 0.5, side: routeEdges(spec.edges, pick) };
}

function build(spec: VizSpec, avail: Avail, horizontal: boolean, bands: number, wrap: number, density: Density): Draft | null {
  const GAP = GAPS[density];
  const nodes = spec.nodes;
  const sizes: Sizes = new Map(nodes.map((n) => [n.id, size(n, density)]));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = spec.edges.filter((e) => sizes.has(e.from) && sizes.has(e.to));

  // Edgeless specs read best as a grid of cards (explainer "row of cards").
  if (!edges.length) return bands === 1 ? grid(nodes, sizes, avail, horizontal, density) : null;

  const layer = layers(nodes, edges);
  const count = Math.max(...layer.values()) + 1;
  if (bands > 1 && count < bands * 2) return null;
  const rows: string[][] = Array.from({ length: count }, () => []);
  for (const n of nodes) rows[layer.get(n.id)!].push(n.id);

  // One barycenter sweep (forward then backward) to reduce crossings; ties keep spec order.
  const order = new Map<string, number>();
  rows.forEach((r) => r.forEach((id, i) => order.set(id, i)));
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const succs = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) { preds.get(e.to)!.push(e.from); succs.get(e.from)!.push(e.to); }
  const sweep = (r: string[], nb: Map<string, string[]>) => {
    const key = (id: string) => {
      const ns = nb.get(id)!.filter((x) => order.has(x));
      return ns.length ? ns.reduce((s, x) => s + order.get(x)!, 0) / ns.length : order.get(id)!;
    };
    r.sort((a, b) => key(a) - key(b) || index.get(a)! - index.get(b)!);
    r.forEach((id, i) => order.set(id, i));
  };
  for (let i = 1; i < rows.length; i++) sweep(rows[i], preds);
  for (let i = rows.length - 2; i >= 0; i--) sweep(rows[i], succs);

  const labelled = (a: number) => edges.some((e) => e.label && (layer.get(e.from) === a || layer.get(e.to) === a));
  const per = Math.ceil(count / bands);
  const parts: Placed[] = [];
  for (let b = 0; b < bands; b++) {
    const first = b * per;
    const chunk = rows.slice(first, first + per);
    parts.push(horizontal ? placeH(chunk, first, sizes, labelled, density) : placeV(chunk, first, sizes, (avail.width / bands) * wrap, labelled, density));
  }

  // Stack the bands: rows of layers under each other (left→right) or columns side by side (top→bottom).
  const boxes = new Map<string, Box>();
  const width = horizontal ? Math.max(...parts.map((p) => p.width)) : parts.reduce((s, p) => s + p.width, 0) + GAP.band * (bands - 1);
  const height = horizontal ? parts.reduce((s, p) => s + p.height, 0) + GAP.band * (bands - 1) : Math.max(...parts.map((p) => p.height));
  let off = 0;
  parts.forEach((p, b) => {
    const dx = horizontal ? (width - p.width) / 2 : off;
    const dy = horizontal ? off : (height - p.height) / 2;
    for (const box of p.boxes.values()) boxes.set(box.id, { ...box, x: box.x + dx, y: box.y + dy, band: b });
    off += (horizontal ? p.height : p.width) + GAP.band;
  });
  return { boxes, width, height, horizontal };
}

const boxOf = (id: string, s: Size, x: number, y: number, layer: number): Box =>
  ({ id, x, y, w: s.w, h: s.h, layer, band: 0, round: s.round, text: s.text, sub: s.sub });

function placeH(rows: string[][], first: number, sizes: Sizes, labelled: (layer: number) => boolean, density: Density): Placed {
  const GAP = GAPS[density];
  const boxes = new Map<string, Box>();
  const cols = rows.map((r) => ({
    r,
    w: Math.max(...r.map((id) => sizes.get(id)!.w)),
    h: r.reduce((s, id) => s + sizes.get(id)!.h, 0) + GAP.sibling * (r.length - 1),
  }));
  const height = Math.max(...cols.map((c) => c.h));
  let x = 0;
  cols.forEach(({ r, w, h }, i) => {
    let y = (height - h) / 2;
    for (const id of r) {
      const s = sizes.get(id)!;
      boxes.set(id, boxOf(id, s, x + w / 2, y + s.h / 2, first + i));
      y += s.h + GAP.sibling;
    }
    x += w + (i < cols.length - 1 ? (labelled(first + i) ? GAP.layerLabelled : GAP.layer) : 0);
  });
  return { boxes, width: x, height };
}

/** Layers top → bottom; layers wider than the band wrap into several lines. */
function placeV(rows: string[][], first: number, sizes: Sizes, bandWidth: number, labelled: (layer: number) => boolean, density: Density): Placed {
  const GAP = GAPS[density];
  const boxes = new Map<string, Box>();
  const maxRow = Math.max(bandWidth, CARDS[density].maxW);
  const lines: { ids: string[]; li: number }[] = [];
  rows.forEach((r, i) => {
    let cur: string[] = [];
    let w = 0;
    for (const id of r) {
      const sw = sizes.get(id)!.w;
      if (cur.length && w + GAP.vSibling + sw > maxRow) { lines.push({ ids: cur, li: first + i }); cur = []; w = 0; }
      w += (cur.length ? GAP.vSibling : 0) + sw;
      cur.push(id);
    }
    if (cur.length) lines.push({ ids: cur, li: first + i });
  });
  const widths = lines.map((l) => l.ids.reduce((s, id) => s + sizes.get(id)!.w, 0) + GAP.vSibling * (l.ids.length - 1));
  const width = Math.max(...widths);
  let y = 0;
  lines.forEach((l, i) => {
    const h = Math.max(...l.ids.map((id) => sizes.get(id)!.h));
    let x = (width - widths[i]) / 2;
    for (const id of l.ids) {
      const s = sizes.get(id)!;
      boxes.set(id, boxOf(id, s, x + s.w / 2, y + h / 2, l.li));
      x += s.w + GAP.vSibling;
    }
    const next = lines[i + 1];
    y += h + (!next ? 0 : next.li === l.li ? GAP.vSibling + 4 : labelled(l.li) ? GAP.vLayerLabelled : GAP.vLayer);
  });
  return { boxes, width, height: y };
}

function grid(nodes: VizNode[], sizes: Sizes, avail: Avail, horizontal: boolean, density: Density): Draft {
  const GAP = GAPS[density];
  const cellW = Math.max(...nodes.map((n) => sizes.get(n.id)!.w));
  const cellH = Math.max(...nodes.map((n) => sizes.get(n.id)!.h));
  const fit = Math.max(1, Math.floor((avail.width + GAP.sibling) / (cellW + GAP.sibling * 2)));
  const cols = Math.min(nodes.length, fit, Math.ceil(Math.sqrt(nodes.length * (horizontal ? 2.2 : 0.8))));
  const boxes = new Map<string, Box>();
  nodes.forEach((n, i) => {
    const s = sizes.get(n.id)!;
    const c = i % cols;
    const r = Math.floor(i / cols);
    boxes.set(n.id, boxOf(n.id, s, c * (cellW + GAP.sibling * 2) + cellW / 2, r * (cellH + GAP.sibling * 2) + cellH / 2, r));
  });
  const rowsN = Math.ceil(nodes.length / cols);
  return { boxes, width: cols * cellW + (cols - 1) * GAP.sibling * 2, height: rowsN * cellH + (rowsN - 1) * GAP.sibling * 2, horizontal };
}

export interface Pt { x: number; y: number }

/**
 * Cubic edge between two boxes, leaving/entering on the sides that face each other. With `side`, it enters the target
 * from the perpendicular side instead (used when the direct path would cross another card).
 */
export function edgeGeometry(a: Box, b: Box, horizontal: boolean, side = false): { d: string; c: Pt[]; mid: Pt; start: Pt; end: Pt; angle: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const sx = Math.sign(dx) || 1;
  const sy = Math.sign(dy) || 1;
  // Edges follow the reading direction; edges inside one layer or into the next band (a line break) go across it.
  const across = a.band !== b.band || a.layer === b.layer ? !horizontal : horizontal;
  let p0: Pt, p3: Pt, c1: Pt, c2: Pt;
  if (across) {
    p0 = { x: a.x + (sx * a.w) / 2, y: a.y };
    if (side) {
      p3 = { x: b.x, y: b.y - (sy * b.h) / 2 - sy * 6 };
      c1 = { x: p0.x + sx * Math.max(28, Math.abs(p3.x - p0.x) * 0.6), y: p0.y };
      c2 = { x: p3.x, y: p3.y - sy * Math.max(24, Math.abs(p3.y - p0.y) * 0.5) };
    } else {
      p3 = { x: b.x - (sx * b.w) / 2 - sx * 6, y: b.y };
      const k = Math.max(28, Math.abs(p3.x - p0.x) * 0.45);
      c1 = { x: p0.x + sx * k, y: p0.y };
      c2 = { x: p3.x - sx * k, y: p3.y };
    }
  } else {
    p0 = { x: a.x, y: a.y + (sy * a.h) / 2 };
    if (side) {
      const ex = -sx; // enter on the side that faces the source
      p3 = { x: b.x + ex * (b.w / 2 + 6), y: b.y };
      c1 = { x: p0.x, y: p0.y + sy * Math.max(24, Math.abs(p3.y - p0.y) * 0.6) };
      c2 = { x: p3.x + ex * Math.max(28, Math.abs(p3.x - p0.x) * 0.5), y: p3.y };
    } else {
      p3 = { x: b.x, y: b.y - (sy * b.h) / 2 - sy * 6 };
      const k = Math.max(24, Math.abs(p3.y - p0.y) * 0.45);
      c1 = { x: p0.x, y: p0.y + sy * k };
      c2 = { x: p3.x, y: p3.y - sy * k };
    }
  }
  const mid = {
    x: 0.125 * p0.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * p3.x,
    y: 0.125 * p0.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * p3.y,
  };
  const r = (n: number) => n.toFixed(1);
  return {
    d: `M${r(p0.x)},${r(p0.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p3.x)},${r(p3.y)}`,
    c: [p0, c1, c2, p3],
    mid,
    start: p0,
    end: p3,
    angle: (Math.atan2(p3.y - c2.y, p3.x - c2.x) * 180) / Math.PI,
  };
}

export interface Cam { tx: number; ty: number; s: number }

/**
 * Camera that maps layout units to the drawing area `{x, y, width, height}`: zoom to fit (never above MAX_SCALE),
 * centred, leaning up to 8 % towards the focus node, but only as far as the free space allows, so no box is ever
 * outside the area (a "meet" fit, like an SVG viewBox with preserveAspectRatio="xMidYMid meet").
 */
export function fitCamera(layout: Layout, area: Avail & { x: number; y: number }, focus?: Box): Cam {
  const s = Math.min(layout.scale, fitScale(layout, area));
  const lean = (free: number, toward: number) => Math.max(-free / 2, Math.min(free / 2, toward * 0.08 * s));
  const nx = focus ? lean(area.width - layout.width * s, focus.x - layout.width / 2) : 0;
  const ny = focus ? lean(area.height - layout.height * s, focus.y - layout.height / 2) : 0;
  return {
    s,
    tx: area.x + (area.width - layout.width * s) / 2 - nx,
    ty: area.y + (area.height - layout.height * s) / 2 - ny,
  };
}

const LABEL_H = 22;
/** Edges shorter than this on screen get no label (it would cover the arrow). */
export const MIN_LABEL_EDGE_PX = 40;

/**
 * Which edge labels to draw and as what text, for the final layout at zoom `scale`. A label is shortened to fit its
 * edge, dropped when the edge is shorter than MIN_LABEL_EDGE_PX on screen, and dropped when its pill would overlap a
 * card or an earlier label (spec order wins).
 */
export function placeEdgeLabels(edges: VizEdge[], layout: Layout, scale: number): Map<string, string> {
  const out = new Map<string, string>();
  const taken: { x: number; y: number; w: number; h: number }[] = [];
  const hits = (r: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, m: number) =>
    Math.abs(r.x - b.x) * 2 < r.w + b.w + m * 2 && Math.abs(r.y - b.y) * 2 < r.h + b.h + m * 2;
  for (const e of edges) {
    const a = layout.boxes.get(e.from);
    const b = layout.boxes.get(e.to);
    if (!e.label || !a || !b) continue;
    const g = edgeGeometry(a, b, layout.horizontal, layout.side.has(edgeKey(e)));
    const len = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
    if (len * scale < MIN_LABEL_EDGE_PX) continue;
    // Along a horizontal edge the pill may use most of its length; across a vertical one it may be wider than the gap.
    const along = Math.abs(g.end.x - g.start.x) >= Math.abs(g.end.y - g.start.y);
    const text = ellipsize(e.label, EDGE_FONT, Math.min(150, along ? len - 30 : 150));
    if (text === '…') continue;
    const rect = { x: g.mid.x, y: g.mid.y, w: textWidth(text, EDGE_FONT) + 16, h: LABEL_H };
    if ([...layout.boxes.values()].some((box) => hits(rect, box, 4)) || taken.some((t) => hits(rect, t, 3))) continue;
    taken.push(rect);
    out.set(edgeKey(e), text);
  }
  return out;
}

export const edgeKey = (e: VizEdge) => `${e.from}>${e.to}`;

/** Does the cubic `c` pass through a card other than its own two ends? */
function crossesCard(c: Pt[], boxes: Iterable<Box>, from: string, to: string): boolean {
  const others = [...boxes].filter((b) => b.id !== from && b.id !== to);
  for (let i = 1; i < 16; i++) {
    const t = i / 16, u = 1 - t;
    const x = u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x;
    const y = u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y;
    if (others.some((b) => Math.abs(x - b.x) < b.w / 2 + 2 && Math.abs(y - b.y) < b.h / 2 + 2)) return true;
  }
  return false;
}

/** Edges whose direct path crosses another card but whose side entry does not. */
function routeEdges(edges: VizEdge[], l: Draft): Set<string> {
  const side = new Set<string>();
  for (const e of edges) {
    const a = l.boxes.get(e.from), b = l.boxes.get(e.to);
    if (!a || !b || !crossesCard(edgeGeometry(a, b, l.horizontal).c, l.boxes.values(), a.id, b.id)) continue;
    if (!crossesCard(edgeGeometry(a, b, l.horizontal, true).c, l.boxes.values(), a.id, b.id)) side.add(edgeKey(e));
  }
  return side;
}

/** Edges that still run through a card after routing (each makes a candidate layout less attractive). */
function crossings(edges: VizEdge[], l: Draft): number {
  const side = routeEdges(edges, l);
  return edges.filter((e) => {
    const a = l.boxes.get(e.from), b = l.boxes.get(e.to);
    return a && b && crossesCard(edgeGeometry(a, b, l.horizontal, side.has(edgeKey(e))).c, l.boxes.values(), a.id, b.id);
  }).length;
}
