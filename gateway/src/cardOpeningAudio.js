import crypto from 'node:crypto';
import WebSocket from 'ws';
import { cardOpening } from './cardStartup.js';

// Card-opening audio in the central narration voice (Florian 23 Nov 2026, DECISIONS explainer-creative-status-summaries-1123;
// job desk-card-opening-tts-20261123). The short "<topic>. <status>. Was brauchst du?" line was spoken by the laptop's
// Windows voice (speechSynthesis), which sounded poor. The gateway now renders that line AHEAD of time in the voice of the
// narration-voice skill (voices.json: C3 = Gemini 3.8 Flash TTS "Enceladus", fallback A2 = OpenAI Realtime "ash") and the
// voice session sends the finished WAV with `card_opening`. One render takes ~2.7 s, too slow for the start path, so:
//   - every POLL_MS the newest card summaries come from the Sandy bridge (notify.cardSummaries) and missing lines are rendered;
//   - a start whose line is not cached yet falls back to the browser voice as before and queues the line for the next start.
// Logs carry lengths, voices and timings only, never the card text.

export const OPENING_VOICES = {
  C3: { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Enceladus', label: 'Gemini 3.8 Flash TTS, Enceladus' },
  A2: { provider: 'openai-realtime', model: 'gpt-realtime-2.1-mini', voice: 'ash', label: 'OpenAI Realtime 2.1 mini, ash' },
};
export const DEFAULT_CHAIN = ['C3', 'A2'];
const POLL_MS = 20_000;
const POLL_LIMIT = 30;
const MAX_ENTRIES = 80; // ~250 KB WAV each (~330 KB as base64): about 26 MB
const RETRY_AFTER_MS = 30 * 60_000;
const DAILY_RENDERS = 600; // a guard against a loop; a normal day renders a few dozen lines (~USD 0.0003 each)
const MAX_TEXT = 200;

// narration-voice voices.json -> pronunciation.de (whole words, speech text only; Gemini says JevBench with a German "J").
export const PRONUNCIATION = { JevBench: 'Dschevbench', JevBenchs: 'Dschevbenchs' };
export const spokenText = (text) => Object.entries(PRONUNCIATION)
  .reduce((t, [k, v]) => t.replace(new RegExp(`(?<![\\w-])${k}(?![\\w])`, 'g'), v), text);

const keyOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

/** Chain from DESK_OPENING_VOICES ("C3,A2" default, "off" disables). Unknown codes are dropped. */
export function openingChain(env = process.env) {
  const raw = String(env.DESK_OPENING_VOICES ?? '').trim();
  if (/^(?:off|0|none)$/i.test(raw)) return [];
  const codes = raw ? raw.split(',').map((c) => c.trim()).filter((c) => Object.hasOwn(OPENING_VOICES, c)) : DEFAULT_CHAIN;
  return codes.length ? codes : DEFAULT_CHAIN;
}

// ---------------- audio helpers: 16-bit mono PCM ----------------
/** {rate, pcm: Int16Array} from a RIFF/WAVE buffer or raw L16. */
export function decodePcm(buf, rate = 24000) {
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12, fmtRate = rate, channels = 1, bits = 16;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
      if (id === 'fmt ') { channels = buf.readUInt16LE(body + 2); fmtRate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14); }
      if (id === 'data') {
        if (bits !== 16 || channels !== 1) throw new Error(`unsupported wav ${bits} bit / ${channels} ch`);
        const end = Math.min(buf.length, body + (size || buf.length));
        const bytes = buf.subarray(body, end - ((end - body) % 2));
        return { rate: fmtRate, pcm: new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) };
      }
      off = body + size + (size % 2);
    }
    throw new Error('wav without data chunk');
  }
  const bytes = buf.subarray(0, buf.length - (buf.length % 2));
  return { rate, pcm: new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) };
}

