// OpenAI GPT-Live (wss://api.openai.com/v1/live/sessions) with a Responses-API delegation backend.
// Docs: developers.openai.com voice-websockets?api=live, live-delegation.
import { cfg } from '../config.js';
import { createWatchdog, openSocket, toolsOf, parseArgs, ToolBatch, unavailableError } from './adapter.js';

const URL = 'wss://api.openai.com/v1/live/sessions';
const MODEL = 'gpt-live-1';
const HEAVY_EFFORT = /^(?:high|xhigh|max)$/i;

/**
 * The delegation backend from the config. Round 10 (critic r9 F4): gpt-6-astra/medium needed 10-20 s of research per turn;
 * the default is the fastest model that still calls the tools right (live-measured). Astra never runs above medium.
 */
export function delegateConfig(model = cfg.openaiDelegateModel(), effort = cfg.openaiDelegateEffort()) {
  const safe = HEAVY_EFFORT.test(effort) ? 'medium' : effort || 'low';
  return { model, reasoning: { effort: safe } };
}

export function sessionStart({ instructions, tools, voice = 'marin', delegate = delegateConfig() }) {
  return {
    type: 'session.start',
    event_id: 'start',
    session: {
      model: MODEL,
      instructions,
      audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice } },
      delegation: {
        type: 'responses',
        responses: { ...delegate, tools: toolsOf(tools).map((t) => ({ type: 'function', ...t })), tool_choice: 'auto' },
      },
    },
  };
}

/**
 * state.typed: the last turn was typed. The Live API has no text-input event, so a typed turn goes straight to the delegation
 * backend, which answers in text. Fix 28 Oct (live: the answer twice, "…bekommen.Okay." and then a spoken copy): the live
 * model ALSO speaks that text (often after a filler like "Okay."), so a typed turn shows ONE assistant message: the backend's
 * text, once the backend is finished (a response without a function call); the spoken transcript of that turn is held back
 * and dropped. Only when the backend finishes without any text, the held speech becomes the transcript.
 */
export function startTypedTurn(state) {
  Object.assign(state, { typed: true, text: '', held: [], shown: false, spoken: false, called: false });
}

function endTypedTurn(state) {
  Object.assign(state, { typed: false, text: '', held: [], shown: false, spoken: false, called: false });
}

export function translate(msg, state = {}) {
  switch (msg.type) {
    case 'session.started':
      return [{ t: 'ready', model: msg.session?.model ?? MODEL }];
    case 'session.output_audio.delta':
      return [{ t: 'audio', pcm: Buffer.from(msg.delta, 'base64') }];
    case 'session.input_transcript.delta':
      endTypedTurn(state);
      return [{ t: 'transcript', role: 'user', delta: msg.delta, final: false }];
    case 'session.output_transcript.delta': {
      const e = { t: 'transcript', role: 'assistant', delta: msg.delta, final: false };
      if (!state.typed || state.spoken) return [e];
      if (state.shown) return []; // the backend's text is already the transcript of this turn: the spoken copy is not shown again
      (state.held ??= []).push(e);
      return [];
    }
    case 'response.event':
      return translateBackend(msg.event ?? {}, state);
    case 'error': {
      const code = msg.error?.code;
      return [unavailableError('openai', { code }) ?? { t: 'error', message: msg.error?.message ?? 'OpenAI-Fehler', code, soft: true }];
    }
    case 'session.closed':
      return [{ t: 'closed' }];
    default:
      // the Live docs name no speech-start event; accept any `*speech_started` the service may add
      return /speech_started$/.test(msg.type ?? '') ? [{ t: 'speech_started' }] : [];
  }
}

