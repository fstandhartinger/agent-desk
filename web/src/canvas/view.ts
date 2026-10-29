// The canvas viewport: which part of a scene the stage shows (an SVG viewBox in scene units). Pure, so the fit and the
// zoom/pan maths are testable in Node. The default ("auto") view fits the whole scene into the stage; only when that
// would make the essential type smaller than MIN_TEXT_PX does a long list or wide table fit one axis and pan the other.
import type { Scene } from './render/scene';

export type VB = [x: number, y: number, w: number, h: number];
export interface Box { w: number; h: number }

/** Smallest on-screen size (CSS px) for labels and values when the auto view can keep it. */
export const MIN_TEXT_PX = 11;
/** Essential type size of renderers that do not report one (chart labels are 13–14 px). */
const DEFAULT_TEXT = 13;
export const MAX_ZOOM = 4;

/** Below this the whole-scene fit is unreadable for anything: then even a chart fits its width and pans vertically. */
export const ILLEGIBLE_PX = 8;

/** Diagrams (flow/architecture): smallest on-screen node-label size of the whole-scene fit. Below it the diagram fits
 *  its width and scrolls vertically (and the side column offers "Groß ansehen"). Phones (stage < 600 px) need more. */
export const LEGIBLE_PX = 9;
export const LEGIBLE_PX_PHONE = 10;
/** Label size a diagram that scrolls (fitted to the width) is never enlarged beyond. */
export const FIT_W_MAX_PX = 15;
export const legiblePx = (box: Box) => (box.w < 600 ? LEGIBLE_PX_PHONE : LEGIBLE_PX);
/** Desktop stages (≥ 600 px): a diagram whose WHOLE fit keeps its labels at least this size is shown whole (an
 *  overview at a glance, "Groß ansehen" offers more) instead of fitted to the width with vertical scrolling. */
export const OVERVIEW_PX = 8;
/** "Alles zeigen" never shrinks the essential type below this: a bigger whole shows the best overview at this size. */
export const FIT_MIN_PX = 6;
/** The size from which a diagram's whole fit is used as the auto view. */
const wholePx = (box: Box) => (box.w < 600 ? LEGIBLE_PX_PHONE : OVERVIEW_PX);

export interface AutoView { vb: VB; scale: number; pan: 'none' | 'x' | 'y' | 'xy' }
export interface FitInput { w: number; h: number; minText?: number; scroll?: boolean; scrollX?: boolean }

/** The scale (and pan axis) of the auto view. Whole scene when that keeps the type readable; long lists / wide tables
 *  fit one axis once the whole fit drops below MIN_TEXT_PX; diagrams fit their width once the whole fit drops below
 *  LEGIBLE_PX (when that is larger); anything else only once it drops below ILLEGIBLE_PX and fitting the width is
 *  clearly (≥ 1.3×) larger. Only a table that is both too wide and too tall scrolls in two directions. */
export function pickScale(scene: FitInput, box: Box, graph: boolean): { scale: number; pan: AutoView['pan'] } {
  const maxScale = graph ? 1.3 : 1;
  const mw = graph ? 40 : 0, mh = graph ? 32 : 0;
  const sw = Math.max(1, scene.w), sh = Math.max(1, scene.h);
  const all = Math.min((box.w - mw) / sw, (box.h - mh) / sh, maxScale);
  const text = scene.minText ?? DEFAULT_TEXT;
  const readable = MIN_TEXT_PX / text;
  const byW = Math.min((box.w - mw) / sw, maxScale), byH = Math.min((box.h - mh) / sh, maxScale);
  if (graph) {
    if (all * text >= wholePx(box) - 1e-6 || byW <= all * 1.02) return { scale: all, pan: 'none' };
    // Fitted to the width, but not blown up: past ~15 px labels more size only means more scrolling.
    return { scale: Math.max(all, Math.min(byW, FIT_W_MAX_PX / text)), pan: 'y' };
  }
  if (all >= readable - 1e-6) return { scale: all, pan: 'none' };
  // A table too wide AND too tall: readable type and scrolling both ways (native scroll, like a spreadsheet).
  if (scene.scrollX && scene.scroll && byH < readable - 1e-6 && byW < readable - 1e-6) return { scale: readable, pan: 'xy' };
  if (scene.scrollX && byH > all) return { scale: Math.min(byH, readable), pan: 'x' };
  if (scene.scroll && byW > all) return { scale: Math.min(byW, readable), pan: 'y' };
  if (!scene.scrollX && all * text < ILLEGIBLE_PX && byW >= all * 1.3) return { scale: Math.min(byW, readable), pan: 'y' };
  return { scale: all, pan: 'none' };
}

