// Renders a Scene and animates between scenes of the same canvas id: matched keys tween (positions, sizes, angles,
// path points, numbers), new keys rise/draw/grow in with a stagger, removed keys fade out. One rAF loop writes SVG
// attributes directly; React only renders the target state. A new canvas id remounts everything (fresh entrance).
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { arcPath, type Prim, type Scene } from './render/scene';
import { GLOW_FILTER, GLOW_FILTER_ID, glowOf } from './render/markup';
import { diffKeys, easeInOut, easeOut, enterFrom, lerpPrim, pathLerp } from './tween';
import { FONT, MONO, prefersReducedMotion } from '../viz/theme';
import { fitSketchText, padSketch } from './render/sketchFit';
import type { VB } from './view';

const TWEEN_MS = 700;
const GROW_MS = 900;
const EXIT_MS = 380;
const MAX_STAGGER = 900;

function writePrim(el: Element, p: Prim) {
  const set = (k: string, v: number | string) => el.setAttribute(k, String(typeof v === 'number' ? Math.round(v * 100) / 100 : v));
  switch (p.t) {
    case 'rect': set('x', p.x); set('y', p.y); set('width', Math.max(0, p.w)); set('height', Math.max(0, p.h)); if (p.rx !== undefined) set('rx', Math.min(p.rx, Math.max(0, p.h) / 2, Math.max(0, p.w) / 2)); break;
    case 'circle': set('cx', p.cx); set('cy', p.cy); set('r', p.r); break;
    case 'arc': set('d', arcPath(p.cx, p.cy, p.r0, p.r1, p.a0, p.a1) || 'M0 0'); break;
    case 'path': set('d', p.d); break;
    case 'text': set('x', p.x); set('y', p.y); if (p.num) el.textContent = p.text; break;
    case 'svg': set('x', p.x); set('y', p.y); set('width', p.w); set('height', p.h); break;
  }
}

function PrimEl({ p, enter, exit, reg }: { p: Prim; enter: boolean; exit?: boolean; reg: (k: string, el: Element | null) => void }) {
  const d = Math.min(MAX_STAGGER, p.delay ?? 0);
  const draw = p.t === 'path' && p.draw;
  const cls = [exit ? 'cv-exit' : enter ? (draw ? 'cv-draw' : p.t === 'arc' || ('grow' in p && p.grow) ? 'cv-fade' : 'cv-enter') : '', p.t === 'path' && p.flow ? 'cv-flow' : '', p.key.endsWith(':glow') ? 'cv-glow' : '']
    .filter(Boolean).join(' ') || undefined;
  const style = enter || exit ? ({ '--d': `${d}ms` } as React.CSSProperties) : undefined;
  const ref = (el: Element | null) => reg(p.key, el);
  const title = 'title' in p && p.title ? <title>{p.title}</title> : null;
  const filter = p.blur ? `url(#${GLOW_FILTER_ID})` : undefined;
  switch (p.t) {
    case 'rect':
      return <rect ref={ref} className={cls} style={style} x={p.x} y={p.y} width={Math.max(0, p.w)} height={Math.max(0, p.h)} rx={p.rx} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} strokeDasharray={p.dash} opacity={p.opacity} filter={filter}>{title}</rect>;
    case 'circle':
      return <circle ref={ref} className={cls} style={style} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} opacity={p.opacity} filter={filter} />;
    case 'arc':
      return <path ref={ref} className={cls} style={style} d={arcPath(p.cx, p.cy, p.r0, p.r1, p.a0, p.a1) || 'M0 0'} fill={p.fill} stroke={p.stroke} strokeWidth={p.sw} opacity={p.opacity} filter={filter}>{title}</path>;
    case 'path':
      return <path ref={ref} className={cls} style={style} d={p.d} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={p.sw} strokeDasharray={p.dash} strokeLinecap={p.cap} strokeLinejoin="round" opacity={p.opacity} pathLength={draw ? 1 : undefined}>{title}</path>;
    case 'text':
      return <text ref={ref} className={cls} style={style} x={p.x} y={p.y} fontSize={p.size} fontWeight={p.weight ?? 500} fill={p.fill} textAnchor={p.anchor} fontFamily={p.mono ? MONO : FONT} fontStyle={p.italic ? 'italic' : undefined} opacity={p.opacity}>{p.text}{p.title && p.title !== p.text ? <title>{p.title}</title> : null}</text>;
    case 'svg':
      return <svg ref={ref} className={cls} style={style} x={p.x} y={p.y} width={p.w} height={p.h} viewBox={p.viewBox} preserveAspectRatio="xMidYMid meet" dangerouslySetInnerHTML={{ __html: p.inner }} />;
  }
}

const expand = (prims: Prim[]) => prims.flatMap((p) => { const g = glowOf(p); return g ? [g, p] : [p]; });

interface Job { el: Element; from: Prim; to: Prim; delay: number; dur: number; path?: ((t: number) => string) | null; ease: (x: number) => number }

const vbLerp = (a: VB, b: VB, t: number): VB => [0, 1, 2, 3].map((i) => a[i] + (b[i] - a[i]) * t) as VB;

/** `vb` = the part of the scene on screen (see view.ts); the svg always fills `box`. A changed `vb` animates (auto-fit
 *  on updates, zoom buttons) unless `instant` (pinch, wheel, drag); a new canvas id snaps to its view. */
