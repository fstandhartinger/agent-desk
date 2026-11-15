// One-time, resumable asset generation. Uses ONLY environment credentials. No server runtime dependency.
// Usage: node gateway/scripts/voice-samples.mjs --generate [--provider=gemini|xai|openai] [--rate]
// --generate explicitly opts into paid vendor calls; the durable reservation ledger caps all runs below USD 3.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';
import { VOICES } from '../src/voice/voices.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'web/public/voice-samples');
const RECEIPTS = resolve(ROOT, 'docs/voice/sample-receipts.json');
const MANIFEST = resolve(ROOT, 'gateway/src/voice/voice-samples.json');
export const SENTENCE = 'Hallo Florian, so klinge ich im Agent Desk. Ich erkläre dir gern, was deine Agenten gerade machen.';
const CALM = ['Sulafat', 'Vindemiatrix', 'Achernar', 'Schedar', 'Despina', 'Algieba', 'Charon'];
const args = process.argv.slice(2);
const providerOnly = args.find((a) => a.startsWith('--provider='))?.split('=')[1];
const ledger = existsSync(RECEIPTS) ? JSON.parse(readFileSync(RECEIPTS, 'utf8')) : { sentence: SENTENCE, budgetUsd: 2.90, calls: [], ratings: [] };
mkdirSync(dirname(RECEIPTS), { recursive: true });
const flush = () => writeFileSync(RECEIPTS, JSON.stringify(ledger, null, 2) + '\n');
// Reservations never refunded, including failures: the ledger overestimates spend and survives interruption/retries.
function reserve(kind, voice, maxUsd) {
  if (!args.includes('--generate')) throw new Error('Paid calls require --generate');
  const used = ledger.calls.reduce((sum, c) => sum + c.reservedUsd, 0);
  if (used + maxUsd > ledger.budgetUsd) throw new Error('USD 2.90 cumulative budget exhausted');
  const call = { at: new Date().toISOString(), kind, voice, reservedUsd: maxUsd, status: 'reserved' };
  ledger.calls.push(call); flush();
  return call;
}
function key(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}
async function request(url, init, call) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
  call.http = r.status;
  if (!r.ok) { call.status = 'http-error'; flush(); throw new Error(`${call.kind}: HTTP ${r.status}`); }
  return r;
}
const googleHeaders = () => ({ 'content-type': 'application/json', 'x-goog-api-key': key('GOOGLE_API_KEY') });

async function gemini(id) {
  const headers = googleHeaders();
  const call = reserve('gemini-tts', id ?? '(no voice)', 0.03);
  const r = await request('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers,
    body: JSON.stringify({ model: 'gemini-3.8-flash-tts', input: [{ type: 'user_input', content: [{ type: 'text', text: SENTENCE }] }],
      response_format: { type: 'audio' }, generation_config: { max_output_tokens: 2048, ...(id ? { speech_config: [{ voice: id }] } : {}) } }),
  }, call);
  const body = await r.json();
  call.usage = body.usage ?? body.usageMetadata;
  const audio = body.output_audio ?? body.steps?.flatMap((s) => s.content ?? []).findLast((c) => c.type === 'audio');
  if (!audio?.data) throw new Error('Gemini returned no audio');
  call.status = 'ok'; flush();
  return { bytes: Buffer.from(audio.data, 'base64'), raw: (audio.mime_type ?? audio.mimeType ?? '').includes('l16') };
}

async function xai(id) {
  const auth = key('XAI_API_KEY');
  const call = reserve('xai-tts', id, SENTENCE.length * 15 / 1e6);
  const r = await request('https://api.x.ai/v1/tts', { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: SENTENCE, voice_id: id, language: 'de', output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 64000 } }) }, call);
  const bytes = Buffer.from(await r.arrayBuffer());
  call.status = 'ok'; flush();
  return { bytes, raw: false };
}

