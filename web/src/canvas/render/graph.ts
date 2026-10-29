// flow + architecture: ELK layered layout (lazy chunk), groups as compound nodes, orthogonal edges with rounded bends,
// arrowheads and edge labels on pills. ELK reserves room for every label, so nothing overlaps by construction; the
// tests check that for the reference architecture.
import type { CanvasEdge, CanvasNode, CanvasSpec } from '../types';
import { legiblePx, pickScale, OVERVIEW_PX } from '../view';
import { arrowHead, measure, PALETTE as P, rgba, roundedPath, tone, wrap, type Box, type Prim, type Scene, type Size } from './scene';

type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number; children?: ElkNode[]; layoutOptions?: Record<string, string>; labels?: { text: string; width: number; height: number }[] };
type ElkEdge = { id: string; sources: string[]; targets: string[]; labels?: { id?: string; text: string; width: number; height: number; x?: number; y?: number }[]; sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[] };
type Pt = { x: number; y: number };
interface ElkApi { layout(g: ElkNode & { edges: ElkEdge[] }): Promise<ElkNode & { edges: ElkEdge[] }> }

let elkPromise: Promise<ElkApi> | null = null;
/** elkjs (~1.6 MB) only loads when the first flow/architecture canvas is drawn. */
export function loadElk(): Promise<ElkApi> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then((m) => {
    const ELK = (m as unknown as { default: new () => ElkApi }).default;
    return new ELK();
  });
  return elkPromise;
}

export interface NodeGeom { id: string; box: Box; lines: string[]; detail: string[]; shape: NonNullable<CanvasNode['shape']> }
export interface GraphLayout { dims: Dims; w: number; h: number; nodes: NodeGeom[]; groups: { id: string; label: string; box: Box; tone?: string; legend?: string[] }[]; edges: { key: string; from: string; to: string; pts: Pt[]; label?: { text: string; box: Box; full?: string }; style: string; both?: boolean }[]; dir: 'LR' | 'TB' }

/** Valid edges with "response" back-edges folded in: when A→B and B→A both exist, B→A is dropped and A→B gets an
 *  arrowhead at both ends (its label "x / y" when both are labelled differently). A pure answer edge would otherwise be a
 *  feedback edge that ELK routes around the whole diagram. */
export function foldEdges(edges: CanvasEdge[] | undefined, ids: Set<string>): (CanvasEdge & { both?: boolean })[] {
  const valid = (edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const out: (CanvasEdge & { both?: boolean })[] = [];
  for (const e of valid) {
    const fwd = out.find((f) => f.from === e.to && f.to === e.from);
    if (!fwd) { out.push({ ...e }); continue; }
    fwd.both = true;
    if (e.label && e.label !== fwd.label) fwd.label = fwd.label ? `${fwd.label} / ${e.label}` : e.label;
  }
  return out;
}

// Type scale. Narrow stages (phones) get a tighter variant so a 14-node architecture stays readable when fitted.
const WIDE = { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 168, line: 20, dline: 16, nodeNode: 30, layers: 58 };
// Wide stages with a horizontal chain: narrower nodes (details wrap) and tighter layers, there is height to spare.
const CHAIN = { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 124, line: 20, dline: 16, nodeNode: 22, layers: 40 };
const NARROW = { label: 15, labelW: 600, detail: 12, edge: 12, group: 11.5, maxText: 118, line: 19, dline: 15, nodeNode: 16, layers: 40 };
// Phones with long chains: smaller nodes, labels wrap to three lines, tight layers (still ≥ 11 px on screen at 0.8 scale).
const COMPACT = { label: 14, labelW: 600, detail: 11.5, edge: 11.5, group: 11, maxText: 90, line: 17, dline: 14, nodeNode: 10, layers: 30 };
// Overview of a big diagram on a desktop stage: labels only (the details would be ~6 px at the scale the whole needs;
// they stay in the node's tooltip and come back in "Groß"), tight spacing.
// Upgrades 28 Oct (§5): a simple view (<= 5 boxes) on a desktop stage is read at a glance while talking: bigger type.
/** Simple views: node labels at least this big on screen (Florian glances at them while talking). */
export const SIMPLE_MIN_PX = 16;
const SIMPLE_T = { label: 19, labelW: 600, detail: 13, edge: 14, group: 13, maxText: 150, line: 23, dline: 17, nodeNode: 28, layers: 46 };
const DENSE = { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 124, line: 19, dline: 16, nodeNode: 12, layers: 20 };
// Last whole-diagram resort for big diagrams on desktop (round 9): labels wrap to three narrow lines, tight layers and
// edge labels only as tooltips, so a 13-node / 5-group architecture still fits a side column whole.
const OVER = { label: 16, labelW: 600, detail: 12.5, edge: 12.5, group: 12, maxText: 80, line: 19, dline: 16, nodeNode: 10, layers: 14 };
type Dims = typeof WIDE;

/** Group legend (the label pill on the frame's top border): never ellipsised (r8 "BROW…", "BRIDGE AUF"). It wraps to
 *  more lines in the overviews, where columns are narrow; the frame reserves its width and the extra lines. */
export const LEGEND_LINE = 15;
export function legendLines(label: string, T: Dims, maxW = T === DENSE ? 132 : T === OVER ? 104 : 420): string[] {
  const words = label.toUpperCase().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if (cur !== undefined && measure(`${cur} ${w}`, T.group, 700) * 1.08 <= maxW) lines[lines.length - 1] = `${cur} ${w}`;
    else lines.push(w);
  }
  return lines.length ? lines : [''];
}
/** Pill width for legend lines; the frame must be at least `legendW + 28` wide (pill starts 16 in, 12 to spare). */
export const legendW = (lines: string[], T: Dims) => Math.max(...lines.map((l) => measure(l, T.group, 700))) * 1.08 + 34;

/** A line that is only a connector ("—", "/", "+") joins the line before it ("Grundbuch —" / "wissen.js"). */
export function joinLoneMarks(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (out.length && /^[—–\-/+&·|]$/.test(l.trim())) out[out.length - 1] = `${out[out.length - 1]} ${l.trim()}`;
    else out.push(l);
  }
  return out;
}

/** A node's detail on two lines, without "…": the node widens (up to 1.9× the base text width) until the detail fits two
 *  lines; if even that is not enough, or on the phone scales, it takes a third (fourth) line instead (r9: "Operator-Wallet,
 *  wöchentli…"). Only a text longer than that is ellipsised, and only on its last line. */
export function wrapDetail(text: string, T: Dims): string[] {
  const base = T === COMPACT ? T.maxText + 10 : Math.max(T.maxText, 110);
  const cut = (lines: string[]) => lines.some((l) => l.endsWith('…')) && !String(text).trim().endsWith('…');
  if (T !== COMPACT && T !== NARROW) {
    for (const k of [1, 1.25, 1.5, 1.9]) {
      const lines = wrap(text, T.detail, 400, base * k, 2);
      if (!cut(lines)) return lines;
    }
  }
  const w = T === COMPACT || T === NARROW ? base : base * 1.25;
  const three = wrap(text, T.detail, 400, w, 3);
  return cut(three) ? wrap(text, T.detail, 400, w, 4) : three;
}

