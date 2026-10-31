import { artifactUrl, parseArtifactUrl } from './artifactUrl';
// Gate "login link" UX (docs/CANVAS.md "Login UX gap"): someone opens the desk from an explainer page without a
// session; the gate can ask the gateway to send a fresh login link via Telegram that leads back to the same place.
import { ApiError, api, errorMessage, fmtRetry } from './api';

/** The path+query to come back to, when the URL is an explainer deep link (`?x=<slug>`); otherwise null. */
export function deepLinkNext(loc: { pathname: string; search: string }): string | null {
  if (loc.pathname === '/device') return '/device';
  const q = new URLSearchParams(loc.search);
  if (loc.pathname === '/' && q.get('companion') === '1') {
    q.delete('k');
    return `/?${q}`;
  }
  const artifact = parseArtifactUrl(`${loc.pathname}${loc.search}`);
  if (artifact.ids.length) return artifactUrl(artifact.ids, artifact.voice ?? undefined, artifact.question || undefined);
  const slug = q.get('x');
  if (!slug || !/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  q.delete('k');
  const search = q.toString();
  return `${loc.pathname || '/'}${search ? `?${search}` : ''}`;
}

export type LinkResult = { ok: true; text: string } | { ok: false; text: string; retryAfter?: number };

export async function requestLoginLink(next: string, post = (body: { next: string }) => api<{ ok?: boolean; error?: string }>('/api/auth/request-link', { method: 'POST', json: body })): Promise<LinkResult> {
  try {
    const r = await post({ next });
    if (r && r.ok === false) return { ok: false, text: r.error || 'Der Link konnte nicht geschickt werden.' };
    return { ok: true, text: 'Neuer Login-Link ist unterwegs – öffne ihn in Telegram. Er bringt dich genau hierher zurück.' };
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) {
      const base = /zu viele anfragen/i.test(e.message) || !e.message ? 'Es wurde gerade erst ein Link geschickt.' : e.message;
      return { ok: false, text: e.retryAfter && !/erneut möglich/i.test(base) ? `${base.replace(/[.\s]+$/, '')} – erneut möglich ${fmtRetry(e.retryAfter)}.` : base, retryAfter: e.retryAfter };
    }
    if (e instanceof ApiError && (e.status === 502 || e.status === 503)) return { ok: false, text: 'Telegram ist gerade nicht erreichbar – bitte gleich noch einmal versuchen.' };
    return { ok: false, text: errorMessage(e) };
  }
}