async function openai(id) {
  const auth = key('OPENAI_API_KEY');
  const call = reserve('openai-live', id, 0.03); // hard 30s connection, $0.05/min; client delegation = no backend calls
  const started = Date.now();
  return new Promise((resolveSample, reject) => {
    const chunks = [];
    let done = false, feed, check, lastVoice = 0;
    const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${auth}` }, handshakeTimeout: 10000 });
    const finish = (error) => {
      if (done) return; done = true;
      clearTimeout(timeout); clearInterval(feed); clearInterval(check);
      if (ws.readyState === WebSocket.OPEN) ws.close(); else ws.terminate();
      call.seconds = (Date.now() - started) / 1000;
      call.status = error ? 'failed' : 'ok'; flush();
      if (error) reject(error); else resolveSample({ bytes: Buffer.concat(chunks), raw: true });
    };
    const timeout = setTimeout(() => finish(chunks.length ? undefined : new Error('Live produced no audio in 30s')), 30000);
    const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
    ws.on('open', () => send({ type: 'session.start', event_id: 'start', session: {
      model: 'gpt-live-1', instructions: `Du sprichst ausschließlich Deutsch. Lies genau einmal diesen Satz vor und sage danach nichts mehr: ${SENTENCE}`,
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: id } }, delegation: { type: 'client' },
    } }));
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'error') { call.code = m.error?.code; finish(new Error(`Live rejected ${id}: ${m.error?.code ?? 'error'}`)); }
      if (m.type === 'session.started') {
        send({ type: 'session.commentary.append', event_id: 'sample', delegation_id: null, content: `Sprich jetzt auf Deutsch genau diesen Satz, ohne Einleitung: ${SENTENCE}` });
        feed = setInterval(() => send({ type: 'session.input_audio.append', audio: Buffer.alloc(4800).toString('base64') }), 100);
        check = setInterval(() => { if (lastVoice && Date.now() - lastVoice > 1800) finish(); }, 100);
      }
      if (m.type === 'session.output_audio.delta') {
        const pcm = Buffer.from(m.delta, 'base64'); chunks.push(pcm);
        for (let i = 0; i + 1 < pcm.length; i += 16) if (Math.abs(pcm.readInt16LE(i)) > 250) { lastVoice = Date.now(); break; }
      }
    });
    ws.on('error', () => finish(new Error('Live socket failed')));
    ws.on('close', () => finish(chunks.length ? undefined : new Error('Live closed without audio')));
  });
}

function encode(bytes, raw, file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...(raw ? ['-f', 's16le', '-ar', '24000', '-ac', '1'] : []), '-i', 'pipe:0',
    '-af', 'silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,areverse',
    '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'mp3', file], { input: bytes, timeout: 30000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 10000, encoding: 'utf8' });
  const seconds = Number(probe.stdout);
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 25) throw new Error('Unusable sample duration');
  return seconds;
}
const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
async function verifyOpenai(file, id) {
  const auth = key('OPENAI_API_KEY');
  const call = reserve('openai-transcription', id, 0.005); // Whisper $0.006/min, sample bounded to <=25s
  const form = new FormData();
  form.set('model', 'whisper-1'); form.set('language', 'de');
  form.set('file', new Blob([readFileSync(file)], { type: 'audio/mpeg' }), 'sample.mp3');
  const r = await request('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${auth}` }, body: form }, call);
  const { text = '' } = await r.json();
  const words = new Set(normalize(text));
  const target = normalize(SENTENCE);
  const recall = target.filter((w) => words.has(w)).length / target.length;
  const precision = [...words].filter((w) => target.includes(w)).length / Math.max(1, words.size);
  call.transcript = text; call.recall = recall; call.precision = precision;
  call.status = recall >= 0.8 && precision >= 0.75 && /ich|erkläre|deine|gerade/i.test(text) ? 'verified' : 'rejected'; flush();
  return call.status === 'verified';
}