/** A node label on two lines (three on the phone scale); when that would cut it with "…" the node widens by a quarter
 *  and then takes a third line (r9: "Fast Lane (48 h, max US…"). */
export function wrapLabel(text: string, T: Dims): string[] {
  const first = wrap(text, T.label, T.labelW, T.maxText, T === COMPACT ? 3 : 2);
  if (!first[first.length - 1]?.endsWith('…') || String(text).trim().endsWith('…')) return first;
  const wide = wrap(text, T.label, T.labelW, T.maxText * 1.25, 2);
  return !wide[wide.length - 1].endsWith('…') ? wide : wrap(text, T.label, T.labelW, T.maxText * 1.25, 3);
}

function nodeSize(n: CanvasNode, T: Dims): Omit<NodeGeom, 'box'> & { w: number; h: number } {
  const shape = n.shape ?? 'box';
  // The labels-only overview never cuts a word: the node is as wide as its longest word (a file name stays whole;
  // compounds may break after a hyphen or slash), up to four lines.
  const lines = joinLoneMarks(T === OVER
    ? wrap(n.label, T.label, T.labelW, Math.max(T.maxText, ...String(n.label).split(/\s+|(?<=[-_/])/).map((w) => measure(w, T.label, T.labelW))), 4)
    : wrapLabel(n.label, T));
  const detail = n.detail && T !== DENSE && T !== OVER ? wrapDetail(n.detail, T) : [];
  const tw = Math.max(...lines.map((l) => measure(l, T.label, T.labelW)), ...detail.map((l) => measure(l, T.detail, 400)), 40);
  const th = lines.length * T.line + (detail.length ? 6 + detail.length * T.dline : 0);
  if (shape === 'diamond') return { id: n.id, shape, lines, detail, w: Math.max(120, tw * 1.45 + 36), h: Math.max(76, th * 1.7 + 24) };
  if (shape === 'pill') return { id: n.id, shape, lines, detail, w: tw + 44, h: Math.max(44, th + 22) };
  if (shape === 'cylinder') return { id: n.id, shape, lines, detail, w: tw + 36, h: th + 44 };
  if (shape === 'person') return { id: n.id, shape, lines, detail, w: Math.max(tw + 20, 72), h: th + 46 };
  if (T === COMPACT) return { id: n.id, shape, lines, detail, w: Math.max(tw + 24, 80), h: Math.max(44, th + 20) };
  return { id: n.id, shape, lines, detail, w: Math.max(tw + 36, 96), h: Math.max(48, th + 26) };
}

/** Order of the "blocks" (groups; ungrouped nodes count as their own block) along the flow: topological over the
 *  edges between blocks, spec order breaks ties and cycles. */
export function blockOrder(spec: CanvasSpec): Map<string, number> {
  const nodes = spec.nodes ?? [];
  const groupIds = new Set((spec.groups ?? []).map((g) => g.id));
  const blockOf = (id: string) => { const n = nodes.find((m) => m.id === id); return n?.group && groupIds.has(n.group) ? `g:${n.group}` : `n:${id}`; };
  const blocks = [...new Set(nodes.map((n) => blockOf(n.id)))];
  const into = new Map(blocks.map((b) => [b, new Set<string>()]));
  for (const e of spec.edges ?? []) {
    const a = blockOf(e.from), b = blockOf(e.to);
    if (a !== b && into.has(a) && into.has(b)) into.get(b)!.add(a);
  }
  const order = new Map<string, number>();
  while (order.size < blocks.length) {
    const left = blocks.filter((b) => !order.has(b));
    const free = left.find((b) => [...into.get(b)!].every((a) => order.has(a))) ?? left[0];
    order.set(free, order.size);
  }
  return new Map(nodes.map((n) => [n.id, order.get(blockOf(n.id))!]));
}

/** Edges that close a cycle: first between blocks (an edge into a group that comes earlier in the block order, e.g.
 *  a "loops" group feeding back into the gateway's hub; ELK cannot interleave two groups and would route it around
 *  everything), then between nodes (depth-first from the nodes in spec order: an edge back to a node still on the
 *  path). ELK gets them reversed, so it never routes a feedback edge around the whole diagram; they are drawn in their
 *  own direction again (see layoutGraph). */
export function backEdges(nodes: { id: string }[], edges: { from: string; to: string }[], block?: Map<string, number>): Set<number> {
  const back = new Set<number>();
  if (block) edges.forEach((e, i) => { if ((block.get(e.from) ?? 0) > (block.get(e.to) ?? 0)) back.add(i); });
  const out = new Map<string, number[]>();
  edges.forEach((e, i) => { if (!back.has(i)) out.set(e.from, [...(out.get(e.from) ?? []), i]); });
  const state = new Map<string, 1 | 2>();
  const visit = (id: string) => {
    state.set(id, 1);
    for (const i of out.get(id) ?? []) {
      const t = edges[i].to;
      if (state.get(t) === 1) back.add(i);
      else if (!state.has(t)) visit(t);
    }
    state.set(id, 2);
  };
  // Sources (no incoming edge) first, so a cycle is cut at its natural end, then the rest in spec order.
  const into = new Set(edges.map((e) => e.to));
  for (const n of [...nodes.filter((m) => !into.has(m.id)), ...nodes]) if (!state.has(n.id)) visit(n.id);
  return back;
}

export type Scale = boolean | 'chain' | 'compact' | 'dense' | 'overview' | 'simple';
/** `stack`: every group gets its own band of layers (ELK partitions in block order), so on a narrow stage the groups
 *  sit one below the other instead of side by side. */
