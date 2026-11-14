/**
 * Local "he started talking" detector on the mic level meter (0..1, 20 ms frames).
 * Why (a#41d6d2, 14 Nov): GPT-Live names no speech-start event and xAI/Gemini only send theirs after the vendor's VAD; the history
 * must show "Du sprichst …" at once. Hysteresis + a minimum run of loud frames keep clicks and breaths from opening a bubble.
 */
export const ONSET_LEVEL = 0.18; // levels.mic = min(1, rms * 4): rms ~0.045
export const HOLD_LEVEL = 0.1; // below this a frame counts as silence
export const ONSET_FRAMES = 6; // 120 ms of speech-level sound
export const ACTIVE_EVERY_FRAMES = 15; // 300 ms: how often "still talking" is reported

export type Onset = 'onset' | 'active' | null;

export class SpeechOnset {
  private run = 0;
  private voiced = false;
  private since = 0;

  /** One mic frame. 'onset' = speech began, 'active' = still voiced (reported every ACTIVE_EVERY_FRAMES), null = nothing to say. */
  feed(level: number): Onset {
    if (this.voiced) {
      if (level < HOLD_LEVEL) { this.voiced = false; this.run = 0; return null; }
      return ++this.since % ACTIVE_EVERY_FRAMES === 0 ? 'active' : null;
    }
    this.run = level >= ONSET_LEVEL ? this.run + 1 : 0;
    if (this.run < ONSET_FRAMES) return null;
    this.voiced = true;
    this.since = 0;
    return 'onset';
  }

  reset() { this.run = 0; this.voiced = false; this.since = 0; }
}
