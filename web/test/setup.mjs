// node --test runs the TypeScript lib modules directly (Node 24 type stripping). This file adds the two things the
// browser has and Node lacks: extensionless relative imports (Vite resolves them) and window/localStorage.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (/^\\.\\.?\\//.test(spec) && !/\\.[cm]?[jt]sx?$/.test(spec) && ctx.parentURL?.endsWith('.ts')) {
      try { return await next(spec + '.ts', ctx); } catch {}
    }
    return next(spec, ctx);
  }
`));

class MemoryStorage {
  #m = new Map();
  get length() { return this.#m.size; }
  key(i) { return [...this.#m.keys()][i] ?? null; }
  getItem(k) { return this.#m.has(k) ? this.#m.get(k) : null; }
  setItem(k, v) { this.#m.set(k, String(v)); }
  removeItem(k) { this.#m.delete(k); }
  clear() { this.#m.clear(); }
}

const events = new EventTarget();
Object.assign(globalThis, {
  window: globalThis,
  localStorage: new MemoryStorage(),
  sessionStorage: new MemoryStorage(),
  addEventListener: events.addEventListener.bind(events),
  removeEventListener: events.removeEventListener.bind(events),
  dispatchEvent: events.dispatchEvent.bind(events),
});
