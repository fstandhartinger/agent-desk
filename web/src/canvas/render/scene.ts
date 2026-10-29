// A rendered canvas is a flat list of keyed primitives in pixel coordinates. Renderers are pure (spec + size → Scene),
// so layouts are testable in Node; the animator diffs two scenes by key (tween, rise in, fade out).
import { C, FONT } from '../../viz/theme';
import type { CanvasTone } from '../types';

interface Base { key: string; opacity?: number; delay?: number; /** Soft papaya glow (blurred copy behind). */ blur?: boolean; /** Enter animation grows the shape: bars along w/h, arcs sweep. */ grow?: 'w' | 'h' }
export interface RectP extends Base { t: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill: string; stroke?: string; sw?: number; dash?: string; glow?: boolean; title?: string }
export interface CircleP extends Base { t: 'circle'; cx: number; cy: number; r: number; fill: string; stroke?: string; sw?: number; glow?: boolean }
export interface TextP extends Base {
  t: 'text'; x: number; y: number; text: string; size: number; weight?: number; fill: string; anchor?: 'start' | 'middle' | 'end';
  mono?: boolean; italic?: boolean; title?: string;
  /** Tweened number: the text is re-formatted from the interpolated value every frame. */
  num?: { value: number; format: (v: number) => string };
}
export interface PathP extends Base { t: 'path'; d: string; stroke?: string; fill?: string; sw?: number; dash?: string; draw?: boolean; flow?: boolean; cap?: 'round' | 'butt'; title?: string }
export interface ArcP extends Base { t: 'arc'; cx: number; cy: number; r0: number; r1: number; a0: number; a1: number; fill: string; stroke?: string; sw?: number; glow?: boolean; title?: string }
export interface SvgP extends Base { t: 'svg'; x: number; y: number; w: number; h: number; viewBox: string; inner: string }
export type Prim = RectP | CircleP | TextP | PathP | ArcP | SvgP;

export interface Scene {
  w: number; h: number; prims: Prim[];
  /** Taller than the stage by design (long lists): when fitting the whole would make type unreadable, fit the width and pan. */
  scroll?: boolean;
  /** Wider than the stage by design (tables): same rule along x. */
  scrollX?: boolean;
  /** Smallest essential font size in scene px (labels, values); the view keeps it at ≥ MIN_TEXT_PX on screen when it can. */
  minText?: number;
  /** The drawing leaves out content the spec has (a labels-only overview: node details, edge labels): the side column
   *  then always offers "Groß ansehen", where it is laid out in full. */
  abridged?: boolean;
}
export interface Size { width: number; height: number }

export const SANS = FONT;
export const PALETTE = { ...C, panel: '#15151c', panelHi: '#1b1b24', grid: '#24242f', text2: '#cfcde0' };
export const TONES: CanvasTone[] = ['violet', 'moss', 'papaya', 'amber'];

export const tone = (t: CanvasTone | undefined, fallback = '#a5a4bb'): string =>
  !t || t === 'neutral' ? fallback : (C as Record<string, string>)[t] ?? fallback;

/** `#rrggbb` + alpha → rgba(). */
export function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- text measuring: canvas in the browser, an Inter-like width table in Node (tests) ----
let ctx: CanvasRenderingContext2D | null | undefined;
const cache = new Map<string, number>();
const NARROW = /[iljtfrI.,:;'|!() ]/;
const WIDE = /[MWmw@%]/;

export function measure(text: string, size: number, weight = 500): number {
  const key = `${weight}|${size}|${text}`;
  let w = cache.get(key);
  if (w !== undefined) return w;
  if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (ctx) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    w = ctx.measureText(text).width;
  } else {
    w = 0;
    for (const ch of text) w += NARROW.test(ch) ? 0.3 : WIDE.test(ch) ? 0.85 : /[A-ZÄÖÜ0-9]/.test(ch) ? 0.66 : 0.56;
    w *= size * (weight >= 600 ? 1.04 : 1);
  }
  if (cache.size > 4000) cache.clear();
  cache.set(key, w);
  return w;
}
export const resetMeasure = () => cache.clear();

