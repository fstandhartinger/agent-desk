// Voice session audio on LeChonk (bridge/src/audio.js): stereo Opus per session, 30-day retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-audio-'));
process.env.DESK_AUDIO_DIR = tmp;
const { append, finish, sweep, resetAudio } = await import('../src/audio.js');
const tone = (ms) => { const n = Math.floor(24 * ms); const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2); return b.toString('base64'); };
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('append validates its input', async () => {
  resetAudio();
  await assert.rejects(append({ aid: 'nope', chunks: [] }), /aid/);
  await assert.rejects(append({ aid: 'a#abc123', chunks: [{ role: 'system', t: 0, pcm: '' }] }), /bad chunk/);
  await assert.rejects(append({ aid: 'a#abc123', chunks: 'x' }), /array/);
});

test('a session becomes one private stereo Opus file; the raw parts are gone', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  resetAudio();
  assert.deepEqual(await finish({ aid: 'a#ffffff' }), { ok: false, reason: 'no audio' });
  await append({ aid: 'a#abc123', chunks: [{ role: 'user', t: 0, pcm: tone(800) }, { role: 'assistant', t: 1200, pcm: tone(1500) }] });
  await append({ aid: 'a#abc123', chunks: [{ role: 'user', t: 3000, pcm: tone(500) }] });
  const r = await finish({ aid: 'a#abc123' });
  assert.equal(r.ok, true);
  const day = fs.readdirSync(tmp)[0];
  const files = fs.readdirSync(path.join(tmp, day));
  assert.deepEqual(files, ['abc123.opus']);
  const st = fs.statSync(path.join(tmp, day, 'abc123.opus'));
  assert.equal(st.mode & 0o777, 0o600);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=channels:format=duration', '-of', 'json', path.join(tmp, day, 'abc123.opus')], { encoding: 'utf8' });
  const info = JSON.parse(probe.stdout);
  assert.equal(info.streams[0].channels, 2);
  assert.ok(Number(info.format.duration) >= 3.4, info.format.duration);
});

test('day folders older than 30 days are deleted', async () => {
  fs.mkdirSync(path.join(tmp, '2026-01-01'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '2026-01-01', 'aaaaaa.opus'), 'x');
  const keep = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(tmp, keep), { recursive: true });
  assert.equal(await sweep(), 1);
  assert.ok(!fs.existsSync(path.join(tmp, '2026-01-01')));
  assert.ok(fs.existsSync(path.join(tmp, keep)));
});