export async function layoutGraph(spec: CanvasSpec, dir: 'LR' | 'TB', narrow: Scale = false, extra: Record<string, string> = {}, stack = false): Promise<GraphLayout> {
  const elk = await loadElk();
  const T = narrow === 'simple' ? SIMPLE_T : narrow === 'chain' ? CHAIN : narrow === 'compact' ? COMPACT : narrow === 'dense' ? DENSE : narrow === 'overview' ? OVER : narrow ? NARROW : WIDE;
  const nodes = (spec.nodes ?? []).filter((n, i, all) => n?.id && all.findIndex((m) => m.id === n.id) === i);
  const ids = new Set(nodes.map((n) => n.id));
  const groups = (spec.groups ?? []).filter((g) => nodes.some((n) => n.group === g.id));
  const sizes = new Map(nodes.map((n) => [n.id, nodeSize(n, T)]));
  const part = stack ? blockOrder({ ...spec, nodes }) : null;
  const leaf = (n: CanvasNode): ElkNode => ({
    id: n.id, width: sizes.get(n.id)!.w, height: sizes.get(n.id)!.h,
    ...(part ? { layoutOptions: { 'elk.partitioning.partition': String(part.get(n.id)) } } : {}),
  });
  // Stacked: a flat graph (ELK's layer bound and partitions only work without compound nodes); the group frames are
  // drawn around their band of layers afterwards.
  const legends = new Map(groups.map((g) => [g.id, legendLines(g.label, T)]));
  const tight = T === DENSE || T === OVER;
  const children: ElkNode[] = stack ? nodes.map(leaf) : [
    ...groups.map((g) => {
      const lg = legends.get(g.id)!;
      const top = (tight ? 32 : 34) + (lg.length - 1) * LEGEND_LINE;
      return {
        id: `group:${g.id}`,
        children: nodes.filter((n) => n.group === g.id).map(leaf),
        layoutOptions: {
          'elk.padding': T === OVER ? `[top=${top},left=8,bottom=8,right=8]` : tight ? `[top=${top},left=12,bottom=12,right=12]` : `[top=${top},left=20,bottom=20,right=20]`,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          // The legend sets a minimum width (the overviews wrap it to narrow lines instead of widening a column).
          'elk.nodeSize.minimum': `(${Math.ceil(legendW(lg, T) + 28)}, 60)`,
        },
      };
    }),
    ...nodes.filter((n) => !groups.some((g) => g.id === n.group)).map(leaf),
  ];
  const seen = new Map<string, number>();
  const folded = foldEdges(spec.edges, ids);
  const back = backEdges(nodes, folded, groups.length ? (part ?? blockOrder({ ...spec, nodes })) : undefined);
  const byElkId = new Map<string, { e: (typeof folded)[number]; rev: boolean }>();
  const edges: ElkEdge[] = folded.map((e, i) => {
    const base = `${e.from}>${e.to}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    // The labels-only overview keeps edge labels as tooltips on the line (they would be ~6 px there).
    const label = e.label && T !== OVER ? wrap(e.label, T.edge, 500, T === DENSE ? 76 : 150, 1)[0] : undefined;
    const rev = back.has(i);
    const id = n ? `${base}#${n}` : base;
    byElkId.set(id, { e, rev });
    return {
      id, sources: [rev ? e.to : e.from], targets: [rev ? e.from : e.to],
      labels: label ? [{ id: `${base}#${n}:l`, text: label, width: Math.ceil(measure(label, T.edge, 500) + 20), height: 24 }] : undefined,
    };
  });
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.json.edgeCoords': 'ROOT',
      'elk.json.shapeCoords': 'ROOT',
      'elk.padding': '[top=24,left=12,bottom=12,right=12]',
      'elk.spacing.nodeNode': String(T.nodeNode),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(T.layers),
      'elk.spacing.edgeNode': T === OVER ? '12' : '20',
      'elk.spacing.edgeEdge': T === OVER ? '9' : '14',
      'elk.layered.spacing.edgeNodeBetweenLayers': T.layers < 26 ? '10' : T.layers < 50 ? '14' : '22',
      'elk.layered.spacing.edgeEdgeBetweenLayers': T === OVER ? '9' : '14',
      'elk.spacing.edgeLabel': '6',
      'elk.spacing.componentComponent': '40',
      'elk.edgeLabels.inline': 'true',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.mergeEdges': 'false',
      ...(stack ? {
        'elk.partitioning.activate': 'true',
        'elk.layered.layering.strategy': 'COFFMAN_GRAHAM',
        'elk.layered.layering.coffmanGraham.layerBound': '2',
      } : {}),
      ...extra,
    },
    children,
    edges,
  };
  const out = await elk.layout(graph);
  const nodeOut: NodeGeom[] = [];
  const groupOut: GraphLayout['groups'] = [];
  const walk = (list: ElkNode[] | undefined) => {
    for (const c of list ?? []) {
      const box = { x: c.x ?? 0, y: c.y ?? 0, w: c.width ?? 0, h: c.height ?? 0 };
      if (c.id.startsWith('group:')) {
        const g = groups.find((x) => `group:${x.id}` === c.id)!;
        groupOut.push({ id: g.id, label: g.label, box, tone: g.tone, legend: legends.get(g.id) });
        walk(c.children);
      } else {
        const s = sizes.get(c.id)!;
        nodeOut.push({ id: c.id, box, lines: s.lines, detail: s.detail, shape: s.shape });
      }
    }
  };
  walk(out.children);
  const edgeOut = (out.edges ?? []).map((e) => {
    const sec = e.sections?.[0];
    const own = byElkId.get(e.id);
    const route = sec ? [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint] : [];
    // A reversed back edge runs from its own source again (the arrowhead then sits at its real target).
    const pts = own?.rev ? route.reverse() : route;
    const l = e.labels?.[0];
    const src = own?.e;
    return {
      key: e.id, from: src?.from ?? e.sources[0], to: src?.to ?? e.targets[0], pts, style: src?.style ?? 'solid', both: src?.both,
      label: l && l.x !== undefined ? { text: l.text, box: { x: l.x, y: l.y ?? 0, w: l.width, h: l.height }, full: src?.label } : undefined,
    };
  });
  const L: GraphLayout = { dims: T, w: out.width ?? 0, h: out.height ?? 0, nodes: nodeOut, groups: groupOut, edges: edgeOut, dir };
  if (stack) return frameBands(L, groups, nodes, part!);
  return extra['elk.layered.wrapping.strategy'] ? attachEnds(carriageReturns(L)) : L;
}

/** ELK's graph wrapping sometimes returns a route that stops short of its target (an edge across a row break ends in
 *  the gap between the rows, its arrowhead pointing at nothing). Such a route is completed orthogonally: along the gap
 *  to the target's centre line, then straight into the target's near side (and the same at the source end). */
export function attachEnds(L: GraphLayout): GraphLayout {
  const box = (id: string) => L.nodes.find((n) => n.id === id)?.box;
  const touches = (p: Pt, b: Box) => p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3;
  const into = (p: Pt, b: Box): Pt[] => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    // Leave the gap the route ends in along its own axis, then enter the target from the side facing that point.
    if (p.y < b.y || p.y > b.y + b.h) return [{ x: cx, y: p.y }, { x: cx, y: p.y < b.y ? b.y : b.y + b.h }];
    return [{ x: p.x, y: cy }, { x: p.x < b.x ? b.x : b.x + b.w, y: cy }];
  };
  const edges = L.edges.map((e) => {
    const sb = box(e.from), tb = box(e.to);
    if (!sb || !tb || e.pts.length < 2) return e;
    let pts = e.pts;
    if (!touches(pts[pts.length - 1], tb)) pts = [...pts, ...into(pts[pts.length - 1], tb)];
    if (!touches(pts[0], sb)) pts = [...into(pts[0], sb).reverse(), ...pts];
    // Drop zero-length steps and collinear middle points.
    pts = pts.filter((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) + Math.abs(p.y - pts[i - 1].y) > 0.5);
    pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 || !((Math.abs(pts[i - 1].x - p.x) < 0.5 && Math.abs(p.x - pts[i + 1].x) < 0.5) || (Math.abs(pts[i - 1].y - p.y) < 0.5 && Math.abs(p.y - pts[i + 1].y) < 0.5)));
    if (pts === e.pts) return e;
    // A label that ELK placed on the cut-off stretch moves onto the longest segment of the completed route.
    let label = e.label;
    if (label) {
      const c = { x: label.box.x + label.box.w / 2, y: label.box.y + label.box.h / 2 };
      const near = pts.slice(1).some((q, i) => {
        const a = pts[i];
        return Math.abs(a.y - q.y) < 0.5 ? Math.abs(c.y - a.y) < 14 && c.x >= Math.min(a.x, q.x) && c.x <= Math.max(a.x, q.x)
          : Math.abs(c.x - a.x) < 14 && c.y >= Math.min(a.y, q.y) && c.y <= Math.max(a.y, q.y);
      });
      if (!near) {
        const segs = pts.slice(1).map((q, i) => ({ a: pts[i], q, len: Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y) }));
        const { a, q } = segs.reduce((m, x) => (x.len > m.len ? x : m));
        label = { ...label, box: { ...label.box, x: (a.x + q.x) / 2 - label.box.w / 2, y: (a.y + q.y) / 2 - label.box.h / 2 } };
      }
    }
    return { ...e, pts, label };
  });
  return { ...L, edges };
}

