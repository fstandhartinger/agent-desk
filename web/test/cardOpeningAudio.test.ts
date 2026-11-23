import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playCardOpeningAudio } from '../src/lib/cardOpening';

type Mode = 'plays' | 'rejects' | 'stalls';
function fakeAudio(mode: Mode) {
  const made: { paused: boolean }[] = [];
  class FakeAudio {
    onplaying: (() => void) | null = null; onended: (() => void) | null = null; onerror: (() => void) | null = null;
    preload = ''; paused = false;
    constructor(public src: string) { made.push(this); }
    play() {
      if (mode === 'rejects') return Promise.reject(new Error('NotAllowedError'));
      if (mode === 'plays') { setTimeout(() => this.onplaying?.(), 5); setTimeout(() => this.onended?.(), 20); }
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }
  Object.assign(globalThis, { Audio: FakeAudio });
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  return made;
}
const audio = { mime: 'audio/wav', data: btoa('RIFFxxxxWAVE'), voice: 'C3' };
const run = (windowMs = 50) => new Promise<{ started: boolean; played: boolean; ms: number }>((resolve) => {
  const t0 = performance.now(); let started = false;
  playCardOpeningAudio(audio, () => { started = true; }, (played) => resolve({ started, played, ms: performance.now() - t0 }), windowMs);
});

test('pre-rendered opening plays to the end', async () => {
  fakeAudio('plays');
  assert.deepEqual((({ started, played }) => ({ started, played }))(await run()), { started: true, played: true });
});

test('a blocked play falls back at once; a stalled one after the start window, and is paused', async () => {
  fakeAudio('rejects');
  const r = await run();
  assert.equal(r.played, false); assert.equal(r.started, false); assert.ok(r.ms < 40, `rejected after ${r.ms} ms`);
  const made = fakeAudio('stalls');
  const s = await run(30);
  assert.equal(s.played, false); assert.ok(s.ms >= 25); assert.equal(made[0].paused, true);
});
