/** Short, device-local opening. A voice that fails to begin yields to the live provider. */
export function speakCardOpening(voice: SpeechSynthesisVoice, text: string, started: () => void, ended: (played: boolean) => void) {
  const synth = globalThis.speechSynthesis;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice.lang;
  utterance.voice = voice;
  utterance.rate = 1.14;
  let played = false;
  const finish = (cancel: boolean) => {
    clearTimeout(timer);
    utterance.onstart = utterance.onend = utterance.onerror = null;
    if (cancel) synth.cancel();
    ended(played);
  };
  const timer = window.setTimeout(() => finish(true), 425);
  utterance.onstart = () => {
    played = true;
    clearTimeout(timer);
    started();
  };
  utterance.onend = () => finish(false);
  utterance.onerror = () => finish(false);
  // Keep completion asynchronous even if the engine throws, so the caller has stored the cancellation handle.
  try { synth.speak(utterance); } catch { queueMicrotask(() => { if (utterance.onerror) finish(false); }); }
  return () => finish(true);
}
