// The "few words, big type" forms of the canvas (CANVAS.md "Web forms"): points (a short numbered / bulleted list of core
// points), stat (1-3 headline numbers) and the stacked bar (ONE segmented bar = the parts of one whole). Pure like every
// renderer (spec + size → Scene in CSS px of the stage), phone first: the smallest essential text is ≥ 15 px at 360 px wide,
// list labels ≥ 22 px (phone) / ≥ 28 px (desktop), the headline number ≥ 48 px. Text is never in a series colour.
import type { CanvasSpec, CanvasStat } from '../types';
import { fmtNumber, fmtPercent, fmtValue } from '../format';
import { CATEGORICAL_DARK, ellipsize, measure, PALETTE as P, r1, tone, wrap, type Prim, type Scene, type Size } from './scene';
import { onColor, REST_COLOR } from './palette';
import { empty, isHi } from './charts';

const num = (n: number) => Math.round(n * 100) / 100;
const STAGGER = 120;

// ------------------------------------------------------------------ points
export interface PointsOpts {
  /** How many leading rows are visible; later rows keep their place at opacity 0 (no reflow when they appear). Default: all. */
  revealed?: number;
}

/** Row geometry for one label size (pure; also used by tests). */
interface PointRow { label: string[]; note: string[]; h: number }

