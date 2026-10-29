// Streaming PCM16 mono resampler (windowed sinc, Blackman). Keeps filter history between chunks so chunk
// boundaries are inaudible. Used for the Gemini input path (24 kHz browser mic -> 16 kHz).
const TAPS = 8; // zero crossings per side at the cut-off frequency

const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const blackman = (u) => 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u); // u in [-1, 1]

export class Resampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.scale = Math.min(1, toRate / fromRate); // low-pass below the target Nyquist when downsampling
    this.half = Math.ceil(TAPS / this.scale);
    this.buf = new Float32Array(0);
    this.base = 0; // absolute input index of buf[0]
    this.nextOut = 0;
    this.total = 0;
  }

  /** @param {Buffer|Int16Array} pcm  @returns {Buffer} PCM16 LE */
  push(pcm) {
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    const merged = new Float32Array(this.buf.length + samples.length);
    merged.set(this.buf);
    for (let i = 0; i < samples.length; i++) merged[this.buf.length + i] = samples[i] / 32768;
    this.buf = merged;
    this.total += samples.length;

    const out = [];
    for (;;) {
      const pos = this.nextOut * this.step;
      const centre = Math.floor(pos);
      if (centre + this.half >= this.total) break; // need look-ahead
      let acc = 0;
      for (let k = centre - this.half + 1; k <= centre + this.half; k++) {
        const d = k - pos;
        const v = k < 0 ? 0 : this.buf[k - this.base];
        acc += v * this.scale * sinc(this.scale * d) * blackman(d / this.half);
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc * 32768))));
      this.nextOut++;
    }
    const keepFrom = Math.max(0, Math.floor(this.nextOut * this.step) - this.half);
    if (keepFrom > this.base) {
      this.buf = this.buf.slice(keepFrom - this.base);
      this.base = keepFrom;
    }
    return Buffer.from(Int16Array.from(out).buffer);
  }
}
