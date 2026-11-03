// Errors the UI shows to Florian (toasts, the voice dock) also reach the session trace as client.error {what, reason}.
// The path is the voice socket's client_event channel; without an open socket they wait here (20 at most) for the next session.
// reason is the text that was shown, never audio, images or tokens; the gateway redacts and bounds it again.
export interface ClientErrorData { what: string; reason: string }
interface Queued { ts: number; data: ClientErrorData }

let sink: ((data: ClientErrorData) => boolean) | null = null;
const queue: Queued[] = [];
const cut = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);

/** `send` returns false when no socket is open; the error is then kept for the next session. */
export function setClientErrorSink(send: ((data: ClientErrorData) => boolean) | null) { sink = send; }

let last = { key: '', at: 0 };

export function reportClientError(what: string, reason: unknown) {
  const data = { what: cut(what, 40), reason: cut(reason, 300) };
  const key = data.reason, at = Date.now();
  if (last.key === key && at - last.at < 2000) return; // the toast and the activity line of one error are one error
  last = { key, at };
  try { if (sink?.(data)) return; } catch { /* a broken sink must not hide the error: it is queued */ }
  if (queue.length >= 20) queue.shift();
  queue.push({ ts: Date.now(), data });
}

/** Called by a session whose socket just opened: the waiting errors, oldest first. */
export const drainClientErrors = (): Queued[] => queue.splice(0);
