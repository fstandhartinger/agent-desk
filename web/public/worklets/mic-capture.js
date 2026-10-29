// AudioWorklet: mono mic capture -> PCM16 LE at 24 kHz in 20 ms frames (480 samples) + RMS level.
// Resamples linearly when the context does not run at 24 kHz.
class MicCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.target = options.processorOptions?.targetRate || 24000;
    this.frame = Math.round(this.target * 0.02);
    this.ratio = sampleRate / this.target;
    this.buf = new Float32Array(this.frame);
    this.fill = 0;
    this.pos = 0; // fractional read position into the current input block for resampling
    this.prev = 0;
  }

  push(s) {
    this.buf[this.fill++] = s;
    if (this.fill === this.frame) {
      const pcm = new Int16Array(this.frame);
      let sum = 0;
      for (let i = 0; i < this.frame; i++) {
        const v = Math.max(-1, Math.min(1, this.buf[i]));
        sum += v * v;
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / this.frame) }, [pcm.buffer]);
      this.fill = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
      return true;
    }
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const f = this.pos - i;
      const a = i === 0 ? this.prev : ch[i - 1];
      const b = ch[i];
      this.push(a + (b - a) * f);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;
    this.prev = ch[ch.length - 1];
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
