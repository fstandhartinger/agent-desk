// xAI Grok Voice Agent API (wss://api.x.ai/v1/realtime), OpenAI-realtime-shaped. Docs: docs.x.ai voice agent.
import { cfg } from '../config.js';
import { createWatchdog, openSocket, toolsOf, parseArgs, ToolBatch } from './adapter.js';

const URL = 'wss://api.x.ai/v1/realtime?model=grok-voice-3.0';
const MODEL = 'grok-voice-3.0';

export function sessionUpdate({ instructions, tools, voice = 'eve', lang = 'de' }) {
  return {
    type: 'session.update',
    session: {
      voice,
      instructions,
      turn_detection: { type: 'server_vad', ...(cfg.xaiSilenceMs() > 0 ? { silence_duration_ms: cfg.xaiSilenceMs() } : {}) },
      tools: toolsOf(tools).map((t) => ({ type: 'function', ...t })),
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint: lang } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  };
}

const idOf = (key, value) => (value == null ? {} : { [key]: value });

/** Pure translation of one server frame into normalised events (see adapter.js). */
export function translate(msg, state = {}) {
  const failed = msg.error?.event_id ?? msg.event_id ?? '';
  // passive screen context: never shown to Florian; a delete of an item the vendor no longer has is harmless (`gone`)
  if (msg.type === 'error' && /^screen-/.test(failed)) return [{ t: 'screen_error', message: msg.error?.message ?? 'xAI-Fehler', ...(/^screen-del-/.test(failed) || /not found/i.test(msg.error?.message ?? '') ? { gone: true } : {}) }];
  switch (msg.type) {
    case 'session.updated':
      return state.ready ? [] : ((state.ready = true), [{ t: 'ready', model: MODEL }]);
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return [{ t: 'audio', pcm: Buffer.from(msg.delta, 'base64') }];
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
      return [{ t: 'transcript', role: 'assistant', delta: msg.delta, final: false }];
    case 'conversation.item.input_audio_transcription.updated':
    case 'conversation.item.input_audio_transcription.completed':
      return [{ t: 'transcript', role: 'user', text: msg.transcript ?? msg.text ?? '', final: true, ...idOf('itemId', msg.item_id) }];
    case 'input_audio_buffer.speech_started':
      return [{ t: 'speech_started' }];
    case 'response.function_call_arguments.done':
      return [{ t: 'tool_call', id: msg.call_id, name: msg.name, args: parseArgs(msg.arguments), ...idOf('responseId', msg.response_id) }];
    case 'response.created':
      return [{ t: 'response_started', ...idOf('id', msg.response?.id) }];
    case 'response.done':
      return [{ t: 'turn_done', ...idOf('id', msg.response?.id) }];
    case 'error':
      return [{ t: 'error', message: msg.error?.message ?? 'xAI-Fehler', code: msg.error?.code, soft: true }];
    default:
      return [];
  }
}

export function createXai(opts, emit) {
  const state = {};
  let screenId = null, screenSeq = 0, briefId = null, briefSeq = 0;
  const output = (r) => send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: r.id, output: r.output } });
  const watchdog = createWatchdog(opts.watchdogMs ?? (() => cfg.voiceWatchdogMs()), (n) => { send({ type: 'response.create' }); emit({ t: 'watchdog', n }); });
  const batch = new ToolBatch((results) => {
    results.forEach(output);
    send({ type: 'response.create' });
    watchdog.arm();
  }, (results) => results.forEach(output));
  const ws = openSocket(opts.url ?? URL, { Authorization: `Bearer ${opts.apiKey}` }, {
    provider: 'xai',
    emit,
    onOpen: () => send(sessionUpdate(opts)),
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
    sendAudio: (pcm24) => send({ type: 'input_audio_buffer.append', audio: pcm24.toString('base64') }),
    sendText: (text) => {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      send({ type: 'response.create' });
    },
    /** Last resort of the no-answer watchdog: held results go out, the question comes again with what is known. */
    recover: (text) => {
      batch.force();
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      send({ type: 'response.create' });
    },
    /** Florian clicked another element: the instructions are replaced by the ones rebuilt for the new page (partial session.update; not live-verified, a vendor error is soft). */
    updatePage: (_text, { instructions }) => { send({ type: 'session.update', session: { instructions: instructions() } }); return 'sent'; },
    /**
     * Passive screen description: ONE conversation item (replaced by id), never response.create, so it does not trigger a reply. Not in the instructions:
     * screen text is untrusted data and must not gain system authority. Not live-verified against xAI (a vendor error is tagged screen-* and only traced).
     */
    setScreenContext: (text) => {
      const prev = screenId;
      screenId = `screen_ctx_${++screenSeq}`;
      send({ type: 'conversation.item.create', event_id: `screen-add-${screenSeq}`, item: { id: screenId, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      if (prev) send({ type: 'conversation.item.delete', event_id: `screen-del-${screenSeq}`, item_id: prev });
      return 'sent';
    },
    /** Start briefing: one conversation item of its own (replaced by id), never response.create; errors carry the screen- prefix, so they stay soft. */
    setBriefing: (text) => {
      const prev = briefId;
      briefId = `briefing_ctx_${++briefSeq}`;
      send({ type: 'conversation.item.create', event_id: `screen-brief-${briefSeq}`, item: { id: briefId, type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
      if (prev) send({ type: 'conversation.item.delete', event_id: `screen-del-brief-${briefSeq}`, item_id: prev });
      return 'sent';
    },
    interrupt: () => { watchdog.clear(); send({ type: 'response.cancel' }); }, // a new question while the old answer is still running (the server VAD also cuts audio itself)
    sendToolResult: (id, _name, output, opts) => batch.result({ id, output, stale: opts?.stale }),
    close: () => { watchdog.clear(); ws.close(); },
  };
}