/** Folded (wrapped) layouts: ELK routes a row break out of the last node, along the far edge and back across the
 *  whole diagram into the first node's side. Re-route it like a carriage return instead: a short stub out, into the gap
 *  between the rows, straight across to the target, into its top (LR; TB is the same with the axes swapped). */
export function carriageReturns(L: GraphLayout): GraphLayout {
  const lr = L.dir === 'LR';
  // Work in "row" coordinates: u along the flow, v across (LR: u = x, v = y).
  const U = (p: Pt) => (lr ? p.x : p.y), V = (p: Pt) => (lr ? p.y : p.x);
  const P = (u: number, v: number): Pt => (lr ? { x: u, y: v } : { x: v, y: u });
  const box = (id: string) => L.nodes.find((n) => n.id === id)?.box;
  const span = (b: Box) => (lr ? { u0: b.x, u1: b.x + b.w, v0: b.y, v1: b.y + b.h } : { u0: b.y, u1: b.y + b.h, v0: b.x, v1: b.x + b.w });
  const edges = L.edges.map((e) => {
    const sb = box(e.from), tb = box(e.to);
    if (!sb || !tb || e.pts.length < 3) return e;
    const s = span(sb), t = span(tb);
    if (t.v0 <= s.v1) return e; // the target is not in a later row: leave ELK's route
    // A row break: ELK's return segment runs backwards in the gap between the rows.
    const ret = e.pts.slice(1).map((q, i) => ({ a: e.pts[i], b: q })).filter(({ a, b }) => Math.abs(V(a) - V(b)) < 1 && V(a) > s.v1 && V(a) < t.v0 && U(b) < U(a) - (s.u1 - s.u0));
    if (!ret.length) return e; // no row break
    const gv = V(ret[0].a);
    const start = { u: s.u1, v: (s.v0 + s.v1) / 2 };
    // The stub clears every node beside the source between its row centre and the gap.
    const blockers = L.nodes.map((n) => span(n.box)).filter((b) => b.v1 > start.v && b.v0 < gv && b.u1 >= start.u - 1);
    const su = Math.max(start.u, ...blockers.map((b) => b.u1)) + 14;
    const tu = (t.u0 + t.u1) / 2;
    const pts = [P(start.u, start.v), P(su, start.v), P(su, gv), P(tu, gv), P(tu, t.v0)];
    const label = e.label ? { ...e.label, box: lr
      ? { ...e.label.box, x: (su + tu) / 2 - e.label.box.w / 2, y: gv - e.label.box.h / 2 }
      : { ...e.label.box, x: gv - e.label.box.w / 2, y: (su + tu) / 2 - e.label.box.h / 2 } } : undefined;
    return { ...e, pts, label };
  });
  const far = Math.max(lr ? L.w : L.h, ...edges.flatMap((e) => e.pts.map((p) => U(p) + 12)));
  return { ...L, edges, ...(lr ? { w: far } : { h: far }) };
}

const PAD = { top: 34, side: 20, bottom: 20 };
/** Stacked layouts: frames every group around its nodes and opens the gaps between the bands so the frames (and their
 *  legends) fit. A monotonic y shift keeps orthogonal edges orthogonal. */
function frameBands(L: GraphLayout, groups: NonNullable<CanvasSpec['groups']>, nodes: CanvasNode[], part: Map<string, number>): GraphLayout {
  const groupOf = new Map(nodes.map((n) => [n.id, groups.some((g) => g.id === n.group) ? n.group! : null]));
  const bands = new Map<number, { min: number; max: number; framed: boolean }>();
  for (const n of L.nodes) {
    const k = part.get(n.id)!;
    const b = bands.get(k) ?? { min: Infinity, max: -Infinity, framed: false };
    b.min = Math.min(b.min, n.box.y); b.max = Math.max(b.max, n.box.y + n.box.h); b.framed ||= !!groupOf.get(n.id);
    bands.set(k, b);
  }
  const order = [...bands.entries()].sort((a, b) => a[1].min - b[1].min);
  // Extra room above each framed band (legend + top padding) and below it (bottom padding).
  const cuts: { at: number; add: number }[] = [];
  order.forEach(([, b], i) => {
    const prev = order[i - 1]?.[1];
    const add = (b.framed ? PAD.top + 6 : 0) + (prev?.framed ? PAD.bottom : 0);
    if (add) cuts.push({ at: prev ? (prev.max + b.min) / 2 : -Infinity, add });
  });
  const last = order[order.length - 1]?.[1];
  const tail = last?.framed ? PAD.bottom : 0;
  const ty = (y: number) => y + cuts.reduce((s, c) => s + (y > c.at ? c.add : 0), 0);
  const nodesOut = L.nodes.map((n) => ({ ...n, box: { ...n.box, y: ty(n.box.y) } }));
  const edgesOut = L.edges.map((e) => ({
    ...e,
    pts: e.pts.map((p) => ({ x: p.x, y: ty(p.y) })),
    label: e.label ? { ...e.label, box: { ...e.label.box, y: ty(e.label.box.y + e.label.box.h / 2) - e.label.box.h / 2 } } : undefined,
  }));
  const frames = groups.map((g) => {
    const mine = nodesOut.filter((n) => groupOf.get(n.id) === g.id);
    const x0 = Math.min(...mine.map((n) => n.box.x)), x1 = Math.max(...mine.map((n) => n.box.x + n.box.w));
    const y0 = Math.min(...mine.map((n) => n.box.y)), y1 = Math.max(...mine.map((n) => n.box.y + n.box.h));
    const legend = legendLines(g.label, L.dims);
    const w = Math.max(x1 - x0 + 2 * PAD.side, legendW(legend, L.dims) + 28);
    return { id: g.id, label: g.label, tone: g.tone, legend, box: { x: (x0 + x1) / 2 - w / 2, y: y0 - PAD.top, w, h: y1 - y0 + PAD.top + PAD.bottom } };
  });
  // Frames may reach past the ELK canvas at the sides: shift everything right and widen.
  const dx = Math.max(0, 12 - Math.min(0, ...frames.map((f) => f.box.x)));
  const sx = <T extends { x: number }>(b: T): T => ({ ...b, x: b.x + dx });
  const right = Math.max(L.w, ...frames.map((f) => f.box.x + f.box.w + 12));
  return {
    ...L,
    w: right + dx,
    h: ty(L.h) + tail,
    nodes: nodesOut.map((n) => ({ ...n, box: sx(n.box) })),
    groups: frames.map((f) => ({ ...f, box: sx(f.box) })),
    edges: edgesOut.map((e) => ({ ...e, pts: e.pts.map(sx), label: e.label ? { ...e.label, box: sx(e.label.box) } : undefined })),
  };
}