function translateBackend(ev, state) {
  if (ev.type === 'response.output_text.done') {
    // collected until the backend is finished: a turn with several backend responses still gets one message
    if (state.typed && !state.shown && !state.spoken && ev.text) state.text = state.text ? `${state.text} ${ev.text}` : ev.text;
    return [];
  }
  if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') {
    state.called = true;
    return [{ t: 'tool_call', id: ev.item.call_id, name: ev.item.name, args: parseArgs(ev.item.arguments) }];
  }
  if (ev.type === 'response.created') { state.called = false; return [{ t: 'response_started' }]; }
  if (ev.type === 'response.completed' || ev.type === 'response.failed' || ev.type === 'response.cancelled') {
    const out = [];
    // a response without a function call ends the backend's work on this typed turn
    if (state.typed && !state.called && !state.shown && !state.spoken) {
      const text = String(state.text ?? '').trim();
      if (text) {
        out.push({ t: 'transcript', role: 'assistant', text, final: true });
        state.shown = true;
      } else state.spoken = true; // no text at all: the speech is the transcript (what was held comes right after turn_done)
      const held = state.spoken ? state.held ?? [] : [];
      state.held = [];
      state.text = '';
      return [...out, { t: 'turn_done' }, ...held];
    }
    return [{ t: 'turn_done' }];
  }
  return [];
}

export function createOpenAI(opts, emit) {
  const state = {};
  endTypedTurn(state);
  let context = null; // the early illustrator's facts for the current question, handed over with the next tool output
  let handed = false; // they went out with a tool output already (this question)
  const output = (r) => send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: r.id, output: r.output } });
  // critic r9 run 1: after desk_status the model never resumed; a silent model after its tool results is asked again
  const watchdog = createWatchdog(opts.watchdogMs ?? (() => cfg.voiceWatchdogMs()), (n) => { send({ type: 'response.create' }); emit({ t: 'watchdog', n }); });
  const batch = new ToolBatch((results) => {
    results.forEach(output);
    send({ type: 'response.create' });
    watchdog.arm();
  }, (results) => results.forEach(output));
  const ws = openSocket(opts.url ?? URL, { Authorization: `Bearer ${opts.apiKey}` }, {
    provider: 'openai',
    emit,
    onOpen: () => send(sessionStart(opts)),
    onMessage: (msg, out) => {
      for (const e of translate(msg, state)) {
        if (e.t === 'tool_call') batch.call();
        if (e.t === 'turn_done') batch.responseDone();
        if (e.t === 'audio' || e.t === 'tool_call' || e.t === 'transcript' || e.t === 'speech_started' || e.t === 'closed') watchdog.clear(); // an answer, or Florian speaks
        out(e);
      }
    },
  });
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  return {
    sendAudio: (pcm24) => send({ type: 'session.input_audio.append', audio: pcm24.toString('base64') }),
    sendText: (text) => {
      // 'session.instructions.append' needs a delegation_id (live-verified 24 Oct): a typed turn is a user message for the backend
      startTypedTurn(state);
      send({ type: 'response.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      send({ type: 'response.create' });
    },
    /** Desk facts the early illustrator read for the current question: added as context without asking for a response (the answer is the model's own turn). */
    /**
     * Desk facts the early illustrator read for the current question. Round 10 (live r10): a separate user message sent while the
     * delegation runs derailed it (filler, then no tool call and silence; critic r9 run 3 too), so the facts ride along with the
     * next tool output of this question.
     */
    addContext: (text, { final = false } = {}) => { if (final && handed) return; context = String(text ?? '').slice(0, 6000) || null; }, // round 12: the early run's later facts only while none went out
    newTurn: () => { context = null; handed = false; },
    /** Florian clicked another element: appended to the live model's instructions (documented `session.instructions.append`; delegation_id null like interrupt()). */
    updatePage: (text) => { send({ type: 'session.instructions.append', delegation_id: null, content: text }); return 'sent'; },
    // The Live API has no response.cancel (live-verified 24 Oct: "Supported values are ..."), and barge-in leaves the backend running (docs: live-delegation).
    // So: steer the live model to the new question; the session marks the old chain's tool results stale, which ends the chain.
    interrupt: () => { watchdog.clear(); send({ type: 'session.instructions.append', delegation_id: null, content: 'Florian hat gerade eine neue Frage gestellt. Die Frage davor ist abgebrochen: antworte nur auf die neueste Frage und recherchiere dafür neu.' }); },
    sendToolResult: (id, _name, output, opts) => {
      let out = output;
      if (context && !opts?.stale) { out = `${output}\n\n=== DESK-FAKTEN zur aktuellen Frage (schon gelesen): antworte Florian jetzt daraus, kurz und auf Deutsch ===\n${context}`; context = null; handed = true; }
      batch.result({ id, output: out, stale: opts?.stale });
    },
    close: () => { watchdog.clear(); send({ type: 'session.close' }); ws.close(); },
  };
}