async function rate(file, id) {
  if (ledger.ratings.some((r) => r.voice === id)) return;
  const headers = googleHeaders();
  const call = reserve('gemini-rating', id, 0.03);
  const r = await request('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', {
    method: 'POST', headers,
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Listen to this German voice sample. Rate 1-10 overall: calm, warm, pleasant to listen to for 30 minutes, natural German pronunciation. Judge only what you hear. Return JSON {"score":number,"reason": "one short sentence in English"}.' }, { inlineData: { mimeType: 'audio/mpeg', data: readFileSync(file).toString('base64') } }] }], generationConfig: { maxOutputTokens: 512, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
  }, call);
  const body = await r.json();
  call.usage = body.usageMetadata;
  const result = JSON.parse(body.candidates?.[0]?.content?.parts?.filter((p) => p.text && !p.thought).map((p) => p.text).join('') ?? '{}');
  if (!Number.isFinite(result.score) || result.score < 1 || result.score > 10 || typeof result.reason !== 'string') throw new Error('Invalid rating');
  ledger.ratings.push({ voice: id, ...result }); call.status = 'ok'; flush();
  console.log(`rating ${id}: ${result.score} — ${result.reason}`);
}

function manifest() {
  const available = Object.fromEntries(['xai', 'openai', 'gemini'].map((p) => [p, VOICES[p].filter((v) => existsSync(resolve(OUT, p, `${v.id}.mp3`))).map((v) => v.id)]));
  writeFileSync(MANIFEST, JSON.stringify(available, null, 2) + '\n');
}
async function generate(provider, id) {
  const file = resolve(OUT, provider, `${id ?? '_default'}.mp3`);
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) return file;
  const attempts = ledger.calls.filter((c) => c.kind === `${provider === 'openai' ? 'openai-live' : provider + '-tts'}` && c.voice === (id ?? '(no voice)')).length;
  for (let n = attempts; n < (provider === 'openai' ? 2 : 1); n++) {
    const tmp = file + '.tmp';
    try {
      const { bytes, raw } = await ({ xai, gemini, openai })[provider](id);
      const seconds = encode(bytes, raw, tmp);
      if (provider === 'openai' && !await verifyOpenai(tmp, id)) throw new Error('German sample did not match the sentence');
      renameSync(tmp, file); console.log(`saved ${provider}/${id ?? '_default'} (${seconds.toFixed(1)}s)`); manifest(); return file;
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      console.log(`no sample ${provider}/${id ?? '_default'}: ${err.message}`);
      ledger.failures ??= []; ledger.failures.push({ provider, voice: id ?? '(no voice)', reason: err.message }); flush();
    }
  }
  return null;
}

if (!args.includes('--generate')) {
  console.log('Dry run. Add --generate to make paid requests. Cumulative reservation budget: USD 2.90.');
  console.log('Voices:', Object.fromEntries(['xai', 'openai', 'gemini'].map((p) => [p, VOICES[p].length])));
} else {
  // Generate calm Gemini candidates first, preserving identical text and neutral delivery for the comparison.
  for (const p of ['gemini', 'xai', 'openai'].filter((p) => !providerOnly || p === providerOnly)) {
    const ids = p === 'gemini' ? [...CALM, ...VOICES.gemini.map((v) => v.id).filter((id) => !CALM.includes(id))] : VOICES[p].map((v) => v.id);
    for (const id of ids) await generate(p, id);
  }
  if (args.includes('--rate')) {
    const baseline = await generate('gemini', undefined);
    for (const id of CALM) {
      const file = resolve(OUT, 'gemini', `${id}.mp3`);
      if (existsSync(file)) { try { await rate(file, id); } catch (e) { console.log(`rating ${id}: ${e.message}`); } }
    }
    if (baseline) { try { await rate(baseline, '(no voice)'); } catch (e) { console.log(`rating default: ${e.message}`); } }
  }
  manifest(); flush();
  console.log(`Reserved upper estimate: USD ${ledger.calls.reduce((s, c) => s + c.reservedUsd, 0).toFixed(4)}`);
}
