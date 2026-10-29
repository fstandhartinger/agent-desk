// Model-drawn sketches (custom_svg) sometimes let a text run under a badge drawn after it (r7 d03: a reason column
// running under the "entfernt" pills). After mounting, every start-anchored text that runs into a later-painted rect
// starting to its right is fitted to end before that rect: slightly condensed, or cut with an ellipsis. The geometry is
// pure (tested in Node); the DOM pass only measures and applies it.

export interface SketchText { i: number; order: number; x: number; y0: number; y1: number; right: number }
export interface SketchRect { order: number; x: number; y0: number; y1: number; w: number }

/** Max width per text index for the texts that collide with a badge painted later (gap 6 user units). */
export function sketchTextLimits(texts: SketchText[], rects: SketchRect[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of texts) {
    const h = t.y1 - t.y0;
    let limit = Infinity;
    for (const r of rects) {
      if (r.order < t.order) continue; // painted below the text: a row background, not a badge
      if (r.x <= t.x + 4 || r.x >= t.right) continue; // starts left of the text or after its end
      const overlap = Math.min(t.y1, r.y1) - Math.max(t.y0, r.y0);
      if (overlap < h * 0.4) continue;
      limit = Math.min(limit, r.x - 6 - t.x);
    }
    if (limit < Infinity && limit > 16) out.set(t.i, limit);
  }
  return out;
}

/** DOM pass over one mounted sketch <svg>. Idempotent (texts keep their original content in data-full). */
export function fitSketchText(svg: SVGSVGElement): void {
  const all = [...svg.querySelectorAll('*')];
  const order = new Map(all.map((el, i) => [el, i]));
  const textEls = [...svg.querySelectorAll('text')].filter((t) => (t.getAttribute('text-anchor') ?? 'start') === 'start' && !t.querySelector('tspan'));
  const texts: SketchText[] = [];
  textEls.forEach((t, i) => {
    if (t.dataset.full !== undefined) { t.textContent = t.dataset.full; t.removeAttribute('textLength'); t.removeAttribute('lengthAdjust'); }
    const b = t.getBBox();
    if (b.width > 0) texts.push({ i, order: order.get(t)!, x: b.x, y0: b.y, y1: b.y + b.height, right: b.x + b.width });
  });
  const rects: SketchRect[] = [...svg.querySelectorAll('rect')].flatMap((r) => {
    const b = r.getBBox();
    return b.width > 0 && b.height > 0 ? [{ order: order.get(r)!, x: b.x, y0: b.y, y1: b.y + b.height, w: b.width }] : [];
  });
  for (const [i, limit] of sketchTextLimits(texts, rects)) {
    const t = textEls[i];
    const full = t.textContent ?? '';
    t.dataset.full = full;
    const w = t.getComputedTextLength();
    if (w <= limit) continue;
    if (w * 0.85 <= limit) { t.setAttribute('textLength', String(limit)); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); continue; }
    let n = full.length;
    while (n > 1 && t.getComputedTextLength() > limit) t.textContent = `${full.slice(0, --n).trimEnd()}…`;
    if (!t.querySelector('title')) { const tt = document.createElementNS('http://www.w3.org/2000/svg', 'title'); tt.textContent = full; t.appendChild(tt); }
  }
}

// Model sketches also draw right up to (or past) their own frame: r8 d01 had the microphone base 8 units from the
// paper's edge. The view box grows so every content shape keeps a margin; full-bleed backgrounds (and horizon lines)
// do not count and are stretched to the new box, so the paper still fills the frame.
export type VBox = [x: number, y: number, w: number, h: number];
export interface ShapeBox { x: number; y: number; w: number; h: number }

/** Margin (user units) content keeps to the sketch frame: 3 % of the larger side, at least 8. */
export const sketchPad = (vb: VBox) => Math.max(8, 0.03 * Math.max(vb[2], vb[3]));

/** A shape that spans (nearly) the whole frame in one direction is background, not content. */
export const isBackdrop = (b: ShapeBox, vb: VBox) => b.w >= vb[2] * 0.95 || b.h >= vb[3] * 0.95;

/** The view box that keeps every content shape `pad` away from the frame (the original box when it already does). */
export function sketchViewBox(vb: VBox, shapes: ShapeBox[], pad = sketchPad(vb)): VBox {
  const content = shapes.filter((b) => b.w > 0 || b.h > 0).filter((b) => !isBackdrop(b, vb));
  if (!content.length) return vb;
  const x0 = Math.min(vb[0], ...content.map((b) => b.x - pad)), y0 = Math.min(vb[1], ...content.map((b) => b.y - pad));
  const x1 = Math.max(vb[0] + vb[2], ...content.map((b) => b.x + b.w + pad)), y1 = Math.max(vb[1] + vb[3], ...content.map((b) => b.y + b.h + pad));
  if (x0 >= vb[0] - 0.5 && y0 >= vb[1] - 0.5 && x1 <= vb[0] + vb[2] + 0.5 && y1 <= vb[1] + vb[3] + 0.5) return vb;
  // Grow symmetrically on each axis that needs it, so the drawing stays centred in its frame.
  const gx = Math.max(vb[0] - x0, x1 - vb[0] - vb[2], 0), gy = Math.max(vb[1] - y0, y1 - vb[1] - vb[3], 0);
  return [vb[0] - gx, vb[1] - gy, vb[2] + 2 * gx, vb[3] + 2 * gy];
}

const SHAPES = 'rect, circle, ellipse, line, polyline, polygon, path, text, image, use';

/** DOM pass: pads one mounted sketch <svg> (idempotent: the model's box is kept in data-vb). */
export function padSketch(svg: SVGSVGElement): void {
  const orig = (svg.dataset.vb ?? svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number) as VBox;
  if (orig.length !== 4 || orig.some((n) => !Number.isFinite(n)) || orig[2] <= 0 || orig[3] <= 0) return;
  svg.dataset.vb = orig.join(' ');
  const els = [...svg.querySelectorAll<SVGGraphicsElement>(SHAPES)].filter((el) => !el.closest('defs, clipPath, mask, pattern, marker, symbol'));
  // Boxes in the sketch's own user units (an element's transform and its groups' transforms included).
  const root = svg.getScreenCTM()?.inverse();
  const boxes = els.map((el) => {
    const b = el.getBBox();
    const m = root && el.getScreenCTM() ? root.multiply(el.getScreenCTM()!) : null;
    if (!m) return { el, b: { x: b.x, y: b.y, w: b.width, h: b.height } };
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(([x, y]) => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { el, b: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
  });
  const vb = sketchViewBox(orig, boxes.map((x) => x.b));
  if (vb === orig) return;
  svg.setAttribute('viewBox', vb.join(' '));
  // Full-bleed background rects follow the frame (the paper fills the padded box too).
  for (const { el, b } of boxes) {
    if (el.tagName.toLowerCase() !== 'rect' || b.w < orig[2] * 0.95 || b.h < orig[3] * 0.95 || el.getAttribute('transform')) continue;
    if (el.dataset.box === undefined) el.dataset.box = [el.getAttribute('x'), el.getAttribute('y'), el.getAttribute('width'), el.getAttribute('height')].join(' ');
    el.setAttribute('x', String(vb[0])); el.setAttribute('y', String(vb[1])); el.setAttribute('width', String(vb[2])); el.setAttribute('height', String(vb[3]));
  }
}
