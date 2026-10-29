// Push-to-talk dictation: MediaRecorder (webm/opus, or WAV fallback for Safari) + live input level.
export interface Recording { stop(): Promise<Blob>; cancel(): void; level(): number }

const MAX_MS = 5 * 60 * 1000;

function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return ['audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export async function startRecording(onAutoStop: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);

  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(250);
  const timer = window.setTimeout(onAutoStop, MAX_MS);

  const release = () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
  };

  return {
    level() {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      return Math.min(1, Math.sqrt(sum / data.length) * 5);
    },
    cancel() {
      rec.onstop = null;
      if (rec.state !== 'inactive') rec.stop();
      release();
    },
    stop() {
      return new Promise<Blob>((resolve) => {
        rec.onstop = async () => {
          release();
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/mp4' });
          resolve(blob.type.includes('webm') ? blob : await toWav(blob).catch(() => blob));
        };
        rec.stop();
      });
    },
  };
}

/** Decodes any recorded format and re-encodes 16 kHz mono PCM WAV (accepted by the gateway). */
async function toWav(blob: Blob): Promise<Blob> {
  const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const buf = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  buf.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, 16000, true);
  buf.setUint32(28, 32000, true);
  buf.setUint16(32, 2, true);
  buf.setUint16(34, 16, true);
  str(36, 'data');
  buf.setUint32(40, pcm.length * 2, true);
  pcm.forEach((v, i) => buf.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}
