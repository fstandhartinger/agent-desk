import { nativeHost } from './companion';
// Same-origin JSON API helpers. Cookie auth; nothing secret ever lives in the browser.
export class ApiError extends Error {
  status: number;
  /** Seconds until the server accepts the request again (Retry-After), if it said so. */
  retryAfter?: number;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const STATUS_TEXT: Record<number, string> = {
  401: 'Nicht angemeldet – bitte neu einloggen.',
  402: 'Tageslimit erreicht – neue kostenpflichtige Arbeit ist für heute gesperrt.',
  403: 'Zugriff verweigert.',
  413: 'Die Datei ist zu groß.',
  429: 'Zu viele Anfragen – bitte kurz warten.',
  502: 'Der Dienst antwortet gerade nicht.',
  503: 'Der Dienst ist gerade nicht verfügbar.',
};

// Older gateways answer in English; the user only ever sees German.
const ENGLISH: [RegExp, string][] = [
  [/^invalid code$/i, 'Dieser Zugangscode stimmt nicht.'],
  [/^too many attempts$/i, 'Zu viele Versuche.'],
  [/^login not configured$/i, 'Der Login ist auf dem Server nicht eingerichtet.'],
  [/^(login required|not authenticated|unauthori[sz]ed)$/i, STATUS_TEXT[401]],
  [/^bad origin$/i, 'Anfrage von einer fremden Seite abgelehnt.'],
  [/rate limit|too many requests/i, STATUS_TEXT[429]],
  [/daily .*cap|spend cap|cost cap/i, STATUS_TEXT[402]],
  [/daily Claude start limit/i, 'Tageslimit für neue Claude-Sitzungen erreicht.'],
  [/bridge (is )?(offline|disconnected)|no bridge/i, 'Die Bridge zum Workshop ist gerade nicht verbunden.'],
  [/session not found|unknown session/i, 'Diese Sitzung gibt es nicht (mehr).'],
  [/^method not allowed$/i, 'Diese Aktion ist hier nicht erlaubt.'],
];

export function germanError(detail: string, status: number): string {
  const text = detail.trim();
  for (const [re, de] of ENGLISH) if (re.test(text)) return de;
  return text || STATUS_TEXT[status] || `Fehler ${status} – bitte erneut versuchen.`;
}

/** "in 40 s", "in 15 min", "in 2 h" for a Retry-After value in seconds. */
export function fmtRetry(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `in ${s} s`;
  if (s < 5400) return `in ${Math.ceil(s / 60)} min`;
  return `in ${Math.round(s / 3600)} h`;
}

/** The message plus when to try again, unless the server already said so. */
export function withRetry(message: string, retryAfter?: number): string {
  if (!retryAfter || /\b(in \d|Minute|Sekunde|Stunde|morgen)/i.test(message)) return message;
  return `${message.replace(/[.\s]+$/, '')} – erneut möglich ${fmtRetry(retryAfter)}.`;
}

export async function errorFrom(res: Response): Promise<ApiError> {
  let detail = '';
  try {
    const body = await res.json();
    detail = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : '';
  } catch {
    /* non-JSON error body */
  }
  if (res.status === 401 && !res.url.endsWith('/api/auth/login')) window.dispatchEvent(new Event('desk:unauthorized'));
  const retry = Number(res.headers.get('retry-after'));
  const retryAfter = Number.isFinite(retry) && retry > 0 ? retry : undefined;
  return new ApiError(res.status, withRetry(germanError(detail, res.status), retryAfter), retryAfter);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (!res.ok) throw await errorFrom(res);
  const type = res.headers.get('content-type') || '';
  return (type.includes('json') ? await res.json() : undefined) as T;
}

export const auth = {
  me: async () => {
    const result = await api<{ ok: boolean; sid: string }>('/api/auth/me');
    if (new URLSearchParams(location.search).get('companion') === '1') nativeHost()?.postMessage({ type: 'session', sid: result.sid });
    return result;
  },
  login: (code: string) => api<{ ok: boolean }>('/api/auth/login', { method: 'POST', json: { code } }),
  logout: () => api<void>('/api/auth/logout', { method: 'POST' }),
};

export async function transcribe(blob: Blob): Promise<string> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  if (!res.ok) throw await errorFrom(res);
  const { text } = (await res.json()) as { text?: string };
  return (text || '').trim();
}

export const errorMessage = (e: unknown) =>
  e instanceof Error ? (e.name === 'TypeError' ? 'Keine Verbindung zum Server.' : e.message) : String(e);

/**
 * "Verwerfen" on a proposal card: tells the gateway to drop the stored proposal (POST {id}, cookie, same-origin).
 * Best effort: the card is already settled in the browser; a failed call only means the proposal expires on its own (24 h).
 */
export async function discardOnServer(url: string, proposalId: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proposalId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