/** Cut leading/trailing silence to a short pad (start pad small: the start is what Florian waits for). */
export function trimSilence({ rate, pcm }, { threshold = 330, head = 0.06, tail = 0.15 } = {}) {
  const frame = Math.max(1, Math.round(rate / 100));
  const loud = (i) => { let s = 0; const end = Math.min(pcm.length, i + frame); for (let j = i; j < end; j++) s += pcm[j] * pcm[j]; return Math.sqrt(s / Math.max(1, end - i)) > threshold; };
  let first = -1, last = -1;
  for (let i = 0; i < pcm.length; i += frame) if (loud(i)) { if (first < 0) first = i; last = i + frame; }
  if (first < 0) return { rate, pcm: new Int16Array(0) };
  const from = Math.max(0, first - Math.round(head * rate)), to = Math.min(pcm.length, last + Math.round(tail * rate));
  return { rate, pcm: pcm.slice(from, to) };
}

/**
 * Shorten pauses inside the take to `maxPause` seconds. Gemini leaves 0.7-1.7 s after each sentence of the short opening, which
 * made a six-word line last up to 7 s. Cuts happen only inside silence (below `threshold`), with 5 ms fades at each seam.
 */
export function compressPauses({ rate, pcm }, { maxPause = 0.3, threshold = 330 } = {}) {
  const frame = Math.max(1, Math.round(rate / 100)), n = Math.floor(pcm.length / frame);
  const quiet = (f) => { let s = 0; for (let j = f * frame; j < (f + 1) * frame; j++) s += pcm[j] * pcm[j]; return Math.sqrt(s / frame) <= threshold; };
  const keep = Math.round(maxPause * rate / 2), fade = Math.round(rate * 0.005);
  const parts = [];
  let from = 0;
  for (let f = 0; f < n;) {
    if (!quiet(f)) { f++; continue; }
    let g = f; while (g < n && quiet(g)) g++;
    const start = f * frame, end = g * frame;
    if (end - start > 2 * keep && g < n) { parts.push([from, start + keep]); from = end - keep; }
    f = g;
  }
  if (!parts.length) return { rate, pcm };
  parts.push([from, pcm.length]);
  const total = parts.reduce((a, [x, y]) => a + (y - x), 0), outPcm = new Int16Array(total);
  let o = 0;
  for (const [i, [x, y]] of parts.entries()) {
    const seg = pcm.subarray(x, y);
    outPcm.set(seg, o);
    for (let k = 0; k < fade && k < seg.length; k++) {
      if (i > 0) outPcm[o + k] = Math.round(outPcm[o + k] * (k / fade));
      if (i < parts.length - 1) outPcm[o + seg.length - 1 - k] = Math.round(outPcm[o + seg.length - 1 - k] * (k / fade));
    }
    o += seg.length;
  }
  return { rate, pcm: outPcm };
}

export function encodeWav({ rate, pcm }) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A take is plausible when its length fits the text: not empty, not a run-on (rough German speaking rates). */
export function plausibleLength(text, seconds) {
  const chars = text.replace(/\s+/g, ' ').trim().length;
  return seconds >= Math.max(0.6, chars * 0.025) && seconds <= chars * 0.16 + 1.5;
}

const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').match(/[a-z0-9]+/g) ?? [];
/** Share of the script's words the transcript contains (exact, or the same first 4 letters for long words: names get misheard). */
export function transcriptCoverage(script, heard) {
  const want = words(script), got = words(heard);
  if (!want.length) return 1;
  const hit = want.filter((w) => got.some((g) => g === w || (w.length >= 5 && g.length >= 4 && g.slice(0, 4) === w.slice(0, 4)))).length;
  return hit / want.length;
}