/** Phones: a single column without ELK. Groups are framed bands in block order, every node is full width (labels at
 *  the narrow type size), an edge to the next node is a short arrow on the left, every other edge runs in its own lane on
 *  the right (interval colouring, short spans inside) with its label on a pill in a gap between nodes. */
export function columnLayout(spec: CanvasSpec, width: number): GraphLayout {
  const T = NARROW;
  const nodes = (spec.nodes ?? []).filter((n, i, all) => n?.id && all.findIndex((m) => m.id === n.id) === i);
  const ids = new Set(nodes.map((n) => n.id));
  const groups = (spec.groups ?? []).filter((g) => nodes.some((n) => n.group === g.id));
  const grouped = new Set(groups.map((g) => g.id));
  const blocks = blockOrder({ ...spec, nodes });
  const order = nodes.map((n, i) => ({ n, i })).sort((a, b) => blocks.get(a.n.id)! - blocks.get(b.n.id)! || a.i - b.i).map((x) => x.n);
  const idx = new Map(order.map((n, i) => [n.id, i]));
  const seen = new Map<string, number>();
  const edges = foldEdges(spec.edges, ids).map((e) => {
    const base = `${e.from}>${e.to}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return { ...e, key: k ? `${base}#${k}` : base, a: idx.get(e.from)!, b: idx.get(e.to)! };
  });
  const direct = edges.filter((e) => e.b === e.a + 1 && !edges.some((f) => f !== e && f.a === e.a && f.b === e.b && edges.indexOf(f) < edges.indexOf(e)));
  const laneEdges = edges.filter((e) => !direct.includes(e)).sort((x, y) => Math.abs(x.b - x.a) - Math.abs(y.b - y.a));
  // Interval colouring on the node index spans (closed: two lanes never share an end node's vertical stretch).
  const laneOf = new Map<(typeof edges)[number], number>();
  const used: [number, number][][] = [];
  for (const e of laneEdges) {
    const lo = Math.min(e.a, e.b), hi = Math.max(e.a, e.b);
    let k = used.findIndex((spans) => spans.every(([l, h]) => hi < l || lo > h));
    if (k < 0) { k = used.length; used.push([]); }
    used[k].push([lo, hi]);
    laneOf.set(e, k);
  }
  const M = 10, GP = groups.length ? 12 : 0, LANE = 11;
  const lanesW = used.length ? used.length * LANE + 10 : 0;
  const colX = M + GP, colW = Math.max(150, width - 2 * M - 2 * GP - lanesW);
  const colR = colX + colW;
  const sizes = order.map((n) => {
    const lines = wrap(n.label, T.label, T.labelW, colW - 24, 2);
    const detail = n.detail ? wrap(n.detail, T.detail, 400, colW - 24, 2) : [];
    return { lines, detail, h: Math.max(46, lines.length * T.line + (detail.length ? 6 + detail.length * T.dline : 0) + 22) };
  });
  // Gap g sits between node g and g + 1: slot 0 for the direct arrow's label, then lane labels (fewest first, near the middle).
  const pills: { text: string; w: number }[][] = order.map(() => []);
  const fit = (t: string) => wrap(t, T.edge, 500, colW - 70, 1)[0];
  const labelGap = new Map<(typeof edges)[number], number>();
  for (const e of laneEdges) {
    if (!e.label) continue;
    const lo = Math.min(e.a, e.b), hi = Math.max(e.a, e.b);
    const mid = (lo + hi - 1) / 2;
    let best = lo;
    for (let g = lo; g < hi; g++) if (pills[g].length < pills[best].length || (pills[g].length === pills[best].length && Math.abs(g - mid) < Math.abs(best - mid))) best = g;
    const text = fit(e.label);
    pills[best].push({ text, w: measure(text, T.edge, 500) + 20 });
    labelGap.set(e, best);
  }
  const directLabel = new Map(direct.filter((e) => e.label).map((e) => [e.a, fit(e.label!)]));
  const blockOf = (n: CanvasNode) => (n.group && grouped.has(n.group) ? n.group : null);
  let y = 12;
  const boxes: Box[] = [];
  const gapTop: number[] = [];
  order.forEach((n, i) => {
    const prev = order[i - 1];
    if (i === 0 && blockOf(n)) y += 34;
    if (prev && blockOf(prev) !== blockOf(n)) y += (blockOf(prev) ? 14 : 0) + (blockOf(n) ? 40 : 0);
    boxes.push({ x: colX, y, w: colW, h: sizes[i].h });
    y += sizes[i].h;
    if (i < order.length - 1) {
      gapTop[i] = y;
      const slots = (directLabel.has(i) ? 1 : 0) + pills[i].length;
      const arrow = direct.some((e) => e.a === i) ? 30 : 18;
      y += Math.max(arrow, 10 + slots * 28);
    }
  });
  if (order.length && blockOf(order[order.length - 1])) y += 14;
  const H = y + 12;
  const nodeOut: NodeGeom[] = order.map((n, i) => ({
    id: n.id, box: boxes[i], lines: sizes[i].lines, detail: sizes[i].detail,
    shape: n.shape === 'pill' || n.shape === 'cylinder' ? n.shape : 'box',
  }));
  // Lane ports: spread over the right edge of each node, ordered by where the other end is (upwards first).
  const ports = new Map<string, number>();
  order.forEach((n, i) => {
    const mine = laneEdges.flatMap((e) => (e.a === i ? [{ e, other: e.b, end: 's' }] : e.b === i ? [{ e, other: e.a, end: 't' }] : []))
      .sort((p, q) => p.other - q.other || laneOf.get(q.e)! - laneOf.get(p.e)!);
    mine.forEach((p, k) => ports.set(`${p.e.key}|${p.end}`, boxes[i].y + (boxes[i].h * (k + 1)) / (mine.length + 1)));
  });
  const edgeOut: GraphLayout['edges'] = [];
  for (const e of direct) {
    const a = boxes[e.a], b = boxes[e.b];
    const x = colX + 26;
    const t = directLabel.get(e.a);
    edgeOut.push({
      key: e.key, from: e.from, to: e.to, style: e.style ?? 'solid', both: e.both, pts: [{ x, y: a.y + a.h }, { x, y: b.y }],
      label: t ? { text: t, box: { x: x + 12, y: gapTop[e.a] + 5, w: measure(t, T.edge, 500) + 20, h: 22 }, full: e.label } : undefined,
    });
  }
  const slotUsed = order.map((_, g) => (directLabel.has(g) ? 1 : 0));
  for (const e of laneEdges) {
    const lx = colR + GP + 8 + laneOf.get(e)! * LANE;
    const ys = ports.get(`${e.key}|s`)!, yt = ports.get(`${e.key}|t`)!;
    const g = labelGap.get(e);
    let label: GraphLayout['edges'][number]['label'];
    if (g !== undefined) {
      const p = pills[g].find((q) => q.text === fit(e.label!))!;
      const slot = slotUsed[g]++;
      label = { text: p.text, box: { x: Math.max(colX + 40, lx - 6 - p.w), y: gapTop[g] + 5 + slot * 28, w: p.w, h: 22 }, full: e.label };
    }
    edgeOut.push({ key: e.key, from: e.from, to: e.to, style: e.style ?? 'solid', both: e.both, pts: [{ x: colR, y: ys }, { x: lx, y: ys }, { x: lx, y: yt }, { x: colR, y: yt }], label });
  }
  const groupOut = groups.map((g) => {
    const mine = nodeOut.filter((n) => order.find((m) => m.id === n.id)!.group === g.id);
    const y0 = Math.min(...mine.map((n) => n.box.y)), y1 = Math.max(...mine.map((n) => n.box.y + n.box.h));
    return { id: g.id, label: g.label, tone: g.tone, box: { x: colX - GP, y: y0 - 30, w: colW + 2 * GP, h: y1 - y0 + 30 + 12 } };
  });
  return { dims: T, w: width, h: H, nodes: nodeOut, groups: groupOut, edges: edgeOut, dir: 'TB' };
}

