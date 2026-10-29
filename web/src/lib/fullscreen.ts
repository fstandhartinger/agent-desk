import { useCallback, useEffect, useState, type RefObject } from 'react';

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** True when a key press belongs to a text field (shortcuts must not fire there). */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el as HTMLElement).tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true;
}

/** The `F` key toggles fullscreen: plain key, not while typing, not with a modifier. */
export function isFullscreenKey(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented'>, active: Element | null): boolean {
  return (e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.defaultPrevented && !isTypingTarget(active);
}

export const nativeFullscreenElement = (doc: Document = document): Element | null => {
  const d = doc as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
};

/** Requests native fullscreen (standard, then webkit). Resolves false where the API is missing or refuses (iPhone Safari). */
export async function requestNativeFullscreen(el: HTMLElement): Promise<boolean> {
  const e = el as FsEl;
  try {
    if (typeof el.requestFullscreen === 'function') await el.requestFullscreen();
    else if (typeof e.webkitRequestFullscreen === 'function') await e.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    return false;
  }
}

export async function exitNativeFullscreen(doc: Document = document) {
  const d = doc as FsDoc;
  try {
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
    else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen();
  } catch {
    /* already left */
  }
}

/** Portrait screen: the CSS large view (no Fullscreen API) turns the player 90° so the 16:9 stage fills the long side. */
export const isPortrait = (w = window.innerWidth, h = window.innerHeight) => h > w;

/** Android Chrome: native fullscreen may pin the screen to landscape. Best effort, errors are ignored. */
export function lockLandscape(on: boolean) {
  try {
    const o = typeof screen !== 'undefined' ? (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }) : undefined;
    if (on) void o?.lock?.('landscape')?.catch(() => {});
    else o?.unlock?.();
  } catch {
    /* unsupported */
  }
}

/**
 * Pointer position along a track as a 0..1 fraction. When the track sits inside the rotated large view (laid out wide,
 * drawn tall: bounding box taller than wide) the finger moves along the screen's vertical axis, top = start.
 */
export function trackFraction(r: { left: number; top: number; width: number; height: number }, layoutW: number, layoutH: number, clientX: number, clientY: number): number {
  const rotated = layoutW > layoutH && r.height > r.width;
  const f = rotated ? (clientY - r.top) / (r.height || 1) : (clientX - r.left) / (r.width || 1);
  return Math.max(0, Math.min(1, f));
}

/** Stages rescale from a ResizeObserver, but the iframe content and orientation changes also listen for `resize`. */
const nudgeResize = () => requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));

export interface FullscreenControl {
  /** Native fullscreen or the CSS large-view fallback is on. */
  active: boolean;
  /** True when the CSS fallback (not native fullscreen) is showing. */
  large: boolean;
  /** The CSS large view is turned 90° (portrait screen without the Fullscreen API). */
  rotated: boolean;
  toggle: () => void;
  exit: () => void;
}

/**
 * Fullscreen for one container: native Fullscreen API (webkit fallback) with a CSS large view where the API is missing
 * or refuses. The caller styles the container with `fullscreenClass(active)`. Esc leaves the large view (native
 * fullscreen handles Esc itself); `F` toggles when `key` is set.
 */
export function useFullscreen(ref: RefObject<HTMLElement | null>, opts: { key?: boolean } = {}): FullscreenControl {
  const [native, setNative] = useState(false);
  const [large, setLarge] = useState(false);
  const [portrait, setPortrait] = useState(() => isPortrait());
  const active = native || large;
  const rotated = large && !native && portrait;

  const exit = useCallback(() => {
    setLarge(false);
    lockLandscape(false);
    if (ref.current && nativeFullscreenElement() === ref.current) void exitNativeFullscreen();
  }, [ref]);

  const toggle = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (nativeFullscreenElement() === el || large) return exit();
    void requestNativeFullscreen(el).then((ok) => {
      if (ok) lockLandscape(true);
      else setLarge(true);
    });
  }, [ref, large, exit]);

  useEffect(() => {
    const onChange = () => {
      const on = nativeFullscreenElement() === ref.current && ref.current !== null;
      setNative(on);
      if (!on) lockLandscape(false);
      nudgeResize();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [ref]);

  useEffect(() => {
    const onSize = () => setPortrait(isPortrait());
    window.addEventListener('resize', onSize);
    window.addEventListener('orientationchange', onSize);
    return () => {
      window.removeEventListener('resize', onSize);
      window.removeEventListener('orientationchange', onSize);
    };
  }, []);

  useEffect(() => {
    nudgeResize();
  }, [active, large, rotated]);

  useEffect(() => {
    if (!large) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLarge(false);
    };
    window.addEventListener('keydown', onKey);
    // The phone's back gesture/orientation lock should not leave a stuck overlay behind.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [large]);

  useEffect(() => {
    if (!opts.key) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isFullscreenKey(e, document.activeElement)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts.key, toggle]);

  // Leaving the component while fullscreen must not strand the browser in fullscreen.
  useEffect(() => () => {
    const el = ref.current;
    if (el && nativeFullscreenElement() === el) void exitNativeFullscreen();
  }, [ref]);

  return { active, large, rotated, toggle, exit };
}
