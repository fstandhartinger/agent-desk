// Footnote text for a CanvasSpec source: paths shrink to "file · job", board refs to "#22 · Eintrag 25697".
import type { CanvasBy, CanvasSource } from './types';

export function shortRef(ref: string): string {
  const r = ref.trim();
  if (!r || /^gespräch$/i.test(r)) return 'Gespräch';
  const board = /^(?:board[\s:#/-]*)?#?(\d{1,4})(?:\s*(?:[/:·,]|entry|eintrag)\s*#?(\d{2,8}))?$/i.exec(r)
    ?? /board.*?#?(\d{1,4}).*?(?:entry|eintrag|id|\/|:)\s*#?(\d{2,8})/i.exec(r);
  if (board) return board[2] ? `#${board[1]} · Eintrag ${board[2]}` : `Board #${board[1]}`;
  if (/^https?:\/\//i.test(r)) {
    try {
      const u = new URL(r);
      const tail = u.pathname.split('/').filter(Boolean).pop();
      return tail ? `${u.hostname} · ${decodeURIComponent(tail)}` : u.hostname;
    } catch { return r; }
  }
  if (r.includes('/')) {
    const parts = r.replace(/\/+$/, '').split('/');
    const file = parts.pop() ?? r;
    const job = /\/jobs\/([^/]+)/.exec(r)?.[1] ?? /\/(?:work|Dev|apps)\/([^/]+)/.exec(r)?.[1];
    return job && job !== file ? `${file} · ${job}` : file;
  }
  return r;
}

/** Label and short ref, without saying the same thing twice. */
export function footnote(s: CanvasSource): { text: string; title: string } {
  const short = shortRef(s.ref);
  const label = (s.label || '').trim();
  const same = !label || label === short || short.startsWith(label) || label.includes(short);
  return { text: same ? (label.length > short.length ? label : short) : `${label} — ${short}`, title: s.ref };
}

const PROVIDER: Record<string, string> = { xai: 'Grok', grok: 'Grok', openai: 'GPT-Live', gemini: 'Gemini', google: 'Gemini' };

/** The by-badge text: Text / Grok / GPT-Live / Gemini / Claude / Auto. */
export function byLabel(by: CanvasBy | undefined, provider?: string): string {
  if (by === 'voice') return PROVIDER[(provider ?? '').toLowerCase()] ?? 'Stimme';
  if (by === 'claude') return 'Claude';
  if (by === 'auto') return 'Auto';
  return 'Text';
}
