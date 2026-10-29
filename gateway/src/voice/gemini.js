// Google Gemini Live API (BidiGenerateContent). Docs: ai.google.dev live-api.
import { cfg } from '../config.js';
import { createWatchdog, openSocket, parseArgs } from './adapter.js';
import { geminiDeclarations } from './schema.js';
import { Resampler } from './resample.js';

const BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const LANGUAGE_HINT = 'Antworte Florian auf Deutsch, in kurzen gesprochenen Sätzen, auch wenn dieses Ergebnis englische Wörter enthält.';
// Round 12 (critic r11 defect 5; live r12): Gemini answered 21 s after the question. Exact early facts (the knowledge topic by its
// own slug, the ledger, desk status) go to Gemini at once as desk input; other facts ride along inside its first tool result (like
// GPT-Live), after which it may research once more (session cap). Fuzzy facts sent at once made it say "keine Information" (3 of 3).
export const FACTS_LEAD = '(Hinweis vom Desk, nicht von Florian: Zu seiner aktuellen Frage ist schon nachgelesen, was unten steht. Seine Wörter stehen dort oft nicht wörtlich: erkläre ihm daraus, was zu seiner Frage passt, kurz und auf Deutsch, ohne Ankündigung. Nur wenn wirklich nichts davon passt, schlage mit knowledge_read oder search_files nach.)';
export const FACTS_HINT = 'Diese Fakten sind zu Florians aktueller Frage schon nachgelesen (seine Wörter stehen dort oft nicht wörtlich): antworte ihm jetzt daraus, kurz und auf Deutsch. Höchstens noch ein Werkzeug, nur wenn darin wirklich etwas fehlt.';
const SELF_INTERRUPT_MS = 2000;
const NUDGE = '(Hinweis vom Desk, nicht von Florian: Du hast die Werkzeugergebnisse. Beantworte jetzt Florians letzte Frage kurz auf Deutsch, aus dem, was du gefunden hast.)';
export const MODELS = { thinking: 'models/gemini-3.8-live-extended-thinking', fast: 'models/gemini-3.8-live' };