export function renderPoints(spec: CanvasSpec, size: Size, opts: PointsOpts = {}): Scene {
  const pts = (spec.points ?? []).filter((p) => p && String(p.label ?? '').trim()).slice(0, 8);
  if (!pts.length) return empty(size);
  const n = pts.length;
  const W = size.width, H = size.height;
  const numbered = spec.style !== 'bullets';
  const phone = W < 480, wide = W >= 720;
  const revealed = Math.max(0, Math.min(n, Math.floor(opts.revealed ?? n)));
  const padX = phone ? 20 : wide ? Math.max(40, Math.round(W * 0.07)) : 32;
  const padY = phone ? 16 : 24;
  // The list is the slide: few rows get big type, 8 rows (detail view) get the smaller floor.
  const dense = n > 5;
  const minL = (wide ? 28 : phone ? 22 : 24) - (dense ? 4 : 0);
  const maxL = wide ? (n <= 3 ? 44 : n === 4 ? 40 : 36) : phone ? (n <= 3 ? 32 : n === 4 ? 30 : 28) : n <= 3 ? 34 : 30;
  const noteMin = phone ? 15 : 17;
  const gapMin = phone ? 10 : 14;
  const avail = H - padY * 2;

  const build = (s: number) => {
    const d = numbered ? Math.round(s * 1.7) : 0;
    const textX = numbered ? d + (phone ? 16 : 22) : 8 + (phone ? 14 : 18);
    const maxW = Math.max(120, Math.min(W - padX * 2 - textX, wide ? 780 : 9999));
    const lineH = Math.round(s * 1.22);
    const noteS = Math.max(noteMin, Math.round(s * 0.62));
    const noteH = Math.round(noteS * 1.3);
    const rows: PointRow[] = pts.map((p) => {
      const label = wrap(String(p.label).trim(), s, 650, maxW, 2);
      const note = p.note && String(p.note).trim() ? wrap(String(p.note).trim(), noteS, 450, maxW, 2) : [];
      const text = label.length * lineH + (note.length ? 4 + note.length * noteH : 0);
      return { label, note, h: Math.max(d, text) };
    });
    const sum = rows.reduce((a, r) => a + r.h, 0);
    return { s, d, textX, maxW, lineH, noteS, noteH, rows, sum };
  };
  let L = build(maxL);
  for (let s = maxL; s >= minL; s--) {
    L = build(s);
    if (L.sum + (n - 1) * gapMin <= avail) break;
  }
  const needed = L.sum + (n - 1) * gapMin + padY * 2;
  const scroll = needed > H + 0.5;
  const sceneH = scroll ? Math.ceil(needed) : H;
  // few rows breathe more (a slide with two points is mostly air); 4-5 rows are limited by the stage anyway
  const gap = n > 1 ? Math.max(gapMin, Math.min(L.s * (n <= 4 ? 1.9 : 1.5), (sceneH - padY * 2 - L.sum) / (n - 1))) : 0;
  const blockH = L.sum + (n - 1) * gap;
  let y = Math.max(padY, (sceneH - blockH) / 2);

  // Wide stages centre the block horizontally (text stays left aligned inside it); phones use the full width.
  const widest = Math.max(...L.rows.map((r) => Math.max(...r.label.map((l) => measure(l, L.s, 650)), ...r.note.map((l) => measure(l, L.noteS, 450)))));
  const blockW = L.textX + widest;
  const x0 = phone ? padX : Math.max(padX, Math.round((W - blockW) / 2));

  const prims: Prim[] = [];
  const numS = Math.round(L.s * 0.9);
  pts.forEach((p, i) => {
    const row = L.rows[i];
    const hi = isHi(spec, String(p.label));
    const t = p.tone && p.tone !== 'neutral' ? tone(p.tone) : undefined;
    const accent = hi ? P.papaya : t ?? P.violet;
    const visible = i < revealed;
    const k = `pt-${i}-`;
    const base = { delay: i * STAGGER, ...(visible ? {} : { opacity: 0 }) };
    const textTop = y + (row.h - (row.label.length * L.lineH + (row.note.length ? 4 + row.note.length * L.noteH : 0))) / 2;
    if (numbered) {
      const cy = y + row.h / 2;
      prims.push({ t: 'circle', key: `${k}disc`, cx: x0 + L.d / 2, cy, r: L.d / 2, fill: accent, glow: hi && visible, ...base });
      prims.push({ t: 'text', key: `${k}num`, x: x0 + L.d / 2, y: cy + numS * 0.35, text: String(i + 1), size: numS, weight: 700, fill: onColor(accent), anchor: 'middle', ...base });
    } else {
      prims.push({ t: 'circle', key: `${k}dot`, cx: x0 + 4, cy: textTop + L.lineH / 2, r: 4, fill: accent, glow: hi && visible, ...base });
    }
    row.label.forEach((line, j) => {
      prims.push({ t: 'text', key: `${k}l${j}`, x: x0 + L.textX, y: textTop + j * L.lineH + L.lineH / 2 + L.s * 0.35, text: line, size: L.s, weight: 650, fill: P.fg, title: j === 0 && row.label.length > 1 ? String(p.label) : undefined, ...base });
    });
    const noteTop = textTop + row.label.length * L.lineH + 4;
    row.note.forEach((line, j) => {
      prims.push({ t: 'text', key: `${k}n${j}`, x: x0 + L.textX, y: noteTop + j * L.noteH + L.noteH / 2 + L.noteS * 0.35, text: line, size: L.noteS, weight: 450, fill: P.dim, ...base });
    });
    y += row.h + gap;
  });
  return { w: W, h: sceneH, prims, minText: Math.min(L.s, L.noteS, numbered ? numS : L.s), ...(scroll ? { scroll: true } : {}) };
}

// ------------------------------------------------------------------ stat
const statText = (v: CanvasStat['value']): { text: string; value?: number; format?: (x: number) => string } => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const format = Number.isInteger(v) ? (x: number) => fmtNumber(Math.round(x)) : (x: number) => fmtNumber(x);
    return { text: format(v), value: v, format };
  }
  return { text: String(v ?? '').trim() || '–' };
};

/** Largest size ≤ max (down to `floor`) at which `text` fits `maxW`. */
function fitSize(text: string, weight: number, maxW: number, max: number, floor: number): number {
  let s = max;
  while (s > floor && measure(text, s, weight) > maxW) s -= 2;
  return Math.max(floor, s);
}

