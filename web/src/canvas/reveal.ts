// Speech-synced reveal of a points canvas: point i appears when the sentence that introduces it (its `cue`, verbatim words of
// the spoken answer) is being spoken. Pure: spec + where the speech cursor is → how many leading points are visible.
import type { CanvasSpec } from './types';
import type { SpeechCursor } from '../lib/speechCursor';

/** A point is due when its cue starts at most this many characters ahead of the spoken position (the voice is a bit ahead of the estimate). */
export const LOOKAHEAD_CHARS = 12;
/** No speech for this long (ms): the answer is over (or was never spoken): show everything. */
export const IDLE_ALL_MS = 1500;
/** A point without a usable cue follows its predecessor after this many spoken characters (about one sentence), not at once. */
export const UNCUED_GAP_CHARS = 60;

/** Lowercase, punctuation to spaces, whitespace collapsed; `map[i]` = the index in the ORIGINAL text of normalised character i. */
export function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let space = true; // leading spaces are dropped
  const src = String(text);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i].toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch;
      map.push(i);
      space = false;
    } else if (!space) {
      norm += ' ';
      map.push(i);
      space = true;
    }
  }
  if (norm.endsWith(' ')) { norm = norm.slice(0, -1); map.pop(); }
  return { norm, map };
}

export const normalize = (text: string): string => normalizeWithMap(text).norm;

/** How many leading points of `spec` are visible now. `sinceMs` = ms since the cursor last said `speaking`; `specTurn` = the
 *  cursor's turn when the canvas arrived (undefined = loaded from history: everything). Never below 1 for a sync spec. */
export function revealCount(spec: CanvasSpec, cursor: SpeechCursor, sinceMs: number, specTurn: number | undefined): number {
  const pts = spec.points ?? [];
  const n = pts.length;
  if (spec.kind !== 'points' || spec.sync !== 'speech' || n === 0) return n;
  if (specTurn === undefined || cursor.turn !== specTurn) return n; // a newer user turn began: the answer is over
  if (!cursor.speaking && sinceMs >= IDLE_ALL_MS) return n;
  const { norm, map } = normalizeWithMap(cursor.text);
  let from = 0;
  let prevDueAt = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const cue = normalize(pts[i].cue ?? '');
    const p = cue ? norm.indexOf(cue, from) : -1;
    let dueAt: number;
    if (p >= 0) {
      dueAt = Math.max(0, (map[p] ?? 0) - LOOKAHEAD_CHARS); // due when map[p] <= spokenChars + LOOKAHEAD_CHARS
      from = p + cue.length;
    } else dueAt = i === 0 ? 0 : prevDueAt + UNCUED_GAP_CHARS;
    dueAt = Math.max(dueAt, prevDueAt);
    if (cursor.spokenChars < dueAt) break;
    prevDueAt = dueAt;
    count = i + 1;
  }
  return Math.max(1, count);
}
