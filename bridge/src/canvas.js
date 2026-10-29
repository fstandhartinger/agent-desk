// Claude sessions draw on the desk canvas with fenced blocks in their answer (docs/CANVAS.md "Bridge"):
//
//   ```desk-canvas
//   {"v":2,"id":"...","kind":"flow",...}
//   ```
//
// CanvasStream cuts such blocks out of the text while it streams (an unfinished block is held back until it is closed
// or the turn ends), emits {kind:"canvas", spec} for every valid JSON object and {kind:"canvas_error", message}
// otherwise, and puts "[Skizze auf der Canvas: <title>]" into the shown text.

const OPEN = '```desk-canvas';
const CLOSE_RE = /\n```[ \t]*(?:\r?\n|$)/;
const MAX_HELD = 200_000;

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function placeholder(spec) {
  const title = typeof spec?.title === 'string' && spec.title.trim() ? spec.title : typeof spec?.id === 'string' ? spec.id : 'Skizze';
  return `[Skizze auf der Canvas: ${clip(title.replace(/\s+/g, ' ').trim(), 70)}]`;
}

export class CanvasStream {
  #buf = '';
  #inBlock = false;
  #atLineStart = true;
  #seen;

  /** `seen` is shared between the streaming path and the complete-message path so a block is announced once per turn. */
  constructor(seen = new Set()) { this.#seen = seen; }

  get holding() { return this.#buf.length > 0 || this.#inBlock; }

  push(chunk) {
    this.#buf += String(chunk ?? '');
    return this.#drain();
  }

  /** End of a content block or of the turn: whatever is held back is shown as it is; an open block is an error. */
  flush() {
    const out = [];
    if (this.#inBlock) {
      out.push({ kind: 'canvas_error', message: 'desk-canvas block was never closed with ```' });
      out.push({ kind: 'text_delta', text: `${OPEN}\n${this.#buf}` });
    } else if (this.#buf) out.push({ kind: 'text_delta', text: this.#buf });
    this.#buf = '';
    this.#inBlock = false;
    this.#atLineStart = true;
    return out;
  }

  #findOpen() {
    for (let i = this.#buf.indexOf(OPEN); i >= 0; i = this.#buf.indexOf(OPEN, i + 1)) {
      if (i === 0 ? this.#atLineStart : this.#buf[i - 1] === '\n') return i;
    }
    return -1;
  }

  #text(out, text) {
    if (!text) return;
    out.push({ kind: 'text_delta', text });
    this.#atLineStart = text.endsWith('\n');
  }

  #drain() {
    const out = [];
    for (;;) {
      if (!this.#inBlock) {
        const at = this.#findOpen();
        if (at >= 0) {
          this.#text(out, this.#buf.slice(0, at));
          this.#buf = this.#buf.slice(at);
          this.#atLineStart = true;
          const head = /^```desk-canvas[^\n]*\n/.exec(this.#buf);
          if (!head) return out; // the opening line is not complete yet
          this.#buf = this.#buf.slice(head[0].length);
          this.#inBlock = true;
          continue;
        }
        // Hold back a tail that may still become the opening marker (at a line start).
        let keep = 0;
        for (let n = Math.min(OPEN.length - 1, this.#buf.length); n > 0; n--) {
          const start = this.#buf.length - n;
          const lineStart = start === 0 ? this.#atLineStart : this.#buf[start - 1] === '\n';
          if (lineStart && OPEN.startsWith(this.#buf.slice(start))) { keep = n; break; }
        }
        const cut = this.#buf.length - keep;
        this.#text(out, this.#buf.slice(0, cut));
        this.#buf = this.#buf.slice(cut);
        if (keep) this.#atLineStart = true;
        return out;
      }
      const empty = this.#buf.startsWith('```') && /^```[ \t]*(?:\r?\n|$)/.test(this.#buf);
      const m = empty ? { index: 0, 0: /^```[ \t]*(?:\r?\n|$)/.exec(this.#buf)[0] } : CLOSE_RE.exec(this.#buf);
      if (!m) {
        if (this.#buf.length > MAX_HELD) {
          out.push({ kind: 'canvas_error', message: 'desk-canvas block is too large (over 200 000 characters)' });
          this.#text(out, '[Skizze auf der Canvas: zu groß]');
          this.#buf = '';
          this.#inBlock = false;
        }
        return out;
      }
      const body = this.#buf.slice(0, m.index);
      const rest = this.#buf.slice(m.index + m[0].length);
      this.#finishBlock(out, body, m[0].endsWith('\n') ? '\n' : '');
      this.#buf = rest;
      this.#inBlock = false;
      this.#atLineStart = m[0].endsWith('\n');
    }
  }

  #finishBlock(out, body, tail) {
    const key = body.trim();
    const first = !this.#seen.has(key);
    this.#seen.add(key);
    let spec = null;
    let message = '';
    try {
      const parsed = JSON.parse(key);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) spec = parsed;
      else message = 'desk-canvas block must be one JSON object';
    } catch (err) {
      message = `desk-canvas block is not valid JSON: ${clip(String(err.message), 160)}`;
    }
    if (spec) {
      if (first) out.push({ kind: 'canvas', spec });
      this.#text(out, placeholder(spec) + tail);
    } else {
      if (first) out.push({ kind: 'canvas_error', message });
      this.#text(out, `[Skizze auf der Canvas: ungültig]${tail}`);
    }
  }
}

/** A complete assistant text: {text with blocks replaced, events: canvas/canvas_error not announced before}. */
export function stripCanvasBlocks(text, seen) {
  const s = new CanvasStream(seen);
  const evs = [...s.push(text), ...s.flush()];
  return {
    text: evs.filter((e) => e.kind === 'text_delta').map((e) => e.text).join(''),
    events: evs.filter((e) => e.kind !== 'text_delta'),
  };
}