export function renderStat(spec: CanvasSpec, size: Size): Scene {
  const stats = (spec.stats ?? []).filter((s) => s && s.value !== undefined && s.value !== null).slice(0, 3);
  if (!stats.length) return empty(size);
  const n = stats.length;
  const W = size.width, H = size.height;
  const phone = W < 480;
  const padX = phone ? 20 : 40, padY = phone ? 16 : 24;
  const stacked = phone && n > 1; // KPI row: side by side on desktop, stacked on phones
  const labelS = phone ? 20 : 26;
  const unitS = phone ? 22 : 28;
  const gap = phone ? 12 : 24;
  const cardW = stacked || n === 1 ? W - padX * 2 : (W - padX * 2 - gap * (n - 1)) / n;
  const cardH = stacked ? (H - padY * 2 - gap * (n - 1)) / n : H - padY * 2;
  const card = n > 1;
  const inner = cardW - (card ? 32 : 0);
  const vMax = n === 1 ? (phone ? 96 : Math.min(160, H * 0.34)) : stacked ? Math.min(64, cardH * 0.42) : Math.min(96, cardW * 0.3, H * 0.3);
  const prims: Prim[] = [];
  let minText = labelS;
  stats.forEach((st, i) => {
    const k = `st-${i}-`;
    const hi = isHi(spec, String(st.label ?? ''));
    const t = st.tone && st.tone !== 'neutral' ? tone(st.tone) : undefined;
    const accent = hi ? P.papaya : t ?? P.violet;
    const x = stacked || n === 1 ? padX : padX + i * (cardW + gap);
    const y = stacked ? padY + i * (cardH + gap) : padY;
    const cx = x + cardW / 2;
    const v = statText(st.value);
    const unit = String(st.unit ?? '').trim();
    // Number and unit on one line when both fit at ≥ 72 % of the maximum size; else the unit sits under the number.
    let vs = fitSize(v.text, 700, inner, vMax, 40);
    let inline = false;
    if (unit) {
      const floor = Math.max(48, vMax * 0.72);
      for (let s = vMax; s >= Math.min(floor, vMax); s -= 2) {
        const us = Math.max(unitS, Math.round(s * 0.34));
        if (measure(v.text, s, 700) + 12 + measure(unit, us, 600) <= inner) { vs = s; inline = true; break; }
      }
      if (!inline) vs = fitSize(v.text, 700, inner, vMax, 40);
    }
    const us = inline ? Math.max(unitS, Math.round(vs * 0.34)) : unitS;
    const labelLines = st.label ? wrap(String(st.label), labelS, 500, inner, 2) : [];
    const labelH = labelLines.length * Math.round(labelS * 1.3);
    const unitRow = unit && !inline ? Math.round(unitS * 1.3) + 4 : 0;
    const blockH = 6 + 18 + Math.round(vs * 0.74) + unitRow + (labelLines.length ? 14 + labelH : 0);
    const top = y + Math.max(card ? 16 : 0, (cardH - blockH) / 2);
    const delay = i * STAGGER;
    if (card) prims.push({ t: 'rect', key: `${k}card`, x: num(x), y: num(y), w: num(cardW), h: num(cardH), rx: 18, fill: 'rgba(255,255,255,0.03)', stroke: 'rgba(255,255,255,0.08)', sw: 1, delay });
    prims.push({ t: 'rect', key: `${k}bar`, x: num(cx - 28), y: num(top), w: 56, h: 6, rx: 3, fill: accent, delay });
    const base = top + 6 + 18 + Math.round(vs * 0.74);
    if (inline) {
      const total = measure(v.text, vs, 700) + 12 + measure(unit, us, 600);
      const left = cx - total / 2;
      const nw = measure(v.text, vs, 700);
      prims.push({ t: 'text', key: `${k}v`, x: num(left + nw), y: num(base), text: v.text, size: vs, weight: 700, fill: P.fg, anchor: 'end', ...(v.format ? { num: { value: v.value!, format: v.format } } : {}), delay });
      prims.push({ t: 'text', key: `${k}u`, x: num(left + nw + 12), y: num(base), text: unit, size: us, weight: 600, fill: P.text2, delay });
    } else {
      prims.push({ t: 'text', key: `${k}v`, x: num(cx), y: num(base), text: v.text, size: vs, weight: 700, fill: P.fg, anchor: 'middle', ...(v.format ? { num: { value: v.value!, format: v.format } } : {}), delay });
      if (unit) prims.push({ t: 'text', key: `${k}u`, x: num(cx), y: num(base + 4 + Math.round(unitS * 1.05)), text: ellipsize(unit, unitS, 600, inner), size: unitS, weight: 600, fill: P.text2, anchor: 'middle', delay });
    }
    const labelTop = base + unitRow + 14;
    labelLines.forEach((line, j) => {
      prims.push({ t: 'text', key: `${k}l${j}`, x: num(cx), y: num(labelTop + j * Math.round(labelS * 1.3) + Math.round(labelS * 0.95)), text: line, size: labelS, weight: 500, fill: P.dim, anchor: 'middle', delay });
    });
    minText = Math.min(minText, vs, labelLines.length ? labelS : 99, unit ? us : 99);
  });
  return { w: W, h: H, prims, minText };
}

