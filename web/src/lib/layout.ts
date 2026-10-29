import { createStore } from './store';
import { clamp } from './format';
import { load, save } from './storage';

// Desktop layout: two slots next to the chat — the big one (left) and the small one (right) — plus Kino mode, where
// the explainer stage fills the desk and the chat floats over it. Which pane sits in which slot follows the content:
// without an explainer the canvas takes the big slot ("canvas first"); with one, the explainer is big and the canvas
// small, until the user picks "Groß" on the canvas (canvasBig), which swaps them without remounting anything.
export interface Layout {
  /** Big slot share of the row with three panes (explainer · chat · canvas). */
  leftShare: number;
  /** Small slot width in px. */
  right: number;
  /** Big slot open. Only collapsible when it is the only pane (canvas first, no explainer). */
  leftOpen: boolean;
  /** Small slot open (collapsed = a 48 px rail). */
  rightOpen: boolean;
  /** Canvas in the big slot while an explainer is loaded. */
  canvasBig?: boolean;
  /** Big slot share with two panes (canvas · chat). */
  soloShare?: number;
}
export type Pane = 'explainer' | 'live';
export const CHAT_MIN = 360;
export const OVERLAY_W = 400;
const COLLAPSED = 48;
export const LAYOUT_KEY = 'desk.layout.v4';

/** Stage as hero: ~45 % of a wide screen for the explainer, the Live panel only when there is room for it. */
export function defaultLayout(vw: number): Layout {
  const right = vw >= 1600 ? 420 : 360;
  const rightOpen = vw >= 1280;
  const leftShare = vw >= 1280 ? 0.45 : 520 / Math.max(vw, 1024);
  return { leftShare, right, leftOpen: true, rightOpen, canvasBig: false, soloShare: 0.6 };
}

/** Which pane is in which slot. */
export function arrange(l: Layout, explainerOn: boolean): { big: Pane; small: Pane | null } {
  if (!explainerOn) return { big: 'live', small: null };
  return l.canvasBig ? { big: 'live', small: 'explainer' } : { big: 'explainer', small: 'live' };
}

/** Widths that actually fit the row: the chat column never drops below CHAT_MIN, so nothing scrolls sideways. With
 *  `solo` (no small slot) the big slot takes ~60 % of the row. */
export function fitLayout(l: Layout, rowWidth: number, solo = false): { left: number; right: number; rightOpen: boolean } {
  if (solo) {
    if (!l.leftOpen) return { left: COLLAPSED, right: 0, rightOpen: false };
    const max = Math.max(340, rowWidth - CHAT_MIN - 16);
    return { left: Math.round(clamp((l.soloShare ?? 0.6) * rowWidth, 340, max)), right: 0, rightOpen: false };
  }
  const leftMin = 340;
  const rightRoom = rowWidth - CHAT_MIN - leftMin - 16;
  const rightOpen = l.rightOpen && rightRoom >= 320;
  const right = rightOpen ? clamp(l.right, 320, Math.min(640, rightRoom)) : COLLAPSED;
  const room = rowWidth - CHAT_MIN - right - 16;
  return { left: Math.round(clamp(Math.min(l.leftShare * rowWidth, room), 340, Math.max(340, rowWidth * 0.62))), right, rightOpen };
}

/** Collapsing the pane in the big slot hands that slot to the other pane (the collapsed one becomes the small rail);
 *  only a lone canvas collapses in place. */
export function collapse(l: Layout, slot: 'big' | 'small', explainerOn: boolean): Layout {
  if (slot === 'small') return { ...l, rightOpen: false };
  if (!explainerOn) return { ...l, leftOpen: false };
  return { ...l, canvasBig: !l.canvasBig, rightOpen: false };
}

/** Makes sure the canvas is visible (new drawing, Claude task): opens its slot if it is collapsed. */
export function revealLive(l: Layout, explainerOn: boolean): Layout {
  const a = arrange(l, explainerOn);
  if (a.small === 'live' && !l.rightOpen) return { ...l, rightOpen: true };
  if (a.big === 'live' && !l.leftOpen) return { ...l, leftOpen: true };
  return l;
}

const initial = (): Layout => ({ ...defaultLayout(typeof innerWidth === 'number' ? innerWidth : 1440), ...load<Partial<Layout>>(LAYOUT_KEY, {}) });
export const layoutStore = createStore<Layout>(initial());
layoutStore.subscribe(() => save(LAYOUT_KEY, layoutStore.get()));
export const toggleCanvasBig = () => layoutStore.set((l) => ({ ...l, canvasBig: !l.canvasBig, rightOpen: true, leftOpen: true }));

/** Floating explainer picker while no explainer is loaded (desktop "Erklärung laden"). */
export const pickerStore = createStore<{ open: boolean }>({ open: false });
export const setPicker = (open: boolean) => pickerStore.set({ open });

export const kinoStore = createStore<{ kino: boolean; chat: boolean }>({ kino: false, chat: true });
export const toggleKino = () => {
  // Kino is the explainer's big stage: entering it from "canvas big" hands the big slot back to the explainer.
  if (!kinoStore.get().kino && layoutStore.get().canvasBig) layoutStore.set((l) => ({ ...l, canvasBig: false }));
  kinoStore.set((s) => ({ kino: !s.kino, chat: true }));
};
export const setKinoChat = (chat: boolean) => kinoStore.set((s) => ({ ...s, chat }));
