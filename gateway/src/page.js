import { fetchExplainerJson } from './explainer.js';
import { loadPack } from './pack.js';

const CONTEXT_MAX = 12_000;
const WINDOW_S = 20;

/**
 * Server-side page context: everything comes from the published points.json / timeline.json, nothing the browser
 * sends is trusted except slug, t, sceneId and pointId.
 */
export async function loadPageContext(page) {
  if (!page || typeof page.slug !== 'string') return null;
  const [points, timeline] = await Promise.all([fetchExplainerJson(page.slug, 'points.json'), fetchExplainerJson(page.slug, 'timeline.json')]);
  if (!points && !timeline) return null;

  const t = Number.isFinite(page.t) ? page.t : 0;
  const scene = timeline?.scenes?.find((s) => t >= s.start && t < s.end);
  const pointId = typeof page.pointId === 'string' ? page.pointId : undefined;
  const entry = pointId ? points?.points?.[pointId] : undefined;
  const transcriptNear = (timeline?.words || [])
    .filter((w) => w.e >= t - WINDOW_S && w.s <= t + WINDOW_S)
    .map((w) => w.w)
    .join(' ');

  const pack = await loadPack(page.slug, points, timeline).catch(() => null);
  const loaded = {
    slug: page.slug,
    title: points?.page?.title || timeline?.title || page.slug,
    t,
    sceneId: typeof page.sceneId === 'string' ? page.sceneId : scene?.id,
    pointId,
    point: entry ? { title: entry.title, short: entry.short, more: entry.more } : undefined,
    context: String(points?.page?.context || '').slice(0, CONTEXT_MAX),
    transcriptNear,
  };
  // The pack (full narration + deep-dive) is model-only: non-enumerable, so JSON.stringify, spreads (illustrator corpora, claude.start,
  // browser-facing events) never carry it; only the instruction builders read `page.pack`.
  Object.defineProperty(loaded, 'pack', { value: pack, enumerable: false });
  return loaded;
}
