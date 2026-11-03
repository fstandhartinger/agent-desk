// Browser side of a voice session: protocol with the web client (docs/SPEC.md "Voice"), tool execution, limits,
// usage/cost ticks and audit. Provider specifics live in the adapters.
import { cfg } from '../config.js';
import { activityLabel, pseudoPathRefusal, resolveToolName } from '../tools.js';
import { short } from '../redact.js';
import { cjkRuns, isGermanText, stripCjk } from '../canvas.js';
import { buildInstructions } from './instructions.js';
import { pageUpdateText } from '../pack.js';
import { estimateCost } from './prices.js';
import { isFiller, knownWords, limitFillers, repairGlued, stripToolMarkup, TranscriptMarkupFilter } from './transcript.js';
import { markOk } from '../providerHealth.js';
import { unavailableError } from './adapter.js';
import { SETTLE_MS } from '../voiceActions.js';
import { belongsToOldQuestion, fitsQuestion, isPromiseOnly, needsAnswer, RECOVERY_LEAD, routingHint } from './noAnswer.js';

export const HARD_CAP_MS = 30 * 60_000;
export const USAGE_TICK_MS = 10_000;
const START_TIMEOUT_MS = 10_000;
const VOICE_TOOL_CHARS = 2500;
export const FACTS_WAIT_MS = 2500;
// Gemini researches in long loops (8 tools on one question, critic r7; 5 sequential calls = 20 s and no answer, critic r9): after 3 it must answer
export const MAX_RESEARCH_TOOLS = { gemini: 3 };
const DRAW_TOOLS = new Set(['canvas_draw', 'canvas_render']);
// Action tools wait for him to finish and are no research: they never count against the research cap
const ACTION_TOOLS = new Set(['output_main_agent_prompt', 'start_agent_job']);
const SPOKEN_KEEP = 12;
const ECHO_MS = 20_000;
const AWAIT_FINAL_MS = 4000; // a sound without any transcript after this long was noise
// Topic files of the desk knowledge are dense and ordered by importance; voice models need most of one at once.
/** Round 11: {focusedId} from a client message (`focusedCanvasId`: string or null); {} when the client did not say. */
const focusOf = (msg) => (Object.hasOwn(msg ?? {}, 'focusedCanvasId') ? { focusedId: typeof msg.focusedCanvasId === 'string' ? msg.focusedCanvasId.slice(0, 64) : null } : {});
const voiceCap = (name) => (name === 'artifact_ref_read' || name === 'artifact_resolve' ? 6000 : name === 'knowledge_read' ? 6000 : name === 'explainer_context' ? 4000 : VOICE_TOOL_CHARS);
const PAGE_LOAD_MS = 4000; // the server-side page context may delay the vendor connect at most this long

/** Vendors also stream silent frames while Florian speaks: those say nothing about an answer. */
function isSilent(pcm) {
  for (let i = 0; i + 1 < pcm.length; i += 32) if (Math.abs(pcm.readInt16LE(i)) > 300) return false;
  return true;
}

