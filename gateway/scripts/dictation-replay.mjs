// Replays recorded dictations through the real dictation code (createDeviceMedia), the way the Screen Agent does: chunk by chunk with the text so far
// as context, then the final pass with light structure. For measuring a change against recordings before it ships.
//
//   node scripts/dictation-replay.mjs --chunks <dir> --out <file.json> [--stt-cache <dir>] [--sources mai,openai,scribe] [--no-format] [--no-final] [--only <id part>]
//
// <dir> holds 16 kHz mono wav chunks and a manifest.json: { "<recording id>": [{ "file": "x-00.wav", "seconds": 20.1, "final": false, "overlap": false }, ...] }.
// With --stt-cache the recognisers are answered from files <cache>/<model>/<chunk>.json ({text, ms}) after the recorded delay, so a run costs only the
// clean-up model; without it every recogniser is called for real. Keys come from the environment. Recordings are private: never commit them or the output.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { createDeviceMedia } from '../src/deviceMedia.js';
import { worthFormatting } from '../src/dictationGuard.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const chunksDir = arg('--chunks'), outFile = arg('--out'), cacheDir = arg('--stt-cache'), only = arg('--only');
if (!chunksDir || !outFile) { console.error('usage: dictation-replay.mjs --chunks <dir> --out <file.json> [--stt-cache <dir>] [--sources a,b,c] [--no-format] [--no-final] [--only <id part>]'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(chunksDir, 'manifest.json'), 'utf8'));
const env = { ...process.env, ...(arg('--sources') ? { DESK_DICTATE_SOURCES: arg('--sources') } : {}), DESK_DAILY_USD_CAP: '1000' };

// which cached model answers which request
const CACHE_NAMES = { 'whisper-large-v3': 'groq-whisper-v3', 'whisper-large-v3-turbo': 'groq-whisper-v3-turbo', 'gpt-4o-transcribe': 'openai-gpt-4o-transcribe', 'gpt-transcribe': 'openai-gpt-transcribe',
  'microsoft/mai-transcribe-2': 'mai-transcribe-2', 'assemblyai/universal-3-6-pro': 'assembly-u3.6-pro', 'mistralai/voxtral-mini-transcribe-3-0': 'voxtral-mini-3', scribe_v2: 'eleven-scribe-v2' };
const byHash = new Map();
const sha = buf => crypto.createHash('sha1').update(buf).digest('hex');
for (const list of Object.values(manifest)) for (const c of list) byHash.set(sha(fs.readFileSync(path.join(chunksDir, c.file))), c.file);
const sleep = (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(Error('aborted'), { name: 'AbortError' })); }, { once: true }); });
const sttCalls = {};
async function cachedFetch(url, opts) {
  const u = String(url);
  let model = null, audio = null;
  if (opts?.body instanceof FormData && (u.endsWith('/audio/transcriptions') || u.endsWith('/speech-to-text'))) { model = opts.body.get('model') ?? opts.body.get('model_id'); audio = Buffer.from(await opts.body.get('file').arrayBuffer()); }
  else if (u.endsWith('/audio/transcriptions')) { const j = JSON.parse(opts.body); model = j.model; audio = Buffer.from(j.input_audio.data, 'base64'); }
  else if (u.includes(':generateContent') && opts.body.includes('"inline_data"') && opts.body.includes('audio/wav')) return new Response('{}', { status: 503 }); // the Gemini reserve is not replayed
  if (!model) return fetch(url, opts);
  const file = byHash.get(sha(audio)), name = CACHE_NAMES[model];
  const p = name && file ? path.join(cacheDir, name, file.replace(/\.wav$/, '.json')) : null;
  if (!p || !fs.existsSync(p)) return new Response('{}', { status: 404 });
  const hit = JSON.parse(fs.readFileSync(p, 'utf8'));
  sttCalls[name] = (sttCalls[name] ?? 0) + 1;
  await sleep(Math.min(hit.ms ?? 500, 8000), opts.signal);
  return Response.json({ text: hit.text ?? '', usage: { seconds: 1 } });
}
const media = createDeviceMedia({ env, fetchImpl: cacheDir ? cachedFetch : fetch });

