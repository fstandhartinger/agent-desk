// Live Canvas generator (viz slice). Contract in contracts.js; VizSpec in docs/SPEC.md "Visualisation".
// Keeps a rolling window of the conversation + tool activity, and after a quiet period (debounce) asks a fast
// model for a VizSpec. At most one call in flight; notes arriving meanwhile coalesce into one follow-up call.
// Invalid or failed answers are dropped and the previous spec stays on screen. Tool calls reach the model as one
// ledger entry per call (vizFacts.js) and every answer is checked against that ledger before it is emitted.
import { cfg } from './config.js';
import { knowledgeLines } from './knowledge.js';
import { postOpenRouter } from './llm.js';
import { createToolLedger, guardSpec } from './vizFacts.js';

export const DEFAULT_VIZ_MODEL = 'deepseek/deepseek-v4.1-flash-20261017:nitro';

const KINDS = new Set(['agent', 'user', 'claude', 'tool', 'file', 'job', 'board', 'idea', 'number', 'risk', 'decision']);
const TONES = new Set(['moss', 'papaya', 'violet', 'amber', 'red', 'neutral']);
const EDGE_STYLES = new Set(['flow', 'pulse', 'dashed']);
const STEP_STATES = new Set(['done', 'active', 'todo']);
const LIMITS = { nodes: 12, edges: 16, steps: 6, label: 28, value: 16, edgeLabel: 20, title: 60, caption: 140 };
const WINDOW = { turns: 8, events: 8, turnChars: 700 };
const TIMEOUT_MS = 8000;

export const SYSTEM_PROMPT = `You draw the live whiteboard next to a conversation between Florian and his agent desk.
Return ONE JSON object (no prose, no markdown) that shows the single most important idea of the conversation RIGHT NOW,
as a small diagram in the style of a 3Blue1Brown explainer: few shapes, short labels, one clear story.

Schema:
{"v":1,"title":string,"caption":string,"focus":nodeId,
 "nodes":[{"id":string,"label":string,"kind":KIND,"tone":TONE,"value"?:string,"group"?:string}],
 "edges":[{"from":nodeId,"to":nodeId,"label"?:string,"style":"flow"|"pulse"|"dashed"}],
 "steps"?:[{"label":string,"state":"done"|"active"|"todo"}]}
KIND: agent (the desk agent), user (Florian), claude (a Claude Code session), tool, file, job, board, idea, number, risk, decision.
TONE: moss = ok/done/healthy, papaya = the thing being changed or the key action, violet = agents/AI, amber = waiting/uncertain,
red = ONLY a real error or risk, neutral = context.

Rules:
- Give time/date ranges only when they cover ALL items, including older jobs. Never infer a range from only the newest few items.
- Write title, caption and labels in the conversation's language (German if Florian writes German). Keep paths/job names as they are.
- 4 to 7 nodes is ideal, never more than 12. Do not list every item: merge similar things into one node with a value
  (e.g. "3 Worker" / "laufen"). Labels <= 28 characters, values <= 16 characters (a number, status or short word).
- Every node should be connected; prefer a left-to-right story (cause → effect, request → result).
- title <= 60 characters, names the topic. caption = ONE plain sentence (<= 140 chars) saying what is happening or what it means.
- Colour carries meaning: the focus node is never neutral. Edge labels are 1–2 words (<= 18 characters).
- Edges show cause, data flow or sequence. "flow" = something moves/runs now, "pulse" = waiting/polling, "dashed" = optional/planned.
- STABILITY: if a previous spec is given and the topic is the same, reuse its node ids and positions in the story; only add,
  remove or change what actually changed. Change the whole diagram only when the topic changed.
- "focus" = id of the node that changed most or that the latest message is about.
- If work runs in several stages (a plan, a Claude Code task with todos), add "steps" (<= 6): finished = done, the one
  running now = active, later ones = todo. Omit steps for plain questions.
- Use node ids that are short lowercase slugs (e.g. "agent", "job-viz", "file-spec").
- Write for a person: translate raw field names and JSON values into words (finalDone: false → "offen"). Leave out
  a field rather than writing false, null, "-" or "n/a"; a "number" node needs a real number as value.
- "tools" has ONE entry per tool call with its CURRENT status: "läuft" (still running), "fertig" (finished) or "Fehler".
  A tool with status "fertig" is finished: never show it, or its query, as läuft/offen/wartet/running; show "fertig"
  (tone moss) or, better, its result fact. A tool with status "Fehler" is shown as "Fehler" (tone red).
- NUMBERS: use only numbers that literally appear in "tools[].fakten", the conversation or the page. Copy them exactly
  ("jobs": 18 → "18 Jobs"; "mind. 17" → "mind. 17"). Never count, add up, estimate or round yourself; if no number is
  given, use a word instead of a number. Never combine counts of DIFFERENT tool entries in one statement ("19 von 20"
  when 19 and 20 come from two calls); say what each list was ("auswahl").
- When the conversation ends with the Agent's answer, the desk's work is DONE: describe the result in the past or as a
  fact ("14 Threads gelesen, dringend: Pod in #15"), never as ongoing work ("liest gerade", "prüft jetzt", "wird gelesen").
- "activity" lines are Claude Code session events (not desk tools).
- Never invent facts, numbers or file names that are not in the input. Never include secrets or tokens.`;

