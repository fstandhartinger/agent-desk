// Manual: one real MAI-Transcribe-2 call over OpenRouter with a synthetic 1 s tone (no real speech, nothing private).
// Usage: OPENROUTER_API_KEY=... node gateway/test/manual/mai-live.mjs [phrase ...]
// Prints status, ms, text length, usage and the phrase-list outcome. Costs about USD 0.00003.
import { createDeviceMedia, pcmToWav } from '../../src/deviceMedia.js';

if (!process.env.OPENROUTER_API_KEY) { console.error('OPENROUTER_API_KEY is not set'); process.exit(2); }
const pcm = Buffer.alloc(32000);
for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / 16000)), i * 2);
const phrases = process.argv.slice(2).length ? process.argv.slice(2) : ['Karpathy', 'Bittensor', 'JevBench'];
const media = createDeviceMedia({ env: process.env });
for (const [label, list] of [['with phrases', phrases], ['without phrases', []], ['200 phrases', Array.from({ length: 200 }, (_, i) => `Begriff${i}`)]]) {
  try {
    const r = await media.caption(pcmToWav(pcm), list);
    console.log(label, { ms: r.ms, seconds: r.seconds, cost: r.cost, chars: r.text.length, retried: r.retried });
  } catch (err) { console.log(label, 'FAILED', { status: err.status, code: err.code, reason: err.reason, upstream: err.upstream, ms: err.ms }); }
}