/** Edges that wrap around the diagram: a long stretch of their route runs outside the hull of all nodes and group
 *  frames (ELK routes a feedback edge, or a forward edge into a group placed behind, along the outer border), or the
 *  route is far longer than the way between its end points (folded rows sent out of the east port and back). */
export function wrapEdges(L: Pick<GraphLayout, 'w' | 'h' | 'edges' | 'nodes' | 'groups'>): string[] {
  const boxes = [...L.nodes.map((n) => n.box), ...L.groups.map((g) => g.box)];
  if (!boxes.length) return [];
  const hx0 = Math.min(...boxes.map((b) => b.x)), hx1 = Math.max(...boxes.map((b) => b.x + b.w));
  const hy0 = Math.min(...boxes.map((b) => b.y)), hy1 = Math.max(...boxes.map((b) => b.y + b.h));
  const limit = Math.max(160, 0.25 * (L.w + L.h));
  const len = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.abs(q.x - p[i].x) + Math.abs(q.y - p[i].y), 0);
  const outside = (a: Pt, b: Pt) => {
    const horiz = Math.abs(a.y - b.y) < 1;
    const off = horiz ? a.y < hy0 - 8 || a.y > hy1 + 8 : a.x < hx0 - 8 || a.x > hx1 + 8;
    const long = horiz ? Math.abs(a.x - b.x) > 0.25 * (hx1 - hx0) : Math.abs(a.y - b.y) > 0.25 * (hy1 - hy0);
    return off && long;
  };
  return L.edges.filter((e) => {
    if (e.pts.length < 2) return false;
    if (e.pts.slice(1).some((q, i) => outside(e.pts[i], q))) return true;
    const a = e.pts[0], b = e.pts[e.pts.length - 1];
    return len(e.pts) - (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) > limit;
  }).map((e) => e.key);
}

/** A plain chain: one path through every node (each node at most one edge in and one out, no cycle). */
export function isChain(spec: CanvasSpec): boolean {
  const nodes = spec.nodes ?? [];
  const ids = new Set(nodes.map((n) => n.id));
  const edges = foldEdges(spec.edges, ids);
  if (nodes.length < 3 || edges.length !== nodes.length - 1 || edges.some((e) => e.both)) return false;
  const outs = new Map<string, string>(), ins = new Set<string>();
  for (const e of edges) { if (outs.has(e.from) || ins.has(e.to)) return false; outs.set(e.from, e.to); ins.add(e.to); }
  let cur = nodes.find((n) => !ins.has(n.id))?.id, seen = 0;
  while (cur && seen <= nodes.length) { seen++; cur = outs.get(cur); }
  return seen === nodes.length;
}

/** Share of the nodes the auto view shows completely before any scrolling (1 when the whole diagram fits). */
export function visibleShare(L: GraphLayout, box: { w: number; h: number }): number {
  const v = pickScale({ w: L.w, h: L.h, minText: L.dims.label }, box, true);
  if (v.pan === 'none' || !L.nodes.length) return 1;
  // Scrolling diagrams start at their top edge (view.ts autoView: 12 px margin).
  const bottom = box.h / v.scale - 12 / v.scale;
  return L.nodes.filter((n) => n.box.y + n.box.h <= bottom).length / L.nodes.length;
}

/** Lays out in the requested direction and, when that is not comfortably legible as a whole on this stage, tries the
 *  other direction, ELK graph wrapping (long chains folded to the stage's aspect ratio), a dense overview (desktop:
 *  labels only, tight spacing), groups stacked one below the other, on phones a compact type scale with three-line
 *  labels and, as the last resort, the single column.
 *
 *  Ranking (round 8): the whole diagram legible on screen beats everything; on a desktop stage (≥ 600 px) a whole
 *  overview with labels ≥ OVERVIEW_PX still beats a column that scrolls ("architecture at a glance"); the
 *  scrolling column is the last resort there. A requested LR is kept on a wide stage whenever an LR variant reaches the
 *  overview size, and a plain LR chain is never turned into a vertical one there. */
/** Smallest on-screen size of node detail lines for a layout to count as fully legible. */
export const DETAIL_MIN_PX = 8;

