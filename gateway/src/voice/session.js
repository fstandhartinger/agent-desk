// Browser side of a voice session: protocol with the web client (docs/SPEC.md "Voice"), tool execution, limits,
// usage/cost ticks and audit. Provider specifics live in the adapters.
import { cfg } from '../config.js';
import { pseudoPathRefusal, resolveToolName } from '../tools.js';
import { cjkRuns, isGermanText, stripCjk } from '../canvas.js';
import { buildInstructions } from './instructions.js';
import { pageUpdateText } from '../pack.js';
import { estimateCost } from './prices.js';
import { isFiller, knownWords, limitFillers, repairGlued, stripToolMarkup, TranscriptMarkupFilter } from './transcript.js';
import { markOk } from '../providerHealth.js';
import { unavailableError } from './adapter.js';

export const HARD_CAP_MS = 30 * 60_000;
export const USAGE_TICK_MS = 10_000;
const START_TIMEOUT_MS = 10_000;
const VOICE_TOOL_CHARS = 2500;
export const FACTS_WAIT_MS = 2500;
// Gemini researches in long loops (8 tools on one question, critic r7; 5 sequential calls = 20 s and no answer, critic r9): after 3 it must answer
export const MAX_RESEARCH_TOOLS = { gemini: 3 };
const DRAW_TOOLS = new Set(['canvas_draw', 'canvas_render']);
// Topic files of the desk knowledge are dense and ordered by importance; voice models need most of one at once.
/** Round 11: {focusedId} from a client message (`focusedCanvasId`: string or null); {} when the client did not say. */
const focusOf = (msg) => (Object.hasOwn(msg ?? {}, 'focusedCanvasId') ? { focusedId: typeof msg.focusedCanvasId === 'string' ? msg.focusedCanvasId.slice(0, 64) : null } : {});
const voiceCap = (name) => (name === 'artifact_ref_read' ? 6000 : name === 'knowledge_read' ? 6000 : name === 'explainer_context' ? 4000 : VOICE_TOOL_CHARS);
const PAGE_LOAD_MS = 4000; // the server-side page context may delay the vendor connect at most this long

