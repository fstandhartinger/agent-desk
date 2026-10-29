// Some models (DeepSeek in particular) write a tool call as plain text when no tools are offered or when the call
// format slips. That markup must never reach the user as the answer: this filter cuts the stream at its start.
const MARKERS = ['<｜DSML｜', '<|DSML|', '<tool_call', '<|tool', '<｜tool', '<function_calls', '<invoke ', '<|python_tag|>', '[TOOL_CALLS]', '<｜begin▁of▁tool'];

export class ToolMarkupFilter {
  #pending = '';

  /** True once tool-call markup was seen; everything from its first character on was dropped. */
  dropped = false;

  /** Takes the next text delta, returns the part that is safe to show. A possible marker prefix is held back. */
  push(delta) {
    if (this.dropped) return '';
    const text = this.#pending + delta;
    const hit = MARKERS.map((m) => text.indexOf(m)).filter((i) => i >= 0);
    if (hit.length) {
      this.dropped = true;
      this.#pending = '';
      return text.slice(0, Math.min(...hit));
    }
    let hold = 0;
    for (const marker of MARKERS) {
      for (let n = Math.min(marker.length - 1, text.length); n > hold; n -= 1) {
        if (marker.startsWith(text.slice(-n))) { hold = n; break; }
      }
    }
    this.#pending = text.slice(text.length - hold);
    return text.slice(0, text.length - hold);
  }

  /** Releases a held-back tail at the end of the stream (it turned out not to be a marker). */
  flush() {
    const rest = this.dropped ? '' : this.#pending;
    this.#pending = '';
    return rest;
  }
}