// Placeholder output of a model that serialised a missing or boolean field ("false", "null", "[object Object]", "-").
const JUNK = /^(?:false|true|null|nil|none|undefined|nan|n\/a|\[object object\]|[-–—_.…?!\s]*)$/i;

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Like clip, but never cuts inside a word or number ("#25700" must not become a "#2570…" the model can copy). */
const clipWords = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > n * 0.6 ? cut.slice(0, space) : cut.replace(/(?<![\p{L}\p{N}#._-])[\p{L}\p{N}#._-]+$/u, '')).trimEnd()}…`;
};

/** Spec text field: strings and finite numbers only, junk placeholders → ''. Sentences are cut at a word boundary. */
const text = (s, n, words = false) => {
  if (typeof s === 'number' ? !Number.isFinite(s) : typeof s !== 'string') return '';
  const t = words ? clipWords(s, n) : clip(s, n);
  return JUNK.test(t) ? '' : t;
};

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|(?<!-)-+$/g, '').slice(0, 32);

// Strict normalisation of a model answer into a VizSpec; returns null when nothing usable is left.
export function validateSpec(raw, prev = null) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null;
  const nodes = [];
  const ids = new Set();
  for (const n of raw.nodes) {
    if (nodes.length >= LIMITS.nodes) break;
    if (!n || typeof n !== 'object') continue;
    const id = slug(n.id);
    const label = text(n.label, LIMITS.label);
    const value = text(n.value, LIMITS.value);
    // A number node without a number ("false", null) says nothing.
    if (!id || !label || ids.has(id) || (n.kind === 'number' && !value)) continue;
    ids.add(id);
    const node = { id, label, kind: KINDS.has(n.kind) ? n.kind : 'idea', tone: TONES.has(n.tone) ? n.tone : 'neutral' };
    if (value) node.value = value;
    const group = text(n.group, LIMITS.label);
    if (group) node.group = group;
    nodes.push(node);
  }
  if (!nodes.length) return null;

  const edges = [];
  const pairs = new Set();
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (edges.length >= LIMITS.edges) break;
    const from = slug(e?.from);
    const to = slug(e?.to);
    const key = `${from}>${to}`;
    if (!ids.has(from) || !ids.has(to) || from === to || pairs.has(key)) continue;
    pairs.add(key);
    const edge = { from, to, style: EDGE_STYLES.has(e.style) ? e.style : 'flow' };
    const label = text(e.label, LIMITS.edgeLabel);
    if (label) edge.label = label;
    edges.push(edge);
  }

  const spec = {
    v: 1,
    title: text(raw.title, LIMITS.title, true) || prev?.title || nodes[0].label,
    nodes,
    edges,
  };
  const caption = text(raw.caption, LIMITS.caption, true);
  if (caption) spec.caption = caption;
  const focus = slug(raw.focus);
  const fresh = prev ? nodes.find((n) => !prev.nodes.some((p) => p.id === n.id)) : null;
  if (ids.has(focus)) spec.focus = focus;
  else if (fresh) spec.focus = fresh.id;
  const focused = nodes.find((n) => n.id === spec.focus);
  if (focused?.tone === 'neutral' && nodes.every((n) => n.tone === 'neutral')) focused.tone = 'papaya';
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s) => ({ label: text(s?.label, LIMITS.label), state: STEP_STATES.has(s?.state) ? s.state : 'todo' }))
    .filter((s) => s.label)
    .slice(0, LIMITS.steps);
  if (steps.some((s) => s.state !== 'todo')) spec.steps = steps; // an all-todo list shows no progress
  return spec;
}

