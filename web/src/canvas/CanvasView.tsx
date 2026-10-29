// The generative canvas frame: header (kind, title, by-badge, PNG/JSON), caption, the animated visual, source
// footnotes and the history strip. Presentational: it renders a CanvasState (bus or demo) and reports selections.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import {
  ArrowRightLeft, Boxes, CalendarRange, ChevronRight, ChartBar, ChartLine, ChartPie, Check, Copy, ImageDown, ListTree, Maximize2, Minimize2, Minus, PenTool, Plus, Scan, Table2, TriangleAlert, Waypoints, Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { CanvasKind, CanvasSpec } from './types';
import { KIND_LABEL } from './types';
import type { CanvasEntry, CanvasState } from './bus';
import { renderScene } from './render';
import { resetMeasure, type Scene } from './render/scene';
import { byLabel, footnote } from './sources';
import { detailLabel, hasDetail, variantSpec } from './detail';
import Stage from './Stage';
import { autoView, canPan, controlsAutoHide, panBy, scaleOf, scrollEdges, scrollMode, wantsBig, wholeView, zoomAt, CONTROLS_IDLE_MS, type VB } from './view';
import { useSize } from '../viz/hooks';
import './canvas.css';

export const KIND_ICON: Record<CanvasKind, LucideIcon> = {
  flow: Workflow, architecture: Boxes, sequence: ArrowRightLeft, pie: ChartPie, bar: ChartBar, line: ChartLine,
  table: Table2, timeline: CalendarRange, sankey: Waypoints, custom_svg: PenTool,
};

/** Bumps when the web font has loaded, so text measured with fallback metrics is laid out again. */
function useFontsReady(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    void document.fonts.ready.then(() => { if (alive) { resetMeasure(); setV((x) => x + 1); } });
    return () => { alive = false; };
  }, []);
  return v;
}

/** Scene for spec at the stage size; keeps the previous scene on screen until the new layout is ready (no flash). */
function useScene(spec: CanvasSpec | undefined, width: number, height: number): { scene: Scene | null; forId: string | null } {
  const [out, setOut] = useState<{ scene: Scene | null; forId: string | null }>({ scene: null, forId: null });
  const fonts = useFontsReady();
  const seq = useRef(0);
  useEffect(() => {
    if (!spec || width < 40 || height < 40) return;
    const n = ++seq.current;
    const run = () => renderScene(spec, { width, height }).then(
      (scene) => { if (n === seq.current) setOut({ scene, forId: spec.id }); },
      () => { if (n === seq.current) setOut({ scene: null, forId: spec.id }); },
    );
    // Resizes settle first; a new spec renders at once.
    const t = window.setTimeout(run, out.forId === spec.id && out.scene ? 90 : 0);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, width, height, fonts]);
  return out;
}

function PendingSketch() {
  // A calm sketch drawing itself: three boxes, two connectors, a soft sweep. No text loop, no spinner.
  return (
    <svg className="cv-pending" viewBox="0 0 360 140" aria-hidden="true">
      <rect className="cv-p cv-p1" x="10" y="44" width="92" height="52" rx="14" pathLength="1" />
      <path className="cv-p cv-p2" d="M106 70 H150" pathLength="1" />
      <rect className="cv-p cv-p3" x="154" y="44" width="92" height="52" rx="14" pathLength="1" />
      <path className="cv-p cv-p4" d="M250 70 H294" pathLength="1" />
      <circle className="cv-p cv-p5" cx="322" cy="70" r="26" pathLength="1" />
    </svg>
  );
}

