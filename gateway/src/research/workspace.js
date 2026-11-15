// Research workspace (design §2, the recursive-language-model idea of prime-agent / alexzhang13/rlm): a long tool result does
// not go into the research model's prompt. It is stored here under a handle (@w1, @w2, …) and the model sees a preview, the
// size and an outline; it then inspects the text with ws_grep / ws_read / ws_ask instead of reading it whole.
// Pure and in-memory: one workspace per research run, dropped with the run. No I/O, no regular expressions from the model
// (ws_grep takes literal terms, so a planted pattern cannot cause catastrophic backtracking).

export const STORE_FROM = 3000; // results longer than this become a handle
export const PREVIEW_CHARS = 1200;
export const MAX_DOC_CHARS = 2_000_000;
export const MAX_DOCS = 40;
export const GREP_MAX_LINES = 40;
export const READ_MAX_CHARS = 8000;
export const CHUNK_CHARS = 30_000;

const lineStarts = (text) => {
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
};

/** Markdown headings / JSON-ish keys / "##" lines as a short outline (at most 12 entries with their line numbers). */
export function outlineOf(text, max = 12) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i += 1) {
    const l = lines[i];
    if (/^#{1,4}\s+\S/.test(l) || /^---\s*$/.test(l) && i + 1 < lines.length && /^\S/.test(lines[i + 1] ?? '')) out.push(`Z.${i}: ${l.replace(/^#+\s*/, '').slice(0, 80)}`);
  }
  return out;
}

export function createWorkspace() {
  const docs = new Map(); // handle -> {text, label, lines}
  let next = 1;

  function put(text, label) {
    const t = String(text ?? '').slice(0, MAX_DOC_CHARS);
    if (docs.size >= MAX_DOCS) docs.delete(docs.keys().next().value); // oldest first
    const ref = `@w${next++}`;
    docs.set(ref, { text: t, label: String(label ?? '').slice(0, 160), starts: lineStarts(t) });
    return ref;
  }

  const get = (ref) => {
    const d = docs.get(String(ref ?? '').trim());
    if (!d) throw new Error(`unknown workspace handle ${String(ref).slice(0, 20)}; valid: ${[...docs.keys()].join(', ') || 'none'}`);
    return d;
  };

  /** What the research model sees instead of a long result. */
  function stub(ref) {
    const d = get(ref);
    return [
      `{"workspace":"${ref}","source":${JSON.stringify(d.label)},"chars":${d.text.length},"lines":${d.starts.length}}`,
      `Langes Ergebnis im Arbeitsbereich. Lies gezielt: ws_grep("${ref}", ["Begriff", ...]) findet Zeilen, ws_read("${ref}", line, count) liest ab einer Zeile, ws_ask("${ref}", "Frage") lässt einen Hilfsagenten das Ganze in Stücken durchsuchen.`,
      ...(outlineOf(d.text).length ? ['Gliederung:', ...outlineOf(d.text)] : []),
      '--- Anfang ---',
      d.text.slice(0, PREVIEW_CHARS),
    ].join('\n');
  }

  /** Lines that contain any of the literal terms (case-insensitive), with one line of context, numbered. */
  function grep(ref, terms, { max = GREP_MAX_LINES } = {}) {
    const d = get(ref);
    const list = (Array.isArray(terms) ? terms : [terms]).map((t) => String(t ?? '').toLowerCase().trim()).filter((t) => t.length >= 2).slice(0, 8);
    if (!list.length) throw new Error('ws_grep needs at least one term of 2+ characters');
    const lines = d.text.split('\n');
    const hits = [];
    let total = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const low = lines[i].toLowerCase();
      if (!list.some((t) => low.includes(t))) continue;
      total += 1;
      if (hits.length < max) hits.push(`Z.${i}: ${lines[i].slice(0, 400)}`);
    }
    return `${ref}: ${total} Treffer für ${list.map((t) => JSON.stringify(t)).join(' | ')}${total > hits.length ? ` (erste ${hits.length}; enger suchen oder ws_read)` : ''}\n${hits.join('\n') || '(keine)'}`;
  }

  /** Lines [line, line+count) at most READ_MAX_CHARS characters. */
  function read(ref, line = 0, count = 80) {
    const d = get(ref);
    const from = Math.max(0, Math.min(Number.isInteger(line) ? line : 0, d.starts.length - 1));
    const to = Math.min(d.starts.length, from + Math.max(1, Math.min(Number.isInteger(count) ? count : 80, 400)));
    const start = d.starts[from];
    const end = to < d.starts.length ? d.starts[to] : d.text.length;
    let body = d.text.slice(start, end);
    let cut = false;
    if (body.length > READ_MAX_CHARS) { body = body.slice(0, READ_MAX_CHARS); cut = true; }
    const shownTo = cut ? from + body.split('\n').length - 1 : to;
    return `${ref} Zeilen ${from}-${shownTo - 1} von ${d.starts.length}${shownTo < d.starts.length ? `; weiter mit ws_read("${ref}", ${shownTo})` : ''}\n---\n${body}`;
  }

  /** The document cut into chunks of about CHUNK_CHARS at line boundaries, each with its first line number. */
  function chunks(ref, size = CHUNK_CHARS) {
    const d = get(ref);
    const out = [];
    let line = 0;
    while (line < d.starts.length) {
      const start = d.starts[line];
      let endLine = line + 1;
      while (endLine < d.starts.length && d.starts[endLine] - start < size) endLine += 1;
      const end = endLine < d.starts.length ? d.starts[endLine] : d.text.length;
      out.push({ line, text: d.text.slice(start, end) });
      line = endLine;
    }
    return out;
  }

  return { put, stub, grep, read, chunks, has: (ref) => docs.has(String(ref ?? '').trim()), label: (ref) => get(ref).label, size: () => docs.size };
}
