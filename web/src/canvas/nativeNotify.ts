// Inside the Windows app only: tells the native host that a drawing started, once per drawing id, so it can show the
// small drawing window. Pure: the host and the bus event are passed in.
import { toMs } from './bus';
import type { CanvasBusEvent } from './types';

export const CANVAS_TITLE_MAX = 80;
const ANNOUNCED_MAX = 200;
const REPLAY_MS = 120_000; // a page load replays the bus ring: drawings of earlier sessions must not open the window

/** Returns a handler for bus events. `host()` is the native host or undefined (normal browser: nothing is ever posted). */
export function canvasPendingNotifier(host: () => { postMessage(message: unknown): void } | undefined, now: () => number = Date.now) {
  const announced = new Set<string>();
  return (ev: CanvasBusEvent) => {
    if (ev.phase !== 'pending' && ev.phase !== 'ready') return;
    if (typeof ev.id !== 'string' || announced.has(ev.id)) return;
    if (now() - toMs(ev.at) > REPLAY_MS) return;
    const h = host();
    if (!h) return;
    announced.add(ev.id);
    if (announced.size > ANNOUNCED_MAX) announced.delete(announced.values().next().value as string);
    const raw = ev.spec?.title ?? ev.title;
    const title = typeof raw === 'string' ? raw.trim().slice(0, CANVAS_TITLE_MAX) : '';
    h.postMessage({ type: 'canvas-pending', title });
  };
}
