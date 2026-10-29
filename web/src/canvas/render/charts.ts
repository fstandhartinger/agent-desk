// pie (donut), bar, line, table, timeline, sankey, sequence and custom_svg renderers. All pure: spec + size → Scene in
// CSS pixels of the canvas area, so type stays at its design size; only flow/architecture can need scaling.
import type { CanvasItem, CanvasSpec, CanvasTone } from '../types';
import { fmtDate, fmtNumber, fmtPercent, fmtValue, niceTicks } from '../format';
import { sanitizeSvg } from '../sanitize';
import { arcPath, arrowHead, ellipsize, measure, PALETTE as P, r1, rgba, tone, TONES, wrap, type Box, type Prim, type Scene, type Size } from './scene';

const isHi = (spec: CanvasSpec, label: string) => !!spec.highlight && spec.highlight.trim().toLowerCase() === label.trim().toLowerCase();
// Red means "problem" (docs/CANVAS.md). Models like to paint the biggest bar red; in data charts the tone only survives
// when the item itself names a problem, otherwise the item falls back to the calm palette.
const PROBLEM = /fehl|problem|kaputt|defekt|risiko|verlust|überfällig|ueberfaellig|blockiert|gesperrt|ausfall|abgelehnt|verweigert|mahnung|strafe|bu(ß|ss)geld|warnung|kritisch|störung|error|fail|denied|refused|overdue|broken|outage/i;
export function dataTone(t: CanvasTone | undefined, label: string, detail?: string): CanvasTone | undefined {
  return t === 'red' && !PROBLEM.test(`${label} ${detail ?? ''}`) ? undefined : t;
}
/** Item colour: its own tone, else a calm rotation; the highlight is always papaya. */
const itemColor = (spec: CanvasSpec, it: { label: string; tone?: CanvasTone; detail?: string }, i: number, rotate = true) => {
  const t = dataTone(it.tone, it.label, it.detail);
  return isHi(spec, it.label) ? P.papaya : t && t !== 'neutral' ? tone(t) : rotate ? DONUT[i % DONUT.length] : P.violet;
};
// Restrained rotation for categorical slices when the spec gives no tones: violet, moss, amber, sky and neutral, then
// lighter variants of the same hues. No red or pink (red is reserved for problems), no papaya (the highlight).
export const DONUT = [P.violet, P.moss, P.amber, '#38bdf8', '#a3a3b8', '#c4b5fd', '#86efac', '#fcd34d', '#7dd3fc', '#d4d4e0', '#a78bfa', '#6ee7b7'];
const empty = (size: Size, text = 'Keine Daten'): Scene => ({
  w: size.width, h: size.height,
  prims: [{ t: 'text', key: 'empty', x: size.width / 2, y: size.height / 2, text, size: 15, fill: P.dim, anchor: 'middle' }],
});

// ------------------------------------------------------------------ pie (donut)
export interface PieSlice { label: string; value: number; share: number; a0: number; a1: number; color: string; item: CanvasItem }

export function pieSlices(spec: CanvasSpec): { slices: PieSlice[]; total: number } {
  const items = (spec.items ?? []).filter((it) => Number.isFinite(it.value) && it.value > 0);
  // Biggest first, "Sonstiges" last — the reading order of every good donut.
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) =>
    (/^sonstig/i.test(a.it.label) ? 1 : 0) - (/^sonstig/i.test(b.it.label) ? 1 : 0) || b.it.value - a.it.value || a.i - b.i);
  const total = sorted.reduce((s, x) => s + x.it.value, 0);
  // Small slices end up at the end of the circle; turn the donut so that tail sits at 9 o'clock, where their labels
  // have the most vertical room (instead of crowding at 12 o'clock with long crossing leader lines).
  let tailStart = 0, acc = 0, tailFound = false;
  for (const { it } of sorted) {
    if (!tailFound && total && it.value / total < 0.06) { tailStart = acc; tailFound = true; }
    acc += total ? (it.value / total) * Math.PI * 2 : 0;
  }
  const tailMid = tailFound ? (tailStart + Math.PI * 2) / 2 : 0;
  let a = tailFound ? Math.PI * 1.5 - tailMid : 0;
  const gap = sorted.length > 1 ? 0.012 : 0;
  const slices = sorted.map(({ it }, i) => {
    const span = total ? (it.value / total) * Math.PI * 2 : 0;
    const s: PieSlice = { label: it.label, value: it.value, share: total ? it.value / total : 0, a0: a + gap / 2, a1: a + span - gap / 2, color: itemColor(spec, it, i), item: it };
    a += span;
    return s;
  });
  return { slices, total };
}

/** Vertical positions for one side's labels: ideal y, then pushed apart to `gap` and kept inside [top, bottom]. */
export function spreadLabels(ys: number[], gap: number, top: number, bottom: number): number[] {
  const idx = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = idx.map((x) => x.y);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], i ? out[i - 1] + gap : top);
  const over = out.length ? out[out.length - 1] - bottom : 0;
  if (over > 0) {
    out[out.length - 1] -= over;
    for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - gap);
  }
  const res: number[] = [];
  idx.forEach((x, k) => (res[x.i] = out[k]));
  return res;
}