export async function bestLayout(spec: CanvasSpec, size: Size): Promise<GraphLayout> {
  const want = spec.direction ?? (spec.kind === 'architecture' ? 'TB' : 'LR');
  const other = want === 'LR' ? 'TB' : 'LR';
  const narrow = size.width < 600;
  const grouped = (spec.groups ?? []).some((g) => (spec.nodes ?? []).some((n) => n.group === g.id));
  const box = { w: size.width, h: size.height };
  const legible = legiblePx(box);
  const view = (l: GraphLayout) => pickScale({ w: l.w, h: l.h, minText: l.dims.label }, box, true);
  // Tiers: 4 whole + legible (full detail) > 3 whole + legible (overview without details) > 2 whole ≥ OVERVIEW_PX
  // (desktop) > 1 fitted to the width with vertical scrolling, legible > 0 illegible. Scrolling variants: past 12 px
  // labels, less scrolling counts more.
  const lowDetail = (l: GraphLayout) => l.dims !== DENSE && l.dims !== OVER && l.nodes.some((n) => n.detail.length) && view(l).scale * l.dims.detail < DETAIL_MIN_PX - 1e-6;
  const score = (l: GraphLayout) => {
    const v = view(l);
    const px = v.scale * l.dims.label;
    const dense = l.dims === DENSE || l.dims === OVER;
    if (v.pan === 'none') {
      // Round 10: whole and legible labels do not make a flow legible when its detail lines (12.5 px at 1:1) end up
      // below DETAIL_MIN_PX; such a layout is only an overview (tier 3) and a snake or a column with readable details wins.
      const smallDetail = lowDetail(l);
      if (px >= legible - 1e-6) return { tier: dense || smallDetail ? 3 : 4, px: Math.min(px, 16), len: 1 };
      if (!narrow && px >= OVERVIEW_PX - 1e-6) return { tier: 2, px: dense ? px * 0.97 : px, len: 1 };
      return { tier: 0, px, len: 1 };
    }
    return px >= legible ? { tier: 1, px: Math.min(px, 12), len: (l.h * v.scale) / size.height } : { tier: 0, px: px * 0.85, len: 1 };
  };
  // A different variant has to be clearly better: the requested direction is part of what the model meant.
  const better = (x: GraphLayout, y: GraphLayout) => {
    const a = score(x), b = score(y);
    if (a.tier !== b.tier) return a.tier > b.tier;
    if (a.px > b.px * 1.08) return true;
    return a.tier === 1 && a.px >= b.px / 1.08 && a.len < b.len * 0.85;
  };
  // A simple view on a desktop stage: the big type when the whole fits with labels >= SIMPLE_MIN_PX (either direction)
  if (!narrow && (spec.nodes ?? []).length <= 5) {
    for (const dir of [want, other] as const) {
      const s = await layoutGraph(spec, dir, 'simple');
      const v = view(s);
      if (v.pan === 'none' && v.scale * s.dims.label >= SIMPLE_MIN_PX - 1e-6 && !wrapEdges(s).length) return s;
    }
  }
  const a = await layoutGraph(spec, want, narrow);
  if (view(a).pan === 'none' && view(a).scale >= 0.85 && !wrapEdges(a).length) return a;
  const aspect = String(Math.max(0.5, Math.min(3, size.width / Math.max(1, size.height))).toFixed(2));
  const wrapOpts = { 'elk.layered.wrapping.strategy': 'MULTI_EDGE', 'elk.aspectRatio': aspect };
  const tries = await Promise.allSettled([
    layoutGraph(spec, other, narrow),
    layoutGraph(spec, want, narrow, wrapOpts),
    layoutGraph(spec, other, narrow, wrapOpts),
    ...(narrow
      ? [layoutGraph(spec, 'TB', 'compact'), layoutGraph(spec, 'TB', 'compact', wrapOpts), layoutGraph(spec, 'LR', 'compact', wrapOpts)]
      : [layoutGraph(spec, 'LR', 'chain', { 'elk.layered.layering.strategy': 'LONGEST_PATH' }), layoutGraph(spec, want, 'chain'), layoutGraph(spec, 'TB', 'chain'),
        // Round 10: a long flow folded into rows (snake) at the tight chain scale, either direction.
        layoutGraph(spec, 'LR', 'chain', wrapOpts), layoutGraph(spec, 'TB', 'chain', wrapOpts),
        // The dense overview (big diagrams only: a small flow keeps its details and full edge labels), both directions.
        ...(grouped || (spec.nodes ?? []).length >= 12
          ? [layoutGraph(spec, want, 'dense'), layoutGraph(spec, other, 'dense'), layoutGraph(spec, want, 'dense', wrapOpts), layoutGraph(spec, other, 'dense', wrapOpts)]
          : [])]),
    // Groups one below the other (a narrow column that scrolls instead of a wide strip of tiny type).
    ...(grouped ? [layoutGraph(spec, 'TB', narrow ? 'compact' : true, {}, true)] : []),
  ]);
  let all = [a, ...tries.flatMap((t) => (t.status === 'fulfilled' && t.value.nodes.length === a.nodes.length ? [t.value] : []))];
  // Round 9 (critic r8 d15): when no variant is whole AND legible with its edge labels, the labels-only overview
  // (three-line labels, edge labels as tooltips) competes too: a 13-node / 5-group architecture whole at ≥ 9 px beats
  // an 8 px whole or a column that shows a quarter of it. Details and edge labels come back in "Groß".
  if (!narrow && (spec.nodes ?? []).length >= 6 && Math.max(...all.map((l) => (lowDetail(l) ? 2 : score(l).tier))) < 3) {
    const over = await Promise.allSettled([layoutGraph(spec, 'LR', 'overview'), layoutGraph(spec, 'TB', 'overview'),
      ...(grouped ? [] : [layoutGraph(spec, 'LR', 'overview', wrapOpts), layoutGraph(spec, 'TB', 'overview', wrapOpts)])]);
    all = [...all, ...over.flatMap((t) => (t.status === 'fulfilled' && t.value.nodes.length === a.nodes.length ? [t.value] : []))];
  }
  if (!narrow && want === 'LR') {
    // Wide stage, requested LR: a plain chain stays horizontal (rows folded at most); otherwise LR wins as soon as one
    // LR variant reaches the overview size.
    const lr = all.filter((l) => l.dir === 'LR');
    // Round 10: not when every such LR variant keeps its details below DETAIL_MIN_PX (a TB / snake variant may then win).
    if (lr.length && lr.some((l) => !lowDetail(l) && (isChain(spec) || score(l).tier >= 2))) all = lr;
  }
  // Edges that wrap around the diagram: within the best class (whole on screen / scrolling / illegible) only the
  // variants with the fewest of them compete (a long chain without groups may take more when that is what makes it
  // legible as a whole). A clean whole overview beats a folded one with a detour, even when that is a little larger.
  const cls = (l: GraphLayout) => Math.min(2, score(l).tier);
  const topCls = Math.max(...all.map(cls));
  const pool = all.filter((l) => cls(l) === topCls);
  const top = Math.max(...pool.map((l) => score(l).tier));
  const wraps = new Map(pool.map((l) => [l, wrapEdges(l).length]));
  const fewest = Math.min(...wraps.values());
  let best = pool.find((l) => wraps.get(l) === fewest)!;
  for (const l of pool) if (wraps.get(l) === fewest && better(l, best)) best = l;
  if (!grouped && top < 4) for (const l of pool) if (wraps.get(l)! > fewest && better(l, best)) best = l;
  // Desktop: never a first view that shows less than half of the nodes when another variant shows more of them.
  if (!narrow && visibleShare(best, box) < 0.5) {
    const most = Math.max(...all.map((l) => visibleShare(l, box)));
    best = all.filter((l) => visibleShare(l, box) >= most - 1e-6).reduce((m, l) => (score(l).px > score(m).px ? l : m));
  }
  // Phones: the single column when no ELK variant keeps the labels legible.
  if (narrow && score(best).px < legible) {
    const col = columnLayout(spec, size.width - 40);
    if (better(col, best)) best = col;
  }
  return best;
}

/** Detail text on the highlighted (papaya) node: contrast ≥ 4.5 against its tinted fill. */
export const HI_DETAIL = '#ffe1d3';

