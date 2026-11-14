// Where the spoken answer is right now, cheaply: the assistant transcript received so far, and how much of the audio
// received so far has been played. spokenChars = text.length × (played / received) — good enough to time a canvas reveal
// to the sentence being spoken (canvas/reveal.ts). The store is updated at most ~10×/s; the tracker does O(1) work per message.
import { createStore } from './store';

export interface SpeechCursor {
  /** Bumps when a new user turn begins (the user's final transcript) or on a barge-in flush. */
  turn: number;
  /** The assistant transcript of this turn so far. */
  text: string;
  spokenChars: number;
  speaking: boolean;
}
export interface SpeechCursorState extends SpeechCursor {
  /** A voice session is running (without one, canvases reveal on their own with a short stagger). */
  active: boolean;
}

export const speechCursor = createStore<SpeechCursorState>({ turn: 0, text: '', spokenChars: 0, speaking: false, active: false });

export const PUBLISH_MS = 100;
const SAMPLE_RATE = 24000;
const SPEAKING_BUFFER = 0.02;

export interface TrackerDeps { now: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void }
const realDeps: TrackerDeps = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };

/** Per voice session: feeds the store from the three streams the browser sees (audio chunks, transcripts, player reports). */
export class SpeechTracker {
  private receivedSec = 0;
  private buffered = 0;
  private text = '';
  private turn = 0;
  private lastPublish = -Infinity;
  private timer: unknown = null;
  private afterFinal = false;

  constructor(private store = speechCursor, private deps: TrackerDeps = realDeps) {
    // the turn counter continues across sessions so an older canvas never matches a newer session's turn
    this.turn = store.get().turn;
  }

  start() { this.set({ active: true, speaking: false }); this.publish(true); }
  stop() { this.receivedSec = 0; this.buffered = 0; this.text = ''; this.turn += 1; this.cancel(); this.store.set((s) => ({ ...s, active: false, turn: this.turn, text: '', spokenChars: 0, speaking: false })); }

  /** A binary audio chunk (PCM16, 24 kHz, mono). */
  audio(bytes: number) {
    this.receivedSec += bytes / 2 / SAMPLE_RATE;
    this.publish();
  }

  /** An assistant transcript message: `delta` appends; a final whole text replaces the text when it is longer. */
  transcript(text: string, final: boolean, isDelta: boolean) {
    if (isDelta) {
      // a new segment after a final one (a second answer part in the same turn) starts after a space
      const sep = this.afterFinal && this.text && !/\s$/.test(this.text) && !/^\s/.test(text) ? ' ' : '';
      this.text += sep + text;
      this.afterFinal = false;
    } else if (text && text.length > this.text.length) this.text = text;
    if (final) this.afterFinal = true;
    this.publish();
  }

  /** The player worklet's periodic report (`buffered` = seconds of audio still waiting to be played). */
  player(buffered: number) {
    this.buffered = Math.max(0, buffered);
    this.publish();
  }

  /** A new user turn (the user's final transcript) or a barge-in flush: everything starts over. */
  reset() {
    this.turn += 1;
    this.receivedSec = 0;
    this.buffered = 0;
    this.text = '';
    this.afterFinal = false;
    this.publish(true);
  }

  snapshot(): SpeechCursor {
    const spokenSec = Math.max(0, this.receivedSec - this.buffered);
    const spokenChars = this.receivedSec > 0 ? Math.round(this.text.length * Math.min(1, spokenSec / this.receivedSec)) : 0;
    return { turn: this.turn, text: this.text, spokenChars, speaking: this.buffered > SPEAKING_BUFFER };
  }

  private set(patch: Partial<SpeechCursorState>) { this.store.set((s) => ({ ...s, ...patch })); }

  private cancel() { if (this.timer !== null) { this.deps.clearTimeout(this.timer); this.timer = null; } }

  /** At most PUBLISH_MS apart: the first change goes out at once, later ones are folded into one trailing publish. */
  private publish(force = false) {
    const now = this.deps.now();
    if (force || now - this.lastPublish >= PUBLISH_MS) {
      this.cancel();
      this.flush(now);
    } else if (this.timer === null) {
      this.timer = this.deps.setTimeout(() => { this.timer = null; this.flush(this.deps.now()); }, PUBLISH_MS - (now - this.lastPublish));
    }
  }

  private flush(now: number) {
    this.lastPublish = now;
    const c = this.snapshot();
    this.store.set((s) => (s.turn === c.turn && s.text === c.text && s.spokenChars === c.spokenChars && s.speaking === c.speaking ? s : { ...s, ...c }));
  }
}

// The turn each canvas arrived in, so a reveal stops once a newer user turn begins (recorded by the canvas bus callback).
const specTurns = new Map<string, number>();
const SPEC_TURNS_MAX = 60;
export function noteSpecTurn(id: string, turn = speechCursor.get().turn) {
  specTurns.delete(id);
  specTurns.set(id, turn);
  if (specTurns.size > SPEC_TURNS_MAX) specTurns.delete(specTurns.keys().next().value as string);
}
/** The turn the canvas `id` arrived in; undefined for canvases loaded from the history (they show everything). */
export const specTurnOf = (id: string): number | undefined => specTurns.get(id);
