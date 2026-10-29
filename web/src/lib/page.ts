import { createStore } from './store';
import type { PageContext } from './types';
import type { Explainer, Point } from './explainer';
import { buildContext } from './explainer';

// The explainer panel registers its player here so chat, voice and Claude can read the live context
// (current time is read on demand instead of being pushed through React 60x per second).
export interface Player {
  time(): number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  paused(): boolean;
}

export interface PageState {
  explainer: Explainer | null;
  sceneId: string | null;
  pointId: string | null;
  /** The user attached the selected point to the composer (context chip). */
  attached: boolean;
  /** Slug the explainer panel shows or is loading (deep link); null = no explainer, the canvas takes the big column. */
  slug?: string | null;
}

export const pageStore = createStore<PageState>({ explainer: null, sceneId: null, pointId: null, attached: false, slug: new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get('x') });

let player: Player | null = null;
export const registerPlayer = (p: Player | null) => {
  player = p;
};
export const getPlayer = () => player;

export function selectPoint(pointId: string | null) {
  pageStore.set((s) => ({ ...s, pointId, attached: pointId !== null }));
}

export function selectedPoint(): (Point & { id: string }) | null {
  const { explainer, pointId } = pageStore.get();
  const p = pointId && explainer?.points.points[pointId];
  return p && pointId ? { ...p, id: pointId } : null;
}

/** Context sent with every chat/voice/Claude request; null without a loaded explainer. */
export function currentContext(): PageContext | undefined {
  const { explainer, pointId, attached } = pageStore.get();
  if (!explainer) return undefined;
  return buildContext(explainer, player?.time() ?? 0, attached ? pointId : null);
}
