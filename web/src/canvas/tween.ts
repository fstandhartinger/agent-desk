// Pure interpolation helpers for the scene animator (tested in Node).
import type { Prim } from './render/scene';

const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/** Interpolates two path strings with identical command structure; null when they differ (then the path snaps). */
export function pathLerp(a: string, b: string): ((t: number) => string) | null {
  if (a === b) return () => b;
  const sa = a.replace(NUM, '#'), sb = b.replace(NUM, '#');
  if (sa !== sb) return null;
  const na = (a.match(NUM) ?? []).map(Number), nb = (b.match(NUM) ?? []).map(Number);
  const parts = sb.split('#');
  return (t) => {
    let out = parts[0];
    for (let i = 0; i < nb.length; i++) out += String(Math.round((na[i] + (nb[i] - na[i]) * t) * 10) / 10) + parts[i + 1];
    return out;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const NUMERIC: Record<Prim['t'], string[]> = {
  rect: ['x', 'y', 'w', 'h', 'rx'],
  circle: ['cx', 'cy', 'r'],
  text: ['x', 'y'],
  arc: ['cx', 'cy', 'r0', 'r1', 'a0', 'a1'],
  path: [],
  svg: ['x', 'y', 'w', 'h'],
};

/** The primitive at progress t between `from` and `to` (same key, same type). */
export function lerpPrim(from: Prim, to: Prim, t: number, paths?: (t: number) => string): Prim {
  if (from.t !== to.t) return to;
  const out = { ...to } as Record<string, unknown>;
  for (const k of NUMERIC[to.t]) {
    const fa = (from as unknown as Record<string, number>)[k], tb = (to as unknown as Record<string, number>)[k];
    if (typeof fa === 'number' && typeof tb === 'number') out[k] = lerp(fa, tb, t);
  }
  if (to.t === 'path' && paths) out.d = paths(t);
  if (to.t === 'text' && to.num && from.t === 'text') {
    const fv = from.num?.value ?? to.num.value;
    const v = lerp(fv, to.num.value, t);
    out.num = { ...to.num, value: v };
    out.text = to.num.format(v);
  }
  return out as unknown as Prim;
}

/** Start state for shapes that grow in on enter: bars from their baseline, arcs from their start angle, numbers from 0. */
export function enterFrom(p: Prim): Prim | null {
  if (p.t === 'rect' && p.grow === 'w') return { ...p, w: 0 };
  if (p.t === 'rect' && p.grow === 'h') return { ...p, y: p.y + p.h, h: 0 };
  if (p.t === 'arc') return { ...p, a1: p.a0 };
  if (p.t === 'text' && p.num) return { ...p, num: { ...p.num, value: 0 }, text: p.num.format(0) };
  return null;
}

export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Keys of `next` that were not in `prev` (enter), of `prev` not in `next` (exit), and in both (update). */
export function diffKeys(prev: Prim[], next: Prim[]) {
  const pk = new Set(prev.map((p) => p.key)), nk = new Set(next.map((p) => p.key));
  return {
    enter: next.filter((p) => !pk.has(p.key)).map((p) => p.key),
    exit: prev.filter((p) => !nk.has(p.key)).map((p) => p.key),
    update: next.filter((p) => pk.has(p.key)).map((p) => p.key),
  };
}