/** Height of the controls strip under the viewport (`.cv-controls`): the zoom pill lives there, never on the drawing. */
export const CONTROLS_H = 44;
/** Phones: the strip folds away after this long without interaction (a tap on the canvas brings it back), so the drawing
 *  gets its 44 px back and nothing ever sits beside or under the zoom pill. */
export const CONTROLS_IDLE_MS = 2000;
/** Whether the strip may fold away: phone-width stages only, and never while the user has zoomed or panned (folding
 *  changes the stage size, which would reset that view). */
export const controlsAutoHide = (stageW: number, customView: boolean) => stageW > 0 && stageW < 600 && !customView;

/** Diagrams keep a margin to the frame and may grow up to 1.3×; charts are laid out for the stage and never grow. */
export function autoView(scene: Scene, box: Box, graph: boolean): AutoView {
  const { scale, pan } = pickScale(scene, box, graph);
  const sw = Math.max(1, scene.w), sh = Math.max(1, scene.h);
  const vw = box.w / scale, vh = box.h / scale;
  // Panned scenes start at their beginning (top / left edge with a small margin), everything else is centred.
  const x = (pan === 'x' || pan === 'xy') && sw > vw ? -8 / scale : (sw - vw) / 2;
  const y = (pan === 'y' || pan === 'xy') && sh > vh ? -12 / scale : (sh - vh) / 2;
  return { vb: [x, y, vw, vh], scale, pan };
}

/** The whole scene, centred (the "Alles zeigen" view when the auto view pans). When the whole would put the essential
 *  type below FIT_MIN_PX, the best overview at that size instead: as much as fits, from the top-left (centred on any
 *  axis that does fit); `clamped` tells the UI to say so. */
export function wholeView(scene: Pick<Scene, 'w' | 'h' | 'minText'> & { prims?: Scene['prims'] }, box: Box, graph: boolean): VB & { clamped?: boolean } {
  const mw = graph ? 40 : 0, mh = graph ? 32 : 0;
  const sw = Math.max(1, scene.w), sh = Math.max(1, scene.h);
  const fit = Math.min((box.w - mw) / sw, (box.h - mh) / sh, graph ? 1.3 : 1);
  // The floor holds for every text of the scene (details, edge labels, legends), not only the essential labels.
  const sizes = (scene.prims ?? []).flatMap((p) => (p.t === 'text' ? [p.size] : []));
  const floor = FIT_MIN_PX / Math.min(scene.minText ?? DEFAULT_TEXT, ...sizes);
  const s = Math.max(fit, floor);
  const vw = box.w / s, vh = box.h / s;
  const vb = [vw >= sw ? (sw - vw) / 2 : -(mw / 2) / s, vh >= sh ? (sh - vh) / 2 : -(mh / 2) / s, vw, vh] as VB & { clamped?: boolean };
  if (s > fit + 1e-9) vb.clamped = true;
  return vb;
}

/** The side column / phone offers "Groß ansehen" when its auto view does not show the drawing whole (it scrolls), its
 *  essential type ends up below the legible size, or the drawing is an abridged overview (details left out). */
export function wantsBig(auto: AutoView, scene: Pick<Scene, 'minText' | 'abridged'>, box: Box): boolean {
  return auto.pan !== 'none' || !!scene.abridged || auto.scale * (scene.minText ?? DEFAULT_TEXT) < legiblePx(box) - 1e-6;
}