/** Greedy word wrap into at most `maxLines` lines of `maxW` px; the last line is ellipsised. */
export function wrap(text: string, size: number, weight: number, maxW: number, maxLines = 2): string[] {
  // Break at spaces, and after hyphens/underscores/slashes inside long words ("Voice-|Agent", "canvas_|draw").
  const words = String(text).split(/\s+/).filter(Boolean).flatMap((w) => (measure(w, size, weight) > maxW ? w.split(/(?<=[-_/.])/) : [w]).map((p, i) => (i ? `\u0000${p}` : p)));
  const join = (a: string, b: string) => (b.startsWith('\u0000') ? a + b.slice(1) : `${a} ${b}`);
  const clean = (w: string) => w.replace(/^\u0000/, '');
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? join(cur, words[i]) : clean(words[i]);
    if (measure(next, size, weight) <= maxW || !cur) {
      cur = next;
      continue;
    }
    lines.push(cur);
    cur = clean(words[i]);
    if (lines.length === maxLines - 1) {
      cur = words.slice(i + 1).reduce(join, cur);
      break;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines).map((l, i, all) => (i === all.length - 1 ? ellipsize(l, size, weight, maxW) : l));
}

export function ellipsize(text: string, size: number, weight: number, maxW: number): string {
  if (measure(text, size, weight) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`, size, weight) <= maxW) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Rounded orthogonal polyline (ELK bend points) as an SVG path. */
export function roundedPath(pts: { x: number; y: number }[], radius = 10): string {
  if (pts.length < 2) return '';
  let d = `M${r1(pts[0].x)} ${r1(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], q = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(q.x - p.x, q.y - p.y), l2 = Math.hypot(n.x - q.x, n.y - q.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { d += ` L${r1(q.x)} ${r1(q.y)}`; continue; }
    const a = { x: q.x + ((p.x - q.x) * r) / l1, y: q.y + ((p.y - q.y) * r) / l1 };
    const b = { x: q.x + ((n.x - q.x) * r) / l2, y: q.y + ((n.y - q.y) * r) / l2 };
    d += ` L${r1(a.x)} ${r1(a.y)} Q${r1(q.x)} ${r1(q.y)} ${r1(b.x)} ${r1(b.y)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${r1(last.x)} ${r1(last.y)}`;
}

/** Filled triangle arrowhead with its tip at `tip`, pointing along (dx, dy). */
export function arrowHead(tip: { x: number; y: number }, dx: number, dy: number, size = 9): string {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l, uy = dy / l;
  const bx = tip.x - ux * size, by = tip.y - uy * size;
  const px = -uy * size * 0.55, py = ux * size * 0.55;
  return `M${r1(tip.x)} ${r1(tip.y)} L${r1(bx + px)} ${r1(by + py)} L${r1(bx - px)} ${r1(by - py)} Z`;
}

export const r1 = (n: number) => Math.round(n * 10) / 10;

/** Donut sector path (angles in radians, 0 = 12 o'clock, clockwise). */
export function arcPath(cx: number, cy: number, r0: number, r1_: number, a0: number, a1: number): string {
  const span = Math.max(0, a1 - a0);
  if (span <= 0.0001) return '';
  const full = span >= Math.PI * 2 - 1e-4;
  const e = full ? a0 + Math.PI * 2 - 1e-4 : a1;
  const large = e - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number) => `${r1(cx + r * Math.sin(a))} ${r1(cy - r * Math.cos(a))}`;
  return `M${p(r1_, a0)} A${r1_} ${r1_} 0 ${large} 1 ${p(r1_, e)} L${p(r0, e)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export interface Box { x: number; y: number; w: number; h: number }
export const overlaps = (a: Box, b: Box, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
