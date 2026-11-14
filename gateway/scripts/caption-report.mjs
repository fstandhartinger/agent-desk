#!/usr/bin/env node
// Caption refinement round, step 1 (14 Nov 2026): reads a device trace (`~/bin/desk-trace device --json > day.json`, or the registry export of a
// "Geräteprotokoll") and, per dictation, puts together what the subtitle heard and showed:
//   - caption.log (gateway): every window's raw recogniser text (k "w") and every live clean-up with input and answer (k "p")
//   - caption.shown / caption.summary / caption.live / caption.typed (app 0.1.16): what was on screen when, the measures, the live and the typed text
//   - dictation.result / dictation.polish (gateway): each transcribed chunk's text and the final pass
// It prints a short report (the dictations with doubled words, late changes, clean-up answers that changed something, live text against typed text)
// and with --out DIR writes the replay input of screen-agent's tools/CaptionReplay (cases.json, windows/<id>.json, final/<id>.json).
//   node gateway/scripts/caption-report.mjs day.json [--out DIR] [--id <dictation id>] [--all]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && !['--out', '--id'].includes(args[args.indexOf(a) - 1]));
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
if (!file) { console.error('usage: caption-report.mjs <device-trace.json> [--out DIR] [--id ID] [--all]'); process.exit(2); }
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = (Array.isArray(raw) ? raw : raw.events ?? []).map(e => ({ ...e, ms: Date.parse(e.ts) })).sort((a, b) => a.ms - b.ms);

