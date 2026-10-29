// Owned by the viz slice. Contract: render the latest VizSpec with animated transitions (explainer visual language).
// Layout is deterministic (layout.ts); every node is keyed by id and tweened from its old to its new position by a
// single rAF loop that writes SVG attributes directly (no React re-render per frame, no layout reads).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { VizEdge, VizNode, VizSpec, VizStep } from '../lib/types';
import {
  EDGE_FONT, edgeGeometry, edgeKey, fitCamera, LABEL_FONT, layoutSpec, NUMBER_FONT, placeEdgeLabels, resetTextWidths,
  textWidth, VALUE_FONT, type Box, type Cam, type Layout,
} from './layout';
import { alpha, C, FONT, KIND_ICON, kindTone, prefersReducedMotion, toneColor } from './theme';
import { easeInOut, useSize, useTypewriter } from './hooks';
import { toolLabel } from './describe';
import { nodeToolStates, reconcileSpec, toolOfNode, type ToolState } from './reconcile';
import { canvasFrame, headerTop, PILL_STRIP, SCROLL_PAD } from './frame';
import './viz.css';

export interface LiveCanvasProps {
  spec: VizSpec | null;
  activity?: { name: string; status: string }[];
  className?: string;
  /** Makes nodes buttons (click, Enter, Space); the app can open the file, job or session behind the node. */
  onNodeClick?: (node: VizNode) => void;
}

const TWEEN_MS = 650;
const EXIT_MS = 400;
const FLIGHT_MS = 950;

type EdgeEls = { base?: SVGPathElement | null; flow?: SVGPathElement | null; arrow?: SVGPathElement | null; label?: SVGGElement | null };
interface Ghosts { nodes: { node: VizNode; box: Box; x: number; y: number }[]; edges: { key: string; d: string; color: string }[] }
/** A tool chip travelling from the agent to the node of its tool (layout coordinates). */
interface Flight { key: number; label: string; state: ToolState; x0: number; y0: number; x1: number; y1: number }

const nodeColor = (n: VizNode | undefined) => (n ? toneColor(n.tone ?? kindTone(n.kind)) : C.dim);
const edgeColor = (e: VizEdge, byId: Map<string, VizNode>) => {
  const to = byId.get(e.to);
  return to && (to.tone ?? kindTone(to.kind)) !== 'neutral' ? nodeColor(to) : nodeColor(byId.get(e.from));
};

/** Height of an element that may mount later (ResizeObserver, measured before paint). */
function useHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    if (!el) { setH(0); return; }
    setH(el.offsetHeight);
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return h;
}

/** Largest title size (down to a floor) at which the title fits on one line; below the floor it wraps to two lines. */
function titleSize(title: string, width: number, compact: boolean): number {
  const max = compact ? 21 : 30;
  const min = compact ? 17 : 22;
  const w = textWidth(title, `700 ${max}px ${FONT}`) * 1.02; // letter-spacing and rounding headroom
  return w <= width || w === 0 ? max : Math.max(min, Math.floor((max * width) / w));
}

/** Bumps once the web font has loaded, so text measured with fallback metrics is measured again. */
function useFontsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts) return;
    let alive = true;
    const bump = () => { if (!alive) return; resetTextWidths(); setV((x) => x + 1); };
    fonts.ready.then(bump);
    fonts.addEventListener('loadingdone', bump);
    return () => { alive = false; fonts.removeEventListener('loadingdone', bump); };
  }, []);
  return v;
}