export function setupMessage({ instructions, tools, voice, model = MODELS.thinking }) {
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (model === MODELS.thinking) generationConfig.thinkingConfig = { thinkingLevel: 'medium' };
  if (voice) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
  return {
    setup: {
      model,
      generationConfig,
      systemInstruction: { parts: [{ text: instructions }] },
      tools: [{ functionDeclarations: geminiDeclarations(tools) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function translate(msg, model = MODELS.thinking) {
  const out = [];
  if (msg.setupComplete) out.push({ t: 'ready', model: model.replace(/^models\//, '') });
  const sc = msg.serverContent;
  if (sc) {
    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data) out.push({ t: 'audio', pcm: Buffer.from(part.inlineData.data, 'base64') });
    }
    if (sc.inputTranscription?.text) out.push({ t: 'transcript', role: 'user', delta: sc.inputTranscription.text, final: false });
    if (sc.outputTranscription?.text) out.push({ t: 'transcript', role: 'assistant', delta: sc.outputTranscription.text, final: false });
    if (sc.interrupted) out.push({ t: 'speech_started' });
    if (sc.turnComplete) out.push({ t: 'turn_done' });
  }
  if (msg.voiceActivity?.type === 'ACTIVITY_START') out.push({ t: 'speech_started' });
  if (msg.toolCallCancellation?.ids?.length) out.push({ t: 'tool_cancelled', ids: msg.toolCallCancellation.ids }); // the user interrupted: these calls are void
  for (const c of msg.toolCall?.functionCalls ?? []) out.push({ t: 'tool_call', id: c.id, name: c.name, args: parseArgs(c.args) });
  return out;
}

export function createGemini(opts, emit) {
  const model = opts.model ?? MODELS.thinking;
  const mic = new Resampler(24000, 16000);
  // NON_BLOCKING tools (canvas_draw) answer "when idle": the result never interrupts or stalls the model's speech.
  const nonBlocking = new Set((opts.tools ?? []).filter((t) => t.async).map((t) => t.name));
  // Round 10 (critic r9 F4): Gemini answered q3 in English after an English-keyed ledger result and gave no answer to q1
  // after five research calls. Every tool result carries the language reminder; the early illustrator's facts ride along with
  // the next one; a model that stays silent after its results is asked once more, in German.
  let context = null;
  let delivered = false; // this question's facts went out (desk input or with a tool result)
  let openCalls = 0; // blocking tool calls of the current question that wait for their result
  let pagePending = null; // page update (new clicked element) waiting for a channel that cannot interrupt or kill the session
  let selfInterrupt = 0; // when the desk's own facts input interrupted the model (that is not Florian speaking)
  const watchdog = createWatchdog(opts.watchdogMs ?? (() => cfg.voiceWatchdogMs()), (n) => { send({ realtimeInput: { text: NUDGE } }); emit({ t: 'watchdog', n }); }, { max: 1 });
  const ws = openSocket(opts.url ?? `${BASE}?key=${opts.apiKey}`, {}, {
    provider: 'gemini',
    emit,
    onOpen: () => send(setupMessage({ ...opts, model })),
    onMessage: (msg, out) => {
      for (const e of translate(msg, model)) {
        // the facts input the desk sent cuts the model's filler: Gemini reports "interrupted", but Florian did not speak
        if (e.t === 'speech_started' && msg.serverContent?.interrupted && !msg.voiceActivity && Date.now() - selfInterrupt < SELF_INTERRUPT_MS) continue;
        if (e.t === 'tool_call' && !nonBlocking.has(e.name)) openCalls += 1;
        if (e.t === 'audio' || e.t === 'tool_call' || e.t === 'transcript' || e.t === 'speech_started' || e.t === 'closed') watchdog.clear(); // an answer, or Florian speaks
        out(e);
      }
    },
  });
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  return {
    sendAudio: (pcm24) => {
      const pcm16 = mic.push(pcm24);
      if (pcm16.length) send({ realtimeInput: { audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } });
    },
    sendText: (text) => {
      const lead = pagePending ? `${pagePending}\n\n` : '';
      pagePending = null;
      send({ realtimeInput: { text: `${lead}${text}` } });
    },
    /**
     * Florian clicked another element. Gemini Live has no verified way to change context mid-session without risk: `clientContent` turns
     * are for seeding history (3.x may close the socket with 1007) and a `realtimeInput.text` would trigger a reply. So the update is HELD
     * and rides along with the next typed turn or tool result; a spoken question without tool call is answered from the start instructions
     * plus the explainer_context tool (the session's page follows the click).
     */
    updatePage: (text) => { pagePending = text; return 'held'; },
    interrupt() { watchdog.clear(); }, // new input interrupts the model; the session drops stale audio itself
    /** The early illustrator's facts for the current question: handed over with the next tool result (a separate turn would interrupt). */
    addContext: (text, { exact = false } = {}) => {
      if (delivered) return 'late';
      context = String(text ?? '').slice(0, 4000) || null;
      if (!context) return 'none';
      if (!exact || openCalls > 0) return 'held'; // they ride along with the next tool result
      delivered = true;
      selfInterrupt = Date.now();
      send({ realtimeInput: { text: `${FACTS_LEAD}\n${context}` } });
      context = null;
      watchdog.arm();
      return 'sent';
    },
    newTurn: () => { context = null; delivered = false; openCalls = 0; watchdog.clear(); },
    /** True once this question's facts went out (the session then allows one more research tool). */
    factsDelivered: () => delivered,
    sendToolResult: (id, name, output) => {
      const idle = nonBlocking.has(name);
      if (!idle) openCalls = Math.max(0, openCalls - 1);
      // like GPT-Live: the facts are part of the result text itself (live r12: a separate "desk_fakten" field was ignored, "keine Information")
      let result = !idle && context ? `${output}\n\n=== DESK-FAKTEN zur aktuellen Frage (schon gelesen) ===\n${FACTS_HINT}\n${context}` : output;
      if (result !== output) { context = null; delivered = true; }
      if (pagePending && !idle) { result += `\n\n=== SEITEN-UPDATE ===\n${pagePending}`; pagePending = null; }
      send({ toolResponse: { functionResponses: [{ id, name, response: { result, hinweis: LANGUAGE_HINT, ...(idle ? { scheduling: 'WHEN_IDLE' } : {}) } }] } });
      if (!idle) watchdog.arm();
    },
    close: () => { watchdog.clear(); ws.close(); },
  };
}
