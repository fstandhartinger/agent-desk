// AudioWorklet: ring-buffer player for 24 kHz PCM16 chunks. Flushes instantly on barge-in.
// Posts {rms, buffered} ~30x/s so the UI can drive the voice orb and know when speech ended.
class PcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.source = options.processorOptions?.sourceRate || 24000;
    this.step = this.source / sampleRate;
    this.size = this.source * 120; // 2 minutes of audio; oldest data is overwritten if exceeded
    this.ring = new Float32Array(this.size);
    this.read = 0; // fractional
    this.write = 0;
    this.count = 0;
    this.sum = 0;
    this.n = 0;
    this.every = Math.round(sampleRate / 30);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m === 'flush') {
        this.read = this.write;
        this.count = 0;
        return;
      }
      const pcm = new Int16Array(m);
      for (let i = 0; i < pcm.length; i++) {
        this.ring[this.write] = pcm[i] / 0x8000;
        this.write = (this.write + 1) % this.size;
      }
      this.count = Math.min(this.size, this.count + pcm.length);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      let v = 0;
      if (this.count > 1) {
        const r = Math.floor(this.read);
        const f = this.read - r;
        const a = this.ring[r % this.size];
        const b = this.ring[(r + 1) % this.size];
        v = a + (b - a) * f;
        this.read += this.step;
        const adv = Math.floor(this.read) - r;
        this.count -= adv;
        if (this.read >= this.size) this.read -= this.size;
      }
      out[i] = v;
      this.sum += v * v;
      if (++this.n >= this.every) {
        this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), buffered: Math.max(0, this.count) / this.source });
        this.sum = 0;
        this.n = 0;
      }
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
