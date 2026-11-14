// Conservative USD-per-second estimates used for the daily cap and the running cost in the dock (docs/SPEC.md). The voice
// providers report no usage on these sockets, so the live number is time based; err on the high side.
// Re-priced 14 Nov 2026 from the providers' own price pages (agent-desk-fixes-20261114, cost slice):
//   xAI grok-voice-3.0 $0.08/min + $0.004 per text input (docs.x.ai/developers/pricing) -> 0.10/min with ~4 text inputs a minute.
//   OpenAI gpt-live-1 $0.05 per connected minute (developers.openai.com/api/docs/models/gpt-live-1) + the Responses delegate:
//     gpt-6.1-sol $2/$10 per M in/out, gpt-6-astra $10/$50. A delegated question with ~4k tokens in and 300 out costs
//     ~$0.011 (Sol) / ~$0.055 (Astra); the envelope below allows ~2-3 such questions a minute with a growing history.
//   Gemini 3.8 Live audio $3/M in, $12/M out (25 tokens/s) and retained history billed again each turn: ~$0.02/min for
//     short sessions, ~$0.09/min on average over 20 minutes -> 0.12/min envelope.
import { cfg } from '../config.js';

const PER_MIN = {
  xai: 0.10,
  gemini: 0.12,
  openai: { 'gpt-6.1-sol': 0.15, 'gpt-6-astra': 0.35 },
};
const OPENAI_UNKNOWN = 0.35; // another delegate model: the dearer envelope

export function perMinute(provider, delegate = cfg.openaiDelegateModel()) {
  if (provider === 'openai' || !(provider in PER_MIN)) return PER_MIN.openai[delegate] ?? OPENAI_UNKNOWN;
  return PER_MIN[provider];
}

export function estimateCost(provider, seconds) {
  return (perMinute(provider) / 60) * seconds;
}