function LiveCanvas({ spec: raw, activity, className, onNodeClick }: LiveCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { width, height } = useSize(rootRef);
  const fontsVersion = useFontsVersion();
  const compact = width < 560;
  const pad = compact ? 16 : 32;
  // Tool events arrive before the next spec: finished tools are shown finished at once (in place, no relayout jump).
  const activityKey = (activity ?? []).map((a) => `${a.name}:${a.status}`).join('|');
  const spec = useMemo(() => reconcileSpec(raw, activity), [raw, activityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const toolStates = useMemo(() => nodeToolStates(spec, activity), [spec, activityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [headerEl, setHeaderEl] = useState<HTMLDivElement | null>(null);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const headerH = useHeight(headerEl);
  const footerH = useHeight(footerEl);
  // The layout is sized without the "mehr ↓" strip; only a scrolling diagram gives up that strip (it scrolls anyway).
  const base = canvasFrame({ height, compact, headerH, footerH, scroll: false });
  const top = base.top;
  const availW = Math.max(0, width - pad * 2);
  const availH = Math.max(0, height - top - base.bottom);

  const layout = useMemo<Layout | null>(
    () => (spec && availW > 60 && availH > 60 ? layoutSpec(spec, { width: availW, height: availH }) : null),
    [spec, availW, availH, fontsVersion], // fontsVersion: text widths were re-measured
  );
  const byId = useMemo(() => new Map((spec?.nodes ?? []).map((n) => [n.id, n])), [spec]);

  // When the diagram only stays readable taller than the box, the diagram (not title, steps or caption) scrolls
  // vertically, never sideways. The scroller then spans the space between header and footer.
  const scroll = !!layout?.scroll;
  const frame = scroll ? canvasFrame({ height, compact, headerH, footerH, scroll }) : base;
  const drawH = scroll ? Math.ceil(layout!.height * layout!.scale) : availH;
  const drawY = scroll ? SCROLL_PAD : top;
  const contentH = scroll ? drawH + SCROLL_PAD * 2 : height;
  // Gentle camera: fit (never clipped), lean towards the focus node so attention moves without losing the overview.
  const camera = useMemo<Cam | null>(
    () => layout && fitCamera(layout, { x: pad, y: drawY, width: availW, height: drawH }, spec?.focus ? layout.boxes.get(spec.focus) : undefined),
    [layout, spec?.focus, availW, drawH, drawY, pad],
  );
  const edgeLabels = useMemo(
    () => (layout && spec && camera ? placeEdgeLabels(spec.edges, layout, camera.s) : new Map<string, string>()),
    [layout, spec, camera],
  );
  const [atEnd, setAtEnd] = useState(false);
  useEffect(() => setAtEnd(false), [raw]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const flights = useFlights(spec, layout, camera, activity, width, drawY);

  // ---- imperative animation state -------------------------------------------------------------------------
  const camEl = useRef<SVGGElement>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, EdgeEls>());
  const cur = useRef(new Map<string, { x: number; y: number }>());
  const lastD = useRef(new Map<string, string>());
  const camCur = useRef<Cam | null>(null);
  const prev = useRef<{ spec: VizSpec; layout: Layout } | null>(null);
  const [ghosts, setGhosts] = useState<Ghosts>({ nodes: [], edges: [] });

  useLayoutEffect(() => {
    if (!layout || !camera || !spec) return;
    // Nodes/edges that disappeared fade out where they were.
    const old = prev.current;
    if (old && old.spec !== spec) {
      const gone = old.spec.nodes.filter((n) => !layout.boxes.has(n.id) && cur.current.has(n.id));
      const keys = new Set(spec.edges.map(edgeKey));
      const goneEdges = old.spec.edges.filter((e) => !keys.has(edgeKey(e)) && lastD.current.has(edgeKey(e)));
      if (gone.length || goneEdges.length) {
        const oldById = new Map(old.spec.nodes.map((n) => [n.id, n]));
        setGhosts({
          nodes: gone.map((n) => ({ node: n, box: old.layout.boxes.get(n.id)!, ...cur.current.get(n.id)! })),
          edges: goneEdges.map((e) => ({ key: edgeKey(e), d: lastD.current.get(edgeKey(e))!, color: edgeColor(e, oldById) })),
        });
        gone.forEach((n) => cur.current.delete(n.id));
        goneEdges.forEach((e) => lastD.current.delete(edgeKey(e)));
      }
    }
    prev.current = { spec, layout };

    const from = new Map<string, { x: number; y: number }>();
    for (const [id, b] of layout.boxes) from.set(id, cur.current.get(id) ?? { x: b.x, y: b.y });
    const camFrom = camCur.current ?? camera;
    const t0 = performance.now();
    const dur = prefersReducedMotion() ? 1 : TWEEN_MS;
    let raf = 0;

    const apply = (k: number) => {
      const e = easeInOut(k);
      const live = new Map<string, Box>();
      for (const [id, b] of layout.boxes) {
        const f = from.get(id)!;
        const p = { x: f.x + (b.x - f.x) * e, y: f.y + (b.y - f.y) * e };
        cur.current.set(id, p);
        live.set(id, { ...b, ...p });
        nodeEls.current.get(id)?.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      }
      for (const edge of spec.edges) {
        const a = live.get(edge.from);
        const b = live.get(edge.to);
        const els = edgeEls.current.get(edgeKey(edge));
        if (!a || !b || !els) continue;
        const g = edgeGeometry(a, b, layout.horizontal, layout.side.has(edgeKey(edge)));
        lastD.current.set(edgeKey(edge), g.d);
        els.base?.setAttribute('d', g.d);
        els.flow?.setAttribute('d', g.d);
        els.arrow?.setAttribute('transform', `translate(${g.end.x.toFixed(1)},${g.end.y.toFixed(1)}) rotate(${g.angle.toFixed(1)})`);
        els.label?.setAttribute('transform', `translate(${g.mid.x.toFixed(1)},${g.mid.y.toFixed(1)})`);
      }
      const c = { tx: camFrom.tx + (camera.tx - camFrom.tx) * e, ty: camFrom.ty + (camera.ty - camFrom.ty) * e, s: camFrom.s + (camera.s - camFrom.s) * e };
      camCur.current = c;
      camEl.current?.setAttribute('transform', `translate(${c.tx.toFixed(1)},${c.ty.toFixed(1)}) scale(${c.s.toFixed(4)})`);
    };
    apply(0);
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      apply(k);
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [layout, camera, spec]);

  useLayoutEffect(() => {
    if (!ghosts.nodes.length && !ghosts.edges.length) return;
    const id = setTimeout(() => setGhosts({ nodes: [], edges: [] }), EXIT_MS);
    return () => clearTimeout(id);
  }, [ghosts]);

  const running = (activity ?? []).filter((a) => a.status === 'start').map((a) => toolLabel(a.name));
  const label = spec ? `${spec.title}. ${spec.caption ?? ''} ${spec.nodes.map((n) => n.label + (n.value ? ` (${n.value})` : '')).join(', ')}` : 'Live-Skizze: noch leer';
  const interactive = !!onNodeClick;

  return (
    <div ref={rootRef} className={`vz-root vz-canvas ${className ?? ''}`} role={interactive ? 'figure' : 'img'} aria-label={label}
      style={{ position: 'relative', overflow: 'hidden', background: `radial-gradient(120% 90% at 50% 40%, #13131a 0%, ${C.bg} 70%)` }}>
      {!spec && <EmptyState compact={compact} running={running} />}
      {spec && (
        <>
          <Header spec={spec} compact={compact} pad={pad} running={running} width={availW} innerRef={setHeaderEl} />
          <div ref={scrollerRef} className="vz-scroll" style={{
            position: 'absolute', left: 0, right: 0, top: scroll ? top - SCROLL_PAD : 0, bottom: scroll ? frame.bottom : 0, overflowX: 'hidden', overflowY: scroll ? 'auto' : 'hidden',
            // Soft edge at the cut, inside the scroll box only; the pill sits in its own strip below.
            ...(scroll && !atEnd ? { maskImage: 'linear-gradient(#000 calc(100% - 22px), transparent)', WebkitMaskImage: 'linear-gradient(#000 calc(100% - 22px), transparent)' } : {}),
          }}
            onScroll={(ev) => { const el = ev.currentTarget; setAtEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 8); }}>
            <svg width={width} height={contentH} viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, contentH)}`} preserveAspectRatio="xMidYMid meet"
              className="vz-svg" style={{ display: 'block' }} aria-hidden={interactive ? undefined : true}>
              <defs>
                {(['moss', 'papaya', 'violet', 'amber', 'red', 'neutral'] as const).map((t) => (
                  <radialGradient key={t} id={`vz-glow-${t}`}>
                    <stop offset="0%" stopColor={toneColor(t)} stopOpacity={0.42} />
                    <stop offset="60%" stopColor={toneColor(t)} stopOpacity={0.1} />
                    <stop offset="100%" stopColor={toneColor(t)} stopOpacity={0} />
                  </radialGradient>
                ))}
              </defs>
              <g ref={camEl}>
                <g>
                  {ghosts.edges.map((g) => (
                    <path key={`ghost-${g.key}`} d={g.d} fill="none" stroke={alpha(g.color, 0.35)} strokeWidth={2} className="vz-exit" />
                  ))}
                  {spec.edges.map((e) => (
                    <Edge key={edgeKey(e)} edge={e} label={edgeLabels.get(edgeKey(e))} color={edgeColor(e, byId)} register={(els) => edgeEls.current.set(edgeKey(e), els)} />
                  ))}
                </g>
                <g>
                  {ghosts.nodes.map((g) => (
                    <g key={`ghost-${g.node.id}`} transform={`translate(${g.x},${g.y})`}>
                      <g className="vz-exit"><NodeShape node={g.node} box={g.box} focus={false} /></g>
                    </g>
                  ))}
                  {layout && spec.nodes.map((n) => {
                    const box = layout.boxes.get(n.id);
                    if (!box) return null;
                    const open = onNodeClick && (() => onNodeClick(n));
                    const nodeLabel = n.label + (n.value ? `: ${n.value}` : '');
                    return (
                      <g key={n.id} data-id={n.id} className={open ? 'vz-node vz-node-btn' : 'vz-node'}
                        role={open ? 'button' : undefined} tabIndex={open ? 0 : undefined} aria-label={open ? `${nodeLabel} öffnen` : undefined}
                        onClick={open} onKeyDown={open && ((ev: KeyboardEvent) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } })}
                        ref={(el) => {
                        if (el) {
                          nodeEls.current.set(n.id, el);
                          const p = cur.current.get(n.id) ?? box;
                          el.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
                        } else nodeEls.current.delete(n.id);
                      }}>
                        <g className="vz-pop" style={{ animationDelay: `${Math.min(6, spec.nodes.indexOf(n)) * 45}ms` }}>
                          <NodeShape node={n} box={box} focus={spec.focus === n.id} toolState={toolStates.get(n.id)} />
                        </g>
                      </g>
                    );
                  })}
                </g>
                <g aria-hidden>{flights.map((f) => <FlightChip key={f.key} flight={f} />)}</g>
              </g>
            </svg>
          </div>
          <Footer spec={spec} compact={compact} pad={pad} innerRef={setFooterEl} />
        </>
      )}
      {spec && frame.pill && !atEnd && (
        <div className="vz-fade" style={{ position: 'absolute', left: 0, right: 0, top: frame.pill.top, height: PILL_STRIP, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <button type="button" onClick={() => scrollerRef.current?.scrollBy({ top: scrollerRef.current.clientHeight * 0.7, behavior: 'smooth' })}
            style={{ pointerEvents: 'auto', fontSize: 12, fontWeight: 600, color: C.dim, padding: '3px 12px', borderRadius: 10, background: C.card, border: `1px solid ${C.line}`, cursor: 'pointer' }}>
            mehr ↓
          </button>
        </div>
      )}
    </div>
  );
}

/** Chips for tool calls that start or finish while a node of that tool is on the canvas: agent (or top) → node. */
function useFlights(spec: VizSpec | null, layout: Layout | null, camera: Cam | null, activity: LiveCanvasProps['activity'], width: number, drawY: number): Flight[] {
  const [flights, setFlights] = useState<Flight[]>([]);
  const seen = useRef<Map<string, number> | null>(null);
  const next = useRef(0);
  const key = (activity ?? []).map((a) => `${a.name}:${a.status}`).join('|');
  useEffect(() => {
    const counts = new Map<string, number>();
    for (const a of activity ?? []) counts.set(`${a.name}\n${a.status}`, (counts.get(`${a.name}\n${a.status}`) ?? 0) + 1);
    const before = seen.current;
    seen.current = counts;
    if (!before || !spec || !layout || !camera || prefersReducedMotion()) return; // first sight: no replay of old calls
    const agent = spec.nodes.find((n) => n.kind === 'agent');
    const from = agent && layout.boxes.get(agent.id);
    const x0 = from ? from.x : (width / 2 - camera.tx) / camera.s;
    const y0 = from ? from.y : (drawY - camera.ty) / camera.s;
    const fresh: Flight[] = [];
    for (const [k, n] of counts) {
      if (n <= (before.get(k) ?? 0)) continue;
      const [name, status] = k.split('\n');
      const target = spec.nodes.find((node) => node.id !== agent?.id && toolOfNode(node, [name], true)) ?? spec.nodes.find((node) => node.id !== agent?.id && toolOfNode(node, [name]));
      const to = target && layout.boxes.get(target.id);
      if (!to) continue;
      const state: ToolState = status === 'error' ? 'error' : status === 'done' ? 'done' : 'start';
      fresh.push({ key: next.current++, label: toolLabel(name), state, x0, y0, x1: to.x, y1: to.y });
    }
    if (!fresh.length) return;
    setFlights((f) => [...f, ...fresh]);
    const id = setTimeout(() => setFlights((f) => f.filter((x) => !fresh.includes(x))), FLIGHT_MS + 50);
    return () => clearTimeout(id);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return flights;
}

function FlightChip({ flight: f }: { flight: Flight }) {
  const ref = useRef<SVGGElement>(null);
  const color = f.state === 'error' ? C.red : f.state === 'done' ? C.moss : C.violet;
  const text = f.state === 'done' ? `${f.label} ✓` : f.label;
  const w = textWidth(text, EDGE_FONT) + 30;
  useLayoutEffect(() => {
    const at = (x: number, y: number, k: number) => `translate(${x}px, ${y}px) scale(${k})`;
    const anim = ref.current?.animate([
      { transform: at(f.x0, f.y0, 0.6), opacity: 0 },
      { transform: at(f.x0 + (f.x1 - f.x0) * 0.1, f.y0 + (f.y1 - f.y0) * 0.1, 1), opacity: 1, offset: 0.15 },
      { transform: at(f.x1, f.y1, 1), opacity: 1, offset: 0.8 },
      { transform: at(f.x1, f.y1, 0.5), opacity: 0 },
    ], { duration: FLIGHT_MS, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    return () => anim?.cancel();
  }, [f]);
  return (
    <g ref={ref} style={{ opacity: 0 }}>
      <rect x={-w / 2} y={-13} width={w} height={26} rx={13} fill={alpha(C.bg, 0.96)} stroke={color} strokeWidth={1.5} />
      <circle cx={-w / 2 + 13} r={4} fill={color} />
      <text x={-w / 2 + 23} dy="0.35em" fill={C.fg} style={{ font: EDGE_FONT }}>{text}</text>
    </g>
  );
}

function NodeShape({ node, box, focus, toolState }: { node: VizNode; box: Box; focus: boolean; toolState?: ToolState }) {
  const tone = node.tone ?? kindTone(node.kind);
  const color = toneColor(tone);
  const Icon = KIND_ICON[node.kind] ?? KIND_ICON.idea;
  const { w, h } = box;
  const glow = focus && (
    <ellipse rx={w * 0.78} ry={h * 1.15} cy={box.round ? -13 : 0} fill={`url(#vz-glow-${tone})`} className="vz-breathe" />
  );
  if (box.round) {
    const d = h - 26;
    return (
      <g>
        {glow}
        <circle className="vz-card" cy={-13} r={d / 2} fill={alpha(color, 0.13)} style={{ stroke: alpha(color, focus ? 0.95 : 0.6), transition: 'stroke 400ms' }} strokeWidth={focus ? 2.5 : 1.5} />
        <text key={node.value} className="vz-fade" y={-13} dy="0.35em" textAnchor="middle" fill={color} style={{ font: NUMBER_FONT }}>{box.sub}</text>
        <text y={d / 2 + 4} dy="0.9em" textAnchor="middle" fill={C.fg} style={{ font: VALUE_FONT }}>{box.text}</text>
      </g>
    );
  }
  const x0 = -w / 2;
  return (
    <g>
      {glow}
      <rect className="vz-card" x={x0} y={-h / 2} width={w} height={h} rx={14} fill={focus ? C.cardHi : C.card}
        style={{ stroke: alpha(color, focus ? 0.95 : 0.42), transition: 'stroke 400ms, fill 400ms' }} strokeWidth={focus ? 2 : 1.25} />
      <circle cx={x0 + 26} r={15} fill={alpha(color, 0.16)} style={{ transition: 'fill 400ms' }} />
      {toolState === 'done' || toolState === 'error' ? <StateMark x={x0 + 26} state={toolState} /> : <Icon x={x0 + 17} y={-9} width={18} height={18} color={color} strokeWidth={2.1} />}
      {toolState === 'start' && (
        <path d="M0,-18 A18,18 0 0 1 18,0" transform={`translate(${x0 + 26},0)`} fill="none" stroke={C.amber} strokeWidth={2.2} strokeLinecap="round" className="vz-spin" />
      )}
      <text x={x0 + 50} y={box.sub ? -8 : 0} dy="0.35em" fill={C.fg} style={{ font: LABEL_FONT }}>{box.text}</text>
      {box.sub && (
        <text key={node.value} className="vz-fade" x={x0 + 50} y={12} dy="0.35em" fill={color} style={{ font: VALUE_FONT }}>{box.sub}</text>
      )}
    </g>
  );
}

/** Finished tool: a moss tick drawn in place of the icon (red cross on error); replays when the state changes. */
function StateMark({ x, state }: { x: number; state: 'done' | 'error' }) {
  const color = state === 'done' ? C.moss : C.red;
  return (
    <g key={state} transform={`translate(${x},0)`}>
      <circle r={15} fill="none" stroke={color} strokeWidth={2} className="vz-tick-ring" />
      <circle r={15} fill={alpha(color, 0.22)} className="vz-pop" />
      <path d={state === 'done' ? 'M-6,0.5 L-1.8,4.6 L6.4,-4.4' : 'M-5,-5 L5,5 M5,-5 L-5,5'} pathLength={1} fill="none" stroke={color}
        strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" className="vz-draw" style={{ animationDelay: '120ms' }} />
    </g>
  );
}

function Edge({ edge, label, color, register }: { edge: VizEdge; label?: string; color: string; register: (els: EdgeEls) => void }) {
  const els = useRef<EdgeEls>({});
  const set = (k: keyof EdgeEls) => (el: SVGPathElement | SVGGElement | null) => {
    (els.current as Record<string, unknown>)[k] = el;
    register(els.current);
  };
  const dashed = edge.style === 'dashed';
  const lw = label ? textWidth(label, EDGE_FONT) + 16 : 0;
  return (
    <g>
      <path ref={set('base')} fill="none" stroke={alpha(color, dashed ? 0.5 : edge.style === 'pulse' ? 0.75 : 0.38)} strokeWidth={2}
        pathLength={dashed ? undefined : 1} strokeDasharray={dashed ? '6 7' : undefined}
        className={dashed ? 'vz-fade' : edge.style === 'pulse' ? 'vz-draw vz-pulse-line' : 'vz-draw'}
        style={edge.style === 'pulse' ? { animation: 'vz-draw 620ms cubic-bezier(.22,1,.36,1) both, vz-breathe 1.6s ease-in-out 620ms infinite' } : undefined} />
      {edge.style !== 'dashed' && edge.style !== 'pulse' && (
        <path ref={set('flow')} fill="none" stroke={color} strokeWidth={3.6} className="vz-flow"
          style={{ animation: 'vz-fade-in 400ms ease 500ms both, vz-flow 0.9s linear infinite' }} />
      )}
      <path ref={set('arrow')} d="M-8,-5 L0,0 L-8,5" fill="none" stroke={alpha(color, 0.9)} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="vz-fade" style={{ animationDelay: '450ms' }} />
      {label && (
        <g ref={set('label')}>
          <g key={label} className="vz-fade" style={{ animationDelay: '350ms' }}>
            <rect x={-lw / 2} y={-11} width={lw} height={22} rx={11} fill={alpha(C.bg, 0.94)} stroke={alpha(color, 0.3)} />
            <text textAnchor="middle" dy="0.35em" fill="#b4b3c9" style={{ font: EDGE_FONT }}>{label}</text>
          </g>
        </g>
      )}
    </g>
  );
}

function Header({ spec, compact, pad, running, width, innerRef }: { spec: VizSpec; compact: boolean; pad: number; running: string[]; width: number; innerRef: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={innerRef} style={{ position: 'absolute', left: pad, right: pad, top: headerTop(compact), pointerEvents: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: compact ? 11 : 12, letterSpacing: 3, textTransform: 'uppercase', color: C.dim, fontWeight: 600 }}>
        <span className="vz-breathe" style={{ width: 7, height: 7, borderRadius: 9, background: C.papaya, boxShadow: `0 0 10px ${C.papaya}` }} />
        Live-Skizze
        {running.length > 0 && <Running names={running} />}
      </div>
      <div key={spec.title} className="vz-rise" title={spec.title} style={{ marginTop: compact ? 6 : 8, fontSize: titleSize(spec.title, width, compact), fontWeight: 700, letterSpacing: compact ? -0.3 : -0.6, lineHeight: 1.15, display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere' }}>
        {spec.title}
      </div>
    </div>
  );
}

function Running({ names }: { names: string[] }) {
  return (
    <span className="vz-fade" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, letterSpacing: 0.4, textTransform: 'none', fontWeight: 500, color: C.amber }}>
      <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden>
        <circle cx={6} cy={6} r={4.5} fill="none" stroke={alpha(C.amber, 0.25)} strokeWidth={2} />
        <path d="M6 1.5 A4.5 4.5 0 0 1 10.5 6" fill="none" stroke={C.amber} strokeWidth={2} strokeLinecap="round" className="vz-spin" />
      </svg>
      {names.slice(-2).join(' · ')}
    </span>
  );
}

// Opaque, measured footer: the diagram area ends above it, so nothing ever shows through the caption. The full caption
// is laid out invisibly underneath the typewriter text, so the height is final from the first frame.
function Footer({ spec, compact, pad, innerRef }: { spec: VizSpec; compact: boolean; pad: number; innerRef: (el: HTMLDivElement | null) => void }) {
  const caption = useTypewriter(spec.caption ?? '');
  const typing = caption.length < (spec.caption ?? '').length;
  if (!spec.caption && !spec.steps?.length) return null;
  return (
    <div ref={innerRef} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: `0 ${pad}px ${compact ? 12 : 20}px`, pointerEvents: 'none', background: C.bg }}>
      {spec.steps?.length ? <StepsRail steps={spec.steps} compact={compact} /> : null}
      {spec.caption && (
        <div style={{ position: 'relative', marginTop: spec.steps?.length ? (compact ? 12 : 16) : 0, fontSize: compact ? 15 : 18, lineHeight: 1.4, color: '#d6d5e4', borderLeft: `3px solid ${C.violet}`, paddingLeft: 12 }}>
          <span style={{ visibility: 'hidden' }}>{spec.caption}</span>
          <span style={{ position: 'absolute', left: 12, right: 0, top: 0 }}>
            {caption}
            {typing && <span className="vz-caret" style={{ color: C.violet }}>▍</span>}
          </span>
        </div>
      )}
    </div>
  );
}

function StepsRail({ steps, compact }: { steps: VizStep[]; compact: boolean }) {
  return (
    <ol aria-label="Schritte" style={{ display: 'flex', alignItems: 'flex-start', listStyle: 'none', margin: 0, padding: 0 }}>
      {steps.map((s, i) => {
        const color = s.state === 'done' ? C.moss : s.state === 'active' ? C.papaya : C.faint;
        return (
          <li key={`${i}-${s.label}`} className="vz-rise" style={{ flex: 1, minWidth: 0, animationDelay: `${i * 60}ms`, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <span style={{ position: 'relative', width: 14, height: 14, flex: 'none', borderRadius: 14, border: `2px solid ${color}`, background: s.state === 'done' ? color : 'transparent', transition: 'background 400ms, border-color 400ms', boxSizing: 'border-box' }}>
                {s.state === 'active' && <span className="vz-ring" style={{ position: 'absolute', inset: -2, borderRadius: 14, border: `2px solid ${color}` }} />}
                {s.state === 'done' && (
                  <svg viewBox="0 0 14 14" width={10} height={10} style={{ position: 'absolute', left: 0, top: 0 }} aria-hidden>
                    <path d="M3 7.2 L5.8 9.6 L10.4 4.4" fill="none" stroke={C.bg} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              {i < steps.length - 1 && <span style={{ flex: 1, height: 2, margin: '0 6px', background: s.state === 'done' ? alpha(C.moss, 0.55) : C.line, transition: 'background 400ms' }} />}
            </div>
            <div style={{ marginTop: 6, paddingRight: 8, fontSize: compact ? 11.5 : 13, fontWeight: s.state === 'active' ? 600 : 500, color: s.state === 'todo' ? C.dim : C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.label}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function EmptyState({ compact, running }: { compact: boolean; running: string[] }) {
  const r = compact ? 46 : 64;
  return (
    <div className="vz-fade" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: compact ? 16 : 22, textAlign: 'center', padding: 24 }}>
      <svg width={r * 3} height={r * 3} viewBox={`${-r * 1.5} ${-r * 1.5} ${r * 3} ${r * 3}`} aria-hidden>
        <circle r={r} fill="none" stroke={C.line} strokeWidth={1.5} strokeDasharray="3 7" />
        <circle r={r * 0.55} fill="none" stroke={alpha(C.violet, 0.25)} strokeWidth={1.5} />
        <circle r={r * 0.2} fill={alpha(C.violet, 0.9)} className="vz-breathe" />
        {[C.moss, C.papaya, C.violet].map((c, i) => (
          <g key={c} style={{ animation: `vz-spin ${7 + i * 3}s linear infinite`, animationDelay: `${-i * 1.7}s` }}>
            <circle cx={i === 1 ? r * 0.55 : r} cy={0} r={12} fill={alpha(c, 0.14)} />
            <circle cx={i === 1 ? r * 0.55 : r} cy={0} r={i === 1 ? 4 : 5} fill={c} />
          </g>
        ))}
      </svg>
      <div>
        <div style={{ fontSize: compact ? 18 : 24, fontWeight: 700, letterSpacing: -0.3 }}>Live-Skizze</div>
        <div style={{ marginTop: 6, fontSize: compact ? 13.5 : 15, color: C.dim, maxWidth: 340, lineHeight: 1.45 }}>
          {running.length ? `Arbeite gerade: ${running.slice(-2).join(' · ')}` : 'Sobald ihr sprecht oder schreibt, entsteht hier die Skizze zum Gespräch.'}
        </div>
      </div>
    </div>
  );
}

// Parents re-render often (voice levels at 30 Hz, streaming text); skip work when the inputs are unchanged.
export default memo(LiveCanvas);