export function renderPie(spec: CanvasSpec, size: Size): Scene {
  const { slices, total } = pieSlices(spec);
  if (!slices.length) return empty(size);
  const unit = spec.unit;
  const prims: Prim[] = [];
  const legend = size.width < 640;
  const W = size.width;
  // Legend mode: the donut leaves room for the legend below it (r7 m17: the last legend row sat under the phone's zoom
  // strip); only below a 64 px radius does the scene grow taller and scroll instead.
  const legendH = slices.reduce((h, s) => h + (s.item.detail ? 50 : 38), 0);
  const R = legend
    ? Math.min(W * 0.34, 128, size.height * 0.3, Math.max(64, (size.height - 56 - legendH - 8) / 2))
    : Math.max(90, Math.min(size.height * 0.36, W * 0.2, 175));
  const r0 = R * 0.64;
  const cx = W / 2;
  // Two label columns: when one side holds more labels than the stage height takes, the scene grows taller (the view
  // then scales or scrolls it) instead of pushing labels out above the top.
  const sideOf = (s: PieSlice) => (Math.sin((s.a0 + s.a1) / 2) >= 0 ? 1 : 0);
  const rowH = (list: PieSlice[]) => Math.max(...list.map((s) => (s.item.detail ? 62 : 46)), 46);
  const need = legend ? 0 : Math.max(...[0, 1].map((side) => { const l = slices.filter((s) => sideOf(s) === side); return l.length ? (l.length - 1) * rowH(l) + 68 + 24 : 0; }));
  const H = Math.max(size.height, need);
  const cy = legend ? R + 22 : H / 2;
  slices.forEach((s, i) => {
    const hi = isHi(spec, s.label);
    prims.push({ t: 'arc', key: `s:${s.label}`, cx, cy, r0: hi ? r0 + 2 : r0, r1: hi ? R + 9 : R, a0: s.a0, a1: s.a1, fill: s.color, glow: hi, title: `${s.label}: ${fmtValue(s.value, unit)}`, delay: i * 70 });
  });
  // Centre: the total, big, with unit and "gesamt".
  // A small donut (phone legend mode) moves a unit note like "(ca.)" under the total, so the total keeps ≥ 12 px.
  const sizeFor = (t: string) => Math.min(R * 0.36, (r0 * 1.7) / Math.max(1, t.length * 0.62), 44);
  const note = /^(.*?)\s*(\([^)]*\))$/.exec(fmtValue(total, unit, { compact: true }));
  const split = !!note && sizeFor(fmtValue(total, unit, { compact: true })) < 12;
  const totalFmt = (v: number) => { const t = fmtValue(v, unit, { compact: true }); return split ? t.replace(/\s*\([^)]*\)$/, '') : t; };
  const totalText = totalFmt(total);
  const tSize = sizeFor(totalText);
  prims.push({ t: 'text', key: 'total', x: cx, y: cy + tSize * 0.18, text: totalText, size: tSize, weight: 700, fill: P.fg, anchor: 'middle', num: { value: total, format: totalFmt } });
  // "gesamt" sits below the centre, where the hole is narrower: it fits the chord at its baseline (≥ 11 px).
  const sub = split ? `gesamt ${note![2]}` : 'gesamt';
  const subY = tSize * 0.18 + 22;
  const chord = 2 * Math.sqrt(Math.max(0, r0 * r0 - (subY + 2) ** 2)) - 8;
  prims.push({ t: 'text', key: 'total:l', x: cx, y: cy + subY, text: sub, size: Math.max(11, Math.min(13, chord / (measure(sub, 13, 500) / 13))), weight: 500, fill: P.dim, anchor: 'middle' });

  if (legend) {
    let y = cy + R + 34;
    const x0 = 16, x1 = W - 16;
    slices.forEach((s, i) => {
      const k = `s:${s.label}`;
      const hi = isHi(spec, s.label);
      if (hi) prims.push({ t: 'rect', key: `${k}:row`, x: x0 - 8, y: y - 6, w: x1 - x0 + 16, h: 44, rx: 12, fill: rgba(P.papaya, 0.1), stroke: rgba(P.papaya, 0.4), sw: 1 });
      prims.push({ t: 'rect', key: `${k}:sw`, x: x0, y: y + 7, w: 12, h: 12, rx: 4, fill: s.color, delay: 300 + i * 50 });
      const valueText = fmtValue(s.value, unit);
      const pctText = fmtPercent(s.share);
      const right = measure(valueText, 15, 650) + measure(pctText, 13, 500) + 18;
      prims.push({ t: 'text', key: `${k}:l`, x: x0 + 22, y: y + 18, text: ellipsize(s.label, 15, 600, x1 - x0 - 30 - right), size: 15, weight: 600, fill: P.fg, delay: 300 + i * 50 });
      prims.push({ t: 'text', key: `${k}:v`, x: x1 - measure(pctText, 13, 500) - 12, y: y + 18, text: valueText, size: 15, weight: 650, fill: P.fg, anchor: 'end', num: { value: s.value, format: (v) => fmtValue(v, unit) }, delay: 300 + i * 50 });
      prims.push({ t: 'text', key: `${k}:p`, x: x1, y: y + 18, text: pctText, size: 13, weight: 500, fill: P.dim, anchor: 'end', num: { value: s.share, format: fmtPercent }, delay: 300 + i * 50 });
      if (s.item.detail) prims.push({ t: 'text', key: `${k}:d`, x: x0 + 22, y: y + 35, text: ellipsize(s.item.detail, 12, 400, x1 - x0 - 30), size: 12, fill: P.dim, delay: 300 + i * 50 });
      y += s.item.detail ? 50 : 38;
    });
    return { w: W, h: Math.max(size.height, y + 8), prims, scroll: true };
  }

  // Desktop: labels in two columns with leader lines; vertical collisions resolved per side.
  const colGap = Math.min(110, (W / 2 - R) * 0.35);
  const sides = [0, 1].map((side) => slices.map((s, i) => ({ s, i })).filter(({ s }) => sideOf(s) === side));
  for (const [side, list] of sides.entries()) {
    const dir = side ? 1 : -1;
    const ideal = list.map(({ s }) => cy - (R + 18) * Math.cos((s.a0 + s.a1) / 2));
    const ys = spreadLabels(ideal, rowH(list.map(({ s }) => s)), 28, H - 40);
    const colX = cx + dir * (R + colGap);
    const maxW = Math.max(120, W / 2 - R - colGap - 24);
    list.forEach(({ s, i }, j) => {
      const k = `s:${s.label}`;
      const mid = (s.a0 + s.a1) / 2;
      const out = isHi(spec, s.label) ? 9 : 0;
      const p0 = { x: cx + (R + out + 5) * Math.sin(mid), y: cy - (R + out + 5) * Math.cos(mid) };
      const p1 = { x: cx + (R + out + 18) * Math.sin(mid), y: cy - (R + out + 18) * Math.cos(mid) };
      const y = ys[j];
      const elbowX = colX - dir * 12;
      const d = `M${r1(p0.x)} ${r1(p0.y)} L${r1(p1.x)} ${r1(p1.y)} L${r1(elbowX)} ${r1(y)} L${r1(colX - dir * 4)} ${r1(y)}`;
      const delay = 380 + i * 70;
      prims.push({ t: 'path', key: `${k}:lead`, d, stroke: rgba(s.color, 0.7), sw: 1.3, draw: true, delay });
      prims.push({ t: 'circle', key: `${k}:dot`, cx: p0.x, cy: p0.y, r: 2.6, fill: s.color, delay });
      const anchor = side ? 'start' : 'end';
      const hi = isHi(spec, s.label);
      prims.push({ t: 'text', key: `${k}:l`, x: colX, y: y - 4, text: ellipsize(s.label, 16, 600, maxW), size: 16, weight: 600, fill: hi ? '#ffb38f' : P.fg, anchor, delay });
      const v = `${fmtValue(s.value, unit)}`;
      const pct = fmtPercent(s.share);
      // value (strong) + percent (dim) on the second line
      const vW = measure(v, 15, 700);
      const pW = measure(pct, 14, 500);
      const vx = side ? colX : colX - pW - 10;
      const px = side ? colX + vW + 10 : colX;
      prims.push({ t: 'text', key: `${k}:v`, x: vx, y: y + 16, text: v, size: 15, weight: 700, fill: s.color, anchor, num: { value: s.value, format: (x) => fmtValue(x, unit) }, delay });
      prims.push({ t: 'text', key: `${k}:p`, x: px, y: y + 16, text: pct, size: 14, weight: 500, fill: P.dim, anchor, num: { value: s.share, format: fmtPercent }, delay });
      if (s.item.detail) prims.push({ t: 'text', key: `${k}:d`, x: colX, y: y + 33, text: ellipsize(s.item.detail, 12.5, 400, maxW), size: 12.5, fill: P.faint, anchor, delay });
    });
  }
  return { w: W, h: H, prims, scroll: H > size.height };
}

// ------------------------------------------------------------------ bar
/** Nice ticks from 0 to ≥ max, as many as fit along `px` pixels with labels `labelW(t)` wide and ≥ 18 px apart (max 6). */
export function axisTicks(max: number, px: number, labelW: (t: number) => number): number[] {
  for (let count = Math.max(1, Math.min(6, Math.floor(px / 60))); count > 1; count--) {
    const t = niceTicks(0, max || 1, count);
    const spacing = px / Math.max(1, t.length - 1);
    if (spacing >= Math.max(...t.map(labelW)) + 18) return t;
  }
  return niceTicks(0, max || 1, 1);
}