// ---------------- providers: text -> {rate, pcm} ----------------
async function synthGemini(text, v, { env, fetchImpl, timeoutMs }) {
  const key = env.GOOGLE_API_KEY || env.GEMINI_API_KEY;
  if (!key) throw new Error('no-key');
  const base = (env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/v1beta/models/${v.model}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'],
      speechConfig: { languageCode: 'de-DE', voiceConfig: { prebuiltVoiceConfig: { voiceName: v.voice } } } } }),
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  const d = await res.json();
  const cand = d?.candidates?.[0];
  const part = cand?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!part?.data) throw new Error('no-audio');
  if (cand.finishReason && cand.finishReason !== 'STOP') throw new Error(`finish-${cand.finishReason}`);
  const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? '')?.[1]) || 24000;
  return decodePcm(Buffer.from(part.data, 'base64'), rate);
}

function synthOpenAIRealtime(text, v, { env, timeoutMs, WebSocketImpl = WebSocket }) {
  const key = env.OPENAI_API_KEY;
  if (!key) return Promise.reject(new Error('no-key'));
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(v.model)}`, { headers: { Authorization: `Bearer ${key}` } });
    const chunks = [];
    const done = (err, value) => { clearTimeout(timer); try { ws.close(); } catch { /* already closed */ } if (err) reject(err); else resolve(value); };
    const timer = setTimeout(() => done(new Error('timeout')), timeoutMs);
    ws.on('error', () => done(new Error('ws-error')));
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'],
        instructions: 'Lies den folgenden Text vollständig und wortgetreu in klarem Hochdeutsch vor, ruhig und natürlich. Keine Einleitung, keine Ergänzungen, nichts weglassen.',
        audio: { output: { voice: v.voice, format: { type: 'audio/pcm', rate: 24000 } } } } }));
      ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    });
    ws.on('message', (raw) => {
      let ev; try { ev = JSON.parse(raw.toString()); } catch { return; }
      if (ev.type === 'response.output_audio.delta' && ev.delta) chunks.push(Buffer.from(ev.delta, 'base64'));
      else if (ev.type === 'error') done(new Error(`openai-${String(ev.error?.code ?? 'error').slice(0, 40)}`));
      else if (ev.type === 'response.done') {
        if (ev.response?.status !== 'completed' || !chunks.length) done(new Error(`openai-${ev.response?.status ?? 'empty'}`));
        else done(null, decodePcm(Buffer.concat(chunks), 24000));
      }
    });
  });
}

/** Groq Whisper transcript of the take, or null when no ASR is configured/answering (then the length check alone decides). */
async function transcribeGroq(wav, { env, fetchImpl }) {
  const key = env.GROQ_API_KEY;
  if (!key) return null;
  const base = (env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'opening.wav');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'de');
  form.append('response_format', 'json');
  try {
    const res = await fetchImpl(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return String((await res.json())?.text ?? '');
  } catch { return null; }
}

const PROVIDERS = { gemini: synthGemini, 'openai-realtime': synthOpenAIRealtime };

/**
 * The pre-render service. get(text) is synchronous (the start path never waits); want(text) queues a render.
 * Options are injectable for tests: synth(code, text) -> {rate, pcm}, transcribe(wav) -> string|null.
 */
export function createCardOpeningAudio({
  hub, env = process.env, fetchImpl = fetch, now = Date.now, log = (line) => console.log(line),
  chain = openingChain(env), synth, transcribe, pollMs = POLL_MS, timeoutMs = 20_000, dailyRenders = DAILY_RENDERS,
} = {}) {
  const cache = new Map(); // key -> {text, voice, data, durationMs, bytes, at}
  const failed = new Map(); // key -> retry-after timestamp
  const queue = [];
  const queued = new Set();
  let busy = false, timer = null, day = '', rendersToday = 0;
  const stats = { renders: 0, failures: 0, hits: 0, misses: 0 };
  const emit = (msg, data = {}) => { try { log(JSON.stringify({ ts: new Date(now()).toISOString(), level: 'info', app: 'agent-desk', msg, ...data })); } catch { /* logging never breaks the start path */ } };
  const doSynth = synth ?? ((code, text) => PROVIDERS[OPENING_VOICES[code].provider](text, OPENING_VOICES[code], { env, fetchImpl, timeoutMs }));
  const doTranscribe = transcribe ?? ((wav) => transcribeGroq(wav, { env, fetchImpl }));

  function get(text) {
    const entry = typeof text === 'string' ? cache.get(keyOf(text)) : undefined;
    if (!entry || entry.text !== text) { stats.misses += 1; return null; }
    cache.delete(keyOf(text)); cache.set(keyOf(text), entry); // LRU: recently used stays
    stats.hits += 1;
    return entry;
  }

  function want(text, { front = false } = {}) {
    if (!chain.length || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return false;
    const key = keyOf(text);
    if (cache.has(key) || queued.has(key) || (failed.get(key) ?? 0) > now()) return false;
    queued.add(key);
    if (front) queue.unshift(text); else queue.push(text);
    void pump();
    return true;
  }

  async function renderOne(text) {
    const tried = [];
    for (const code of chain) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const t0 = now();
        try {
          const take = compressPauses(trimSilence(await doSynth(code, spokenText(text))));
          const seconds = take.pcm.length / take.rate;
          if (!plausibleLength(text, seconds)) throw new Error(`length-${seconds.toFixed(2)}s`);
          const wav = encodeWav(take);
          const heard = await doTranscribe(wav);
          const coverage = heard === null ? null : transcriptCoverage(spokenText(text), heard);
          if (coverage !== null && coverage < 0.6) throw new Error(`content-${coverage.toFixed(2)}`);
          return { voice: code, wav, durationMs: Math.round(seconds * 1000), renderMs: now() - t0, coverage, tried };
        } catch (err) {
          tried.push(`${code}:${String(err?.message ?? err).slice(0, 40)}`);
          if (/no-key|http-4(?!29)/.test(String(err?.message))) break; // a missing key or a refused request will not heal on retry
        }
      }
    }
    throw new Error(tried.join(' '));
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const text = queue.shift();
        const key = keyOf(text);
        const today = new Date(now()).toISOString().slice(0, 10);
        if (today !== day) { day = today; rendersToday = 0; }
        if (rendersToday >= dailyRenders) { queued.delete(key); emit('card-opening.render.skipped', { reason: 'daily-cap', cap: dailyRenders }); continue; }
        rendersToday += 1;
        try {
          const r = await renderOne(text);
          cache.set(key, { text, voice: r.voice, data: r.wav.toString('base64'), durationMs: r.durationMs, bytes: r.wav.length, at: now() });
          while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
          failed.delete(key);
          stats.renders += 1;
          emit('card-opening.render', { voice: r.voice, renderMs: r.renderMs, audioMs: r.durationMs, bytes: r.wav.length, chars: text.length, coverage: r.coverage, fallbacks: r.tried.length ? r.tried : undefined });
        } catch (err) {
          failed.set(key, now() + RETRY_AFTER_MS);
          stats.failures += 1;
          emit('card-opening.render.failed', { chars: text.length, reason: String(err?.message ?? err).slice(0, 200) });
        } finally { queued.delete(key); }
      }
    } finally { busy = false; }
  }

  async function poll() {
    if (!chain.length || !hub?.hostsFor?.('notify.cardSummaries')?.includes('sandy')) return;
    try {
      const { cards = [] } = await hub.call('notify.cardSummaries', { limit: POLL_LIMIT }, { host: 'sandy', timeoutMs: 3000 }) ?? {};
      for (const card of cards) if (card?.id && card.title) want(cardOpening(card));
    } catch { /* bridge away or old bridge without the method: starts fall back to the browser voice */ }
  }

  function start() {
    if (timer || !chain.length) return;
    void poll();
    timer = setInterval(() => void poll(), pollMs);
    timer.unref?.();
    hub?.on?.('bridge-up', (host) => { if (host === 'sandy') setTimeout(() => void poll(), 1500).unref?.(); }); // after the hello with its caps
  }
  function stop() { clearInterval(timer); timer = null; }

  return { get, want, poll, start, stop, chain, stats, size: () => cache.size, idle: () => !busy && !queue.length };
}
