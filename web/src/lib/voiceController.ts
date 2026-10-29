import { VoiceSession, optionByKey, voiceStore, type VoiceOption } from './voice';
import { addMessage, appendText, finish, setText, upsertClaudeProposal, upsertHandoff, upsertTool } from './conversation';
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

function closeTurn(role: 'user' | 'assistant') {
  const id = open[role];
  if (id) finish(id);
  open[role] = null;
}

export function receiveVoiceTranscript(role: 'user' | 'assistant', text: string, final: boolean, isDelta: boolean, typed = false) {
  closeTurn(role === 'user' ? 'assistant' : 'user');
  let id = open[role];
  if (!id) {
    if (!text.trim() && !final) return;
    id = open[role] = addMessage(role, typed ? 'typed' : 'voice', '', role === 'user' ? { status: 'streaming' } : {});
  }
  if (isDelta) appendText(id, text);
  else if (text) setText(id, text);
  if (final) {
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
function begin(opt: VoiceOption, viaFallback?: VoiceOption) {
  session?.stop();
  logActivity('voice', 'Sprachsitzung startet', opt.label, 'violet');
  const s = new VoiceSession(opt, currentContext(), {
    onTranscript: receiveVoiceTranscript,
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
    onViz: noteViz,
    onUsage(seconds, cost) {
      logActivity('voice', 'Sprachnutzung', `${Math.round(seconds)} s · ${fmtUsd(cost)}`);
    },
    onFallback(provider, message) {
      const next = optionByKey(provider);
      const picked = viaFallback ?? opt;
      toast(`${opt.label} nicht verfügbar – wechsle zu ${next.label}.`, 'info');
      logActivity('voice', 'Fallback', `${opt.label} → ${next.label}: ${message}`, 'amber');
      session = null;
      begin(next, picked);
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
  });
  session = s;
  void s.start();
}

export function stopVoice() {
  session?.stop();
  session = null;
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
export function sendVoiceText(text: string) {
  if (!session) return false;
  closeTurn('user');
  session.sendText(text);
  return true;
}