/** `layout`: draw this layout instead of choosing one (tests, comparisons). */
export async function renderGraph(spec: CanvasSpec, size: Size, layout?: GraphLayout): Promise<Scene> {
  const L = layout ?? await bestLayout(spec, size);
  const T = L.dims;
  const byId = new Map((spec.nodes ?? []).map((n) => [n.id, n]));
  const hi = spec.highlight;
  const prims: Prim[] = [];
  const gTone = (t?: string) => tone(t as never, '#8d8ca3');
  // Edge labels the layout did not place (labels-only overview) stay readable as the line's tooltip.
  const edgeLabels = new Map(foldEdges(spec.edges, new Set(byId.keys())).map((e) => [`${e.from}>${e.to}`, e.label]));
  const byLabel = new Map(L.edges.map((e) => [e.key, edgeLabels.get(`${e.from}>${e.to}`) ?? edgeLabels.get(`${e.to}>${e.from}`)]));

  L.groups.forEach((g, i) => {
    const c = gTone(g.tone);
    prims.push({ t: 'rect', key: `g:${g.id}`, ...g.box, rx: 20, fill: rgba(c, 0.045), stroke: rgba(c, 0.32), sw: 1.2, delay: i * 60 });
  });

  // Edges under nodes. Colour follows the source node's tone; the highlighted node's edges glow papaya.
  L.edges.forEach((e, i) => {
    if (e.pts.length < 2) return;
    const touches = hi && (e.from === hi || e.to === hi);
    const src = byId.get(e.from);
    const base = touches ? P.papaya : src?.tone && src.tone !== 'neutral' ? tone(src.tone) : '#8d8ca3';
    const col = touches ? P.papaya : rgba(base, 0.62);
    const d = roundedPath(e.pts, 12);
    const delay = 200 + i * 45;
    const dashed = e.style === 'dashed';
    const full = e.label?.full ?? (e.label ? undefined : byLabel.get(e.key));
    prims.push({ t: 'path', key: `e:${e.key}`, d, stroke: col, sw: touches ? 2.4 : 1.8, dash: dashed ? '6 6' : undefined, draw: !dashed, delay, cap: 'round', title: full });
    if (e.style === 'pulse') prims.push({ t: 'path', key: `e:${e.key}:flow`, d, stroke: touches ? P.papaya : base, sw: 2.4, dash: '3 13', flow: true, delay, cap: 'round' });
    const n = e.pts.length;
    const tip = e.pts[n - 1], prev = e.pts[n - 2];
    prims.push({ t: 'path', key: `e:${e.key}:arrow`, d: arrowHead(tip, tip.x - prev.x, tip.y - prev.y, 10), fill: touches ? P.papaya : rgba(base, 0.95), delay: delay + 250 });
    if (e.both) {
      const s0 = e.pts[0], s1 = e.pts[1];
      prims.push({ t: 'path', key: `e:${e.key}:arrow0`, d: arrowHead(s0, s0.x - s1.x, s0.y - s1.y, 10), fill: touches ? P.papaya : rgba(base, 0.95), delay: delay + 250 });
    }
    if (e.label) {
      const b = e.label.box;
      prims.push({ t: 'rect', key: `e:${e.key}:lb`, x: b.x, y: b.y, w: b.w, h: b.h, rx: b.h / 2, fill: '#13131a', stroke: touches ? rgba(P.papaya, 0.7) : '#34343f', sw: 1, delay: delay + 200 });
      prims.push({ t: 'text', key: `e:${e.key}:lt`, x: b.x + b.w / 2, y: b.y + b.h / 2 + 4.3, text: e.label.text, title: e.label.full, size: T.edge, weight: 500, fill: touches ? '#ffd9c7' : P.text2, anchor: 'middle', delay: delay + 200 });
    }
  });

  // Group names sit on the top border like a fieldset legend, above the edges that enter the group.
  // A legend is never ellipsised: it wraps (the layout reserved the frame width and the extra lines).
  L.groups.forEach((g, i) => {
    const c = gTone(g.tone);
    const lines = g.legend ?? legendLines(g.label, T, Math.max(120, g.box.w - 28 - 34));
    const w = legendW(lines, T);
    const h = 24 + (lines.length - 1) * LEGEND_LINE;
    prims.push({ t: 'rect', key: `g:${g.id}:lb`, x: g.box.x + 16, y: g.box.y - 12, w, h, rx: 12, fill: '#121218', stroke: rgba(c, 0.45), sw: 1, delay: i * 60 });
    prims.push({ t: 'circle', key: `g:${g.id}:dot`, cx: g.box.x + 29, cy: g.box.y, r: 3.5, fill: c, delay: i * 60 });
    lines.forEach((text, j) => prims.push({ t: 'text', key: j ? `g:${g.id}:l${j}` : `g:${g.id}:l`, x: g.box.x + 39, y: g.box.y + 4.3 + j * LEGEND_LINE, text, size: T.group, weight: 700, fill: rgba(c, 0.95), delay: i * 60 }));
  });

  L.nodes.forEach((g, i) => {
    const n = byId.get(g.id)!;
    const isHi = hi === g.id;
    const c = isHi ? P.papaya : tone(n.tone, '#a5a4bb');
    const neutral = !isHi && (!n.tone || n.tone === 'neutral');
    const { x, y, w, h } = g.box;
    const delay = 80 + i * 55;
    const fill = neutral ? P.panelHi : rgba(c, 0.13);
    const stroke = neutral ? '#3b3b4b' : rgba(c, isHi ? 1 : 0.6);
    const sw = isHi ? 2 : 1.4;
    const k = `n:${g.id}`;
    if (g.shape === 'diamond') {
      prims.push({ t: 'path', key: k, d: `M${x + w / 2} ${y} L${x + w} ${y + h / 2} L${x + w / 2} ${y + h} L${x} ${y + h / 2} Z`, fill, stroke, sw, delay });
    } else if (g.shape === 'cylinder') {
      const ry = 8;
      prims.push({ t: 'path', key: k, d: `M${x} ${y + ry} A${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} L${x + w} ${y + h - ry} A${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z`, fill, stroke, sw, delay });
      prims.push({ t: 'path', key: `${k}:rim`, d: `M${x} ${y + ry} A${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}`, stroke, sw, delay });
    } else if (g.shape === 'person') {
      prims.push({ t: 'circle', key: `${k}:head`, cx: x + w / 2, cy: y + 11, r: 9, fill: rgba(c, 0.25), stroke: c, sw: 1.6, delay });
      prims.push({ t: 'path', key: `${k}:body`, d: `M${x + w / 2 - 15} ${y + 38} Q${x + w / 2 - 15} ${y + 22} ${x + w / 2} ${y + 22} Q${x + w / 2 + 15} ${y + 22} ${x + w / 2 + 15} ${y + 38}`, fill: rgba(c, 0.25), stroke: c, sw: 1.6, delay });
    } else {
      // The overview drops details and shortens labels: the tooltip keeps them.
      prims.push({ t: 'rect', key: k, x, y, w, h, rx: g.shape === 'pill' ? h / 2 : 13, fill, stroke, sw, glow: isHi, delay, title: n.detail ? `${n.label} — ${n.detail}` : n.label });
    }
    const textH = g.lines.length * T.line + (g.detail.length ? 6 + g.detail.length * T.dline : 0);
    let ty = g.shape === 'person' ? y + 44 + 14 : y + (h - textH) / 2 + 15 + (g.shape === 'cylinder' ? 4 : 0);
    g.lines.forEach((line, j) => {
      prims.push({ t: 'text', key: `${k}:l${j}`, x: x + w / 2, y: ty, text: line, size: T.label, weight: T.labelW, fill: P.fg, anchor: 'middle', delay });
      ty += T.line;
    });
    ty += 2;
    g.detail.forEach((line, j) => {
      // The highlighted node is papaya on papaya: its detail is a light peach (r8: orange on orange was unreadable).
      prims.push({ t: 'text', key: `${k}:d${j}`, x: x + w / 2, y: ty, text: line, size: T.detail, weight: 400, fill: isHi ? HI_DETAIL : neutral ? P.dim : rgba(c, 0.95), anchor: 'middle', delay });
      ty += T.dline;
    });
  });
  // The overviews leave out node details (and the labels-only one edge labels too) that the spec has.
  const abridged = (T === DENSE || T === OVER) && ((spec.nodes ?? []).some((n) => n.detail) || (T === OVER && (spec.edges ?? []).some((e) => e.label)));
  return { w: L.w, h: L.h, prims, minText: T.label, ...(abridged ? { abridged } : {}) };
}
