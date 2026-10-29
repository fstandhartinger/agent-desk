// Shared adapter plumbing. An adapter is `createAdapter(opts, emit) -> {sendAudio, sendText, interrupt,
// sendToolResult, close}` and reports normalised events through `emit`:
//   {t:'ready', model} {t:'audio', pcm} {t:'transcript', role, delta?, text?, final}
//   {t:'speech_started'} {t:'turn_done'} {t:'tool_call', id, name, args}
//   {t:'error', message, status?, code?, fallback?} {t:'closed'}
import WebSocket from 'ws';
import { markFailure, markOk } from '../providerHealth.js';

export const FALLBACK = 'gemini';
const CREDIT_MESSAGES = {
  xai: 'Grok Voice ist gerade nicht verfügbar (xAI-Guthaben aufgebraucht)',
  openai: 'OpenAI Voice ist gerade nicht verfügbar (OpenAI-Guthaben aufgebraucht)',
  gemini: 'Gemini Voice ist gerade nicht verfügbar (Zugriff verweigert)',
};
const LABELS = { xai: 'Grok Voice', openai: 'OpenAI Voice', gemini: 'Gemini Voice' };
const CLOSE_REASONS = {
  1002: 'Protokollfehler',
  1003: 'Datenformat nicht unterstützt',
  1006: 'Verbindung unerwartet abgebrochen',
  1007: 'Anfrage vom Anbieter abgelehnt (ungültige Daten)',
  1008: 'Zugriff vom Anbieter verweigert',
  1009: 'Nachricht zu groß',
  1011: 'interner Fehler beim Anbieter',
  1012: 'Anbieter startet neu',
  1013: 'Anbieter überlastet, bitte später erneut versuchen',
};
const QUOTA_REASON = /quota|billing|credit|exhausted|insufficient/i;
const CREDIT_CODES = new Set(['credit_balance_exhausted', 'insufficient_quota', 'billing_hard_limit_reached']);

/** Maps an auth/billing failure (HTTP 401/402/403 or a credit error event) to the browser error with fallback. */
export function unavailableError(provider, { status, code } = {}) {
  const denied = status === 401 || status === 402 || status === 403 || CREDIT_CODES.has(code);
  if (!denied) return null;
  return { t: 'error', message: CREDIT_MESSAGES[provider], status, code, fallback: provider === FALLBACK ? undefined : FALLBACK };
}

/** Maps an abnormal vendor close (code + vendor reason) to the browser error: "<Provider>: <German reason>". */
export function closeError(provider, code, reason = '') {
  const detail = String(reason).replace(/\s+/g, ' ').slice(0, 140);
  if (QUOTA_REASON.test(detail)) return unavailableError(provider, { status: 402 });
  const why = CLOSE_REASONS[code] ?? `Verbindung mit Code ${code} beendet`;
  return { t: 'error', message: `${LABELS[provider]}: ${why}${detail ? ` (${detail})` : ''}`, code: String(code) };
}

/**
 * Opens the vendor socket. Handshake rejections and socket errors are emitted as errors. `onMessage(msg, emit)`
 * must emit translated events through the given `emit`, which feeds providerHealth.
 */
export function openSocket(url, headers, { provider, emit: rawEmit, onOpen, onMessage }) {
  const emit = (e) => {
    if (e.t === 'ready') markOk(provider);
    else if (e.t === 'error' && !e.soft) markFailure(provider, e.message);
    rawEmit(e);
  };
  const ws = new WebSocket(url, { headers, handshakeTimeout: 10_000 });
  let failed = false;
  const fail = (err) => {
    if (failed) return;
    failed = true;
    emit(err);
    ws.terminate();
  };
  ws.on('unexpected-response', (_req, res) => {
    res.resume();
    fail(unavailableError(provider, { status: res.statusCode }) ?? { t: 'error', message: `Voice-Anbieter nicht erreichbar (HTTP ${res.statusCode})`, status: res.statusCode });
  });
  ws.on('error', () => fail({ t: 'error', message: 'Verbindung zum Voice-Anbieter fehlgeschlagen' }));
  ws.on('open', onOpen);
  ws.on('message', (data) => { // Gemini sends its JSON as binary frames
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    onMessage(msg, emit);
  });
  ws.on('close', (code, reason) => {
    if (!failed && code !== 1000 && code !== 1005) emit(closeError(provider, code, reason.toString()));
    emit({ t: 'closed' });
  });
  return ws;
}

export const toolsOf = (defs) => defs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));

export function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * Collects tool results and releases them together: xAI/OpenAI want every function_call_output before one
 * response.create. `release(results)` runs once nothing is pending and the current response has finished.
 */
export class ToolBatch {
  constructor(release, releaseStale = () => {}) {
    this.release = release;
    this.releaseStale = releaseStale; // outputs of calls whose question was overtaken by a new one: kept in the conversation, no new response
    this.pending = 0;
    this.results = [];
    this.responseOpen = false;
  }
  call() { this.pending++; this.responseOpen = true; }
  result(r) {
    this.pending = Math.max(0, this.pending - 1);
    if (r.stale) this.releaseStale([r]);
    else this.results.push(r);
    this.flush();
  }
  responseDone() { this.responseOpen = false; this.flush(); }
  flush() {
    if (this.pending > 0 || this.responseOpen || !this.results.length) return;
    const out = this.results;
    this.results = [];
    this.release(out);
  }
}

/**
 * Round 10 (critic r9 F4): a voice model that got its tool results but stays silent. `arm()` after the results went out;
 * any sign of an answer (audio, assistant transcript, a new tool call) calls `clear()`. When `ms()` pass without one, `fire()`
 * runs (the adapter asks for the answer again), at most `max` times per arm.
 */
export function createWatchdog(ms, fire, { max = 2 } = {}) {
  let timer = null;
  let left = max;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (left <= 0) return;
      left -= 1;
      fire(max - left);
      start();
    }, ms());
    timer.unref?.();
  };
  return {
    arm() { left = max; start(); },
    clear() { clearTimeout(timer); timer = null; },
    get armed() { return timer !== null; },
  };
}