// ------------------------------------------------------------------ stacked bar
export interface StackedPart { label: string; value: number; share: number; color: string; folded?: boolean }

/** The parts of the whole in item order, slot colours fixed by position; more than six parts fold the smallest into "Sonstige". */
export function stackedParts(spec: CanvasSpec): { parts: StackedPart[]; total: number } {
  let items = (spec.items ?? []).filter((it) => it && Number.isFinite(it.value) && it.value >= 0).map((it) => ({ label: String(it.label), value: it.value, folded: false }));
  if (items.length > 6) {
    // keep the five largest in their given order, fold the others
    const keep = new Set(items.map((it, i) => ({ i, v: it.value })).sort((a, b) => b.v - a.v || a.i - b.i).slice(0, 5).map((x) => x.i));
    const rest = items.filter((_, i) => !keep.has(i));
    items = [...items.filter((_, i) => keep.has(i)), { label: 'Sonstige', value: rest.reduce((a, it) => a + it.value, 0), folded: true }];
  }
  const total = items.reduce((a, it) => a + it.value, 0);
  const parts = items.map((it, i) => ({ label: it.label, value: it.value, share: total ? it.value / total : 0, color: it.folded ? REST_COLOR : CATEGORICAL_DARK[i % CATEGORICAL_DARK.length], ...(it.folded ? { folded: true } : {}) }));
  return { parts, total };
}

/** Closed rounded-rectangle path with its own radius per corner (all segments share one command structure, so they tween). */
function cornerPath(x: number, y: number, w: number, h: number, tl: number, tr: number, br: number, bl: number): string {
  return `M${r1(x + tl)} ${r1(y)} L${r1(x + w - tr)} ${r1(y)} A${tr} ${tr} 0 0 1 ${r1(x + w)} ${r1(y + tr)} L${r1(x + w)} ${r1(y + h - br)} A${br} ${br} 0 0 1 ${r1(x + w - br)} ${r1(y + h)} L${r1(x + bl)} ${r1(y + h)} A${bl} ${bl} 0 0 1 ${r1(x)} ${r1(y + h - bl)} L${r1(x)} ${r1(y + tl)} A${tl} ${tl} 0 0 1 ${r1(x + tl)} ${r1(y)} Z`;
}