export function renderBar(spec: CanvasSpec, size: Size): Scene {
  const items = (spec.items ?? []).filter((it) => Number.isFinite(it.value));
  if (!items.length) return empty(size);
  const unit = spec.unit;
  const prims: Prim[] = [];
  const max = Math.max(...items.map((it) => it.value), 0);
  const longLabels = items.some((it) => measure(it.label, 14, 500) > 96);
  const horizontal = size.width < 640 || longLabels || items.length > 7;
  const W = size.width;
  if (horizontal) {
    const rowH = Math.max(30, Math.min(56, (size.height - 60) / items.length));
    const labelW = Math.min(W * 0.36, Math.max(...items.map((it) => measure(it.label, 14, 600))) + 8);
    const valueW = Math.max(...items.map((it) => measure(fmtValue(it.value, unit), 14, 700))) + 14;
    const x0 = 16 + labelW + 12;
    const x1 = W - 16 - valueW;
    // As many ticks as fit side by side at this width (an export or a phone gets its own count, never overlapping).
    const ticks = axisTicks(max, x1 - x0, (t) => measure(fmtNumber(t), 11.5, 400));
    const top = ticks[ticks.length - 1] || 1;
    const plotH = rowH * items.length;
    const y0 = Math.max(24, (size.height - plotH - 30) / 2);
    ticks.forEach((t, i) => {
      const x = x0 + ((x1 - x0) * t) / top;
      prims.push({ t: 'path', key: `grid:${i}`, d: `M${r1(x)} ${r1(y0 - 6)} L${r1(x)} ${r1(y0 + plotH)}`, stroke: i ? P.grid : '#3a3a48', sw: 1 });
      prims.push({ t: 'text', key: `tick:${i}`, x, y: y0 + plotH + 18, text: fmtNumber(t), size: 11.5, fill: P.faint, anchor: 'middle' });
    });
    items.forEach((it, i) => {
      const k = `b:${it.label}`;
      const y = y0 + i * rowH;
      const bh = Math.min(26, rowH * 0.56);
      const by = y + (rowH - bh) / 2;
      const w = Math.max(2, ((x1 - x0) * Math.max(0, it.value)) / top);
      const c = itemColor(spec, it, i, false);
      prims.push({ t: 'text', key: `${k}:l`, x: x0 - 12, y: by + bh / 2 + 5, text: ellipsize(it.label, 14, 600, labelW), size: 14, weight: 600, fill: isHi(spec, it.label) ? '#ffb38f' : P.text2, anchor: 'end', delay: i * 50 });
      prims.push({ t: 'rect', key: k, x: x0, y: by, w, h: bh, rx: 6, fill: c, glow: isHi(spec, it.label), delay: i * 50, title: it.detail, grow: 'w' });
      prims.push({ t: 'text', key: `${k}:v`, x: x0 + w + 8, y: by + bh / 2 + 5, text: fmtValue(it.value, unit), size: 14, weight: 700, fill: P.fg, num: { value: it.value, format: (v) => fmtValue(v, unit) }, delay: 200 + i * 50 });
    });
    return { w: W, h: Math.max(size.height, y0 + plotH + 32), prims, scroll: true };
  }
  const left = 56, bottom = 58, topPad = 36;
  const x0 = left, x1 = W - 24, y0 = topPad, y1 = size.height - bottom;
  const ticks = axisTicks(max, y1 - y0, () => 14);
  const top = ticks[ticks.length - 1] || 1;
  const band = (x1 - x0) / items.length;
  const bw = Math.min(72, band * 0.58);
  ticks.forEach((t, i) => {
    const y = y1 - ((y1 - y0) * t) / top;
    prims.push({ t: 'path', key: `grid:${i}`, d: `M${x0} ${r1(y)} L${x1} ${r1(y)}`, stroke: i ? P.grid : '#3a3a48', sw: 1 });
    prims.push({ t: 'text', key: `tick:${i}`, x: x0 - 10, y: y + 4, text: fmtNumber(t), size: 11.5, fill: P.faint, anchor: 'end' });
  });
  items.forEach((it, i) => {
    const k = `b:${it.label}`;
    const cx = x0 + band * (i + 0.5);
    const h = Math.max(2, ((y1 - y0) * Math.max(0, it.value)) / top);
    const c = itemColor(spec, it, i, false);
    prims.push({ t: 'rect', key: k, x: cx - bw / 2, y: y1 - h, w: bw, h, rx: 6, fill: c, glow: isHi(spec, it.label), delay: i * 60, title: it.detail, grow: 'h' });
    prims.push({ t: 'text', key: `${k}:v`, x: cx, y: y1 - h - 9, text: fmtValue(it.value, unit), size: 14, weight: 700, fill: P.fg, anchor: 'middle', num: { value: it.value, format: (v) => fmtValue(v, unit) }, delay: 200 + i * 60 });
    wrap(it.label, 13.5, 600, band - 8, 2).forEach((line, j) => {
      prims.push({ t: 'text', key: `${k}:l${j}`, x: cx, y: y1 + 20 + j * 17, text: line, size: 13.5, weight: 600, fill: isHi(spec, it.label) ? '#ffb38f' : P.text2, anchor: 'middle', delay: i * 60 });
    });
  });
  return { w: W, h: size.height, prims };
}

// ------------------------------------------------------------------ line
const dateMs = (x: string | number) => (typeof x === 'number' ? NaN : Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(x) ? x.replace(' ', 'T') : x));

