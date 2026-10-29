// Conservative USD-per-second estimates used for the daily cap (docs/SPEC.md). Providers report exact usage only
// at session end (if at all), so the live number is time based; err on the high side.
const PER_SECOND = {
  xai: 0.05 / 60, // Grok Voice Agent API list price: $0.05 / minute
  openai: 0.3 / 60, // gpt-live-1 audio + gpt-6-astra delegation (medium reasoning), generous guess
  gemini: 0.03 / 60, // native-audio Live API incl. thinking tokens
};

export function estimateCost(provider, seconds) {
  return (PER_SECOND[provider] ?? PER_SECOND.openai) * seconds;
}
