// Audio of Desk voice sessions (Florian, 15 Nov 2026, card 19712 "Ja": keep the sound of voice sessions 30 days, privately, to hear
// recognition errors and pauses). LeChonk only. The gateway sends timed PCM chunks (24 kHz, 16-bit mono) per session and role
// (user = Florian's microphone, silent frames left out; assistant = the voice model); at the end the bridge writes ONE stereo Opus
// file (left Florian, right Desk, on one timeline) and deletes the raw parts. Files older than 30 days are deleted.
// Stored in ~/desk-audio/<YYYY-MM-DD>/<6-hex id>.opus (0600, directories 0700); never in a repository, never served.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME } from './paths.js';

export const RATE = 24000;
export const RETAIN_DAYS = 30;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024; // one append (about 20 s of both roles), decoded
const MAX_SESSION_BYTES = 400 * 1024 * 1024; // 30 min of both roles at 24 kHz is ~170 MB raw: a hard stop well above that
const ID = /^[0-9a-f]{6}$/;
const ROLES = new Set(['user', 'assistant']);
const dir = () => process.env.DESK_AUDIO_DIR || path.join(HOME, 'desk-audio');
const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const sessions = new Map(); // id -> {dir, bytes, parts: {user: [], assistant: []}}

function idOf(aid) {
  const id = String(aid ?? '').replace(/^a#/i, '').toLowerCase();
  if (!ID.test(id)) throw new Error('aid must be a#<6 hex>');
  return id;
}

async function sessionOf(id) {
  let s = sessions.get(id);
  if (s) return s;
  const d = path.join(dir(), day());
  await fs.promises.mkdir(d, { recursive: true, mode: 0o700 });
  s = { dir: d, bytes: 0, parts: { user: [], assistant: [] } };
  sessions.set(id, s);
  return s;
}

/** append({aid, chunks: [{role, t (ms since session start), pcm (base64 PCM16 24 kHz mono)}]}) */
export async function append({ aid, chunks } = {}) {
  const id = idOf(aid);
  if (!Array.isArray(chunks) || chunks.length > 2000) throw new Error('chunks must be an array (at most 2000)');
  const s = await sessionOf(id);
  let total = 0;
  for (const c of chunks) {
    if (!ROLES.has(c?.role) || !Number.isFinite(c?.t) || c.t < 0 || c.t > 6 * 3600_000 || typeof c.pcm !== 'string') throw new Error('bad chunk');
    const buf = Buffer.from(c.pcm, 'base64');
    total += buf.length;
    if (total > MAX_CHUNK_BYTES) throw new Error('append too large');
    if (s.bytes + buf.length > MAX_SESSION_BYTES) return { ok: false, full: true };
    const file = path.join(s.dir, `${id}.${c.role}.raw`);
    const offset = s.parts[c.role].reduce((n, p) => n + p.bytes, 0);
    await fs.promises.appendFile(file, buf, { mode: 0o600 });
    s.parts[c.role].push({ t: Math.round(c.t), offset, bytes: buf.length });
    s.bytes += buf.length;
  }
  return { ok: true, bytes: s.bytes };
}

/** One role's raw parts laid on the timeline (silence between them) as a WAV file; null when the role has no audio. */
async function timelineWav(rawFile, parts, outFile) {
  if (!parts.length) return null;
  const raw = await fs.promises.readFile(rawFile);
  const bytesAt = (t) => Math.floor((t / 1000) * RATE) * 2;
  const end = Math.max(...parts.map((p) => bytesAt(p.t) + p.bytes));
  const pcm = Buffer.alloc(end);
  let cursor = 0;
  for (const p of parts.sort((a, b) => a.t - b.t)) {
    const at = Math.max(bytesAt(p.t), cursor); // speech that arrives faster than real time (the model streams ahead) follows on
    raw.copy(pcm, at, p.offset, p.offset + p.bytes);
    cursor = at + p.bytes;
  }
  const body = pcm.subarray(0, Math.max(cursor, end));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(body.length, 40);
  await fs.promises.writeFile(outFile, Buffer.concat([head, body]), { mode: 0o600 });
  return outFile;
}

const run = (bin, args) => new Promise((resolve, reject) => {
  const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-200)}`))));
});

/** finish({aid}) -> {ok, file, seconds}: stereo Opus (left Florian, right Desk), raw parts deleted. */
export async function finish({ aid } = {}) {
  const id = idOf(aid);
  const s = sessions.get(id);
  if (!s) return { ok: false, reason: 'no audio' };
  sessions.delete(id);
  const raw = (role) => path.join(s.dir, `${id}.${role}.raw`);
  const wav = (role) => path.join(s.dir, `${id}.${role}.wav`);
  const out = path.join(s.dir, `${id}.opus`);
  try {
    const [u, a] = await Promise.all([timelineWav(raw('user'), s.parts.user, wav('user')), timelineWav(raw('assistant'), s.parts.assistant, wav('assistant'))]);
    if (!u && !a) return { ok: false, reason: 'no audio' };
    const silent = ['-f', 'lavfi', '-i', `anullsrc=r=${RATE}:cl=mono`];
    const inputs = [...(u ? ['-i', u] : silent), ...(a ? ['-i', a] : silent)];
    const wavSeconds = async (f) => (f ? ((await fs.promises.stat(f)).size - 44) / (RATE * 2) : 0);
    const seconds = Math.max(await wavSeconds(u), await wavSeconds(a));
    // both tracks padded with silence and cut to the longer one (amerge alone stops with the shorter stream)
    await run(process.env.BRIDGE_FFMPEG || 'ffmpeg', ['-loglevel', 'error', '-y', ...inputs, '-filter_complex', '[0:a]apad[l];[1:a]apad[r];[l][r]amerge=inputs=2[s]', '-map', '[s]', '-ac', '2', '-t', seconds.toFixed(2), '-c:a', 'libopus', '-b:a', '32k', out]);
    await fs.promises.chmod(out, 0o600);
    return { ok: true, file: `~/desk-audio/${path.basename(s.dir)}/${id}.opus`, seconds: Math.round(seconds) };
  } finally {
    for (const f of [raw('user'), raw('assistant'), wav('user'), wav('assistant')]) await fs.promises.rm(f, { force: true });
  }
}

/** Deletes day folders older than RETAIN_DAYS. Returns the number of folders removed. */
export async function sweep(now = Date.now()) {
  let removed = 0;
  let days = [];
  try { days = await fs.promises.readdir(dir()); } catch { return 0; /* no audio folder yet: nothing to delete */ }
  const cutoff = day(now - RETAIN_DAYS * 86_400_000);
  for (const d of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) { await fs.promises.rm(path.join(dir(), d), { recursive: true, force: true }); removed += 1; }
  }
  return removed;
}

/** Hourly retention sweep; returns stop(). */
export function startAudioSweep(log = () => {}, paused = () => false) {
  let sweeping = false;
  const tick = () => {
    if (paused() || sweeping) return;
    sweeping = true;
    void sweep().then((n) => n && log(`desk-audio: ${n} day folder(s) older than ${RETAIN_DAYS} days deleted`), () => {})
      .finally(() => { sweeping = false; });
  };
  tick();
  const t = setInterval(tick, 3600_000);
  t.unref?.();
  return Object.assign(() => clearInterval(t), { busy: () => sweeping });
}

/** Tests only. */
export const resetAudio = () => sessions.clear();