const key = w => (w.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
/** The app's join: words a hard cut made both chunks say are taken out once. */
function join(parts, overlapped) {
  const words = [];
  parts.forEach((p, i) => {
    const next = String(p ?? '').split(/\s+/).filter(Boolean); if (!next.length) return;
    let drop = 0;
    if (overlapped[i] && words.length) for (let k = Math.min(8, words.length, next.length); k >= 1; k--) { let same = true; for (let j = 0; j < k && same; j++) same = key(words[words.length - k + j]) === key(next[j]) && key(next[j]).length > 0; if (same) { drop = k; break; } }
    words.push(...next.slice(drop));
  });
  return words.join(' ');
}
const median = list => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const stats = { chunkMs: [], lastChunkMs: [], polishMs: [], mergeFailed: 0, mergeReasons: {}, undone: 0, polishUndone: 0, polishFailed: 0, breaks: 0 };

async function one(id) {
  const parts = [], overlapped = [], sources = []; let degraded = false, lastMs = 0;
  for (const c of manifest[id]) {
    const audio = fs.readFileSync(path.join(chunksDir, c.file));
    const context = { process: 'Code - Insiders', fieldBefore: join(parts, overlapped).slice(-500), visibleIds: [], recentTerms: [] };
    let r;
    try { r = await media.dictate(audio, context, { items: [] }, { patient: !c.final }); }
    catch (err) { r = { text: '', ms: 0, providers: {}, degraded: true, sources: {}, error: err.code ?? err.message }; }
    parts.push(r.text); overlapped.push(Boolean(c.overlap)); sources.push(r.sources);
    degraded ||= r.degraded; stats.chunkMs.push(r.ms); lastMs = r.ms;
    if (r.providers?.merge && !r.providers.merge.ok) { stats.mergeFailed += 1; stats.mergeReasons[r.providers.merge.reason] = (stats.mergeReasons[r.providers.merge.reason] ?? 0) + 1; }
    stats.undone += r.providers?.merge?.undone ?? 0;
  }
  stats.lastChunkMs.push(lastMs);
  const joined = join(parts, overlapped); let text = joined, polish = null;
  const format = !arg('--no-format');
  const mode = !arg('--no-final') && joined && (manifest[id].length >= 2 || degraded) ? 'final' : format && worthFormatting(joined) ? 'format' : null;
  if (mode) {
    try { polish = await media.polish(joined, { process: 'Code - Insiders', fieldBefore: '' }, { mode, dictionary: { items: [] }, format }); text = polish.text; stats.polishMs.push(polish.ms); stats.polishUndone += polish.undone ?? 0; stats.polishFailed += polish.failed ?? 0; stats.breaks += polish.breaks ?? 0; }
    catch (err) { polish = { error: err.code ?? err.message }; }
  }
  return { id, chunks: manifest[id].length, joined, text, waitMs: lastMs + (polish?.ms ?? 0), polish: polish && { ...polish, text: undefined }, sources };
}
const ids = Object.keys(manifest).filter(id => !only || id.includes(only)), results = [];
let next = 0;
await Promise.all(Array.from({ length: Number(arg('--jobs', 3)) }, async () => { while (next < ids.length) results.push(await one(ids[next++])); }));
results.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
const flat = t => t.replace(/\s+/g, ' ');
fs.writeFileSync(outFile.replace(/\.json$/, '') + '.tsv', results.map(r => `${r.id}\t${flat(r.text)}`).join('\n') + '\n');
fs.writeFileSync(outFile.replace(/\.json$/, '') + '.joined.tsv', results.map(r => `${r.id}\t${flat(r.joined)}`).join('\n') + '\n');
console.log(JSON.stringify({ recordings: results.length, chunkMs: median(stats.chunkMs), lastChunkMs: median(stats.lastChunkMs), polishMs: median(stats.polishMs), waitAfterReleaseMs: median(results.map(r => r.waitMs)),
  mergeFailed: stats.mergeFailed, mergeReasons: stats.mergeReasons, mergeUndone: stats.undone, polishFailed: stats.polishFailed, polishUndone: stats.polishUndone, breaks: stats.breaks, sttCalls }));
