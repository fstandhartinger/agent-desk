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

export interface OpeningAudio { mime: string; data: string; voice?: string }

/**
 * The pre-rendered opening in the central narration voice (gateway cardOpeningAudio.js). It must START within `windowMs`,
 * otherwise it is cancelled and `ended(false)` lets the caller fall back to the device voice: never slower than before.
 */
export function playCardOpeningAudio(audio: OpeningAudio, started: () => void, ended: (played: boolean) => void, windowMs = 200) {
  let url = '';
  let el: HTMLAudioElement | null = null;
  let played = false, done = false;
  const finish = (cancel: boolean) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (el) {
      el.onplaying = el.onended = el.onerror = null;
      if (cancel) { try { el.pause(); } catch { /* already gone */ } }
    }
    if (url) URL.revokeObjectURL(url);
    ended(played);
  };
  const timer = window.setTimeout(() => finish(true), windowMs);
  try {
    const bin = atob(audio.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes], { type: audio.mime || 'audio/wav' }));
    el = new Audio(url);
    el.preload = 'auto';
    el.onplaying = () => {
      if (played || done) return;
      played = true;
      clearTimeout(timer);
      started();
    };
    el.onended = () => finish(false);
    el.onerror = () => finish(false);
    const p = el.play();
    p?.catch?.(() => finish(false));
  } catch { queueMicrotask(() => finish(false)); }
  return () => finish(true);
}
