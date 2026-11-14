import { setClientErrorSink } from './clientError';
import { VoiceSession, optionByKey, voiceStore, type VoiceOption } from './voice';
import { addMessage, appendText, convStore, finish, removeMessage, setSpeaking, setText, textOf, upsertClaudeProposal, upsertHandoff, upsertMainAgentPrompt, upsertTool } from './conversation';
import { logActivity, noteTool, noteViz } from './activity';
import { currentContext, pageStore } from './page';
import { toast } from './toast';
import { save, load } from './storage';
import { fmtUsd } from './format';
import { statusStore } from './status';
import { chooseVoice, voiceUnavailableNotice } from './voiceChoice';

// Glue between a VoiceSession and the shared thread/activity/live stores.
const PREF_KEY = 'desk.voiceOption.v1';
voiceStore.set((s) => ({ ...s, option: load(PREF_KEY, 'xai') }));

let session: VoiceSession | null = null;

// A click on another element during a running voice session updates the agent's page context (gateway: {type:'page'}).
let lastPoint: string | null = pageStore.get().attached ? pageStore.get().pointId : null;
pageStore.subscribe(() => {
  const { pointId, attached } = pageStore.get();
  const now = attached ? pointId : null;
  if (now === lastPoint) return;
  lastPoint = now;
  if (now) session?.updatePage(currentContext());
});
const open: { user: string | null; assistant: string | null } = { user: null, assistant: null };
let lastUser: string | null = null; // the finished user message, so a grown fragment (`replace`) can overwrite it in place

/** How long an empty "Du sprichst …" bubble waits after the last sign of speech before it disappears (noise, breath, a barge-in that came to nothing). */
export const SPEAKING_TIMEOUT_MS = 5000;
let speakTimer: ReturnType<typeof setTimeout> | undefined;

const messageOf = (id: string | null) => (id ? convStore.get().messages.find((m) => m.id === id) : undefined);
/** The open user bubble when it is only the "he is speaking" placeholder (no text yet). */
const emptyPlaceholder = () => {
  const m = messageOf(open.user);
  return m && m.speaking && !textOf(m).trim() ? m : undefined;
};

function clearSpeakTimer() {
  clearTimeout(speakTimer);
  speakTimer = undefined;
}

/** Drops the open placeholder when it is still empty; a bubble that already shows partial text stays. */
function dropPlaceholder() {
  clearSpeakTimer();
  const m = emptyPlaceholder();
  if (!m) return;
  removeMessage(m.id);
  open.user = null;
}

function armSpeakTimer() {
  clearSpeakTimer();
  speakTimer = setTimeout(() => {
    speakTimer = undefined;
    if (emptyPlaceholder()) dropPlaceholder();
    else if (open.user) setSpeaking(open.user, false); // partial text without a final: stop the pulse, keep the words
  }, SPEAKING_TIMEOUT_MS);
}

/** His speech started (server `speech_started` or the local mic onset): a user bubble "Du sprichst …" at the end of the history. */
export function voiceSpeechStarted() {
  if (voiceStore.get().muted) return; // nothing he says is heard while muted
  const id = open.user;
  if (id && messageOf(id)) {
    setSpeaking(id, true); // still the same utterance (partials arrived first, or a second signal): just keep it alive
    armSpeakTimer();
    return;
  }
  closeTurn('assistant'); // an answer that was still streaming ends here; its late deltas open a new message AFTER this bubble
  open.user = addMessage('user', 'voice', '', { status: 'streaming', speaking: true });
  armSpeakTimer();
}

/** The mic is still voiced (local level): the placeholder stays. Never opens a bubble by itself. */
export function voiceSpeechActive() {
  if (open.user && messageOf(open.user)?.speaking && !voiceStore.get().muted) armSpeakTimer();
}

// Mute closes an empty placeholder at once.
let lastMuted = false;
voiceStore.subscribe(() => {
  const { muted } = voiceStore.get();
  if (muted && !lastMuted) dropPlaceholder();
  lastMuted = muted;
});

function closeTurn(role: 'user' | 'assistant') {
  const id = open[role];
  if (id) {
    const m = messageOf(id);
    if (role === 'user' && m && !textOf(m).trim() && !m.parts.length) { removeMessage(id); clearSpeakTimer(); } // never leave an empty user message behind
    else finish(id);
  }
  open[role] = null;
}

export function receiveVoiceTranscript(role: 'user' | 'assistant', text: string, final: boolean, isDelta: boolean, typed = false, replace = false) {
  if (typed || (replace && role === 'user' && final)) dropPlaceholder(); // typed text is not his speech; a grown fragment belongs to the earlier bubble
  if (replace && role === 'user' && final && lastUser && convStore.get().messages.some((m) => m.id === lastUser)) {
    // the gateway merged a growing fragment into the previous turn: same message, whole sentence
    setText(lastUser, text);
    return;
  }
  if (!(role === 'assistant' && emptyPlaceholder())) closeTurn(role === 'user' ? 'assistant' : 'user'); // the assistant's words go AFTER his empty bubble; it stays open for his transcript
  let id = open[role];
  const shown = messageOf(id);
  if (role === 'user' && final && !text.trim() && !(shown && textOf(shown).trim())) { // an empty transcript (noise): no bubble
    if (id) { removeMessage(id); open.user = null; }
    clearSpeakTimer();
    return;
  }
  if (!id) {
    if (!text.trim() && !final) return;
    id = open[role] = addMessage(role, typed ? 'typed' : 'voice', '', role === 'user' ? { status: 'streaming' } : {});
  }
  if (isDelta) appendText(id, text);
  else if (text) setText(id, text);
  if (role === 'user') {
    if (!final && text.trim()) { setSpeaking(id, true); armSpeakTimer(); } // live partial: the pulse stays until the final
    else if (final) clearSpeakTimer();
  }
  if (final) {
    if (role === 'user') lastUser = id;
    closeTurn(role);
    if (role === 'user') logActivity('voice', typed ? 'Getippt' : 'Gesprochen', text.slice(0, 120), 'violet');
  }
}