function Empty() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <svg viewBox="0 0 220 90" className="mb-5 w-[200px] opacity-80" aria-hidden="true">
        <rect x="6" y="28" width="58" height="34" rx="10" fill="rgba(139,92,246,0.12)" stroke="rgba(139,92,246,0.55)" />
        <path d="M66 45 H96" stroke="#5b5a6e" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="122" cy="45" r="22" fill="none" stroke="#63D297" strokeWidth="9" strokeDasharray="88 50" transform="rotate(-90 122 45)" opacity="0.85" />
        <path d="M148 45 H170" stroke="#5b5a6e" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="172" y="30" width="10" height="30" rx="3" fill="#FA5D19" opacity="0.85" />
        <rect x="188" y="40" width="10" height="20" rx="3" fill="#F59E0B" opacity="0.7" />
        <rect x="204" y="22" width="10" height="38" rx="3" fill="#8B5CF6" opacity="0.8" />
      </svg>
      <p className="text-[17px] font-semibold text-fg">Die Canvas ist bereit</p>
      <p className="mt-1.5 max-w-[340px] text-[13.5px] leading-relaxed text-dim">
        Frag nach einem Ablauf, einer Architektur oder nach Zahlen – der Agent zeichnet es hier live auf.
      </p>
    </div>
  );
}

/** The stage viewport: auto-fit for every new or updated scene (animated by Stage), plus zoom (buttons, keys, Ctrl/⌘ +
 *  wheel, trackpad pinch, two-finger pinch) and pan (drag, wheel) while the view does not show everything. An auto view
 *  that pans is shown in scroll mode (native scrolling); zooming from there switches to the zoom/pan view. */
