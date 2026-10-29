export const fmtTime = (s: number) => {
  const v = Math.max(0, Number.isFinite(s) ? s : 0);
  return `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
};

export const fmtUsd = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}`;

export const fmtClock = (ts: number) =>
  new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function fmtAgo(ts: number, now = Date.now()) {
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: 'short' });
}

export const fmtDuration = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);

export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "1 Zug", "2 Züge". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Short, readable model name: "deepseek/deepseek-v4.1-flash-20261017:nitro" → "deepseek-v4.1-flash". */
export const modelLabel = (model: string) => (model.split('/').pop() ?? model).replace(/:.*$/, '').replace(/-\d{8}$/, '');