// Compact one-line description of a Claude Code event (desk tool calls go through the tool ledger instead).
export function describeEvent(evt) {
  if (!evt || typeof evt !== 'object' || evt.type === 'tool') return null;
  switch (evt.kind) {
    case 'tool_use': return `claude ${evt.name} ${clip(evt.path || evt.command || evt.input, 120)}`;
    case 'tool_result': return evt.ok ? null : `claude tool failed: ${clip(evt.preview, 120)}`;
    case 'todo': return `claude todos: ${evt.items.map((i) => `[${i.status}] ${clip(i.content, 50)}`).join('; ')}`;
    case 'text': return `claude says: ${clip(evt.text, 200)}`;
    case 'status': return `claude session ${evt.state}`;
    case 'result': return `claude finished in ${Math.round((evt.durationMs || 0) / 1000)} s`;
    case 'error': return `claude error: ${clip(evt.message, 120)}`;
    default: return null;
  }
}

function reasoningFor(model) {
  // Gemini 3.8 refuses to disable reasoning; keep it minimal and out of the answer.
  return /gemini/.test(model) ? { effort: 'minimal', exclude: true } : { enabled: false };
}

export async function openRouterJSON({ model, messages, signal }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY missing');
  // same privacy routing as every other OpenRouter call (critic round 2, P2-9)
  const res = await postOpenRouter('https://openrouter.ai/api/v1/chat/completions', { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, {
    model,
    messages,
    response_format: { type: 'json_object' },
    max_tokens: 700,
    temperature: 0.3,
    reasoning: reasoningFor(model),
    usage: { include: true },
  }, signal);
  if (!res.ok) throw new Error(`viz model HTTP ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  return { json: parseJSON(text), costUsd: data.usage?.cost ?? 0 };
}

export function parseJSON(text) {
  const s = String(text).replace(/^\s*```(?:json)?|```\s*$/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/** Everything the model may draw from (the previous spec aside): the facts guardSpec() checks numbers against. */
export function buildInput({ turns, events = [], tools = [], page }) {
  return {
    page: page ? {
      title: page.title, t: page.t, scene: page.sceneId,
      point: page.point ? { title: page.point.title, short: clip(page.point.short, 240) } : undefined,
    } : undefined,
    conversation: turns.map((t) => `${t.role === 'user' ? 'Florian' : 'Agent'}: ${t.text}`),
    tools: tools.length ? tools : undefined,
    activity: events.length ? events : undefined,
  };
}

export function buildMessages({ prev, ...rest }) {
  return [
    { role: 'system', content: [SYSTEM_PROMPT, ...knowledgeLines()].join('\n') },
    { role: 'user', content: JSON.stringify({ ...buildInput(rest), previousSpec: prev ?? undefined }) },
  ];
}

/** validateSpec + guardSpec against the ledger as it is NOW (a tool may have finished while the model was writing). */
export function checkSpec(json, { prev, calls, input, answered = false }) {
  return guardSpec(validateSpec(json, prev), { calls, source: JSON.stringify(input), answered });
}

export function createVizGenerator({
  emit,
  model = process.env.DESK_VIZ_MODEL || DEFAULT_VIZ_MODEL,
  complete = openRouterJSON,
  debounceMs = 1200,
  maxWaitMs = 4000,
  page = null,
  onCost,
  onError,
} = {}) {
  const turns = [];
  const events = [];
  const ledger = createToolLedger();
  // The agent's answer is the newest turn and no Claude Code session is reporting: the desk turn is over.
  const answered = () => turns.at(-1)?.role === 'assistant' && !events.length;
  // Re-check the spec on screen without a model call (a tool finished, or the update after the answer failed);
  // emit only when it changed.
  const recheck = () => {
    const fixed = spec ? guardSpec(spec, { calls: ledger.calls(), numbers: false, answered: answered() }) : null;
    if (fixed?.fixes.length && fixed.spec) {
      spec = fixed.spec;
      emit({ type: 'viz', spec });
    }
  };
  let current = page;
  let spec = null;
  let timer = null;
  let firstPending = 0;
  let inFlight = null;
  let dirty = false;
  let closed = false;

  const schedule = () => {
    if (closed) return;
    dirty = true;
    if (inFlight) return; // the running call reschedules when it finishes
    const now = Date.now();
    if (!firstPending) firstPending = now;
    clearTimeout(timer);
    timer = setTimeout(run, Math.max(0, Math.min(debounceMs, firstPending + maxWaitMs - now)));
  };

  async function run() {
    timer = null;
    firstPending = 0;
    if (closed || !dirty || (!turns.length && !ledger.calls().length)) return;
    dirty = false;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    inFlight = ctrl;
    try {
      const req = { turns: [...turns], events: [...events], tools: ledger.entries(), page: current };
      const { json, costUsd } = await complete({ model, messages: buildMessages({ ...req, prev: spec }), signal: ctrl.signal });
      if (costUsd) onCost?.(costUsd);
      // Numbers may come from what the model saw or from facts that arrived meanwhile.
      const input = [buildInput(req), buildInput({ ...req, tools: ledger.entries() })];
      const next = checkSpec(json, { prev: spec, calls: ledger.calls(), input, answered: answered() }).spec;
      if (next && !closed) {
        spec = next;
        emit({ type: 'viz', spec });
      } else if (!closed) recheck();
    } catch (err) {
      if (!closed) { onError?.(err); recheck(); }
    } finally {
      clearTimeout(timeout);
      inFlight = null;
      if (dirty) schedule();
    }
  }

  return {
    noteTurn({ role, text }) {
      const t = clipWords(text, WINDOW.turnChars);
      if (!t) return;
      turns.push({ role: role === 'user' ? 'user' : 'assistant', text: t });
      if (turns.length > WINDOW.turns) turns.shift();
      schedule();
    },
    noteEvent(evt) {
      if (evt?.type === 'page') { current = evt.page ?? null; return; }
      if (ledger.note(evt)) {
        // The spec on screen may still show this call as running: correct it now, the model update follows.
        if (evt.status !== 'start') recheck();
        if (turns.length || evt.status === 'done') schedule();
        return;
      }
      const line = describeEvent(evt);
      if (!line) return;
      events.push(line);
      if (events.length > WINDOW.events) events.shift();
      if (turns.length) schedule();
    },
    get spec() { return spec; },
    close() {
      closed = true;
      clearTimeout(timer);
      inFlight?.abort();
    },
  };
}

const NOOP_VIZ = Object.freeze({ noteTurn() {}, noteEvent() {}, close() {} });

/**
 * The generator the chat and voice paths use. Since the generative canvas (docs/CANVAS.md) the VizSpec "Live Canvas"
 * is off by default - no model calls for it - and DESK_ACTIVITY_VIZ=1 brings it back.
 */
export function createActivityViz(options) {
  return cfg.activityViz() ? createVizGenerator(options) : NOOP_VIZ;
}