/** Scroll mode: the svg's full size, the view box for it and the scroll axis. */
export interface ScrollMode { axis: 'x' | 'y' | 'xy'; vb: VB; box: Box }

/** The auto view as native scrolling: when the auto view pans (tall diagram fitted to the width, long list, wide
 *  table), the svg gets the content's full size and the viewport scrolls it like a page (touch swipe, wheel, mouse
 *  drag, scrollbar-free with a fade at the open edge). Pure, so it is tested in Node. */
export function scrollMode(auto: AutoView, scene: Scene, box: Box): ScrollMode | null {
  if (auto.pan === 'none') return null;
  const s = auto.scale;
  const tall = auto.pan === 'y' || auto.pan === 'xy', wide = auto.pan === 'x' || auto.pan === 'xy';
  const h = tall ? Math.max(box.h, Math.ceil((scene.h - auto.vb[1]) * s + 16)) : box.h;
  const w = wide ? Math.max(box.w, Math.ceil((scene.w - auto.vb[0]) * s + 12)) : box.w;
  return { axis: auto.pan, vb: [auto.vb[0], auto.vb[1], w / s, h / s], box: { w, h } };
}

/** Where scroll-mode content continues past the viewport: a fade on that edge, and on the right a "mehr Spalten →"
 *  hint (r8: phone tables hid their last column with no affordance). Both axes for 'xy'. */
export interface ScrollMetrics { scrollLeft: number; clientWidth: number; scrollWidth: number; scrollTop: number; clientHeight: number; scrollHeight: number }
export function scrollEdges(m: ScrollMetrics, axis: ScrollMode['axis'] | null): { x: boolean; y: boolean } {
  if (!axis) return { x: false, y: false };
  return {
    x: axis !== 'y' && m.scrollLeft + m.clientWidth < m.scrollWidth - 4,
    y: axis !== 'x' && m.scrollTop + m.clientHeight < m.scrollHeight - 4,
  };
}

export const scaleOf = (vb: VB, box: Box) => box.w / vb[2];

/** Keeps the zoom between half the auto scale and MAX_ZOOM× it, and the view centre over the scene (no losing it). */
export function clampView(vb: VB, scene: Scene, box: Box, auto: number): VB {
  const s = Math.min(Math.max(scaleOf(vb, box), auto * 0.5), Math.max(auto * MAX_ZOOM, 2));
  const w = box.w / s, h = box.h / s;
  const cx = Math.min(Math.max(vb[0] + vb[2] / 2, 0), scene.w);
  const cy = Math.min(Math.max(vb[1] + vb[3] / 2, 0), scene.h);
  return [cx - w / 2, cy - h / 2, w, h];
}

/** Zoom by `factor` around the stage point (px, py): the scene point under the pointer stays under it. */
export function zoomAt(vb: VB, factor: number, px: number, py: number, box: Box, scene: Scene, auto: number): VB {
  const fx = px / box.w, fy = py / box.h;
  const sx = vb[0] + fx * vb[2], sy = vb[1] + fy * vb[3];
  const w = vb[2] / factor, h = vb[3] / factor;
  const next = clampView([sx - fx * w, sy - fy * h, w, h], scene, box, auto);
  // When the zoom limit kicked in, keep the pointer anchor for the clamped size too.
  const cw = next[2], ch = next[3];
  return clampView([sx - fx * cw, sy - fy * ch, cw, ch], scene, box, auto);
}

/** Pan by a stage-pixel delta (drag right = content moves right). */
export function panBy(vb: VB, dx: number, dy: number, box: Box, scene: Scene, auto: number): VB {
  const k = vb[2] / box.w;
  return clampView([vb[0] - dx * k, vb[1] - dy * k, vb[2], vb[3]], scene, box, auto);
}

/** True when the view does not show the whole scene (then dragging and wheel scrolling pan it). */
export function canPan(vb: VB, scene: Scene): boolean {
  return vb[0] > 0.5 || vb[1] > 0.5 || vb[0] + vb[2] < scene.w - 0.5 || vb[1] + vb[3] < scene.h - 0.5;
}