export function setVoiceOption(key: string) {
  save(PREF_KEY, key);
  voiceStore.set((s) => ({ ...s, option: key }));
}

/** Starts the user's choice, or the first usable option when the status shows that choice is down (no detour, no toast). */
export function startVoice() {
  const { run, picked } = chooseVoice(optionByKey(voiceStore.get().option), statusStore.get().providers);
  begin(run, picked);
  voiceStore.set((s) => ({ ...s, notice: picked ? voiceUnavailableNotice(picked, run) : null }));
}

/** Starts a session. `viaFallback` is the option the user actually picked when this is an automatic fallback. */
function begin(opt: VoiceOption, viaFallback?: VoiceOption, startMuted = false) {
  session?.stop();
  logActivity('voice', 'Sprachsitzung startet', opt.label, 'violet');
  const s = new VoiceSession(opt, currentContext(), {
    onTranscript: receiveVoiceTranscript,
    onSpeechStart: voiceSpeechStarted,
    onSpeechActive: voiceSpeechActive,
    onTool(t) {
      let id = open.assistant;
      if (!id) id = open.assistant = addMessage('assistant', 'voice');
      upsertTool(id, t);
      noteTool('voice', t);
    },
    onHandoff(h) {
      let id = open.assistant;
      if (!id) id = open.assistant = addMessage('assistant', 'voice');
      upsertHandoff(id, h);
      logActivity('voice', 'Übergabe vorgeschlagen', h.title, 'amber');
    },
    onClaudeProposal(p) {
      let id = open.assistant;
      if (!id) id = open.assistant = addMessage('assistant', 'voice');
      upsertClaudeProposal(id, p);
      logActivity('voice', 'Claude-Auftrag vorgeschlagen', p.title, 'violet');
    },
    onMainAgentPrompt(p) {
      let id = open.assistant;
      if (!id) id = open.assistant = addMessage('assistant', 'voice');
      if (upsertMainAgentPrompt(id, p)) logActivity('voice', 'Prompt für den Main Agent nicht eingetippt', undefined, 'amber');
    },
    onViz: noteViz,
    onNotice: (message) => toast(message, 'info', 8000),
    onUsage(seconds, cost) {
      logActivity('voice', 'Sprachnutzung', `${Math.round(seconds)} s · ${fmtUsd(cost)}`);
    },
    onFallback(provider, message, wasMuted) {
      const next = optionByKey(provider);
      const picked = viaFallback ?? opt;
      toast(`${opt.label} nicht verfügbar – wechsle zu ${next.label}.`, 'info');
      logActivity('voice', 'Fallback', `${opt.label} → ${next.label}: ${message}`, 'amber');
      session = null;
      dropPlaceholder(); // the new provider has not heard what the old one was listening to
      begin(next, picked, wasMuted);
      voiceStore.set((s) => ({ ...s, notice: voiceUnavailableNotice(picked, next) }));
    },
    onError(message) {
      // the picker keeps the user's choice, so a failed fallback leaves it where they put it
      const text = viaFallback ? `${message} (Ersatz für ${viaFallback.label})` : message;
      toast(text, 'error');
      logActivity('voice', 'Sprachfehler', text, 'red');
      closeTurn('user');
      closeTurn('assistant');
    },
  }, startMuted);
  session = s;
  setClientErrorSink((d) => s.eventNow('error', d));
  void s.start();
}

export function stopVoice() {
  session?.stop();
  session = null;
  setClientErrorSink(null);
  voiceStore.set((s) => ({ ...s, notice: null }));
  closeTurn('user');
  closeTurn('assistant');
  logActivity('voice', 'Sprachsitzung beendet');
}

export const toggleVoice = () => (session && voiceStore.get().state !== 'idle' && voiceStore.get().state !== 'error' ? stopVoice() : startVoice());
/** Closes the error state of the dock without retrying. */
export function dismissVoiceError() {
  session = null;
  voiceStore.set((s) => ({ ...s, state: 'idle', error: null, notice: null }));
}
export const interruptVoice = () => session?.interrupt();
export const voiceActive = () => Boolean(session) && !['idle', 'error'].includes(voiceStore.get().state);
/** Typed text goes into the live voice session when one is running. */
export function sendVoiceText(text: string, suggestion = false) {
  if (!session) return false;
  closeTurn('user');
  session.sendText(text, suggestion);
  return true;
}

export const voiceMuted = () => voiceStore.get().muted;
/** Mute the mic of the running session (no session = nothing to mute). Same session, same context; the model is told nothing. */
export function setVoiceMuted(on: boolean, source: 'dock' | 'hotkey' = 'dock') {
  if (!session || !voiceActive()) return false;
  session.setMuted(on, source);
  return true;
}
export const toggleVoiceMuted = (source: 'dock' | 'hotkey' = 'dock') => setVoiceMuted(!voiceMuted(), source);

// Screen Agent's global hotkey reaches the page through WebView2 (companion 'mute' message); this is the same switch for anything that can run script.
(window as Window & { __deskVoice?: unknown }).__deskVoice = { setMuted: (on: boolean) => setVoiceMuted(Boolean(on), 'hotkey'), toggleMuted: () => toggleVoiceMuted('hotkey'), muted: voiceMuted };