export function renderLine(spec: CanvasSpec, size: Size): Scene {
  const series = (spec.series ?? []).map((s) => ({ ...s, points: (s.points ?? []).filter((p) => Number.isFinite(p.y)) })).filter((s) => s.points.length);
  if (!series.length) return empty(size);
  const unit = spec.unit;
  const all = series.flatMap((s) => s.points);
  const isDate = all.every((p) => typeof p.x === 'string' && Number.isFinite(dateMs(p.x)));
  const isNum = !isDate && all.every((p) => typeof p.x === 'number' || (typeof p.x === 'string' && p.x.trim() !== '' && Number.isFinite(Number(p.x))));
  const cats = !isDate && !isNum ? [...new Set(all.map((p) => String(p.x)))] : [];
  const xv = (x: string | number) => (isDate ? dateMs(String(x)) : isNum ? Number(x) : cats.indexOf(String(x)));
  const xs = all.map((p) => xv(p.x));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymax = Math.max(...all.map((p) => p.y)), ymin = Math.min(0, ...all.map((p) => p.y));
  const ticks = niceTicks(ymin, ymax, 4);
  const lastValW = Math.max(...series.map((s) => measure(fmtValue(s.points[s.points.length - 1].y, unit), 13, 700))) + 26;
  const left = Math.max(...ticks.map((t) => measure(fmtNumber(t), 11.5, 400))) + 22;
  const x0 = left, x1 = size.width - lastValW - 10, y0 = series.length > 1 ? 44 : 24, y1 = size.height - 40;
  const sx = (x: number) => (xmax === xmin ? (x0 + x1) / 2 : x0 + ((x1 - x0) * (x - xmin)) / (xmax - xmin));
  const sy = (y: number) => y1 - ((y1 - y0) * (y - ticks[0])) / (ticks[ticks.length - 1] - ticks[0] || 1);
  const prims: Prim[] = [];
  ticks.forEach((t, i) => {
    prims.push({ t: 'path', key: `grid:${i}`, d: `M${x0} ${r1(sy(t))} L${x1} ${r1(sy(t))}`, stroke: t === 0 ? '#3a3a48' : P.grid, sw: 1 });
    prims.push({ t: 'text', key: `tick:${i}`, x: x0 - 10, y: sy(t) + 4, text: fmtNumber(t), size: 11.5, fill: P.faint, anchor: 'end' });
  });
  // x labels: at most ~6, evenly picked from the distinct x values
  const distinct = [...new Set(xs)].sort((a, b) => a - b);
  const maxLabels = Math.max(2, Math.floor((x1 - x0) / 90));
  const step = Math.max(1, Math.ceil(distinct.length / maxLabels));
  distinct.filter((_, i) => i % step === 0 || i === distinct.length - 1).forEach((x, i, arr) => {
    if (i === arr.length - 2 && distinct.indexOf(arr[i + 1]) - distinct.indexOf(x) < step / 2) return; // keep last label clear
    const raw = all.find((p) => xv(p.x) === x)!.x;
    const text = isDate ? fmtDate(String(raw)) : isNum ? fmtNumber(Number(raw)) : String(raw);
    prims.push({ t: 'text', key: `xt:${x}`, x: sx(x), y: y1 + 22, text: ellipsize(text, 11.5, 400, 86), size: 11.5, fill: P.faint, anchor: 'middle' });
  });
  const lastYs: number[] = [];
  series.forEach((s, si) => {
    const c = isHi(spec, s.name) ? P.papaya : tone(dataTone(s.tone, s.name), tone(TONES[si % TONES.length]));
    const pts = s.points.map((p) => ({ x: sx(xv(p.x)), y: sy(p.y) })).sort((a, b) => a.x - b.x);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.y)}`).join(' ');
    const k = `ser:${s.name}`;
    if (series.length === 1) prims.push({ t: 'path', key: `${k}:area`, d: `${d} L${r1(pts[pts.length - 1].x)} ${r1(sy(Math.max(ticks[0], 0)))} L${r1(pts[0].x)} ${r1(sy(Math.max(ticks[0], 0)))} Z`, fill: rgba(c, 0.09), delay: 300 });
    prims.push({ t: 'path', key: k, d, stroke: c, sw: 2.6, draw: true, cap: 'round', delay: si * 120 });
    if (pts.length <= 32) pts.forEach((p, i) => prims.push({ t: 'circle', key: `${k}:p${i}`, cx: p.x, cy: p.y, r: 3.4, fill: P.bg, stroke: c, sw: 2, delay: 300 + i * 20 }));
    const last = s.points[s.points.length - 1];
    const lp = pts[pts.length - 1];
    let ly = lp.y;
    for (const o of lastYs) if (Math.abs(o - ly) < 24) ly = o + 24;
    lastYs.push(ly);
    const txt = fmtValue(last.y, unit);
    const tw = measure(txt, 13, 700) + 16;
    prims.push({ t: 'rect', key: `${k}:lastbg`, x: lp.x + 10, y: ly - 12, w: tw, h: 24, rx: 12, fill: rgba(c, 0.16), stroke: rgba(c, 0.55), sw: 1, delay: 700 });
    prims.push({ t: 'text', key: `${k}:last`, x: lp.x + 10 + tw / 2, y: ly + 4.5, text: txt, size: 13, weight: 700, fill: P.fg, anchor: 'middle', num: { value: last.y, format: (v) => fmtValue(v, unit) }, delay: 700 });
  });
  if (series.length > 1) {
    let lx = x0;
    series.forEach((s, si) => {
      const c = isHi(spec, s.name) ? P.papaya : tone(dataTone(s.tone, s.name), tone(TONES[si % TONES.length]));
      prims.push({ t: 'rect', key: `leg:${s.name}:sw`, x: lx, y: 14, w: 14, h: 4, rx: 2, fill: c });
      prims.push({ t: 'text', key: `leg:${s.name}`, x: lx + 20, y: 20, text: s.name, size: 13, weight: 600, fill: P.text2 });
      lx += 20 + measure(s.name, 13, 600) + 22;
    });
  }
  return { w: size.width, h: size.height, prims };
}

// ------------------------------------------------------------------ table
const NUMERIC = /^[-+−]?[\d.,\s ]+(\s?(€|\$|%|EUR|USD|Std|h|min|s|ms|MB|GB|KB|x))?$/i;

export function renderTable(spec: CanvasSpec, size: Size): Scene {
  const cols = spec.columns ?? [];
  const rows = (spec.rows ?? []).map((r) => cols.map((_, i) => r[i] ?? ''));
  if (!cols.length) return empty(size);
  const cell = (v: string | number) => (typeof v === 'number' ? fmtNumber(v) : String(v));
  const numeric = cols.map((_, c) => {
    const vals = rows.map((r) => r[c]).filter((v) => v !== '');
    return vals.length > 0 && vals.filter((v) => typeof v === 'number' || NUMERIC.test(String(v).trim())).length / vals.length >= 0.6;
  });
  const pad = 16;
  const natural = cols.map((h, c) => Math.max(measure(h.toUpperCase(), 11.5, 700) + 4, ...rows.map((r) => measure(cell(r[c]), 14, c === 0 ? 600 : 450))) + pad * 2);
  const avail = size.width - 8;
  const sum = natural.reduce((a, b) => a + b, 0);
  // Shrink the widest columns first, never below 120 px (then the table pans sideways instead).
  const widths = natural.map((w) => Math.min(w, avail < 600 ? 260 : 300));
  // Narrow stages pan sideways, so columns keep their natural width there (no "explainer-…" cuts).
  if (sum > avail && avail >= 600) {
    let over = sum - avail;
    while (over > 0.5) {
      const maxW = Math.max(...widths);
      if (maxW <= 120) break;
      const i = widths.indexOf(maxW);
      const second = Math.max(120, ...widths.filter((_, j) => j !== i));
      const cut = Math.min(over, maxW - Math.min(second, maxW) || Math.min(over, maxW - 120));
      widths[i] -= Math.max(1, cut);
      over -= Math.max(1, cut);
    }
  }
  const total = widths.reduce((a, b) => a + b, 0);
  const x0 = Math.max(4, (size.width - total) / 2);
  const rowH = 40;
  const headH = 38;
  const tableH = headH + rows.length * rowH;
  const y0 = Math.max(12, Math.min(40, (size.height - tableH) / 2));
  const prims: Prim[] = [];
  prims.push({ t: 'rect', key: 'frame', x: x0, y: y0, w: total, h: tableH, rx: 14, fill: P.panel, stroke: '#2a2a36', sw: 1 });
  let x = x0;
  const colX = widths.map((w) => { const s = x; x += w; return s; });
  cols.forEach((h, c) => {
    const right = numeric[c];
    prims.push({ t: 'text', key: `h:${c}`, x: right ? colX[c] + widths[c] - pad : colX[c] + pad, y: y0 + 24, text: ellipsize(h.toUpperCase(), 11.5, 700, widths[c] - pad * 2), size: 11.5, weight: 700, fill: P.dim, anchor: right ? 'end' : 'start' });
  });
  prims.push({ t: 'path', key: 'h:line', d: `M${x0} ${y0 + headH} L${x0 + total} ${y0 + headH}`, stroke: '#34343f', sw: 1 });
  rows.forEach((r, i) => {
    const y = y0 + headH + i * rowH;
    const k = `r:${String(r[0])}`;
    const hi = isHi(spec, String(r[0]));
    if (hi || i % 2 === 1) prims.push({ t: 'rect', key: `${k}:bg`, x: x0 + 1, y, w: total - 2, h: rowH, rx: i === rows.length - 1 ? 0 : 0, fill: hi ? rgba(P.papaya, 0.12) : 'rgba(255,255,255,0.025)', delay: i * 30 });
    r.forEach((v, c) => {
      const right = numeric[c];
      prims.push({
        t: 'text', key: `${k}:c${c}`, x: right ? colX[c] + widths[c] - pad : colX[c] + pad, y: y + 25, text: ellipsize(cell(v), 14, c === 0 ? 600 : 450, widths[c] - pad * 2),
        size: 14, weight: c === 0 ? 600 : 450, fill: hi ? '#ffd9c7' : c === 0 ? P.fg : P.text2, anchor: right ? 'end' : 'start', title: cell(v), delay: i * 30,
        num: typeof v === 'number' ? { value: v, format: (n) => fmtNumber(n) } : undefined,
      });
    });
  });
  return { w: Math.max(size.width, x0 + total + 4), h: Math.max(size.height, y0 + tableH + 12), prims, scroll: true, scrollX: x0 + total + 4 > size.width };
}

// ------------------------------------------------------------------ timeline
export function renderTimeline(spec: CanvasSpec, size: Size): Scene {
  const events = spec.events ?? [];
  if (!events.length) return empty(size);
  const prims: Prim[] = [];
  const horizontal = events.length <= 6 && size.width >= 720;
  if (horizontal) {
    const colW = Math.min(230, (size.width - 48) / events.length - 16);
    const x0 = 24 + colW / 2, x1 = size.width - 24 - colW / 2;
    const step = events.length > 1 ? (x1 - x0) / (events.length - 1) : 0;
    const y = Math.max(110, size.height * 0.4);
    prims.push({ t: 'path', key: 'axis', d: `M${r1(x0 - 30)} ${y} L${r1(x1 + 30)} ${y}`, stroke: '#34343f', sw: 2, cap: 'round', draw: true });
    events.forEach((e, i) => {
      const x = events.length > 1 ? x0 + i * step : (x0 + x1) / 2;
      const c = isHi(spec, e.label) ? P.papaya : tone(e.tone, P.violet);
      const k = `ev:${e.label}`;
      const delay = 200 + i * 110;
      prims.push({ t: 'circle', key: `${k}:halo`, cx: x, cy: y, r: 13, fill: rgba(c, 0.18), delay });
      prims.push({ t: 'circle', key: `${k}:dot`, cx: x, cy: y, r: 6.5, fill: c, glow: isHi(spec, e.label), delay });
      prims.push({ t: 'text', key: `${k}:date`, x, y: y - 28, text: fmtDate(e.date), size: 13.5, weight: 650, fill: c, anchor: 'middle', delay });
      let ty = y + 40;
      wrap(e.label, 16, 650, colW, 2).forEach((l, j) => { prims.push({ t: 'text', key: `${k}:l${j}`, x, y: ty, text: l, size: 16, weight: 650, fill: P.fg, anchor: 'middle', delay }); ty += 21; });
      if (e.detail) wrap(e.detail, 13, 400, colW, 3).forEach((l, j) => { prims.push({ t: 'text', key: `${k}:d${j}`, x, y: ty + 3, text: l, size: 13, fill: P.dim, anchor: 'middle', delay }); ty += 18; });
    });
    return { w: size.width, h: size.height, prims };
  }
  const compact = size.width < 560;
  const dateW = compact ? 0 : Math.max(...events.map((e) => measure(fmtDate(e.date), 13.5, 650))) + 20;
  const lx = compact ? 26 : 24 + dateW + 16;
  const textX = lx + 24;
  const textW = size.width - textX - 16;
  let y = 30;
  const rows = events.map((e) => {
    const lines = wrap(e.label, 16, 650, textW, 2);
    const detail = e.detail ? wrap(e.detail, 13, 400, textW, 3) : [];
    const h = (compact ? 20 : 0) + lines.length * 21 + detail.length * 18 + 22;
    const r = { e, y, lines, detail, h };
    y += h;
    return r;
  });
  const total = y;
  const off = Math.max(0, (size.height - total) / 2 - 10);
  prims.push({ t: 'path', key: 'axis', d: `M${lx} ${rows[0].y + off} L${lx} ${r1(rows[rows.length - 1].y + off + 8)}`, stroke: '#34343f', sw: 2, cap: 'round', draw: true });
  rows.forEach(({ e, y: ry, lines, detail }, i) => {
    const yy = ry + off;
    const c = isHi(spec, e.label) ? P.papaya : tone(e.tone, P.violet);
    const k = `ev:${e.label}`;
    const delay = 150 + i * 90;
    prims.push({ t: 'circle', key: `${k}:halo`, cx: lx, cy: yy + 2, r: 11, fill: rgba(c, 0.18), delay });
    prims.push({ t: 'circle', key: `${k}:dot`, cx: lx, cy: yy + 2, r: 5.5, fill: c, glow: isHi(spec, e.label), delay });
    let ty = yy + 8;
    if (compact) {
      prims.push({ t: 'text', key: `${k}:date`, x: textX, y: yy + 7, text: fmtDate(e.date), size: 12.5, weight: 650, fill: c, delay });
      ty += 20;
    } else prims.push({ t: 'text', key: `${k}:date`, x: lx - 22, y: yy + 7, text: fmtDate(e.date), size: 13.5, weight: 650, fill: c, anchor: 'end', delay });
    lines.forEach((l, j) => { prims.push({ t: 'text', key: `${k}:l${j}`, x: textX, y: ty, text: l, size: 16, weight: 650, fill: P.fg, delay }); ty += 21; });
    detail.forEach((l, j) => { prims.push({ t: 'text', key: `${k}:d${j}`, x: textX, y: ty, text: l, size: 13, fill: P.dim, delay }); ty += 18; });
  });
  return { w: size.width, h: Math.max(size.height, total + 20), prims, scroll: true };
}

// ------------------------------------------------------------------ sankey
type SkNode = { id: string; label: string; tone?: CanvasTone; title?: string };
type SkLink = { from: string; to: string; value: number };

/** Folds a source's small leaf flows (< 2 % of all money, at least two of them) into one "Sonstige (n)" node, so the
 *  tail of tiny counterparties does not turn into a stack of unreadable labels. */
export function foldSankey(spec: CanvasSpec, share = 0.02): { nodes: SkNode[]; links: SkLink[] } {
  const links: SkLink[] = (spec.links ?? []).filter((l) => l.from !== l.to && Number.isFinite(l.value) && l.value > 0).map((l) => ({ ...l }));
  const nodes: SkNode[] = (spec.nodes ?? []).map((n) => ({ id: n.id, label: n.label, tone: n.tone }));
  const hasIn = new Set(links.map((l) => l.to)), hasOut = new Set(links.map((l) => l.from));
  const roots = links.filter((l) => !hasIn.has(l.from));
  const total = (roots.length ? roots : links).reduce((s, l) => s + l.value, 0);
  const limit = total * share;
  const inCount = (id: string) => links.filter((l) => l.to === id).length;
  const label = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  for (const src of [...new Set(links.map((l) => l.from))]) {
    const small = links.filter((l) => l.from === src && l.value < limit && !hasOut.has(l.to) && inCount(l.to) === 1 && l.to !== spec.highlight);
    if (small.length < 2) continue;
    const id = `${src}~sonstige`;
    const value = small.reduce((s, l) => s + l.value, 0);
    const gone = new Set(small.map((l) => l.to));
    nodes.push({ id, label: `Sonstige (${small.length})`, title: small.map((l) => `${label(l.to)}: ${fmtNumber(l.value)}`).join(' · ') });
    links.splice(0, links.length, ...links.filter((l) => !(l.from === src && gone.has(l.to))), { from: src, to: id, value });
  }
  return { nodes, links };
}

/** A node label that already carries the node's value ("Gesamt 1.234,56", "Korn: 812 €") loses that number: the
 *  value is drawn under or beside it anyway (r8 d03 showed the total twice: in the label and as the value). */
export function stripValue(label: string, value: number): string {
  const parse = (t: string) => Number(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  const out = label.replace(/\s*[:=–—-]?\s*(?:€|EUR|USD|\$)?\s*(?<![\p{L}\p{N}])(\d[\d.,]*\d|\d)\s*(?:k\b|Tsd\.?)?\s*(?:€|EUR|USD|\$)?(?:\s*\(ca\.\))?/gu, (m, num: string) => {
    const v = parse(num);
    return Number.isFinite(v) && v > 0 && Math.abs(v - value) <= Math.max(1, Math.abs(value) * 0.005) ? ' ' : m;
  }).replace(/\s+/g, ' ').replace(/[\s:=–—-]+$/, '').trim();
  return out || label;
}

export interface SankeyNode { id: string; label: string; lines: string[]; inline: boolean; col: number; value: number; x: number; y: number; h: number; color: string; title?: string; label_: Box; left?: boolean }

/** Columns left to right; every label sits right of its node inside a reserved band, and every node gets a vertical
 *  slot at least as tall as its label, so labels can neither overlap each other nor the next column. */
export function sankeyLayout(spec: CanvasSpec, size: Size) {
  const { nodes: specNodes, links } = foldSankey(spec);
  const known = new Map(specNodes.map((n) => [n.id, n]));
  const ids = [...new Set([...specNodes.map((n) => n.id).filter((id) => links.some((l) => l.from === id || l.to === id)), ...links.flatMap((l) => [l.from, l.to])])];
  const unit = spec.unit;
  // Column = longest path from a source (cycles are cut by the iteration cap).
  const col = new Map(ids.map((id) => [id, 0]));
  for (let k = 0; k < ids.length; k++) for (const l of links) col.set(l.to, Math.max(col.get(l.to)!, col.get(l.from)! + 1));
  const ncol = Math.max(...col.values()) + 1;
  const inV = (id: string) => links.filter((l) => l.to === id).reduce((s, l) => s + l.value, 0);
  const outV = (id: string) => links.filter((l) => l.from === id).reduce((s, l) => s + l.value, 0);
  const val = (id: string) => Math.max(inV(id), outV(id));
  const cols = Array.from({ length: ncol }, (_, c) => ids.filter((id) => col.get(id) === c));
  // Order each column by the weighted position of its sources (fewer crossings), keeping input order on ties;
  // folded "Sonstige" nodes go last among their siblings.
  for (let c = 1; c < ncol; c++) {
    const prevIdx = new Map(cols[c - 1].map((id, i) => [id, i]));
    const bary = (id: string) => {
      const ins = links.filter((l) => l.to === id && prevIdx.has(l.from));
      const w = ins.reduce((s, l) => s + l.value, 0);
      return (w ? ins.reduce((s, l) => s + prevIdx.get(l.from)! * l.value, 0) / w : Infinity) + (id.endsWith('~sonstige') ? 0.5 : 0);
    };
    cols[c] = cols[c].map((id, i) => ({ id, i, b: bary(id) })).sort((a, b) => a.b - b.b || a.i - b.i).map((x) => x.id);
  }
  const narrow = size.width < 640;
  const LS = narrow ? 12.5 : 14, VS = narrow ? 11.5 : 12.5;
  const LH = Math.round(LS * 1.25), VH = Math.round(VS * 1.3);
  const nodeW = narrow ? 10 : 14;
  const padX = 12, padY = 20, slotGap = narrow ? 6 : 8, labelPad = 8;
  const minGap = narrow ? 26 : 56;
  // Label bands: natural width, capped evenly (water filling) when the stage is too narrow; labels then wrap.
  const labelOf = (id: string) => stripValue(known.get(id)?.label ?? id, val(id));
  const natural = cols.map((c) => Math.min(narrow ? 150 : 210, Math.max(...c.map((id) => Math.max(measure(labelOf(id), LS, 600), measure(fmtValue(val(id), unit), VS, 600)))) + 4));
  const room = size.width - padX * 2 - ncol * (nodeW + labelPad) - (ncol - 1) * minGap;
  let bands = natural.slice();
  if (bands.reduce((a, b) => a + b, 0) > room) {
    const sorted = natural.slice().sort((a, b) => a - b);
    let left = Math.max(room, ncol * 56), cap = 0;
    for (let i = 0; i < sorted.length; i++) {
      const share = left / (sorted.length - i);
      if (sorted[i] <= share) left -= sorted[i];
      else { cap = share; break; }
    }
    if (cap) bands = natural.map((w) => Math.min(w, cap));
  }
  // Never squeezed below a readable minimum: a long chain then grows wider than the stage and scrolls sideways.
  const minBand = narrow ? 64 : 84;
  bands = bands.map((w, c) => Math.max(Math.min(minBand, natural[c]), 56, w));
  const slack = Math.max(0, room - bands.reduce((a, b) => a + b, 0));
  const gapX = ncol > 1 ? minGap + slack / (ncol - 1) : 0;
  // The source column's labels sit LEFT of its nodes: on the right they would lie on the outgoing flows (r8 d03).
  const colX: number[] = [];
  let x = ncol > 1 ? padX + bands[0] + labelPad : padX + slack / 2;
  for (let c = 0; c < ncol; c++) { colX.push(x); x += nodeW + (c === 0 && ncol > 1 ? 0 : labelPad + bands[c]) + gapX; }
  const leftLabel = (c: number) => c === 0 && ncol > 1;
  // "Label  value" on one line when it fits the band (half the height per node), else label (≤ 2 lines) over value.
  const inline = new Map(ids.map((id) => [id, measure(labelOf(id), LS, 600) + 8 + measure(fmtValue(val(id), unit), VS, 600) <= bands[col.get(id)!]]));
  // A single word longer than the band ("Geldbewegungen") is ellipsised too, never drawn into the next column.
  const lines = new Map(ids.map((id) => [id, inline.get(id) ? [labelOf(id)] : wrap(labelOf(id), LS, 600, bands[col.get(id)!], 2).map((l) => ellipsize(l, LS, 600, bands[col.get(id)!]))]));
  const labelH = (id: string) => lines.get(id)!.length * LH + (inline.get(id) ? 0 : VH);
  // Scale: the largest k where every column's slots (max(node, label)) fit the height; ink stays below ~72 %.
  const availH = size.height - padY * 2;
  const used = (c: string[], k: number) => c.reduce((s, id) => s + Math.max(val(id) * k, labelH(id)), 0) + slotGap * (c.length - 1);
  const colTotals = cols.map((c) => c.reduce((s, id) => s + val(id), 0));
  let lo = 0, hi = Math.min(...colTotals.map((t) => (availH * 0.72) / (t || 1)));
  if (cols.every((c) => used(c, hi) <= availH)) lo = hi;
  else for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (cols.every((c) => used(c, mid) <= availH)) lo = mid; else hi = mid; }
  // Flows must stay visible: at least ~40 % of the height is ink in the fullest column; the scene grows taller instead
  // (and the view fits it), rather than ribbons collapsing to hairlines under a long list of labels.
  const k = Math.max(lo, (availH * 0.4) / Math.max(...colTotals, 1e-9));
  const H = Math.max(size.height, Math.max(...cols.map((c) => used(c, k))) + padY * 2);
  const nodes = new Map<string, SankeyNode>();
  let ci = 0;
  cols.forEach((c, i) => {
    let y = padY + (H - padY * 2 - used(c, k)) / 2;
    c.forEach((id) => {
      const v = val(id);
      const n = known.get(id);
      const t = dataTone(n?.tone, labelOf(id));
      const color = spec.highlight === id ? P.papaya : id.endsWith('~sonstige') ? '#8d8ca3' : t && t !== 'neutral' ? tone(t) : DONUT[ci++ % DONUT.length];
      const slot = Math.max(v * k, labelH(id));
      const h = Math.max(3, v * k);
      const ny = y + (slot - h) / 2;
      const lh = labelH(id);
      nodes.set(id, {
        id, label: labelOf(id), lines: lines.get(id)!, col: i, value: v, x: colX[i], y: ny, h, color, title: n?.title,
        inline: inline.get(id)!, left: leftLabel(i),
        label_: { x: leftLabel(i) ? colX[i] - labelPad - bands[i] : colX[i] + nodeW + labelPad, y: y + (slot - lh) / 2, w: bands[i], h: lh },
      });
      y += slot + slotGap;
    });
  });
  // Ribbons: stacked at each node in the order of the other end's y (fewer crossings).
  const outOff = new Map<string, number>(), inOff = new Map<string, number>();
  const sorted = links.slice().sort((a, b) => nodes.get(a.to)!.y - nodes.get(b.to)!.y || nodes.get(a.from)!.y - nodes.get(b.from)!.y);
  const ribbons = sorted.map((l) => {
    const s = nodes.get(l.from)!, t = nodes.get(l.to)!;
    const so = outOff.get(s.id) ?? 0, to = inOff.get(t.id) ?? 0;
    const w = l.value * k;
    outOff.set(s.id, so + w);
    inOff.set(t.id, to + w);
    return { l, s, t, sy: s.y + so, ty: t.y + to, w };
  });
  const W = Math.max(size.width, Math.ceil(colX[ncol - 1] + nodeW + labelPad + bands[ncol - 1] + padX));
  return { nodes: [...nodes.values()], ribbons, H, W, nodeW, LS, VS, LH, VH };
}

export function renderSankey(spec: CanvasSpec, size: Size): Scene {
  if (!(spec.links ?? []).length) return empty(size);
  const unit = spec.unit;
  const { nodes, ribbons, H, W, nodeW, LS, VS, LH } = sankeyLayout(spec, size);
  const ncol = Math.max(...nodes.map((n) => n.col)) + 1;
  const prims: Prim[] = [];
  ribbons.forEach((r, i) => {
    const xa = r.s.x + nodeW, xb = r.t.x, xm = (xa + xb) / 2;
    const d = `M${r1(xa)} ${r1(r.sy)} C${r1(xm)} ${r1(r.sy)} ${r1(xm)} ${r1(r.ty)} ${r1(xb)} ${r1(r.ty)} L${r1(xb)} ${r1(r.ty + r.w)} C${r1(xm)} ${r1(r.ty + r.w)} ${r1(xm)} ${r1(r.sy + r.w)} ${r1(xa)} ${r1(r.sy + r.w)} Z`;
    const hot = spec.highlight && (r.l.from === spec.highlight || r.l.to === spec.highlight);
    // Ribbons take the colour of where the money goes.
    prims.push({ t: 'path', key: `lk:${r.l.from}>${r.l.to}`, d, fill: rgba(hot ? P.papaya : r.t.color, hot ? 0.45 : 0.3), delay: 250 + i * 40 });
  });
  nodes.forEach((n, i) => {
    prims.push({ t: 'rect', key: `sn:${n.id}`, x: n.x, y: n.y, w: nodeW, h: n.h, rx: Math.min(4, nodeW / 2), fill: n.color, glow: spec.highlight === n.id, delay: i * 50, title: n.title });
    const b = n.label_;
    const valueText = fmtValue(n.value, unit);
    // Labels of inner columns lie over the outgoing ribbons: a soft backdrop keeps them legible.
    const vw = measure(valueText, VS, 600);
    if (n.col < ncol - 1 && !n.left) {
      const tw = n.inline ? measure(n.label, LS, 600) + 8 + vw : Math.max(...n.lines.map((l) => measure(l, LS, 600)), vw);
      prims.push({ t: 'rect', key: `sn:${n.id}:bg`, x: b.x - 5, y: b.y - 2, w: tw + 10, h: b.h + 4, rx: 7, fill: rgba(P.bg, 0.78), delay: i * 50 });
    }
    // Left labels are right-aligned against their node ("Label  value" ends at the node).
    const anchor = n.left ? 'end' as const : undefined;
    const lx = n.left ? b.x + b.w - (n.inline ? vw + 8 : 0) : b.x;
    n.lines.forEach((line, j) => {
      prims.push({ t: 'text', key: `sn:${n.id}:l${j ? j : ''}`, x: lx, y: b.y + LS + j * LH - 1, text: line, size: LS, weight: 600, fill: P.fg, anchor, delay: i * 50, title: n.title ?? (line !== n.label ? n.label : undefined) });
    });
    const vx = n.left ? b.x + b.w : n.inline ? b.x + measure(n.label, LS, 600) + 8 : b.x;
    const vy = n.inline ? b.y + LS - 1 : b.y + n.lines.length * LH + VS;
    prims.push({ t: 'text', key: `sn:${n.id}:v`, x: vx, y: vy, text: valueText, size: VS, weight: 600, fill: n.color, anchor, num: { value: n.value, format: (v) => fmtValue(v, unit) }, delay: i * 50 });
  });
  return { w: W, h: H, prims, minText: VS, scrollX: W > size.width };
}

// ------------------------------------------------------------------ sequence
/** Monospace only for a single code-like token ("notify.loginLink", "/api/canvas", "canvas_draw", "start()"); a
 *  hyphen alone is German prose ("Telegram-Nachricht mit Link", r7 d01x), and so is anything with spaces. */
export function codeLabel(label: string): boolean {
  const t = label.trim();
  return /^[\w./:@#-]+(\(\))?$/.test(t) && /[./_]|\(\)$/.test(t);
}

/** `text` wrapped to as many lines as it needs (up to `max`) so that nothing is cut with "…" (round 10: actor labels
 *  and message labels used to stop after two lines). Only a text longer than `max` lines is ellipsised. */
export function wrapFull(text: string, size: number, weight: number, maxW: number, max = 4): string[] {
  let lines = wrap(text, size, weight, maxW, 2);
  for (let n = 3; n <= max && lines.length && lines[lines.length - 1].endsWith('…') && !String(text).trim().endsWith('…'); n++) lines = wrap(text, size, weight, maxW, n);
  return lines;
}

export function renderSequence(spec: CanvasSpec, size: Size): Scene {
  if (!(spec.actors ?? []).length) return empty(size);
  // Lay out once at the top, then again vertically centred when it is shorter than the stage.
  const first = sequenceAt(spec, size, 16);
  const used = first.bottom + 12 - 16;
  return used < size.height - 40 ? sequenceAt(spec, size, Math.round((size.height - used) / 2.2)).scene : first.scene;
}

function sequenceAt(spec: CanvasSpec, size: Size, top: number): { scene: Scene; bottom: number } {
  const actors = spec.actors ?? [];
  const msgs = (spec.messages ?? []).filter((m) => actors.some((a) => a.id === m.from) && actors.some((a) => a.id === m.to));
  const prims: Prim[] = [];
  const compact = size.width < 560;
  const minCol = compact ? 92 : 150;
  const colW = Math.max(minCol, (size.width - 24) / actors.length);
  const W = Math.max(size.width, colW * actors.length + 24);
  const x0 = (W - colW * actors.length) / 2;
  const ax = new Map(actors.map((a, i) => [a.id, x0 + colW * (i + 0.5)]));
  const aSize = compact ? 12.5 : 15;
  const actorLines = actors.map((a) => wrapFull(a.label, aSize, 650, colW - (compact ? 16 : 22), 4));
  const headH = Math.max(compact ? 50 : 46, Math.max(...actorLines.map((l) => l.length)) * 16 + 18);
  const lifeTop = top + headH;
  const lblSize = compact ? 12.5 : 13.5;
  let y = lifeTop + 34;
  const rowLabelX = (xa: number, xb: number, lines: string[], self: boolean) => {
    const w = Math.max(...lines.map((l) => measure(l, lblSize, 550)));
    if (self) return Math.min(xa + 54, W - 12 - w);
    return Math.max(12 + w / 2, Math.min(W - 12 - w / 2, (xa + xb) / 2));
  };
  const rows = msgs.map((m) => {
    const span = Math.abs(ax.get(m.to)! - ax.get(m.from)!) || colW;
    // Labels may be wider than the arrow (each message has its own row), never wider than the stage.
    const lw = Math.min(W - 24, Math.max(span - 16, compact ? 170 : 220));
    const lines = wrapFull(m.label, lblSize, 550, lw);
    const note = m.note ? wrapFull(m.note, 12, 400, lw, 4) : [];
    const self = m.from === m.to;
    const h = (lines.length - 1) * 16 + (note.length ? 17 + (note.length - 1) * 14 : 0) + (self ? 54 : 46);
    const r = { m, y: y + (lines.length - 1) * 16, lines, note, self };
    y += h;
    return r;
  });
  const bottom = y + 6;
  actors.forEach((a, i) => {
    const x = ax.get(a.id)!;
    const c = spec.highlight === a.id ? P.papaya : tone(a.tone, '#a5a4bb');
    const lines = actorLines[i];
    const w = Math.min(colW - 6, Math.max(...lines.map((l) => measure(l, aSize, 650))) + (compact ? 16 : 30));
    prims.push({ t: 'path', key: `life:${a.id}`, d: `M${r1(x)} ${lifeTop} L${r1(x)} ${r1(bottom)}`, stroke: rgba(c, 0.35), sw: 1.4, dash: '4 6' });
    prims.push({ t: 'rect', key: `act:${a.id}`, x: x - w / 2, y: top, w, h: headH, rx: 14, fill: rgba(c, a.tone && a.tone !== 'neutral' ? 0.14 : 0.06), stroke: rgba(c, 0.6), sw: 1.4, glow: spec.highlight === a.id, delay: i * 60 });
    lines.forEach((l, j) => prims.push({ t: 'text', key: `act:${a.id}:l${j}`, x, y: top + headH / 2 + 5 - (lines.length - 1) * 8 + j * 16, text: l, size: aSize, weight: 650, fill: P.fg, anchor: 'middle', delay: i * 60 }));
  });
  rows.forEach(({ m, y: my, lines, note, self }, i) => {
    const xa = ax.get(m.from)!, xb = ax.get(m.to)!;
    const c = isHi(spec, m.label) ? P.papaya : m.style === 'reply' ? '#8d8ca3' : tone(actors.find((a) => a.id === m.from)?.tone, '#b9b8cc');
    const k = `msg:${i}:${m.from}>${m.to}`;
    const delay = 250 + i * 120;
    const dash = m.style === 'reply' ? '6 5' : undefined;
    if (self) {
      const w = Math.min(46, colW * 0.4);
      prims.push({ t: 'path', key: k, d: `M${r1(xa)} ${r1(my)} L${r1(xa + w)} ${r1(my)} L${r1(xa + w)} ${r1(my + 22)} L${r1(xa + 4)} ${r1(my + 22)}`, stroke: c, sw: 1.8, dash, delay });
      prims.push({ t: 'path', key: `${k}:arrow`, d: arrowHead({ x: xa + 2, y: my + 22 }, -1, 0, 9), fill: c, delay: delay + 150 });
      lines.forEach((l, j) => prims.push({ t: 'text', key: `${k}:l${j}`, x: rowLabelX(xa, xa, lines, true) - 54 + w + 8, y: my + 5 + j * 16 - (lines.length - 1) * 16, text: l, size: lblSize, weight: 550, fill: P.text2, delay }));
      return;
    }
    const dir = xb > xa ? 1 : -1;
    const tip = { x: xb - dir * 3, y: my };
    prims.push({ t: 'path', key: k, d: `M${r1(xa)} ${r1(my)} L${r1(tip.x - dir * 2)} ${r1(my)}`, stroke: c, sw: 1.8, dash, draw: !dash, delay });
    const open = m.style === 'reply' || m.style === 'async';
    if (open) prims.push({ t: 'path', key: `${k}:arrow`, d: `M${r1(tip.x - dir * 9)} ${r1(my - 5.5)} L${r1(tip.x)} ${r1(my)} L${r1(tip.x - dir * 9)} ${r1(my + 5.5)}`, stroke: c, sw: 1.8, cap: 'round', delay: delay + 150 });
    else prims.push({ t: 'path', key: `${k}:arrow`, d: arrowHead(tip, dir, 0, 10), fill: c, delay: delay + 150 });
    prims.push({ t: 'circle', key: `${k}:from`, cx: xa, cy: my, r: 3.2, fill: c, delay });
    const mx = rowLabelX(xa, xb, lines, false);
    lines.forEach((l, j) => prims.push({ t: 'text', key: `${k}:l${j}`, x: mx, y: my - 9 - (lines.length - 1 - j) * 16, text: l, size: lblSize, weight: 550, fill: isHi(spec, m.label) ? '#ffb38f' : P.text2, anchor: 'middle', mono: codeLabel(m.label), delay }));
    note.forEach((nl, j) => prims.push({ t: 'text', key: `${k}:note${j ? j : ''}`, x: mx, y: my + 17 + j * 14, text: nl, size: 12, fill: P.amber, anchor: 'middle', italic: true, delay }));
  });
  // More actors than the stage holds: wider than the stage; the view then scrolls (both ways when also tall).
  return { scene: { w: W, h: Math.max(size.height, bottom + 12), prims, scroll: true, scrollX: W > size.width, minText: lblSize }, bottom };
}

// ------------------------------------------------------------------ custom_svg
let sketchN = 0;
export function renderCustomSvg(spec: CanvasSpec, size: Size): Scene {
  const clean = sanitizeSvg(spec.svg ?? '', `cs${++sketchN}-`);
  if (!clean) return empty(size, 'Skizze nicht darstellbar');
  const [vx, vy, vw, vh] = clean.viewBox;
  const s = Math.min((size.width - 24) / vw, (size.height - 24) / vh);
  const w = vw * s, h = vh * s;
  return { w: size.width, h: size.height, prims: [{ t: 'svg', key: 'sketch', x: (size.width - w) / 2, y: (size.height - h) / 2, w, h, viewBox: `${vx} ${vy} ${vw} ${vh}`, inner: clean.inner }] };
}
