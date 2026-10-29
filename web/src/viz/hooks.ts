import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from './theme';

/** Content-box size of an element, updated by ResizeObserver (no polling, no layout reads per frame). */
export function useSize<T extends HTMLElement>(ref: RefObject<T | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (width: number, height: number) =>
      setSize((s) => (Math.abs(s.width - width) < 1 && Math.abs(s.height - height) < 1 ? s : { width, height }));
    set(el.clientWidth, el.clientHeight);
    const ro = new ResizeObserver(([e]) => set(e.contentRect.width, e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Typewriter: reveals `text` at `cps` characters per second (explainer anim "type"). */
export function useTypewriter(text: string, cps = 70): string {
  const [n, setN] = useState(text.length);
  useEffect(() => {
    if (prefersReducedMotion() || !text) { setN(text.length); return; }
    const t0 = performance.now();
    const dur = Math.min(1600, (text.length / cps) * 1000);
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      setN(Math.round(text.length * k));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    setN(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, cps]);
  return text.slice(0, n);
}

/** Seconds since `since` (ms epoch), ticking once per second while `running`. */
export function useElapsed(since: number | null, until: number | null, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  if (since == null) return 0;
  return Math.max(0, Math.round(((until ?? (running ? now : since)) - since) / 1000));
}

/** Latest value of a prop for use inside rAF loops without restarting them. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
