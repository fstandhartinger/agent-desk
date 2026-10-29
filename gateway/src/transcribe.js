import { audit } from './audit.js';
import { cfg } from './config.js';
import { readBody, sendJson } from './http.js';
import { TEXT } from './messages.js';
import { markFailure, markOk } from './providerHealth.js';
import { short } from './redact.js';

const MAX_BYTES = 10 * 1024 * 1024;
const EXTENSIONS = { 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' };
const PREFERENCE = ['gpt-live-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
export const TRANSCRIBE_MODELS = { primary: 'scribe_v2', fallback: PREFERENCE }; // desk facts (deskStatus.js)
const MODEL_LIST_TTL_MS = 60 * 60_000;

let available = { at: 0, ids: new Set() };
let working = null;

async function availableModels() {
  if (Date.now() - available.at < MODEL_LIST_TTL_MS) return available.ids;
  const response = await fetch(`${cfg.openaiBase()}/models`, { headers: { authorization: `Bearer ${cfg.openaiKey()}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw Object.assign(new Error(TEXT.transcribeFailed), { status: 502 });
  available = { at: Date.now(), ids: new Set((await response.json()).data.map((m) => m.id)) };
  return available.ids;
}

async function transcribeWith(model, audio, type) {
  const form = new FormData();
  form.set('model', model);
  form.set('language', 'de');
  form.set('response_format', 'json');
  form.set('file', new Blob([audio], { type }), `audio.${EXTENSIONS[type]}`);
  return fetch(`${cfg.openaiBase()}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${cfg.openaiKey()}` }, body: form, signal: AbortSignal.timeout(60_000) });
}

/** ElevenLabs Scribe (primary since 24 Oct 2026: ~0.6 s for a German sentence; OpenAI had no credit). */
async function transcribeEleven(audio, type) {
  const form = new FormData();
  form.set('model_id', TRANSCRIBE_MODELS.primary);
  form.set('language_code', 'deu');
  form.set('tag_audio_events', 'false');
  form.set('file', new Blob([audio], { type }), `audio.${EXTENSIONS[type]}`);
  const response = await fetch(`${cfg.elevenBase()}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': cfg.elevenKey() }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    if ([401, 402, 403].includes(response.status)) markFailure('elevenlabs', 'Zugang abgelehnt oder kein Guthaben');
    throw Object.assign(new Error(TEXT.transcribeFailed), { status: 502, detail: `elevenlabs status ${response.status}` });
  }
  markOk('elevenlabs');
  return { text: String((await response.json()).text ?? '').trim(), model: 'elevenlabs/scribe_v2' };
}

/** ElevenLabs first, then the OpenAI models; the last error wins. */
async function transcribeAny(audio, type) {
  if (cfg.elevenKey()) {
    try { return await transcribeEleven(audio, type); } catch (err) { if (!cfg.openaiKey()) throw err; }
  }
  return transcribe(audio, type);
}

/** First model of PREFERENCE that exists and accepts the transcription endpoint; remembered afterwards. */
async function transcribe(audio, type) {
  const ids = await availableModels();
  const candidates = working ? [working] : PREFERENCE.filter((m) => ids.has(m));
  let lastError = 'no transcription model available';
  for (const model of candidates) {
    const response = await transcribeWith(model, audio, type);
    if (response.ok) {
      working = model;
      markOk('openai');
      return { text: String((await response.json()).text ?? '').trim(), model };
    }
    const detail = (await response.json().catch(() => ({})))?.error;
    lastError = detail?.message || `status ${response.status}`;
    if (response.status !== 400 && response.status !== 404) {
      const noCredit = detail?.code === 'insufficient_quota' || detail?.code === 'credit_balance_exhausted';
      if (noCredit) markFailure('openai', 'Kein Guthaben');
      throw Object.assign(new Error(noCredit ? TEXT.transcribeNoCredit : TEXT.transcribeFailed), { status: 502, detail: lastError });
    }
    working = null;
  }
  throw Object.assign(new Error(TEXT.transcribeFailed), { status: 502, detail: lastError });
}

/** POST /api/transcribe — raw audio body, JSON answer {text}. */
export async function handleTranscribe(req, res, { sid, ip, limits }) {
  if (!cfg.openaiKey() && !cfg.elevenKey()) return sendJson(res, 503, { error: TEXT.transcribeMissing });
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!EXTENSIONS[type]) return sendJson(res, 415, { error: TEXT.transcribeType });
  const gate = limits.check(sid, 'transcribe');
  if (!gate.ok) return sendJson(res, 429, { error: gate.reason }, { 'retry-after': String(gate.retryAfter) });
  const spend = limits.check(sid, 'spend');
  if (!spend.ok) return sendJson(res, 429, { error: spend.reason }, { 'retry-after': String(spend.retryAfter) });

  const audio = await readBody(req, MAX_BYTES);
  if (audio.length < 200) return sendJson(res, 400, { error: TEXT.transcribeShort });
  try {
    const started = Date.now();
    const { text, model } = await transcribeAny(audio, type);
    // Duration is unknown without decoding; assume ~4 KB/s (webm/opus) and price at $0.006 per minute, rounded up.
    const costUsd = (Math.min(audio.length / 4000, 600) / 60) * 0.006;
    limits.addCost(costUsd);
    audit({ action: 'transcribe', ip, cost_usd: costUsd, detail: `${model} ${audio.length} bytes ${Date.now() - started} ms` });
    sendJson(res, 200, { text });
  } catch (err) {
    audit({ action: 'transcribe.error', ip, detail: err.detail || err.message });
    sendJson(res, err.status || 502, { error: short(err.status ? err.message : TEXT.transcribeFailed, 120) });
  }
}

export function resetTranscribeForTests() {
  available = { at: 0, ids: new Set() };
  working = null;
}
