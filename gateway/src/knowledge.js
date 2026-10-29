// The desk's basic knowledge of Florian's topics: ~/desk-knowledge/INDEX.md on LeChonk, fetched through the bridge
// (ctx.knowledge) and cached for 10 minutes. Every system prompt (text agent, the voice providers, the illustrator)
// adds knowledgeLines(): the index plus the rule to call knowledge_read before searching.
const TTL_MS = 10 * 60_000;
const RETRY_MS = 30_000; // while the bridge is not connected yet
const MAX_INDEX_CHARS = 7000;

let state = { hub: null, text: '', at: 0, tried: 0, loading: null, timer: null };

/** Fetches INDEX.md now; keeps the previous text when the bridge fails. */
export async function refreshKnowledge({ now = Date.now() } = {}) {
  if (!state.hub) return state.text;
  if (state.loading) return state.loading;
  state.tried = now;
  state.loading = (async () => {
    try {
      const r = await state.hub.call('ctx.knowledge', {}, { timeoutMs: 8000 });
      if (r?.found && typeof r.text === 'string' && r.text.trim()) {
        state.text = r.text.trim().slice(0, MAX_INDEX_CHARS);
        state.at = Date.now();
      }
    } catch { /* bridge offline: keep the cached index */ }
    return state.text;
  })().finally(() => { state.loading = null; });
  return state.loading;
}

/** server.js calls this once with the BridgeHub; the index is loaded at once and kept fresh in the background. */
export function attachKnowledge(hub) {
  clearInterval(state.timer);
  state = { hub, text: '', at: 0, tried: 0, loading: null, timer: null };
  refreshKnowledge();
  state.timer = setInterval(() => {
    const age = Date.now() - (state.text ? state.at : state.tried);
    if (age >= (state.text ? TTL_MS : RETRY_MS)) refreshKnowledge();
  }, RETRY_MS);
  state.timer.unref?.();
  return () => clearInterval(state.timer);
}

/** The cached index (may be ''); a stale cache triggers a background refresh. */
export function knowledgeIndex({ now = Date.now() } = {}) {
  if (state.hub && now - (state.text ? state.at : state.tried) >= (state.text ? TTL_MS : RETRY_MS)) refreshKnowledge({ now });
  return state.text;
}

/** Prompt lines with the knowledge index; [] while none is loaded. `index` overrides the cache (tests). */
export function knowledgeLines(index = knowledgeIndex()) {
  if (!index) return [];
  return [
    '',
    '## Grundwissen',
    'Das ist dein Grundwissen über Florians Themen; für Details rufe knowledge_read auf, bevor du suchst.',
    index,
  ];
}

/** Test hook: set the cached index directly. */
export function setKnowledgeForTest(text) {
  state.text = text ?? '';
  state.at = Date.now();
}