const words = t => String(t ?? '').split(/\s+/).filter(Boolean);
const key = w => (String(w).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
const FILLER = /^(äh+m?|ähm+|öh+m?|hm+|mhm|ehm+|uh+m?)$/;
const LEGIT = new Set(['die', 'der', 'das', 'den', 'dem', 'des', 'sehr', 'ganz', 'viel', 'viele', 'nein', 'ja', 'bitte', 'klar', 'okay', 'immer', 'schnell', 'lange', 'weit', 'haha']);
/** Immediate repeats of one to three words ("ich ich", "wir haben wir haben"), doubled articles not counted; returns the places. */
export function repeats(text) {
  const w = words(text), k = w.map(key), out = [];
  for (let i = 0; i < k.length; i++) for (let n = 1; n <= 3 && i + 2 * n <= k.length; n++) {
    let same = true; for (let j = 0; j < n && same; j++) same = k[i + j] && k[i + j] === k[i + n + j] && !FILLER.test(k[i + j]);
    if (same && !(n === 1 && LEGIT.has(k[i]))) { out.push(w.slice(Math.max(0, i - 2), i + 2 * n + 2).join(' ')); i += 2 * n - 1; break; }
  }
  return out;
}

/** Chunk texts joined like the app's DictationJoin: words a hard cut heard twice (up to 8 at the seam) once. */
function joinChunks(texts) {
  const out = [];
  for (const t of texts) {
    const next = words(t); let drop = 0;
    for (let n = Math.min(8, out.length, next.length); n >= 1; n--) if (next.slice(0, n).every((w, j) => key(w) && key(w) === key(out[out.length - n + j]))) { drop = n; break; }
    out.push(...next.slice(drop));
  }
  return out.join(' ');
}

// ---- group per dictation ----
const dict = new Map(); // id -> {id, windows, polish, chunks, shown, summary, live[], typed[], final}
const get = id => { if (!dict.has(id)) dict.set(id, { id, windows: [], polish: [], chunks: [], shown: [], summary: null, live: [], typed: [], final: null, start: null }); return dict.get(id); };
let anon = 0, lastAnonAt = -Infinity, anonId = null;
for (const e of events) {
  const d = e.data ?? {};
  if (e.type === 'caption.log') {
    for (const it of d.items ?? []) {
      let id = it.d ?? d.d;
      if (!id) { if (it.at - lastAnonAt > 10_000) anonId = `old-${++anon}`; lastAnonAt = it.at; id = anonId; } // app 0.1.15: no id, a gap of 10 s starts a new one
      const x = get(id);
      if (it.k === 'w') x.windows.push(it); else if (it.k === 'p') x.polish.push(it);
    }
  } else if (e.type === 'dictation.start' && d.id) get(d.id).start = e.ms;
  else if (e.type === 'dictation.result' && d.dictationId) get(d.dictationId).chunks.push({ at: e.ms, index: d.index, final: d.final, text: d.text ?? '' });
  else if (e.type === 'dictation.polish' && d.d) get(d.d).final = d.text ?? null;
  else if (e.type === 'caption.shown' && d.id) get(d.id).shown.push(...(d.items ?? []));
  else if (e.type === 'caption.summary' && d.id) get(d.id).summary = d;
  else if ((e.type === 'caption.live' || e.type === 'caption.typed') && d.id) get(d.id)[e.type === 'caption.live' ? 'live' : 'typed'][(d.n ?? 1) - 1] = d.transcript ?? d.text ?? '';
}

// ---- report ----
const only = opt('--id'), all = args.includes('--all');
const list = [...dict.values()].filter(x => (!only || x.id === only) && (x.windows.length || x.summary));
const outDir = opt('--out'), cases = [];
if (outDir) for (const sub of ['windows', 'final']) fs.mkdirSync(path.join(outDir, sub), { recursive: true });
for (const x of list) {
  const typed = x.typed.join('') || x.final || joinChunks(x.chunks.sort((a, b) => a.index - b.index).map(c => c.text));
  const rawRepeats = x.windows.flatMap(w => repeats(w.text));
  const fixes = x.polish.filter(p => p.ok && p.out && p.out !== p.text);
  const s = x.summary;
  const interesting = all || rawRepeats.length || (s && (s.repeatsShown || s.changedLate || s.missingInTyped + s.extraInTyped > 3)) || fixes.length;
  if (interesting) {
    console.log(`\n=== dictation ${x.id}: ${x.windows.length} windows, ${x.polish.length} clean-ups (${fixes.length} changed the text), ${x.chunks.length} chunks`);
    if (s) console.log(`  app summary: shown first after ${s.firstShownMs} ms; updates ${s.updates}; words changed after shown ${s.changed} (window ${s.changedWindow}, clean-up ${s.changedPolish}, chunk ${s.changedChunk}; ${s.changedLate} after >= 3 s, median ${s.correctionAgeMs} ms); updates showing a doubled word ${s.repeatsShown}; doubled words in the live text ${s.repeatsLive} (raw ${s.repeatsRaw}, typed ${s.repeatsTyped}); live vs typed: ${s.missingInTyped} missing, ${s.extraInTyped} extra of ${s.typedWords}; windows appended without a match ${s.appended}`);
    for (const r of rawRepeats.slice(0, 6)) console.log(`  doubled in a window: "${r}"`);
    for (const p of fixes.slice(0, 6)) console.log(`  clean-up: "${p.text}"\n        ->  "${p.out}"`);
    for (const d of (s?.diffs ?? []).slice(0, 8)) console.log(`  live/typed: ${d}`);
    if (x.live.length) console.log(`  live:  ${x.live.join('').slice(0, 600)}`);
    if (typed) console.log(`  typed: ${typed.slice(0, 600)}`);
  }
  if (outDir && x.windows.length) {
    // the replay's clock: seconds since the first window's audio began; a window's audio ends when it was sent (answer time minus recogniser time)
    const first = x.windows[0], t0 = (first.at - (first.ms ?? 0)) / 1000 - (first.sec ?? 6);
    const windows = x.windows.map(w => { const to = (w.at - (w.ms ?? 0)) / 1000 - t0; return { t: +to.toFixed(3), at: +(w.at / 1000 - t0).toFixed(3), from: +Math.max(0, to - (w.sec ?? 6)).toFixed(3), to: +to.toFixed(3), text: w.text ?? '', ms: w.ms ?? 0 }; });
    const chunks = x.chunks.sort((a, b) => a.index - b.index).map(c => ({ at: +(c.at / 1000 - t0).toFixed(3), text: c.text }));
    const seconds = Math.max(...windows.map(w => w.to));
    fs.writeFileSync(path.join(outDir, 'windows', `${x.id}.json`), JSON.stringify({ id: x.id, seconds, windows }, null, 1));
    fs.writeFileSync(path.join(outDir, 'final', `${x.id}.json`), JSON.stringify({ id: x.id, chunks, text: typed, typed }, null, 1));
    cases.push({ id: x.id, kind: 'log', seconds, reference: typed, features: [] });
  }
}
if (outDir) { fs.writeFileSync(path.join(outDir, 'cases.json'), JSON.stringify(cases, null, 1)); console.log(`\nreplay input for ${cases.length} dictations in ${outDir} (tools/CaptionReplay in screen-agent)`); }
if (!list.length) console.log('no caption.log / caption.summary in this trace (gateway before 14 Nov 2026 or DESK_CAPTION_TEXT_LOG=off)');