function Stage({ scene, canvasId, vb, box, instant = false }: { scene: Scene; canvasId: string; vb: VB; box: { w: number; h: number }; instant?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const liveVb = useRef<{ id: string; vb: VB } | null>(null);
  const vbRaf = useRef(0);
  const els = useRef(new Map<string, Element>());
  const live = useRef(new Map<string, Prim>());
  const prev = useRef<{ id: string; prims: Prim[] } | null>(null);
  const raf = useRef(0);
  const [ghosts, setGhosts] = useState<Prim[]>([]);
  const prims = useMemo(() => expand(scene.prims), [scene]);
  // Which keys enter with this scene; fixed per scene so a re-render (ghosts) does not strip the entrance classes.
  const entering = useMemo(() => {
    const before = prev.current?.id === canvasId ? new Set(prev.current.prims.map((p) => p.key)) : null;
    return before ? new Set(prims.filter((p) => !before.has(p.key)).map((p) => p.key)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prims, canvasId]);
  const reg = (k: string, el: Element | null) => { if (el) els.current.set(k, el); else els.current.delete(k); };

  // The viewBox: its own loop, so pan/zoom never restarts the shape tweens.
  useLayoutEffect(() => {
    cancelAnimationFrame(vbRaf.current);
    const write = (v: VB) => { liveVb.current = { id: canvasId, vb: v }; svgRef.current?.setAttribute('viewBox', v.map((n) => Math.round(n * 100) / 100).join(' ')); };
    const from = liveVb.current?.id === canvasId ? liveVb.current.vb : null;
    if (!from || instant || prefersReducedMotion() || from.every((n, i) => Math.abs(n - vb[i]) < 0.5)) { write(vb); return; }
    const t0 = performance.now();
    const tick = (now: number) => {
      const z = Math.min(1, (now - t0) / TWEEN_MS);
      write(vbLerp(from, vb, easeInOut(z)));
      if (z < 1) vbRaf.current = requestAnimationFrame(tick);
    };
    vbRaf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(vbRaf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId, vb[0], vb[1], vb[2], vb[3], box.w, box.h, instant]);

  useLayoutEffect(() => {
    cancelAnimationFrame(raf.current);
    const reduced = prefersReducedMotion();
    const before = prev.current;
    const isUpdate = before?.id === canvasId;
    const jobs: Job[] = [];
    if (!reduced) {
      if (isUpdate) {
        const { exit } = diffKeys(before.prims, prims);
        const gone = new Set(exit);
        const g = before.prims.filter((p) => gone.has(p.key)).map((p) => ({ ...(live.current.get(p.key) ?? p), key: `ghost:${p.key}`, delay: 0 }));
        setGhosts(g);
        if (g.length) window.setTimeout(() => setGhosts([]), EXIT_MS + 40);
      } else setGhosts([]);
      for (const p of prims) {
        const el = els.current.get(p.key);
        if (!el) continue;
        const old = isUpdate ? live.current.get(p.key) : undefined;
        if (old) {
          const path = p.t === 'path' && old.t === 'path' ? pathLerp(old.d, p.d) : null;
          jobs.push({ el, from: old, to: p, delay: 0, dur: TWEEN_MS, path, ease: easeInOut });
        } else {
          const from = enterFrom(p);
          if (from) jobs.push({ el, from, to: p, delay: Math.min(MAX_STAGGER, p.delay ?? 0), dur: GROW_MS, ease: easeOut });
        }
      }
    } else setGhosts([]);
    for (const j of jobs) writePrim(j.el, lerpPrim(j.from, j.to, 0, j.path ?? undefined));
    const next = new Map(prims.map((p) => [p.key, p]));
    for (const j of jobs) next.set(j.to.key, j.from);
    live.current = next;
    prev.current = { id: canvasId, prims };
    if (!jobs.length) return;
    const t0 = performance.now();
    const tick = (now: number) => {
      let running = false;
      for (const j of jobs) {
        const x = Math.min(1, Math.max(0, (now - t0 - j.delay) / j.dur));
        if (x < 1) running = true;
        const cur = lerpPrim(j.from, j.to, j.ease(x), j.path ?? undefined);
        writePrim(j.el, cur);
        live.current.set(j.to.key, cur);
      }
      if (running) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prims, canvasId]);

  // Model-drawn sketches: content keeps a margin to the sketch's frame; texts that run under a badge drawn after them
  // end before it (again once the font is in).
  useLayoutEffect(() => {
    const run = () => svgRef.current?.querySelectorAll<SVGSVGElement>('svg svg').forEach((el) => { try { padSketch(el); fitSketchText(el); } catch { /* jsdom/no layout */ } });
    if (!prims.some((p) => p.t === 'svg')) return;
    run();
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) run(); });
    return () => { alive = false; };
  }, [prims]);

  const shownVb = liveVb.current?.id === canvasId ? liveVb.current.vb : vb;
  return (
    <svg ref={svgRef} className="cv-svg" width={box.w} height={box.h} viewBox={shownVb.join(' ')} role="img" aria-hidden="true">
      <defs dangerouslySetInnerHTML={{ __html: GLOW_FILTER }} />
      <g key={canvasId}>
        {prims.map((p) => <PrimEl key={p.key} p={p} enter={!entering || entering.has(p.key)} reg={reg} />)}
        {ghosts.map((p) => <PrimEl key={p.key} p={p} enter={false} exit reg={() => {}} />)}
      </g>
    </svg>
  );
}

export default memo(Stage);