function useViewport(el: React.RefObject<HTMLDivElement | null>, scene: Scene | null, box: { w: number; h: number }, graph: boolean) {
  const auto = useMemo(() => (scene && box.w > 0 && box.h > 0 ? autoView(scene, box, graph) : null), [scene, box.w, box.h, graph]);
  // The user's view belongs to one scene at one stage size; a new scene (update, new canvas) or a resize fits again.
  const [user, setUser] = useState<{ vb: VB; instant: boolean; scene: Scene; w: number; h: number; clamped?: boolean } | null>(null);
  const own = user && user.scene === scene && user.w === box.w && user.h === box.h ? user : null;
  const scroll = !own && auto && scene ? scrollMode(auto, scene, box) : null;
  const vb = own?.vb ?? scroll?.vb ?? auto?.vb ?? null;
  /** What is on screen right now as a view box of the stage size (scroll mode: the scrolled-to part). */
  const visible = useCallback((): VB | null => {
    const { vb: v, scroll: sm, box: b } = live.current;
    const node = el.current;
    if (!sm || !v || !node) return v;
    const k = v[2] / sm.box.w;
    return [v[0] + node.scrollLeft * k, v[1] + node.scrollTop * k, b.w * k, b.h * k];
  }, [el]);
  const live = useRef({ vb, auto, scene, box, scroll, visible, clamped: false });
  live.current = { vb, auto, scene, box, scroll, visible, clamped: !!own?.clamped };
  const set = useCallback((next: VB, instant: boolean, clamped?: boolean) => {
    const { scene: sc, box: b } = live.current;
    if (sc) setUser({ vb: next, instant, scene: sc, w: b.w, h: b.h, clamped });
  }, []);
  const zoom = useCallback((f: number, px?: number, py?: number, instant = false) => {
    const { auto: a, scene: sc, box: b, visible: vis } = live.current;
    const v = vis();
    if (v && a && sc) set(zoomAt(v, f, px ?? b.w / 2, py ?? b.h / 2, b, sc, a.scale), instant);
  }, [set]);
  // "Alles zeigen": the whole scene when anything is out of view, otherwise back to the auto view.
  const fit = useCallback(() => {
    const { scene: sc, box: b, visible: vis, clamped } = live.current;
    const v = vis();
    if (v && sc && !clamped && canPan(v, sc)) {
      // Never below FIT_MIN_PX: a whole that would be smaller shows the best overview at that size (and says so).
      const w = wholeView(sc, b, graph);
      set([w[0], w[1], w[2], w[3]], false, w.clamped);
    } else setUser(null);
  }, [set, graph]);
  const pannable = !!(vb && scene && !scroll && canPan(vb, scene));

  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const onWheel = (e: WheelEvent) => {
      const { vb: v, auto: a, scene: sc, box: b, scroll: sm } = live.current;
      if (!v || !a || !sc) return;
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? b.h : 1;
      const r = node.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top, true);
      } else if (!sm && canPan(v, sc)) {
        e.preventDefault();
        set(panBy(v, -e.deltaX * k, -e.deltaY * k, b, sc, a.scale), true);
      }
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [el, zoom, set]);

  const pts = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ vb: VB; x: number; y: number; d: number; sl: number; st: number } | null>(null);
  const snapshot = () => {
    const p = [...pts.current.values()];
    const v = live.current.visible();
    if (!p.length || !v) { start.current = null; return; }
    const x = p.reduce((s, q) => s + q.x, 0) / p.length, y = p.reduce((s, q) => s + q.y, 0) / p.length;
    start.current = { vb: v, x, y, d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0, sl: el.current?.scrollLeft ?? 0, st: el.current?.scrollTop ?? 0 };
  };
  const at = (e: RPointerEvent) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const handlers = {
    onPointerDown: (e: RPointerEvent) => {
      if (!live.current.vb || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // Scroll mode: touch scrolls natively; only a mouse drag (and a pinch) is ours.
      if (live.current.scroll && e.pointerType === 'touch' && pts.current.size === 0) { pts.current.set(e.pointerId, at(e)); return; }
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      pts.current.set(e.pointerId, at(e));
      snapshot();
    },
    onPointerMove: (e: RPointerEvent) => {
      if (!pts.current.has(e.pointerId)) return;
      pts.current.set(e.pointerId, at(e));
      const s0 = start.current;
      const { auto: a, scene: sc, box: b, scroll: sm } = live.current;
      if (!a || !sc || !s0) return;
      const p = [...pts.current.values()];
      const x = p.reduce((s, q) => s + q.x, 0) / p.length, y = p.reduce((s, q) => s + q.y, 0) / p.length;
      if (p.length > 1 && s0.d > 0) {
        const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        set(panBy(zoomAt(s0.vb, d / s0.d, s0.x, s0.y, b, sc, a.scale), x - s0.x, y - s0.y, b, sc, a.scale), true);
      } else if (sm && el.current) {
        el.current.scrollLeft = s0.sl - (x - s0.x);
        el.current.scrollTop = s0.st - (y - s0.y);
      } else if (canPan(s0.vb, sc)) set(panBy(s0.vb, x - s0.x, y - s0.y, b, sc, a.scale), true);
    },
    onPointerUp: (e: RPointerEvent) => { pts.current.delete(e.pointerId); snapshot(); },
    onPointerCancel: (e: RPointerEvent) => { pts.current.delete(e.pointerId); snapshot(); },
    onDoubleClick: (e: React.MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (own) setUser(null); else zoom(2, e.clientX - r.left, e.clientY - r.top);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') zoom(1.4);
      else if (e.key === '-' || e.key === '_') zoom(1 / 1.4);
      else if (e.key === '0') fit();
      else return;
      e.preventDefault();
    },
  };
  return {
    vb, box: scroll?.box ?? box, scroll: scroll?.axis ?? null, instant: own?.instant ?? false, whole: !pannable && !scroll, pannable, zoom, fit,
    /** "Alles zeigen" could not show everything without going below FIT_MIN_PX. */
    clamped: !!own?.clamped,
    /** The user zoomed or panned (or pressed "Alles zeigen"). */
    custom: !!own,
    handlers,
    /** Fitted type is small or the drawing does not fit: the big view would show it better. */
    cramped: !!auto && !!scene && wantsBig(auto, scene, box),
    percent: vb && auto && !scroll ? Math.round((scaleOf(vb, box) / auto.scale) * 100) : 100,
  };
}

/** Fade at the edge where scroll-mode content continues. */
function useScrollEdge(el: React.RefObject<HTMLDivElement | null>, axis: 'x' | 'y' | 'xy' | null, dep: unknown) {
  const [more, setMore] = useState({ x: false, y: false });
  useEffect(() => {
    const node = el.current;
    if (!node || !axis) { setMore({ x: false, y: false }); return; }
    const check = () => setMore((old) => {
      const next = scrollEdges(node, axis);
      return next.x === old.x && next.y === old.y ? old : next;
    });
    check();
    node.addEventListener('scroll', check, { passive: true });
    return () => node.removeEventListener('scroll', check);
  }, [el, axis, dep]);
  return more;
}