const GROW_WINDOW_MS = 30_000; // a longer final within this window that extends the previous one is the same utterance
const normText = (t) => String(t ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const MAX_RECOVERIES = 2;
const RECOVERY_FACT_CHARS = 1500;
const HALF_SENTENCE_MS = 1500; // a mute this soon after the last word cut a sentence (GPT-Live transcripts often have no punctuation)
const OPENAI_EXTRA_MS = 2000; // GPT-Live's delegate needs up to ~9 s to its first tool call (live 2 Nov)

export function runVoiceSession(ws, deps, { provider, create, apiKey, now = Date.now, mergeMs = cfg.userMergeMs(), noAnswerMs = () => cfg.voiceNoAnswerMs() + (provider === 'openai' ? OPENAI_EXTRA_MS : 0) }) {
  const { runTool, makeCtx, limits, audit, toolDefs, sid } = deps;
  const sendJson = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  // Live activity for the dock and the Screen Agent window (v0.1.7): what the desk does right now. Not traced: tool.call / tool.done already are.
  const activity = (obj) => sendJson({ type: 'activity', ...obj, at: now() });
  let thoughtFor = 0; // the user turn the 'thinking' activity was sent for
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
  // Incident 2 Nov (GPT-Live, 5 minutes of silence): a call is only "old" on positive evidence, see belongsToOldQuestion.
  const overtaken = new Set(); // vendor response ids that were open when a new question began
  let openResponses = new Set(); // vendor response ids that started and did not finish yet
  const responseStarted = new Map(); // vendor response id -> when it started
  const fragmentResponses = new Set(); // vendor responses that answered a fragment which then grew: their tool calls are stale
  // Florian's own words (speech finals, typed turns): the only thing the action tools' trigger is checked against (voiceActions.js).
  // Marker turns, context turns, tool results and screen/registry text never get in.
  const spoken = []; // the last SPOKEN_KEEP {text, at, turn}
  let speechAt = -Infinity; // when he last made a sound or a transcript piece arrived: speaking() = within SETTLE_MS
  let speechOpen = false; // he started speaking and that sound has no final transcript yet
  let heardBack = { text: '', at: -Infinity }; // what the agent said last: its own voice through his speakers must not count as his words
  const echoOf = (text, at_) => { // most of the sentence's words were just spoken by the agent
    if (at_ - heardBack.at > ECHO_MS) return false;
    const said = new Set(normText(heardBack.text).split(' ')), own = normText(text).split(' ').filter(Boolean);
    return own.length > 0 && own.filter((w) => said.has(w)).length / own.length >= 0.8;
  };
  const noteSpoken = (text, at_, turn_) => { spoken.push({ text, at: at_, turn: turn_, echo: echoOf(text, at_) }); if (spoken.length > SPOKEN_KEEP) spoken.shift(); };
  let lastFinal = null; // the newest user final of the current turn: a longer final that extends it replaces it (growing fragments)
  let previousQuestion = ''; // the question before the current one: only a call that demonstrably fits THAT one is stale
  // No-answer watchdog for all providers: a user turn with neither speech nor a running tool, or a spoken promise with nothing following.
  const pending = { active: false, text: '', answer: '', recoveries: 0, timer: null, facts: [], promised: false, overlap: false };
  let runningTools = 0;
  let detachVision = null;
  let screenHeld = null; // screen context that arrived before the vendor was ready
  let briefingHeld = null; // the start briefing (item G), same: held until the vendor is ready
  let detachBriefing = null;
  let muted = false;
  let mutedAt = 0;
  let mutedMs = 0;
  let framesWhileMuted = 0;
  let turnId = 0;
  const trace = deps.openTrace?.({ provider }) ?? { event() {}, close() {} };

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
    trace.event(`transcript.${role}.final`, { turn: turnId, text });
    if (role === 'assistant') {
      heardBack = { text: `${now() - heardBack.at < ECHO_MS ? `${heardBack.text} ` : ''}${text}`.slice(-4000), at: now() };
      if (!isPromiseOnly(text)) { if (lastFinal) lastFinal.answered = true; if (spoken.length) spoken.at(-1).answered = true; }
    }
    if (role === 'user') { speechOpen = false; lastUserText = text; lastFinal = { text, norm: normText(text), itemId: turn.itemId ?? null, turn: turnId, at: now() }; noteSpoken(text, lastFinal.at, turnId); }
    else if (isGermanText(lastUserText)) text = stripCjk(text, [...cjkKnown]); // a stray CJK glyph in a German answer is a model slip
    turn.role = null;
    turn.text = '';
    turn.itemId = null;
    sendJson({ type: 'transcript', role, text, final: true });
    if (role === 'user') {
      activity({ id: `heard-${turnId}`, phase: 'heard', label: short(text, 80) });
      collectUser(text);
      return;
    }
    viz?.noteTurn({ role, text });
    canvas?.noteTurn({ role, text });
    // a finished spoken answer may deserve a drawing (or refused to draw): decided without a model call
    if (role === 'assistant') canvas?.autoTurn({ answerText: text });
  }

  /** The answer in flight belongs to something Florian just replaced or interrupted (new question, grown fragment): normal barge-in. */
  function cutAnswer(trigger) {
    interrupted = true;
    pending.overlap = tracksResponses; // GPT-Live keeps speaking the old answer for many seconds: that text answers nothing
    staleChain = tracksResponses ? responseOpen : true;
    for (const id of openResponses) overtaken.add(id);
    responding = false;
    dropAudio = false;
    adapter?.interrupt(); // OpenAI/xAI: response.cancel; Gemini: the new input interrupts by itself
    audit({ action: 'voice.barge_in', detail: provider });
    trace.event('barge_in', { turn: turnId, trigger, epoch: contentEpoch, staleChain, openResponses: [...openResponses] });
  }

  /**
   * A new question begins. `content` = real speech (a transcript), not just a VAD event: only that stops the answer to the
   * previous question (barge-in), and makes the pending tool results of that answer stale.
   */
  function beginUserTurn(content, trigger = 'speech') {
    if (content && !contentOpen) {
      contentOpen = true;
      contentEpoch += 1;
      turnId += 1;
      previousQuestion = lastUserText;
      lastUserText = '';
      turnProposals = new Map(); // proposals with the same title are deduped within one user turn (critic P2-6)
      pending.recoveries = 0;
      pending.answer = '';
      pending.facts = [];
      pending.promised = false;
      pending.overlap = false;
      trace.event('turn.user.start', { turn: turnId, epoch: contentEpoch, trigger, ...(trigger === 'marker' ? { marker: true } : {}) });
      if (responding) cutAnswer(trigger);
    }
    if (userOpen && (content || userBuf || turn.role === 'user')) return;
    userOpen = true;
    canvas?.startTurn();
    adapter?.newTurn?.();
    researchTools = 0;
    factsAt = null;
    fillers = 0;
  }

  /** 'Verstanden, denke nach …' once per spoken question, when the provider starts its response (or, without response events, when the question is complete). */
  function thinking() {
    if (!turnId || thoughtFor === turnId) return;
    thoughtFor = turnId;
    activity({ id: `think-${turnId}`, phase: 'thinking', label: 'Verstanden, denke nach …' });
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
    armNoAnswer(text);
    if (!tracksResponses) thinking();
    viz?.noteTurn({ role: 'user', text });
    canvas?.noteTurn({ role: 'user', text });
    // the question is complete: the early illustrator starts now, in parallel with the agent's answer
    expectFacts(canvas?.userTurn(text));
  }

  /** The question waits for an answer: `noAnswerMs` of silence with no running tool -> recovery. */
  function armNoAnswer(text) {
    if (pending.settled === turnId) return; // the fragments of this turn were committed after its answer had begun
    pending.active = needsAnswer(text);
    pending.text = text;
    pending.promised = false;
    pending.at = now();
    if (pending.active) restartNoAnswer();
    else clearTimeout(pending.timer);
  }

  function restartNoAnswer() {
    clearTimeout(pending.timer);
    if (!pending.active || closed) return;
    pending.timer = setTimeout(fireNoAnswer, noAnswerMs());
    pending.timer.unref?.();
  }

  function fireNoAnswer() {
    if (!pending.active || closed || !adapter) return;
    if (runningTools > 0) { restartNoAnswer(); return; } // a tool still works: the same timer checks again
    const reason = pending.answer.trim() ? 'promise' : 'silent';
    if (pending.recoveries >= MAX_RECOVERIES) {
      pending.active = false;
      audit({ action: 'voice.unanswered', detail: `${provider} turn=${turnId}` });
      trace.event('turn.unanswered', { turn: turnId, reason, question: pending.text, recoveries: pending.recoveries });
      sendJson({ type: 'notice', code: 'no-answer', message: 'Das Modell antwortet gerade nicht. Stell die Frage bitte noch einmal oder wechsle die Stimme.' });
      return;
    }
    pending.recoveries += 1;
    pending.answer = '';
    const facts = pending.facts.join('\n\n').slice(0, RECOVERY_FACT_CHARS);
    const hint = routingHint(pending.text);
    const text = `${RECOVERY_LEAD}\nFrage: ${pending.text}${hint ? `\n${hint}` : ''}${facts ? `\nSchon gefunden:\n${facts}` : ''}`;
    audit({ action: 'voice.no_answer', detail: `${provider} ${reason} #${pending.recoveries} turn=${turnId}` });
    trace.event('watchdog.no_answer', { turn: turnId, reason, n: pending.recoveries, question: pending.text, factsChars: facts.length });
    if (adapter.recover) adapter.recover(text);
    else adapter.sendText?.(text);
    restartNoAnswer();
  }

  /** Assistant text since the question: real content settles it; a promise ("Ich schaue sofort") keeps waiting for a tool or an answer. */
  function noteAnswer(delta) {
    if (!pending.active) return;
    pending.answer += delta;
    // deltas are single words: only the text collected since the question can name something of it
    if (pending.overlap && !fitsQuestion(pending.answer, pending.text)) { restartNoAnswer(); return; }
    pending.overlap = false;
    if (isPromiseOnly(pending.answer)) { pending.promised = true; restartNoAnswer(); return; }
    pending.active = false;
    pending.settled = turnId;
    clearTimeout(pending.timer);
  }

  function expectFacts(decision) {
    factsDue = provider === 'gemini' && (decision === 'early' || decision === 'deictic') ? now() + FACTS_WAIT_MS : 0;
  }

  /** Gemini: a research result waits (bounded) for the early facts, so they ride along with it. */
  async function waitForFacts(name) {
    if (!factsDue || DRAW_TOOLS.has(name) || ACTION_TOOLS.has(name) || adapter?.factsDelivered?.()) return;
    const left = factsDue - now();
    if (left <= 0) return;
    await new Promise((resolve) => { const timer = setTimeout(resolve, left); factsReady = () => { clearTimeout(timer); resolve(); }; });
  }

  /**
   * A user final that EXTENDS the previous final of the same turn (xAI sends the growing sentence again after each pause; same item id or
   * the normalised text starts with the old one): the same turn, the browser message replaced, the shorter fragment's answer cut and its
   * tool calls stale, watchdog and illustrator once on the whole sentence. A fragment not yet committed is simply replaced.
   */
  function growsPrevious(e) {
    const prev = lastFinal;
    if (!prev || e.role !== 'user' || !e.final || typeof e.text !== 'string' || prev.turn !== turnId || now() - prev.at > GROW_WINDOW_MS) return false;
    const norm = normText(e.text);
    const answering = turn.role === 'assistant' && turn.text.trim() && !isPromiseOnly(turn.text); // the answer still being spoken counts, a filler like "Ich schaue kurz" does not
    if ((prev.answered || answering) && (e.itemId == null || e.itemId !== prev.itemId)) return false; // he heard an answer: "Ja genau" after "Ja" is a new turn, not a longer fragment
    if (!norm || norm === prev.norm) return Boolean(norm) && (e.itemId ?? null) === prev.itemId && prev.itemId !== null; // a repeated item is dropped, an equal sentence by another item is a new turn
    return (e.itemId != null && e.itemId === prev.itemId) || `${norm} `.startsWith(`${prev.norm} `);
  }

  function growUser(e) {
    const text = e.text.trim(), prev = lastFinal;
    if (normText(text) === prev.norm) return; // the same item again
    trace.event('turn.user.grown', { turn: prev.turn, text: prev.text, into: text });
    sendJson({ type: 'transcript', role: 'user', text, final: true, replace: true });
    trace.event('transcript.user.final', { turn: prev.turn, text, grown: true });
    lastFinal = { text, norm: normText(text), itemId: e.itemId ?? prev.itemId, turn: prev.turn, at: now() };
    speechOpen = false;
    if (spoken.length && spoken.at(-1).turn === prev.turn) spoken[spoken.length - 1] = { ...spoken.at(-1), text, at: lastFinal.at, echo: echoOf(text, lastFinal.at) }; // the grown sentence REPLACES the fragment; a word already used stays used
    else noteSpoken(text, lastFinal.at, prev.turn);
    lastUserText = text;
    if (contentOpen) { // not committed yet: collect again from the whole sentence
      userBuf = '';
      collectUser(text);
      return;
    }
    // xAI opens the response about 0.4 s BEFORE it delivers the transcript it answers (a#7f54a5, a#eb8667): a response started since the shorter fragment belongs to this
    // longer one and must live, otherwise the whole sentence gets 10 s of silence. Only what was already running when the shorter fragment arrived is out of date.
    const old = [...openResponses].filter((id) => (responseStarted.get(id) ?? 0) <= prev.at);
    if (old.length || (responding && !tracksResponses)) { old.forEach((id) => fragmentResponses.add(id)); cutAnswer('grown'); }
    contentEpoch += 1; // results of the fragment's answer arrive for an older epoch: stale
    pending.recoveries = 0; pending.answer = ''; pending.facts = []; pending.promised = false; pending.overlap = false; pending.settled = null;
    armNoAnswer(text);
    viz?.noteTurn({ role: 'user', text, replace: true });
    canvas?.noteTurn({ role: 'user', text, replace: true });
    canvas?.startTurn();
    expectFacts(canvas?.userTurn(text));
  }

  function onTranscript(e) {
    if (e.role === 'user') speechAt = now();
    if (growsPrevious(e)) { if (turn.role === 'assistant') flushTranscript(); growUser(e); return; }
    if (e.role !== turn.role) flushTranscript();
    if (e.role === 'user') {
      beginUserTurn(true, 'transcript');
      if (e.delta != null || e.text != null) { clearTimeout(mergeTimer); mergeTimer = null; } // still speaking: commit after the last fragment
      // GPT-Live sends user deltas without a final: the watchdog also has to run for a question that was never committed
      armNoAnswer(`${userBuf} ${turn.role === 'user' ? turn.text : ''} ${e.delta ?? e.text ?? ''}`.replace(/\s+/g, ' ').trim());
    } else {
      assistantStarted();
      noteAnswer(e.delta ?? e.text ?? '');
    }
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
    if (e.role === 'user' && e.itemId != null) turn.itemId = e.itemId;
    if (e.final) flushTranscript();
  }

  async function onToolCall({ id, name, args, responseId }) {
    const requestedName = name;
    name = resolveToolName(name);
    const t0 = now();
    assistantStarted();
    const question = `${userBuf} ${lastUserText} ${pending.text}`;
    // A call of a response that started after the barge-in is current; an older one is stale only if its arguments demonstrably fit the previous question.
    const fromFragment = responseId != null && fragmentResponses.has(responseId); // answered a fragment that grew into this question
    const oldChain = fromFragment || (staleChain && (responseId == null || overtaken.has(responseId)) && belongsToOldQuestion(args, previousQuestion, question));
    const myEpoch = oldChain ? contentEpoch - 1 : contentEpoch;
    trace.event('tool.call', { turn: turnId, id, name, args, responseId, epoch: contentEpoch, myEpoch, staleChain, oldChain });
    const evt = { type: 'tool', id, name, args };
    // round 12: once the early facts went out with a tool result, Gemini may research once more, then it answers
    if (factsAt === null && adapter?.factsDelivered?.()) factsAt = researchTools;
    const cap = MAX_RESEARCH_TOOLS[provider] && factsAt !== null ? Math.min(MAX_RESEARCH_TOOLS[provider], factsAt + 1) : MAX_RESEARCH_TOOLS[provider];
    if (cap && !DRAW_TOOLS.has(name) && !ACTION_TOOLS.has(name) && (researchTools += 1) > cap) {
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
    if (myEpoch === contentEpoch) { pending.overlap = false; restartNoAnswer(); }
    runningTools += 1;
    const label = activityLabel(name, args);
    activity({ id, phase: 'start', tool: name, label });
    sendJson({ ...evt, status: 'start' });
    viz?.noteEvent({ ...evt, status: 'start' });
    canvas?.toolStarted(name);
    audit({ action: 'voice.tool', detail: `${provider}:${name} ${JSON.stringify(args).slice(0, 120)}` });
    let output;
    try {
      const voiceTurn = { spoken: () => spoken.slice(), fromFragment, oldChain, speaking: () => now() - speechAt < SETTLE_MS, awaitingFinal: () => speechOpen && now() - speechAt < AWAIT_FINAL_MS, epoch: () => contentEpoch, provider, turn: turnId };
      const res = await runTool(name, args, { ...makeCtx(page), canvas, turnProposals, maxChars: voiceCap(name), voiceTurn });
      output = String(res.content ?? '').slice(0, voiceCap(name));
      trace.event('tool.done', { turn: turnId, id, name, ok: res.ok !== false, ms: now() - t0, chars: output.length });
      canvas?.noteTool({ name, args, ok: res.ok !== false, content: res.content });
      for (const w of knownWords(res.content)) known.add(w);
      for (const r of cjkRuns(res.content)) if (cjkKnown.size < 500) cjkKnown.add(r);
      const done = { ...evt, status: 'done', summary: res.summary, ms: now() - t0 };
      activity({ id, phase: res.ok === false ? 'fail' : 'done', tool: name, label, ms: now() - t0, ...(res.ok === false ? { reason: short(res.summary, 80) } : {}) });
      sendJson(done);
      if (res.event?.type === 'handoff' || res.event?.type === 'claude_proposal' || res.event?.type === 'main_agent_prompt') sendJson(res.event); // handoff_propose / claude_task: same confirm cards as in the text chat; main_agent_prompt: the text to copy when the Screen Agent could not type it
      viz?.noteEvent({ ...done, content: output });
    } catch (err) {
      output = JSON.stringify({ error: String(err.message ?? err).slice(0, 300) });
      trace.event('tool.error', { turn: turnId, id, name, ms: now() - t0, error: String(err.message ?? err).slice(0, 300) });
      canvas?.noteTool({ name, args, ok: false, content: '' }); // the drawing stops waiting for this tool
      const failed = { ...evt, status: 'error', summary: String(err.message ?? err).slice(0, 200), ms: now() - t0 };
      activity({ id, phase: 'fail', tool: name, label, ms: now() - t0, reason: short(err.message ?? err, 80) });
      sendJson(failed);
      viz?.noteEvent(failed);
    }
    runningTools = Math.max(0, runningTools - 1);
    if (closed) return;
    // the user asked something new meanwhile: the result belongs to a question that is no longer being answered
    if (cancelledCalls.delete(id)) {
      audit({ action: 'voice.tool.cancelled', detail: `${provider}:${name}` });
      trace.event('tool.cancelled', { turn: turnId, id, name, reason: 'vendor-voided' });
      return;
    }
    await waitForFacts(name);
    if (closed) return;
    // An action tool's answer is never swallowed: xAI can call before the transcript of the same sentence arrives (which moves the epoch), and a refusal must reach the model so it calls again or says why
    if (myEpoch !== contentEpoch && !ACTION_TOOLS.has(name)) {
      audit({ action: 'voice.tool.stale', detail: `${provider}:${name}` });
      trace.event('tool.stale', { turn: turnId, id, name, myEpoch, epoch: contentEpoch, reachedModel: true, responseRequested: provider === 'gemini', reason: fromFragment ? 'fragment superseded' : oldChain ? 'args fit the previous question' : 'result arrived after a new question began' });
      if (provider === 'gemini') { // the model waits for every call it made: answer it, but say the result is old (dropping it made Gemini report "ich bearbeite noch deine vorherige Anfrage")
        adapter.sendToolResult(id, requestedName, JSON.stringify({ hinweis: 'Ergebnis zu einer früheren Frage. Florian hat inzwischen eine neue Frage gestellt: beantworte nur die neueste Frage, nutze dieses Ergebnis nur wenn es dazu passt.', ergebnis: output.slice(0, 2000) }));
        return;
      }
      adapter.sendToolResult(id, requestedName, output, { stale: true }); // OpenAI/xAI: keep the call/output pairing, no new response
      return;
    }
    if (pending.active) {
      pending.facts.push(`${name}: ${output.slice(0, RECOVERY_FACT_CHARS)}`);
      restartNoAnswer(); // the model now has the results: same clock for its answer (the adapter nudge runs first, this is the last resort)
    }
    const route = name === 'knowledge_read' ? routingHint(question) : '';
    adapter.sendToolResult(id, requestedName, route ? `${output}\n\n${route}` : output);
    trace.event('tool.result_sent', { turn: turnId, id, name, reachedModel: true, responseRequested: true, routed: Boolean(route) });
  }

  function onEvent(e) {
    if (closed) return;
    switch (e.t) {
      case 'ready':
        readyAt = now();
        sendJson({ type: 'ready', provider, model: e.model });
        trace.event('session.ready', { provider, model: e.model });
        if (screenHeld) { const how = adapter?.setScreenContext?.(screenHeld); screenHeld = null; trace.event('screen.context', { how: how ?? 'unsupported', late: true }); }
        if (briefingHeld) { const how = adapter?.setBriefing?.(briefingHeld); briefingHeld = null; trace.event('briefing.context', { how: how ?? 'unsupported', late: true }); }
        break;
      case 'audio':
        if (!audioSeen) { audioSeen = true; markOk(provider); } // a session that produced speech counts as working today
        if (!dropAudio && ws.readyState === ws.OPEN) ws.send(e.pcm, { binary: true });
        if (pending.active && !isSilent(e.pcm)) restartNoAnswer(); // still speaking (its transcript may lag): the clock starts when the sound stops
        break;
      case 'transcript':
        onTranscript(e);
        break;
      case 'speech_started':
        speechAt = now();
        speechOpen = true;
        flushTranscript();
        beginUserTurn(false);
        dropAudio = false;
        restartNoAnswer(); // Florian is talking again: no recovery into his speech
        trace.event('vad.speech_started', { turn: turnId });
        sendJson({ type: 'speech_started' });
        break;
      case 'turn_done':
        dropAudio = false;
        responding = false;
        staleChain = false;
        if (e.id != null) { openResponses.delete(e.id); overtaken.delete(e.id); fragmentResponses.delete(e.id); } else { openResponses = new Set(); overtaken.clear(); }
        if (pending.overlap) { pending.overlap = false; pending.answer = ''; } // the overtaken response is over: what follows is the answer
        responseOpen = openResponses.size > 0;
        trace.event('response.done', { turn: turnId, id: e.id });
        flushTranscript();
        if (!userOpen) canvas?.turnDone();
        break;
      case 'response_started':
        tracksResponses = true;
        responseOpen = true;
        if (e.id != null) { openResponses.add(e.id); responseStarted.set(e.id, now()); }
        pending.overlap = false; // a response that started after the question: what it says belongs to the question
        restartNoAnswer();
        trace.event('response.created', { turn: turnId, id: e.id });
        thinking();
        break;
      case 'screen_error': // the vendor refused the passive screen context: traced only, Florian sees nothing
        if (e.gone || /not found/i.test(String(e.message ?? ''))) trace.event('screen.context.gone', { message: String(e.message ?? '').slice(0, 200) }); // the replaced item is already gone: harmless
        else trace.event('screen.context.error', { message: String(e.message ?? '').slice(0, 200) });
        break;
      case 'watchdog': // the model stayed silent after its tool results: the adapter asked for the answer again
        audit({ action: 'voice.watchdog', detail: `${provider} #${e.n}` });
        trace.event('watchdog.adapter', { turn: turnId, n: e.n });
        break;
      case 'tool_cancelled': // Gemini: the interruption voided these calls; their results would make the model answer the old question
        trace.event('tool.cancel_request', { turn: turnId, ids: e.ids });
        for (const id of e.ids) cancelledCalls.add(id);
        break;
      case 'tool_call':
        flushTranscript();
        onToolCall(e);
        break;
      case 'error':
        trace.event('provider.error', { turn: turnId, message: String(e.message ?? '').slice(0, 300), code: e.code, soft: Boolean(e.soft), status: e.status });
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
      trace?.event('session.refused', { reason: 'limit', retryAfter: verdict.retryAfter ?? null, message: verdict.reason });
      sendJson({ type: 'error', message: `Voice-Limit erreicht${verdict.retryAfter ? ` (erneut in ${Math.ceil(verdict.retryAfter / 60)} min)` : ''}` });
      finish('limit');
      return;
    }
    if (!apiKey) {
      const err = unavailableError(provider, { status: 401 });
      trace?.event('provider.error', { message: String(err.message ?? '').slice(0, 300), status: 401, code: 'no-key', provider });
      sendJson({ type: 'error', message: err.message, fallback: err.fallback });
      finish('no-key');
      return;
    }
    page = msg.page ?? null;
    // Server-side page context (points/timeline/context.json/deepdive): nothing the browser sent except slug, t, sceneId and pointId is
    // trusted once it loads; without a loader or on failure the browser's own page object is used as before.
    if (deps.loadPage && page?.slug) {
      const loaded = await Promise.race([deps.loadPage(page).catch((err) => { trace?.event('page.load_failed', { slug: page.slug, message: String(err?.message ?? err).slice(0, 120) }); return null; }), new Promise((resolve) => setTimeout(resolve, PAGE_LOAD_MS, null))]);
      if (closed) return;
      if (loaded) page = loaded;
      else audit({ action: 'voice.page.fallback', detail: `${provider} slug=${page.slug}` });
    }
    artifactBlock = deps.artifactInstructions?.() ?? '';
    startedAt = now();
    viz = deps.createViz((evt) => sendJson(evt));
    canvas = deps.createCanvas?.({ emit: sendJson, page, provider, onSkip: (info) => trace.event('canvas.skipped', { turn: turnId, reason: info.reason, by: info.by, ms: info.ms }), onFacts: (text, meta) => { const how = adapter?.addContext?.(text, meta); factsReady?.(); factsReady = null; factsDue = 0; audit({ action: 'voice.facts', detail: `${provider} ${how ?? 'held'} strong=${meta?.strong ?? '-'} final=${meta?.final ?? '-'} ${String(text).length}ch ${(String(text).match(/^### \S+/gm) ?? []).join(' ')}` }); }, ...focusOf(msg) }) ?? null;
    adapter = create({ apiKey, instructions: buildInstructions(page, undefined, { provider, screen: deps.vision?.attached(sid) ?? false }) + artifactBlock, tools: toolDefs, voice: msg.voice, lang: msg.lang ?? 'de' }, onEvent);
    // Screen vision: the Screen Agent's running description reaches the model as passive context (adapter.setScreenContext: never a reply).
    detachVision = deps.vision?.attach(sid, { kind: 'voice', slow: provider === 'openai', trace: (type, data) => trace.event(type, data), setContext: (text) => {
      if (readyAt === null) { screenHeld = text; return 'held-until-ready'; }
      return adapter?.setScreenContext?.(text) ?? 'unsupported';
    } });
    // Start briefing (item G): its own passive channel (adapter.setBriefing), so it never replaces the screen description.
    detachBriefing = deps.briefing?.attach(sid, { trace: (type, data) => trace.event(type, data), setContext: (text) => {
      if (readyAt === null) { briefingHeld = text; return 'held-until-ready'; }
      return adapter?.setBriefing?.(text) ?? 'unsupported';
    } });
    unregisterText = deps.registerText?.((text, o) => readyAt !== null && (o?.marker ? deliverMarker(text) : deliverText(text)));
    // Round 10 (live r10): the first ledger read of a session is cold on the bridge (~3 s for the board pages), and money questions
    // are the common voice case; warming its 5-minute cache now takes those seconds out of the first spoken answer.
    if (deps.prewarm === true) Promise.resolve().then(() => runTool('ledger_spend', { groupBy: 'category' }, { ...makeCtx(page), maxChars: 200 })).catch(() => {}); // prewarm only: the first real call reports its own failure
    tickTimer = setInterval(tick, USAGE_TICK_MS);
    capTimer = setTimeout(() => {
      trace?.event('session.hard_cap', { ms: HARD_CAP_MS });
      sendJson({ type: 'error', message: 'Voice-Sitzung nach 30 Minuten beendet' });
      finish('hard-cap');
    }, HARD_CAP_MS);
    audit({ action: 'voice.start', detail: `${provider} slug=${page?.slug ?? '-'}` });
    trace.event('session.start', { provider, slug: page?.slug ?? null, title: page?.title ?? null, client: msg.client ?? null, entry: msg.entry ?? null, voice: msg.voice ?? null, lang: msg.lang ?? 'de' });
    Promise.resolve(trace.ready).then((info) => { if (info?.aid) sendJson({ type: 'session', aid: info.aid }); }).catch(() => {}); // ready never rejects; the id is a courtesy
  }

  /**
   * Florian clicked another element (or the video moved on) during the session: reload the server-side context and tell the model
   * the new clicked element + scene. The `page` the tools use follows. Rate-limited to one reload per second.
   */
  let pageUpdateAt = 0;
  async function updatePage(raw) {
    if (!deps.loadPage || !raw?.slug || raw.slug !== page?.slug || now() - pageUpdateAt < 1000) return;
    pageUpdateAt = now();
    const loaded = await deps.loadPage(raw).catch((err) => { trace?.event('page.load_failed', { slug: raw.slug, message: String(err?.message ?? err).slice(0, 120) }); return null; });
    if (!loaded || closed) return;
    const changed = loaded.pointId !== page?.pointId;
    page = loaded;
    canvas?.setPage?.(loaded); // the voice canvases draw from the element Florian clicked now (critic r2 P1-2)
    if (!changed || !loaded.point) return;
    const how = adapter?.updatePage?.(pageUpdateText(loaded), { instructions: () => buildInstructions(loaded, undefined, { provider, screen: deps.vision?.attached(sid) ?? false }) + artifactBlock });
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
    clearTimeout(pending.timer);
    if (muted) { mutedMs += now() - mutedAt; muted = false; }
    if (startedAt) {
      tick();
      audit({ action: 'voice.stop', detail: `${provider} ${reason} ${billedSeconds}s`, cost_usd: estimateCost(provider, billedSeconds) });
    }
    trace.event('session.stop', { reason, seconds: billedSeconds, costUsd: estimateCost(provider, billedSeconds), mutedSeconds: Math.round(mutedMs / 1000), framesWhileMuted });
    trace.close();
    unregisterText?.();
    detachVision?.();
    detachBriefing?.();
    adapter?.close();
    viz?.close();
    canvas?.close(); // drawings already under way still finish and reach the canvas bus
    sendJson({ type: 'closed' });
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
  }

  /** Mic mute: the vendor hears nothing and learns nothing about it, so no turn, no barge-in and no remark. Billing clock: see prices.js. */
  function setMuted(next, source) {
    if (next === muted) return;
    muted = next;
    if (muted) {
      mutedAt = now();
      // a half sentence cut by the mute is no question to recover; a complete one still gets its answer
      if (pending.active && now() - pending.at < HALF_SENTENCE_MS && !/[?.!]["”)]*\s*$/.test(pending.text)) { pending.active = false; clearTimeout(pending.timer); }
    } else mutedMs += now() - mutedAt;
    audit({ action: muted ? 'voice.mute' : 'voice.unmute', detail: `${provider} ${String(source ?? 'dock').slice(0, 20)}` });
    trace.event(muted ? 'mic.mute' : 'mic.unmute', { turn: turnId, source: String(source ?? 'dock').slice(0, 20), mutedSeconds: Math.round(mutedMs / 1000) });
    sendJson({ type: 'mute', muted });
  }

  // Both browser WS text and authenticated context-turn use this exact user-turn path.
  function deliverText(raw, msg = {}, typedByHim = false) {
    const text = raw.slice(0, 2000).trim();
    if (!text || !adapter || closed) return false;
    if (Object.hasOwn(msg, 'focusedCanvasId')) canvas?.setFocus?.(focusOf(msg).focusedId);
    flushTranscript();
    commitUser();
    beginUserTurn(true, 'typed');
    userOpen = false;
    contentOpen = false;
    interrupted = false;
    viz?.noteTurn({ role: 'user', text });
    canvas?.noteTurn({ role: 'user', text });
    expectFacts(canvas?.userTurn(text));
    sendJson({ type: 'transcript', role: 'user', text, final: true, typed: true });
    lastUserText = text;
    if (typedByHim) { speechAt = now(); noteSpoken(text, now(), turnId); } // typed in the Desk composer: his words; a context turn is not
    armNoAnswer(text);
    trace.event('transcript.user.final', { turn: turnId, text, typed: true });
    adapter.sendText(text);
    return true;
  }

  /**
   * Florian marked something on the screen (Screen Agent highlight): the description reaches the model as a marked context turn that asks for
   * an answer. It is no user transcript: the browser sees nothing of it, the trace flags it `marker`, no illustrator, no growing-fragment merge.
   */
  function deliverMarker(raw) {
    const text = String(raw ?? '').slice(0, 12000).trim();
    if (!text || !adapter || closed) return false;
    flushTranscript();
    commitUser();
    const spoken = lastFinal;
    beginUserTurn(true, 'marker');
    userOpen = false;
    contentOpen = false;
    interrupted = false;
    lastFinal = spoken && !spoken.answered ? { ...spoken, turn: turnId } : null; // he often goes on talking while he draws: the sentence still grows across the marking
    lastUserText = text;
    armNoAnswer(text);
    trace.event('transcript.user.final', { turn: turnId, text: text.replace(/\d/g, '#'), marker: true }); // what he circled is screen data: numbers stay out of the durable trace
    adapter.sendText(text);
    return true;
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (muted) { framesWhileMuted += 1; return; } // the client stops sending; a frame still in flight never reaches the vendor
      if (adapter) adapter.sendAudio(Buffer.from(data));
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { trace?.event('client.bad_message', { bytes: data.length }); return; }
    if (msg.type === 'start' && !adapter) begin(msg).catch((err) => { trace?.event('session.error', { reason: 'start-failed', message: String(err?.message ?? err).slice(0, 200) }); finish('start-failed'); });
    else if (msg.type === 'page' && adapter) updatePage(msg.page);
    else if (msg.type === 'focus') canvas?.setFocus?.(focusOf(msg).focusedId); // round 11: the canvas the browser shows now
    else if (msg.type === 'text' && adapter && typeof msg.text === 'string') {
      deliverText(msg.text, msg, msg.source !== 'suggestion'); // a suggested question from a link is not his own wording
    }
    else if (msg.type === 'interrupt' && adapter) { dropAudio = true; adapter.interrupt(); trace.event('client.interrupt', { turn: turnId }); }
    else if (msg.type === 'mute') setMuted(msg.muted === true, msg.source);
    else if (msg.type === 'client_event' && msg.event && typeof msg.event === 'object') trace.client?.(msg.event);
    else if (msg.type === 'stop') finish('client-stop');
  });
  ws.on('close', () => finish('client-closed'));
  ws.on('error', () => finish('client-error'));
}
