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
      turn_detection: { type: 'server_vad' },
      tools: toolsOf(tools).map((t) => ({ type: 'function', ...t })),
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { language_hint: lang } },
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
    },
  };
}

/** Pure translation of one server frame into normalised events (see adapter.js). */
export function translate(msg, state = {}) {
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
      return [{ t: 'transcript', role: 'user', text: msg.transcript ?? msg.text ?? '', final: true }];
    case 'input_audio_buffer.speech_started':
      return [{ t: 'speech_started' }];
    case 'response.function_call_arguments.done':
      return [{ t: 'tool_call', id: msg.call_id, name: msg.name, args: parseArgs(msg.arguments) }];
    case 'response.created':
      return [{ t: 'response_started' }];
    case 'response.done':
      return [{ t: 'turn_done' }];
    case 'error':
      return [{ t: 'error', message: msg.error?.message ?? 'xAI-Fehler', code: msg.error?.code, soft: true }];
    default:
      return [];
  }
}

export function createXai(opts, emit) {
  const state = {};
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
    /** Florian clicked another element: the instructions are replaced by the ones rebuilt for the new page (partial session.update; not live-verified, a vendor error is soft). */
    updatePage: (_text, { instructions }) => { send({ type: 'session.update', session: { instructions: instructions() } }); return 'sent'; },
    interrupt: () => { watchdog.clear(); send({ type: 'response.cancel' }); }, // a new question while the old answer is still running (the server VAD also cuts audio itself)
    sendToolResult: (id, _name, output, opts) => batch.result({ id, output, stale: opts?.stale }),
    close: () => { watchdog.clear(); ws.close(); },
  };
}