export function renderStackedBar(spec: CanvasSpec, size: Size): Scene {
  const { parts, total } = stackedParts(spec);
  if (!parts.length || !total) return empty(size);
  const unit = spec.unit;
  const W = size.width, H = size.height;
  const phone = W < 480;
  const padX = phone ? 20 : Math.max(40, Math.round(W * 0.06));
  const padY = phone ? 16 : 24;
  const contentW = Math.min(W - padX * 2, 880);
  const x0 = Math.round((W - contentW) / 2);
  const barH = phone ? 56 : 72;
  const nameS = phone ? 17 : 19, valueS = phone ? 17 : 19, pctS = phone ? 16 : 18;
  const rowH = phone ? 36 : 40;
  const gapBL = phone ? 24 : 32;
  const need = barH + gapBL + parts.length * rowH;
  const scroll = need + padY * 2 > H;
  const sceneH = scroll ? Math.ceil(need + padY * 2) : H;
  let y = Math.max(padY, (sceneH - need) / 2);
  const prims: Prim[] = [];

  // Segments: a 2 px surface gap between neighbours, 4 px rounded outer ends; zero parts take no width.
  const live = parts.map((p, i) => ({ p, i })).filter(({ p }) => p.value > 0);
  const room = contentW - 2 * (live.length - 1);
  let x = x0;
  const segs = live.map(({ p, i }, j) => {
    const w = Math.max(2, p.share * room);
    const s = { p, i, x, w, first: j === 0, last: j === live.length - 1 };
    x += w + 2;
    return s;
  });
  const draw = (s: (typeof segs)[number], hi: boolean) => {
    const r = (on: boolean) => (on ? Math.min(4, s.w / 2, barH / 2) : 0);
    const d = cornerPath(s.x, y, s.w, barH, r(s.first), r(s.last), r(s.last), r(s.first));
    prims.push({ t: 'path', key: `sb-${s.i}-seg`, d, fill: s.p.color, ...(hi ? { stroke: P.fg, sw: 2 } : {}), title: `${s.p.label}: ${fmtValue(s.p.value, unit)} (${fmtPercent(s.p.share)})`, delay: s.i * 90 });
    const pct = fmtPercent(s.p.share);
    if (measure(pct, pctS, 700) + 12 <= s.w) prims.push({ t: 'text', key: `sb-${s.i}-pct`, x: num(s.x + s.w / 2), y: num(y + barH / 2 + pctS * 0.35), text: pct, size: pctS, weight: 700, fill: onColor(s.p.color), anchor: 'middle', delay: 250 + s.i * 90 });
  };
  for (const s of segs) if (!isHi(spec, s.p.label)) draw(s, false);
  for (const s of segs) if (isHi(spec, s.p.label)) draw(s, true); // painted last: its outline is not covered by neighbours

  // Legend: swatch + name + value, one row per part (zero parts keep their row).
  y += barH + gapBL;
  const valueTexts = parts.map((p) => fmtValue(p.value, unit));
  const valueW = Math.max(...valueTexts.map((t) => measure(t, valueS, 650))) + 2;
  const nameW = Math.min(contentW - 26 - 20 - valueW, Math.max(...parts.map((p) => measure(p.label, nameS, 600))) + 4);
  parts.forEach((p, i) => {
    const k = `sb-${i}-`;
    const cy = y + rowH / 2;
    const hi = isHi(spec, p.label);
    const delay = 300 + i * 70;
    prims.push({ t: 'rect', key: `${k}sw`, x: x0, y: num(cy - 8), w: 16, h: 16, rx: 4, fill: p.color, ...(hi ? { stroke: P.fg, sw: 2 } : {}), delay });
    prims.push({ t: 'text', key: `${k}l`, x: x0 + 26, y: num(cy + nameS * 0.35), text: ellipsize(p.label, nameS, 600, nameW), size: nameS, weight: 600, fill: P.fg, delay });
    prims.push({ t: 'text', key: `${k}v`, x: num(x0 + 26 + nameW + 20 + valueW), y: num(cy + valueS * 0.35), text: valueTexts[i], size: valueS, weight: 650, fill: P.fg, anchor: 'end', num: { value: p.value, format: (v) => fmtValue(v, unit) }, delay });
    y += rowH;
  });
  return { w: W, h: sceneH, prims, minText: Math.min(nameS, valueS, pctS), ...(scroll ? { scroll: true } : {}) };
}