export function runVoiceSession(ws, deps, { provider, create, apiKey, now = Date.now, mergeMs = cfg.userMergeMs() }) {
  const { runTool, makeCtx, limits, audit, toolDefs, sid } = deps;
  const sendJson = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  let adapter = null;
  let artifactBlock = '';
  let unregisterText = null;
  let starting = false;
  let page = null;
  let closed = false;
  let startedAt = 0;
  let readyAt = null; // billing starts when the vendor is ready; a failed connect costs nothing
  let billedSeconds = 0;
  let dropAudio = false;
  let tickTimer = null;
  let capTimer = null;
  let viz = null;
  let canvas = null;
  const turn = { role: null, text: '' };
  // Round 12 (critic r11 defect 5): tool markup never reaches the browser; Gemini shows at most one filler sentence per question
  let markup = new TranscriptMarkupFilter();
  let head = { text: '', decided: false }; // the first sentence of a Gemini answer waits until it is known not to be a second filler
  let fillers = 0; // filler sentences shown for the current question
  const limitsFillers = provider === 'gemini';
  const known = new Set(); // CamelCase words of tool results: never split by the Gemini hyphen repair
  const cjkKnown = new Set(); // CJK runs of the session's tool results (a contact's name): stripCjk keeps them (critic r6 P2-3)
  let audioSeen = false;
  let lastUserText = '';
  let researchTools = 0; // non-drawing tool calls of the current user turn
  let factsAt = null; // researchTools when the early facts went out with a tool result (round 12)
  // Round 12 (live r12, Gemini fast: first search 0.4 s after the question, before the early facts were read): a Gemini research
  // result waits for the early illustrator's facts until FACTS_WAIT_MS after the question was complete
  let factsDue = 0; // when the facts of the current question are expected at the latest (0 = none expected)
  let factsReady = null; // resolves the wait when they arrive
  // Round 9 (critic r8 F4/C2): user transcripts arrive in fragments ("Wofür" / "geben wir das" / "aus") while the assistant may
  // still answer the previous question. Fragments within `mergeMs` are ONE turn for the agent side (early illustrator, memory).
  let userOpen = false; // a user turn is being collected (speech started, fragments pending)
  let userBuf = '';
  let mergeTimer = null;
  let responding = false; // the assistant has a response in flight (audio / transcript / tool call since the last turn_done)
  const cancelledCalls = new Set(); // tool call ids the vendor voided
  let staleChain = false; // an answer was overtaken by a new question: its remaining tool calls (until its turn_done) are stale
  // Round 10 (live r10, critic r9 F4 run 1): only a vendor response that is still open can issue more calls for the old question.
  // GPT-Live keeps SPEAKING after its backend response completed; a barge-in then marked the next question's first tool call
  // stale and that question got no answer at all. Adapters that report `response_started` (OpenAI backend, xAI) say exactly
  // when a response is open; for the others every barge-in keeps the old behaviour (stale until turn_done).
  let tracksResponses = false;
  let responseOpen = false;
  let turnProposals = new Map(); // handoff / Claude proposals of the current user turn, by kind + title
  let contentEpoch = 0; // counts spoken user turns: a tool result that comes back after the next question began is stale
  let contentOpen = false; // the current user turn has transcript content
  let interrupted = false; // the user turn began while an answer was still in flight (its transcript fragments interleave with the old answer)

  const startTimer = setTimeout(() => finish('start-timeout'), START_TIMEOUT_MS);

  /** An assistant delta -> the part the browser may see now (markup cut, a second filler held back and dropped). */
  function assistantPiece(delta) {
    let piece = markup.push(delta);
    if (!limitsFillers || head.decided) return piece;
    head.text += piece;
    const end = /[.!?…](?:\s|$)/.exec(head.text);
    if (!end) return '';
    const first = head.text.slice(0, end.index + 1);
    piece = (isFiller(first) && fillers >= 1 ? '' : first) + head.text.slice(end.index + 1);
    head = { text: '', decided: true };
    return piece;
  }

  function flushTranscript() {
    if (turn.role === 'assistant') {
      turn.text += head.text + markup.flush(); // the held first sentence, then the held last word
      turn.text = stripToolMarkup(turn.text);
    }
    markup = new TranscriptMarkupFilter();
    const streamed = head.decided;
    head = { text: '', decided: false };
    if (turn.role === 'assistant' && limitsFillers && turn.text.trim()) {
      const r = limitFillers(turn.text, Math.max(0, 1 - fillers));
      fillers += r.fillers;
      if (!r.text && !streamed) { audit({ action: 'voice.filler.dropped', detail: provider }); turn.role = null; turn.text = ''; return; }
      if (r.text) turn.text = r.text;
    }
    if (!turn.role || !turn.text.trim()) { turn.role = null; turn.text = ''; return; }
    const role = turn.role;
    let text = provider === 'gemini' ? repairGlued(turn.text, known) : turn.text; // Gemini glues German compounds ("KryptoEmissionen")
    if (role === 'user') lastUserText = text;
    else if (isGermanText(lastUserText)) text = stripCjk(text, [...cjkKnown]); // a stray CJK glyph in a German answer is a model slip
    turn.role = null;
    turn.text = '';
    sendJson({ type: 'transcript', role, text, final: true });
    if (role === 'user') {
      collectUser(text);
      return;
    }
    viz?.noteTurn({ role, text });
    canvas?.noteTurn({ role, text });
    // a finished spoken answer may deserve a drawing (or refused to draw): decided without a model call
    if (role === 'assistant') canvas?.autoTurn({ answerText: text });
  }

  /**
   * A new question begins. `content` = real speech (a transcript), not just a VAD event: only that stops the answer to the
   * previous question (barge-in), and makes the pending tool results of that answer stale.
   */
  function beginUserTurn(content) {
    if (content && !contentOpen) {
      contentOpen = true;
      contentEpoch += 1;
      turnProposals = new Map(); // proposals with the same title are deduped within one user turn (critic P2-6)
      if (responding) {
        interrupted = true;
        staleChain = tracksResponses ? responseOpen : true;
        responding = false;
        dropAudio = false;
        adapter?.interrupt(); // OpenAI/xAI: response.cancel; Gemini: the new input interrupts by itself
        audit({ action: 'voice.barge_in', detail: provider });
      }
    }
    if (userOpen && (content || userBuf || turn.role === 'user')) return;
    userOpen = true;
    canvas?.startTurn();
    adapter?.newTurn?.();
    researchTools = 0;
    factsAt = null;
    fillers = 0;
  }

  /** The assistant starts a NEW answer (nothing of an older one was running): the user's question is complete, no need to wait for more fragments. */
  function assistantStarted() {
    responding = true; // bare audio does not prove an answer is in flight (OpenAI streams audio frames while the user speaks)
    if (!contentOpen || interrupted) return;
    flushTranscript();
    commitUser();
  }

  /** One final fragment of the user's speech: joined with the ones before, committed when nothing follows for mergeMs (at once after a closed sentence). */
  function collectUser(text) {
    userBuf = userBuf ? `${userBuf} ${text}` : text;
    lastUserText = userBuf;
    clearTimeout(mergeTimer);
    if (/[.?!]["”)]*\s*$/.test(userBuf)) commitUser(); // a closed sentence: nothing to wait for
    else mergeTimer = setTimeout(commitUser, mergeMs);
  }

  function commitUser() {
    clearTimeout(mergeTimer);
    mergeTimer = null;
    const text = userBuf.trim();
    userBuf = '';
    userOpen = false;
    contentOpen = false;
    interrupted = false;
    if (!text || closed) return;
    viz?.noteTurn({ role: 'user', text });
    canvas?.noteTurn({ role: 'user', text });
    // the question is complete: the early illustrator starts now, in parallel with the agent's answer
    expectFacts(canvas?.userTurn(text));
  }

  function expectFacts(decision) {
    factsDue = provider === 'gemini' && (decision === 'early' || decision === 'deictic') ? now() + FACTS_WAIT_MS : 0;
  }

  /** Gemini: a research result waits (bounded) for the early facts, so they ride along with it. */
  async function waitForFacts(name) {
    if (!factsDue || DRAW_TOOLS.has(name) || adapter?.factsDelivered?.()) return;
    const left = factsDue - now();
    if (left <= 0) return;
    await new Promise((resolve) => { const timer = setTimeout(resolve, left); factsReady = () => { clearTimeout(timer); resolve(); }; });
  }

  function onTranscript(e) {
    if (e.role !== turn.role) flushTranscript();
    if (e.role === 'user') {
      beginUserTurn(true);
      if (e.delta != null || e.text != null) { clearTimeout(mergeTimer); mergeTimer = null; } // still speaking: commit after the last fragment
    } else assistantStarted();
    if (e.delta != null) {
      turn.role = e.role;
      const piece = e.role === 'assistant' ? assistantPiece(e.delta) : e.delta;
      turn.text += e.role === 'assistant' && limitsFillers && !head.decided ? '' : piece; // a held first sentence joins the text when it is decided
      if (piece) sendJson({ type: 'transcript', role: e.role, delta: piece, final: false });
    } else if (e.text != null) {
      turn.role = e.role;
      // a complete assistant text (GPT-Live typed turn) replaces what was streamed: held pieces are not glued onto it ("…bekommen.Okay.")
      if (e.role === 'assistant') { markup = new TranscriptMarkupFilter(); head = { text: '', decided: false }; }
      turn.text = e.role === 'assistant' ? stripToolMarkup(e.text) : e.text;
    }
    if (e.final) flushTranscript();
  }

  async function onToolCall({ id, name, args }) {
    const requestedName = name;
    name = resolveToolName(name);
    const t0 = now();
    assistantStarted();
    const myEpoch = staleChain ? contentEpoch - 1 : contentEpoch;
    const evt = { type: 'tool', id, name, args };
    // round 12: once the early facts went out with a tool result, Gemini may research once more, then it answers
    if (factsAt === null && adapter?.factsDelivered?.()) factsAt = researchTools;
    const cap = MAX_RESEARCH_TOOLS[provider] && factsAt !== null ? Math.min(MAX_RESEARCH_TOOLS[provider], factsAt + 1) : MAX_RESEARCH_TOOLS[provider];
    if (cap && !DRAW_TOOLS.has(name) && (researchTools += 1) > cap) {
      audit({ action: 'voice.tool.capped', detail: `${provider}:${name}` });
      if (!closed) adapter.sendToolResult(id, requestedName, JSON.stringify({ error: `Recherche-Limit erreicht (${cap} Werkzeuge pro Frage): keine weiteren Werkzeuge. Antworte Florian jetzt auf Deutsch mit dem, was du bisher gefunden hast.` }));
      return;
    }
    const pseudo = pseudoPathRefusal(name, args); // r6 P2-7
    if (pseudo) {
      audit({ action: 'voice.tool.pseudo-path', detail: `${provider}:${name}` });
      if (!closed) adapter.sendToolResult(id, requestedName, JSON.stringify({ error: pseudo.content }));
      return;
    }
    sendJson({ ...evt, status: 'start' });
    viz?.noteEvent({ ...evt, status: 'start' });
    canvas?.toolStarted(name);
    audit({ action: 'voice.tool', detail: `${provider}:${name} ${JSON.stringify(args).slice(0, 120)}` });
    let output;
    try {
      const res = await runTool(name, args, { ...makeCtx(page), canvas, turnProposals, maxChars: voiceCap(name) });
      output = String(res.content ?? '').slice(0, voiceCap(name));
      canvas?.noteTool({ name, args, ok: res.ok !== false, content: res.content });
      for (const w of knownWords(res.content)) known.add(w);
      for (const r of cjkRuns(res.content)) if (cjkKnown.size < 500) cjkKnown.add(r);
      const done = { ...evt, status: 'done', summary: res.summary, ms: now() - t0 };
      sendJson(done);
      if (res.event?.type === 'handoff' || res.event?.type === 'claude_proposal') sendJson(res.event); // handoff_propose / claude_task: same confirm cards as in the text chat
      viz?.noteEvent({ ...done, content: output });
    } catch (err) {
      output = JSON.stringify({ error: String(err.message ?? err).slice(0, 300) });
      canvas?.noteTool({ name, args, ok: false, content: '' }); // the drawing stops waiting for this tool
      const failed = { ...evt, status: 'error', summary: String(err.message ?? err).slice(0, 200), ms: now() - t0 };
      sendJson(failed);
      viz?.noteEvent(failed);
    }
    if (closed) return;
    // the user asked something new meanwhile: the result belongs to a question that is no longer being answered
    if (cancelledCalls.delete(id)) {
      audit({ action: 'voice.tool.cancelled', detail: `${provider}:${name}` });
      return;
    }
    await waitForFacts(name);
    if (closed) return;
    if (myEpoch !== contentEpoch) {
      audit({ action: 'voice.tool.stale', detail: `${provider}:${name}` });
      if (provider === 'gemini') { // the model waits for every call it made: answer it, but say the result is old (dropping it made Gemini report "ich bearbeite noch deine vorherige Anfrage")
        adapter.sendToolResult(id, requestedName, JSON.stringify({ hinweis: 'Ergebnis zu einer früheren Frage. Florian hat inzwischen eine neue Frage gestellt: beantworte nur die neueste Frage, nutze dieses Ergebnis nur wenn es dazu passt.', ergebnis: output.slice(0, 2000) }));
        return;
      }
      adapter.sendToolResult(id, requestedName, output, { stale: true }); // OpenAI/xAI: keep the call/output pairing, no new response
      return;
    }
    adapter.sendToolResult(id, requestedName, output);
  }

  function onEvent(e) {
    if (closed) return;
    switch (e.t) {
      case 'ready':
        readyAt = now();
        sendJson({ type: 'ready', provider, model: e.model });
        break;
      case 'audio':
        if (!audioSeen) { audioSeen = true; markOk(provider); } // a session that produced speech counts as working today
        if (!dropAudio && ws.readyState === ws.OPEN) ws.send(e.pcm, { binary: true });
        break;
      case 'transcript':
        onTranscript(e);
        break;
      case 'speech_started':
        flushTranscript();
        beginUserTurn(false);
        dropAudio = false;
        sendJson({ type: 'speech_started' });
        break;
      case 'turn_done':
        dropAudio = false;
        responding = false;
        staleChain = false;
        responseOpen = false;
        flushTranscript();
        if (!userOpen) canvas?.turnDone();
        break;
      case 'response_started':
        tracksResponses = true;
        responseOpen = true;
        break;
      case 'watchdog': // the model stayed silent after its tool results: the adapter asked for the answer again
        audit({ action: 'voice.watchdog', detail: `${provider} #${e.n}` });
        break;
      case 'tool_cancelled': // Gemini: the interruption voided these calls; their results would make the model answer the old question
        for (const id of e.ids) cancelledCalls.add(id);
        break;
      case 'tool_call':
        flushTranscript();
        onToolCall(e);
        break;
      case 'error':
        if (e.soft && /cancel|no active response|not active/i.test(`${e.code ?? ''} ${e.message ?? ''}`)) break; // response.cancel with nothing to cancel
        if (e.soft) { sendJson({ type: 'error', message: e.message }); break; }
        sendJson({ type: 'error', message: e.message, fallback: e.fallback });
        finish(e.fallback ? 'unavailable' : 'vendor-error');
        break;
      case 'closed':
        finish('vendor-closed');
        break;
    }
  }

  function tick() {
    const seconds = readyAt !== null ? Math.round((now() - readyAt) / 1000) : 0;
    const costUsd = estimateCost(provider, seconds);
    limits.addCost(estimateCost(provider, seconds - billedSeconds));
    billedSeconds = seconds;
    sendJson({ type: 'usage', seconds, costUsd: Math.round(costUsd * 10_000) / 10_000 });
  }

  async function begin(msg) {
    if (starting) return;
    starting = true;
    clearTimeout(startTimer);
    const verdict = limits.check(sid, 'voice');
    if (!verdict.ok) {
      sendJson({ type: 'error', message: `Voice-Limit erreicht${verdict.retryAfter ? ` (erneut in ${Math.ceil(verdict.retryAfter / 60)} min)` : ''}` });
      finish('limit');
      return;
    }
    if (!apiKey) {
      const err = unavailableError(provider, { status: 401 });
      sendJson({ type: 'error', message: err.message, fallback: err.fallback });
      finish('no-key');
      return;
    }
    page = msg.page ?? null;
    // Server-side page context (points/timeline/context.json/deepdive): nothing the browser sent except slug, t, sceneId and pointId is
    // trusted once it loads; without a loader or on failure the browser's own page object is used as before.
    if (deps.loadPage && page?.slug) {
      const loaded = await Promise.race([deps.loadPage(page).catch(() => null), new Promise((resolve) => setTimeout(resolve, PAGE_LOAD_MS, null))]);
      if (closed) return;
      if (loaded) page = loaded;
      else audit({ action: 'voice.page.fallback', detail: `${provider} slug=${page.slug}` });
    }
    artifactBlock = deps.artifactInstructions?.() ?? '';
    startedAt = now();
    viz = deps.createViz((evt) => sendJson(evt));
    canvas = deps.createCanvas?.({ emit: sendJson, page, provider, onFacts: (text, meta) => { const how = adapter?.addContext?.(text, meta); factsReady?.(); factsReady = null; factsDue = 0; audit({ action: 'voice.facts', detail: `${provider} ${how ?? 'held'} strong=${meta?.strong ?? '-'} final=${meta?.final ?? '-'} ${String(text).length}ch ${(String(text).match(/^### \S+/gm) ?? []).join(' ')}` }); }, ...focusOf(msg) }) ?? null;
    adapter = create({ apiKey, instructions: buildInstructions(page, undefined, { provider }) + artifactBlock, tools: toolDefs, voice: msg.voice, lang: msg.lang ?? 'de' }, onEvent);
    unregisterText = deps.registerText?.((text) => readyAt !== null && deliverText(text));
    // Round 10 (live r10): the first ledger read of a session is cold on the bridge (~3 s for the board pages), and money questions
    // are the common voice case; warming its 5-minute cache now takes those seconds out of the first spoken answer.
    if (deps.prewarm === true) Promise.resolve().then(() => runTool('ledger_spend', { groupBy: 'category' }, { ...makeCtx(page), maxChars: 200 })).catch(() => {});
    tickTimer = setInterval(tick, USAGE_TICK_MS);
    capTimer = setTimeout(() => {
      sendJson({ type: 'error', message: 'Voice-Sitzung nach 30 Minuten beendet' });
      finish('hard-cap');
    }, HARD_CAP_MS);
    audit({ action: 'voice.start', detail: `${provider} slug=${page?.slug ?? '-'}` });
  }

  /**
   * Florian clicked another element (or the video moved on) during the session: reload the server-side context and tell the model
   * the new clicked element + scene. The `page` the tools use follows. Rate-limited to one reload per second.
   */
  let pageUpdateAt = 0;
  async function updatePage(raw) {
    if (!deps.loadPage || !raw?.slug || raw.slug !== page?.slug || now() - pageUpdateAt < 1000) return;
    pageUpdateAt = now();
    const loaded = await deps.loadPage(raw).catch(() => null);
    if (!loaded || closed) return;
    const changed = loaded.pointId !== page?.pointId;
    page = loaded;
    canvas?.setPage?.(loaded); // the voice canvases draw from the element Florian clicked now (critic r2 P1-2)
    if (!changed || !loaded.point) return;
    const how = adapter?.updatePage?.(pageUpdateText(loaded), { instructions: () => buildInstructions(loaded, undefined, { provider }) + artifactBlock });
    audit({ action: 'voice.page.update', detail: `${provider} ${how ?? 'unsupported'} point=${loaded.pointId}` });
  }

  function finish(reason) {
    if (closed) return;
    flushTranscript();
    commitUser();
    closed = true;
    clearTimeout(startTimer);
    clearInterval(tickTimer);
    clearTimeout(capTimer);
    if (startedAt) {
      tick();
      audit({ action: 'voice.stop', detail: `${provider} ${reason} ${billedSeconds}s`, cost_usd: estimateCost(provider, billedSeconds) });
    }
    unregisterText?.();
    adapter?.close();
    viz?.close();
    canvas?.close(); // drawings already under way still finish and reach the canvas bus
    sendJson({ type: 'closed' });
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  }

  // Both browser WS text and authenticated context-turn use this exact user-turn path.
  function deliverText(raw, msg = {}) {
    const text = raw.slice(0, 2000).trim();
    if (!text || !adapter || closed) return false;
    if (Object.hasOwn(msg, 'focusedCanvasId')) canvas?.setFocus?.(focusOf(msg).focusedId);
    flushTranscript();
    commitUser();
    beginUserTurn(true);
    userOpen = false;
    contentOpen = false;
    interrupted = false;
    viz?.noteTurn({ role: 'user', text });
    canvas?.noteTurn({ role: 'user', text });
    expectFacts(canvas?.userTurn(text));
    sendJson({ type: 'transcript', role: 'user', text, final: true, typed: true });
    adapter.sendText(text);
    return true;
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (adapter) adapter.sendAudio(Buffer.from(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'start' && !adapter) begin(msg).catch(() => finish('start-failed'));
    else if (msg.type === 'page' && adapter) updatePage(msg.page);
    else if (msg.type === 'focus') canvas?.setFocus?.(focusOf(msg).focusedId); // round 11: the canvas the browser shows now
    else if (msg.type === 'text' && adapter && typeof msg.text === 'string') {
      deliverText(msg.text, msg);
    }
    else if (msg.type === 'interrupt' && adapter) { dropAudio = true; adapter.interrupt(); }
    else if (msg.type === 'stop') finish('client-stop');
  });
  ws.on('close', () => finish('client-closed'));
  ws.on('error', () => finish('client-error'));
}
