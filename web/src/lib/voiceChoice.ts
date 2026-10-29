import { optionByKey, type VoiceOption } from './voice';
import type { DeskStatus } from './status';

// When the user's voice provider is known to be down, a session starts on the first usable option instead of
// failing first. The order prefers Gemini extended, which carries the voice tools reliably.
const FALLBACK_ORDER = ['gemini', 'gemini-fast', 'openai', 'xai'];

const down = (providers: DeskStatus['providers'], o: VoiceOption) => providers[o.provider]?.state === 'failed' || providers[o.provider]?.state === 'off';

/** `run` is what to start now; `picked` is set when it differs from the user's choice (which stays selected). */
export function chooseVoice(choice: VoiceOption, providers: DeskStatus['providers']): { run: VoiceOption; picked?: VoiceOption } {
  if (!down(providers, choice)) return { run: choice };
  const usable = FALLBACK_ORDER.map(optionByKey).find((o) => o.key !== choice.key && !down(providers, o));
  return usable ? { run: usable, picked: choice } : { run: choice };
}

export const voiceUnavailableNotice = (picked: VoiceOption, run: VoiceOption) => `${picked.label} ist nicht verfügbar – ${run.label} übernimmt.`;
