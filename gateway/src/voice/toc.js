// Context appended to a running voice session is a TABLE OF CONTENTS, never the detail (a#41d6d2, 14 Nov 2026, 13:44Z): OpenAI GPT-Live
// closed both sessions after 0 s with "Context append text must not exceed 500 tokens". The start briefing (up to 6000 characters, ~2000
// tokens) went out as one `session.instructions.append`. Limits (developers.openai.com, read 14 Nov 2026, Live primary WebSocket + guides
// live-conversations / live-delegation): `session.start.instructions` <= 16,384 tokens; `session.instructions.append`,
// `session.thinking.append` and `session.commentary.append` each "limited to 500 tokens" (per append; appends stay in the conversation
// history through compaction, so every append is paid again on every later turn). Florian: "mehr eine Art Inhaltsangabe, mit Verweisen,
// wo das Modell über Tool-Calls on demand Details nachladen kann".

/**
 * Conservative token estimate. German text is ~3.5-4 chars/token on the OpenAI/Gemini tokenizers; digits, ids and JSON punctuation are
 * denser. chars/3 plus a small surcharge per non-letter character over-counts on purpose: a trimmed line costs less than a closed session.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let dense = 0;
  for (const ch of s) if (!/[\p{L}\s]/u.test(ch)) dense += 1;
  return Math.ceil(s.length / 3 + dense / 6);
}

/** Per provider: the vendor's hard limit of ONE appended context text, and what this desk allows itself (margin for the estimator). */
export const APPEND_LIMIT = { openai: 500 };
export const APPEND_BUDGET = {
  openai: 400, // 80 % of the documented 500 tokens
  // xAI and Gemini document no per-append limit (xAI: a conversation item; Gemini: rides along with a tool result). The TOC has the same
  // shape and size everywhere; these budgets are only the safety net for the other free-text channels (screen description, notes).
  xai: 1500,
  gemini: 1500,
};
export const budgetOf = (provider) => APPEND_BUDGET[provider] ?? APPEND_BUDGET.xai;

/**
 * `text` within `maxTokens`: whole lines are dropped from the END (callers put the lowest-priority lines last); when even the first line
 * is too long it is cut. Returns { text, from, to, trimmed } (tokens estimated). Never throws, never returns more than maxTokens.
 */
export function fitText(text, maxTokens) {
  const src = String(text ?? '');
  const from = estimateTokens(src);
  if (from <= maxTokens) return { text: src, from, to: from, trimmed: false };
  const lines = src.split('\n');
  // a closing marker line (</artifact_data>) survives a trim, or the data block would stay open
  const closer = lines.length > 1 && /^<\/artifact_data>$/.test(lines.at(-1)) ? lines.pop() : null;
  const join = () => (closer ? [...lines, closer] : lines).join('\n');
  while (lines.length > 1 && estimateTokens(join()) > maxTokens) lines.pop();
  let out = join();
  if (estimateTokens(out) > maxTokens) {
    let cut = Math.max(0, Math.floor(maxTokens * 3) - 1);
    out = src.slice(0, cut).trimEnd();
    while (cut > 0 && estimateTokens(`${out}…`) > maxTokens) { cut = Math.floor(cut * 0.9); out = src.slice(0, cut).trimEnd(); }
    out = `${out}…`;
  }
  return { text: out, from, to: estimateTokens(out), trimmed: true };
}

/**
 * The adapters' safety net for every context text they send after the start: fits `text` to the provider's budget and reports a trim
 * through `emit({ t: 'context_trimmed', kind, from, to, provider })` (the session traces it as `context.trimmed`). A trim never fails the session.
 */
export function fitContext(text, { provider, kind, emit, max = budgetOf(provider) } = {}) {
  const r = fitText(text, max);
  if (r.trimmed) { try { emit?.({ t: 'context_trimmed', kind, from: r.from, to: r.to, provider }); } catch { /* advisory */ } }
  return r.text;
}

/** One TOC line: what exists, and the tool that loads its detail. `parts` that are empty are left out. */
export const tocLine = (what, tool) => `- ${what}${tool ? ` → ${tool}` : ''}`;
