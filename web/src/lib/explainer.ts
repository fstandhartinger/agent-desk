import type { PageContext } from './types';
import { load, save } from './storage';

// Shapes published by the explainer-video-webpage skill (timeline.json / points.json).
export interface Word { w: string; s: number; e: number; scene: string }
export interface Scene { id: string; start: number; end: number; text?: string }
export interface Timeline { title?: string; duration: number; scenes: Scene[]; words: Word[] }
export interface Point { title: string; short?: string; more?: string; sources?: string[] }
export interface Points { page: { title?: string; subtitle?: string; lang?: string }; points: Record<string, Point> }
export interface EndFrame { id: string; start: number; end: number; endFrame: string; text?: string }
export interface Explainer { cardId?: number; endFrames?: EndFrame[]; slug: string; timeline: Timeline; points: Points; sentences: number[][] }

export const SLUG_RE = /^[a-z0-9-]{3,80}$/;
export const assetUrl = (slug: string, file: string) => `/api/explainer/${slug}/${file}`;

/** Accepts a bare slug or any explainer URL (…/p/<slug>/…, …?x=<slug>). */
export function parseSlug(input: string): string | null {
  const s = input.trim();
  const fromUrl = s.match(/\/p\/([a-z0-9-]{3,80})/) || s.match(/[?&]x=([a-z0-9-]{3,80})/);
  const slug = fromUrl ? fromUrl[1] : s.toLowerCase();
  return SLUG_RE.test(slug) ? slug : null;
}

async function getJSON<T>(slug: string, file: string): Promise<T> {
  const res = await fetch(assetUrl(slug, file), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 404 ? 'Diese Erklärseite gibt es nicht.' : `Laden fehlgeschlagen (${res.status}).`);
  return res.json() as Promise<T>;
}

/** Splits narration into caption sentences (same rule as the published player). */
export function splitSentences(words: Word[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    cur.push(i);
    if (/[.!?:]$/.test(w.w) || i === words.length - 1 || words[i + 1].scene !== w.scene) {
      out.push(cur);
      cur = [];
    }
  });
  return out;
}

export async function loadExplainer(slug: string): Promise<Explainer> {
  const [timeline, points, metadata, card] = await Promise.all([
    getJSON<Timeline>(slug, 'timeline.json'),
    getJSON<Points>(slug, 'points.json').catch(() => ({ page: {}, points: {} }) as Points),
    getJSON<{ scenes?: EndFrame[] }>(slug, 'metadata.json').catch(() => null),
    loadCardId(slug),
  ]);
  timeline.scenes ||= [];
  timeline.words ||= [];
  return { slug, timeline, points, cardId: card, endFrames: Array.isArray(metadata?.scenes) ? metadata.scenes : [], sentences: splitSentences(timeline.words) };
}

export async function loadCardId(slug: string): Promise<number | undefined> {
  const card = await getJSON<{ card_id?: unknown }>(slug, 'card.json').catch(() => null);
  return typeof card?.card_id === 'number' && Number.isSafeInteger(card.card_id) && card.card_id > 0 ? card.card_id : undefined;
}

/** Only allow the frame paths the publisher generates, under this explainer's authenticated proxy. */
export function endFrameAt(x: Explainer, t: number) {
  const scene = sceneAt(x, t);
  return x.endFrames?.find((s) => s.id === scene?.id && /^end-frames\/\d{3}\.png$/.test(s.endFrame));
}

export function slideTextAt(x: Explainer, t: number) {
  const scene = sceneAt(x, t);
  if (!scene) return '';
  return endFrameAt(x, t)?.text || [x.points.points[scene.id]?.title || scene.id, scene.text].filter(Boolean).join('\n\n');
}

export const titleOf = (x: Explainer) => x.points.page.title || x.timeline.title || x.slug;

export function sceneAt(x: Explainer, t: number) {
  const { scenes } = x.timeline;
  if (!scenes.length) return undefined;
  if (t < scenes[0].start) return scenes[0];
  return scenes.find((s) => t >= s.start && t < s.end) ?? scenes[scenes.length - 1];
}

/** Stage time shown before the first play: the first scene once its opening animation has settled, not a blank t=0. */
export function posterTime(x: Explainer): number {
  const first = x.timeline.scenes[0];
  if (!first) return 0;
  return first.start + Math.min(4.5, (first.end - first.start) * 0.5);
}

export function buildContext(x: Explainer, t: number, pointId?: string | null): PageContext {
  const scene = sceneAt(x, t);
  const near = x.timeline.words.filter((w) => w.s >= t - 20 && w.e <= t + 20).map((w) => w.w).join(' ');
  const p = pointId ? x.points.points[pointId] : undefined;
  return {
    slug: x.slug,
    title: titleOf(x),
    t: Math.round(t * 10) / 10,
    sceneId: scene?.id,
    ...(p && pointId ? { pointId, point: { title: p.title, short: p.short, more: p.more } } : {}),
    transcriptNear: near,
  };
}

const RECENT_KEY = 'desk.recentExplainers.v1';
export interface Recent { slug: string; title: string; at: number; cardId?: number }
export const recentExplainers = () => load<Recent[]>(RECENT_KEY, []);
export function rememberExplainer(slug: string, title: string, cardId?: number) {
  const next = [{ slug, title, cardId, at: Date.now() }, ...recentExplainers().filter((r) => r.slug !== slug)].slice(0, 8);
  save(RECENT_KEY, next);
}
