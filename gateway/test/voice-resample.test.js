import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler } from '../src/voice/resample.js';

const tone = (hz, rate, seconds, amp = 10000) => {
  const n = Math.round(rate * seconds);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
};
const rms = (buf, skip = 40) => {
  const s = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
  let acc = 0;
  for (let i = skip; i < s.length - skip; i++) acc += s[i] * s[i];
  return Math.sqrt(acc / (s.length - 2 * skip));
};

test('24k -> 16k yields 2/3 of the samples (minus filter look-ahead)', () => {
  const out = new Resampler(24000, 16000).push(tone(440, 24000, 1));
  assert.ok(Math.abs(out.length / 2 - 16000) <= 16, `got ${out.length / 2}`);
});

test('in-band tone keeps its amplitude, out-of-band tone is attenuated', () => {
  const pass = rms(new Resampler(24000, 16000).push(tone(1000, 24000, 1)));
  assert.ok(pass > 6500 && pass < 7500, `1 kHz rms ${pass}`); // 10000/sqrt2 = 7071
  const stop = rms(new Resampler(24000, 16000).push(tone(11000, 24000, 1)));
  assert.ok(stop < 700, `11 kHz rms ${stop}`);
});

test('chunked input equals one-shot input', () => {
  const pcm = Buffer.from(tone(700, 24000, 0.5).buffer);
  const whole = new Resampler(24000, 16000).push(pcm);
  const r = new Resampler(24000, 16000);
  const parts = [];
  for (let o = 0; o < pcm.length; o += 960) parts.push(r.push(pcm.subarray(o, o + 960)));
  assert.deepEqual(Buffer.concat(parts), whole);
});

test('16k -> 24k upsamples by 3/2 and keeps amplitude', () => {
  const out = new Resampler(16000, 24000).push(tone(1000, 16000, 1));
  assert.ok(Math.abs(out.length / 2 - 24000) <= 16);
  assert.ok(rms(out) > 6500);
});