function ByBadge({ entry }: { entry: CanvasEntry }) {
  const label = byLabel(entry.by, entry.provider);
  const tone = entry.by === 'claude' ? 'cv-by-claude' : entry.by === 'voice' ? 'cv-by-voice' : entry.by === 'auto' ? 'cv-by-auto' : 'cv-by-text';
  return <span className={`cv-by ${tone}`} title={`Gezeichnet von: ${label}`}>{label}</span>;
}

export interface CanvasViewProps {
  state: CanvasState;
  onSelect?: (id: string) => void;
  onExport?: (spec: CanvasSpec, scene: Scene, entry: CanvasEntry) => void | Promise<void>;
  onCopy?: (spec: CanvasSpec) => void | Promise<void>;
  /** Shows an enlarge button (or, with `expanded`, a shrink button) that calls this. */
  onExpand?: () => void;
  expanded?: boolean;
  /** Simple <-> detailed version of a canvas (state in the bus, shared with the enlarged view). Without it: local state. */
  onToggleDetail?: (id: string) => void;
  className?: string;
}

export default function CanvasView({ state, onSelect, onExport, onCopy, onExpand, expanded, onToggleDetail, className = '' }: CanvasViewProps) {
  const entry = state.current ? state.entries[state.current] : undefined;
  const raw = entry?.spec;
  // §5: the simple view by default; "Details" switches this canvas id to its detailed version (animated in place: same id)
  const [localDetails, setLocalDetails] = useState<Record<string, boolean>>({});
  const withDetail = hasDetail(raw);
  const detailed = !!entry && withDetail && !!(onToggleDetail ? state.details?.[entry.id] : localDetails[entry.id]);
  const toggleDetail = () => {
    if (!entry) return;
    if (onToggleDetail) onToggleDetail(entry.id);
    else setLocalDetails((d) => ({ ...d, [entry.id]: !d[entry.id] }));
  };
  const spec = raw ? variantSpec(raw, detailed) : undefined;
  const stageRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(stageRef);
  const { scene, forId } = useScene(spec, Math.floor(width), Math.floor(height));
  const shown = scene && spec && forId === spec.id ? scene : null;
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const kind = spec?.kind ?? entry?.kind;
  const Icon = kind ? KIND_ICON[kind] : PenTool;
  const title = spec?.title ?? entry?.title ?? (entry ? 'Neue Skizze' : '');
  const pending = entry?.phase === 'pending';
  const failed = entry?.phase === 'error';
  const graph = kind === 'flow' || kind === 'architecture';
  const view = useViewport(stageRef, shown, { w: Math.floor(width), h: Math.floor(height) }, graph);
  const more = useScrollEdge(stageRef, view.scroll, shown);
  // Phones: the controls strip folds away after CONTROLS_IDLE_MS without interaction; a tap on the canvas shows it again.
  const autoHide = !!shown && controlsAutoHide(Math.floor(width), view.custom);
  const [idle, setIdle] = useState(false);
  const [pokes, setPokes] = useState(0);
  const poke = useCallback(() => { setIdle(false); setPokes((n) => n + 1); }, []);
  useEffect(() => {
    if (!autoHide || idle) return;
    const t = window.setTimeout(() => setIdle(true), CONTROLS_IDLE_MS);
    return () => window.clearTimeout(t);
  }, [autoHide, idle, pokes]);
  const controlsHidden = autoHide && idle;
  const history = state.order.map((id) => state.entries[id]).filter(Boolean);
  // The ELK chunk (~1.6 MB) starts loading as soon as a diagram is being drawn, not when its spec arrives.
  useEffect(() => {
    if (pending && (!kind || graph)) void import('./render/graph').then((m) => m.loadElk()).catch(() => {});
  }, [pending, kind, graph]);

  return (
    <div className={`cv-root flex h-full min-h-0 flex-col ${className}`} data-canvas-id={entry?.id ?? ''} data-phase={entry?.phase ?? 'empty'}>
      {entry && (
        <header className="cv-head shrink-0">
          <span className={`cv-kind ${pending ? 'cv-kind-pending' : ''}`} title={kind ? KIND_LABEL[kind] : 'Skizze'}><Icon className="h-[18px] w-[18px]" /></span>
          <div className="cv-text min-w-0">
            <h2 className="cv-title" key={title}>{title}</h2>
            {spec?.caption && <p className="cv-caption">{spec.caption}</p>}
          </div>
          <div className="cv-actions">
            <ByBadge entry={entry} />
            {spec && withDetail && (
              <button
                type="button"
                className={`cv-detail ${detailed ? 'cv-detail-on' : ''}`}
                onClick={toggleDetail}
                aria-pressed={detailed}
                aria-label="Details anzeigen"
                title={detailed ? 'Zur einfachen Fassung' : 'Ausführliche Fassung zeigen'}
              >
                <ListTree className="h-4 w-4" aria-hidden="true" />
                <span>{detailLabel(detailed)}</span>
              </button>
            )}
            {spec && (
              <>
                <button
                  type="button"
                  className="cv-btn"
                  disabled={!shown || exporting}
                  onClick={async () => { if (!shown || !onExport) return; setExporting(true); try { await onExport(spec, shown, entry); } finally { setExporting(false); } }}
                  aria-label="Als PNG speichern"
                  title="Als PNG speichern"
                >
                  <ImageDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  className="cv-btn cv-copy"
                  onClick={async () => { await onCopy?.(raw ?? spec); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }}
                  aria-label="Spezifikation als JSON kopieren"
                  title="JSON kopieren"
                >
                  {copied ? <Check className="h-4 w-4 text-moss" /> : <Copy className="h-4 w-4" />}
                </button>
              </>
            )}
            {onExpand && (
              <button type="button" className="cv-btn" onClick={onExpand} aria-label={expanded ? 'Klein anzeigen' : 'Groß anzeigen'} title={expanded ? 'Klein anzeigen (Esc)' : 'Groß anzeigen'}>
                {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
            )}
          </div>
        </header>
      )}
      {/* The drawing area and, below it, its own strip for the zoom controls (they never cover the drawing). */}
      <div className="cv-stage relative flex min-h-0 flex-1 flex-col" onPointerDownCapture={poke} onFocusCapture={poke}>
        <div
          ref={stageRef}
          className={`cv-viewport relative min-h-0 flex-1 ${view.scroll ? `cv-scroll-${view.scroll}` : 'overflow-hidden'} ${view.pannable ? 'cursor-grab active:cursor-grabbing' : ''}`}
          style={{ touchAction: !shown ? undefined : view.scroll === 'y' ? 'pan-y' : view.scroll === 'x' ? 'pan-x' : view.scroll === 'xy' ? 'pan-x pan-y' : 'none' }}
          tabIndex={shown ? 0 : -1}
          aria-label={shown ? `Zeichenfläche: ${view.scroll ? 'scrollen für den Rest' : 'ziehen zum Verschieben'}, Strg + Mausrad oder zwei Finger zum Zoomen, 0 zeigt alles` : undefined}
          {...view.handlers}
        >
          {pending && <div className="cv-progress" aria-hidden="true" />}
          {!entry && <Empty />}
          {/* Also while a ready spec is still being laid out (cold ELK chunk): never an empty frame. */}
          {entry && !shown && (pending || (spec && !failed)) && (
            <div className="flex h-full flex-col items-center justify-center gap-4" role="status" aria-label="Wird gezeichnet">
              <PendingSketch />
              <p className="text-[13px] font-medium text-dim">Wird gezeichnet</p>
            </div>
          )}
          {entry && !spec && failed && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
              <TriangleAlert className="h-6 w-6 text-danger" />
              <p className="text-[15px] font-semibold text-fg">Zeichnung fehlgeschlagen</p>
              <p className="max-w-[360px] text-[13px] text-dim">{entry.message?.replace(/^Zeichnung fehlgeschlagen:?\s*/i, '') || 'Bitte noch einmal fragen.'}</p>
            </div>
          )}
          {shown && view.vb && (
            <div className={`${view.scroll ? 'relative' : 'absolute inset-0'} ${pending ? 'cv-updating' : ''}`} style={view.scroll ? { width: view.box.w, height: view.box.h } : undefined}>
              <Stage scene={shown} canvasId={spec!.id} vb={view.vb} box={view.box} instant={view.instant} />
            </div>
          )}
        </div>
        {more.y && <div className={`cv-more cv-more-y ${controlsHidden ? 'cv-more-flush' : ''}`} aria-hidden="true" />}
        {more.x && <div className={`cv-more cv-more-x ${controlsHidden ? 'cv-more-flush' : ''}`} aria-hidden="true" />}
        {more.x && (
          <button
            type="button"
            className={`cv-more-hint ${controlsHidden ? 'cv-more-flush' : ''}`}
            onClick={() => stageRef.current?.scrollBy({ left: stageRef.current.clientWidth * 0.8, behavior: 'smooth' })}
            aria-label={kind === 'table' ? 'Weitere Spalten anzeigen' : 'Nach rechts scrollen'}
          >
            {kind === 'table' ? 'mehr Spalten' : 'mehr'} <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {spec && failed && (
          <p className="absolute bottom-12 left-1/2 -translate-x-1/2 rounded-full border border-danger/30 bg-ink-900/90 px-3 py-1 text-[12px] text-danger/90" role="alert">
            Aktualisierung fehlgeschlagen{entry?.message ? `: ${entry.message.replace(/^Zeichnung fehlgeschlagen:?\s*/i, '')}` : ''}
          </p>
        )}
        {entry && controlsHidden && <div className="cv-controls cv-controls-hidden" aria-hidden="true" />}
        {entry && !controlsHidden && (
          <div className="cv-controls">
            {shown && view.vb && onExpand && !expanded && view.cramped && (
              <button type="button" className="cv-big-hint" onClick={onExpand} title="Groß anzeigen">
                <Maximize2 className="h-3.5 w-3.5" />
                Groß ansehen
              </button>
            )}
            {shown && view.vb && view.clamped && (
              <span className="cv-fit-note" role="status" title="Ganz wäre die Schrift kleiner als 6 px: das ist die größte noch lesbare Übersicht, der Rest lässt sich verschieben.">zu groß für ganz</span>
            )}
            {shown && view.vb && (
              <div className="cv-zoom" role="group" aria-label="Zoom">
                <button type="button" className="cv-zbtn" onClick={() => view.zoom(1 / 1.4)} aria-label="Verkleinern" title="Verkleinern (−)"><Minus className="h-4 w-4" /></button>
                <button type="button" className={`cv-zbtn ${view.whole ? 'cv-zbtn-on' : ''}`} onClick={view.fit} aria-label="Alles zeigen" aria-pressed={view.whole} title="Alles zeigen (0)">
                  {view.whole || view.percent === 100 ? <Scan className="h-4 w-4" /> : <span className="cv-zpct">{view.percent} %</span>}
                </button>
                <button type="button" className="cv-zbtn" onClick={() => view.zoom(1.4)} aria-label="Vergrößern" title="Vergrößern (+)"><Plus className="h-4 w-4" /></button>
              </div>
            )}
          </div>
        )}
      </div>
      {spec && (
        <footer className="cv-sources shrink-0 px-4 lg:px-5" aria-label="Quellen">
          <span className="cv-by-foot">{byLabel(entry!.by, entry!.provider)} ·</span>
          <span className="cv-sources-h">Quellen</span>
          {spec.sources.map((s, i) => {
            const f = footnote(s);
            return <span key={`${s.ref}|${i}`} className="cv-src" title={f.title}><sup>{i + 1}</sup>{f.text}</span>;
          })}
          {spec.unsourced && <span className="cv-unsourced">ohne Quelle</span>}
        </footer>
      )}
      {history.length > 1 && (
        <nav className="cv-history shrink-0" aria-label="Verlauf der Skizzen">
          {history.map((h) => {
            const HIcon = h.kind ? KIND_ICON[h.kind] : PenTool;
            const active = h.id === state.current;
            return (
              <button key={h.id} type="button" className={`cv-hist ${active ? 'cv-hist-on' : ''}`} aria-current={active || undefined} onClick={() => onSelect?.(h.id)} title={h.title}>
                <HIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{h.title ?? h.id}</span>
                {h.phase === 'pending' && <span className="cv-hist-dot" aria-label="wird gezeichnet" />}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
