import { companionMuted, nativeHost } from './companion';
import { ACTIVITY_LINGER_MS, isActivity, nextActivity, type ActivityLine } from './liveActivity';
import { forwardActivity } from '../canvas/nativeNotify';
import { MuteGate } from './muteGate';
import { matchMic, micPreference, sameMic } from './micChoice';
import { SpeechOnset } from './speechOnset';
import { createStore } from './store';
import { SpeechTracker } from './speechCursor';
import { drainClientErrors } from './clientError';
import { focusedCanvasId, watchFocusedCanvas } from '../canvas/bus';
import type { ActivityEvent, ClaudeProposalEvent, HandoffEvent, MainAgentPromptEvent, PageContext, ToolEvent, VizSpec, VoiceServerMsg } from './types';
import type { ProviderId } from './status';

export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface VoiceOption { key: string; provider: ProviderId; variant?: 'fast'; label: string; hint: string }
export const VOICE_OPTIONS: VoiceOption[] = [
  { key: 'xai', provider: 'xai', label: 'Grok Voice 3.0', hint: 'Standard · schnell, natürlich' },
  { key: 'openai', provider: 'openai', label: 'GPT-Live-1', hint: 'Delegiert an GPT-6 Astra' },
  { key: 'gemini', provider: 'gemini', label: 'Gemini 3.8 Live', hint: 'Extended Thinking' },
  { key: 'gemini-fast', provider: 'gemini', variant: 'fast', label: 'Gemini 3.8 Live fast', hint: 'Ohne Denkpause' },
];
export const optionByKey = (k: string) => VOICE_OPTIONS.find((o) => o.key === k) ?? VOICE_OPTIONS[0];

export interface VoiceHandlers {
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean, isDelta: boolean, typed?: boolean, replace?: boolean, flags?: { quiet?: boolean; context?: boolean }): void;
  onTool(t: ToolEvent): void;
  onViz(spec: VizSpec): void;
  onHandoff(h: HandoffEvent): void;
  onClaudeProposal(p: ClaudeProposalEvent): void;
  onMainAgentPrompt?(p: MainAgentPromptEvent): void;
  onFallback(provider: string, message: string, muted: boolean): void;
  onError(message: string): void;
  onUsage(seconds: number, costUsd: number, dayUsd?: number): void;
  /** His speech started: the gateway's `speech_started` or the local mic onset (a#41d6d2: the history showed nothing while he talked). */
  onSpeechStart?(): void;
  /** The mic is still voiced. */
  onSpeechActive?(): void;
  onNotice?(message: string): void;
  /** The conversation this session belongs to (voice memory): sent with `start`. */
  conversation?(): { id: string; turns: { role: 'user' | 'assistant'; content: string; ts: number }[]; memory?: { summary: string; upto: number } };
  /** The gateway's running summary of the conversation. */
  onMemory?(conversationId: string, summary: string, upto: number): void;
  /** The session reached its time cap and ends now; the controller starts the next one in the same conversation. */
  onRollover?(message?: string, wasMuted?: boolean): void;
}

/** Last `usage` tick of the gateway (every 10 s): this session's cost (USD) and today's whole Desk spend. */
export interface VoiceUsage { seconds: number; costUsd: number; dayUsd?: number }

/** `option` is the user's picker choice and never changes by itself; `active` is the provider of the running session. */
export const voiceStore = createStore<{ state: VoiceState; option: string; active: string; model: string | null; error: string | null; notice: string | null; muted: boolean; aid: string | null; serverNotice: string | null; activity: ActivityLine | null; readyAt: number | null; usage: VoiceUsage | null }>({ state: 'idle', option: 'xai', active: 'xai', model: null, error: null, notice: null, muted: false, aid: null, serverNotice: null, activity: null, readyAt: null, usage: null });

/** Mic/speaker RMS (0..1). Read at animation rate, never pushed through React state. */
export const levels = { mic: 0, speaker: 0 };

const READY_TIMEOUT_MS = 15_000;
const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

/**
 * Realtime voice session: mic -> AudioWorklet -> PCM16/24 kHz/20 ms frames -> WS /api/voice;
 * assistant PCM -> ring-buffer worklet. All vendor traffic is relayed by the gateway.
 */
export class VoiceSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private player: AudioWorkletNode | null = null;
  private mic: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  /** A mic switch asked for while the session was still opening its microphone: done once the audio graph stands. */
  private micDirty = false;
  private switching: Promise<boolean> | null = null;
  private ready = false;
  private startMessage: (() => unknown) | null = null;
  private earlyAudio: ArrayBuffer[] = [];
  private earlyMic: ArrayBuffer[] = [];
  private localVoice: SpeechSynthesisVoice | undefined;
  private openingModule: Promise<typeof import('./cardOpening') | null> | undefined;
  private stopOpening: (() => void) | null = null;
  private closed = false;
  private decay = 0;
  private onset = new SpeechOnset();
  private readyTimer = 0;
  /** Set by the gateway's `rollover` (time cap): the close that follows is no error. */
  private rollover: string | null = null;
  private unwatchFocus: (() => void) | null = null;
  /** Where the spoken answer is (canvas reveal, see speechCursor.ts). */
  private cursor = new SpeechTracker();
  private pending: { ts: number; type: string; data: unknown }[] = [];
  private offDevice: (() => void) | null = null;
  private gate = new MuteGate(() => this.stream?.getAudioTracks() ?? [], (muted, source) => {
    voiceStore.set((s) => ({ ...s, muted }));
    levels.mic = 0;
    this.sendJson({ type: 'mute', muted, source });
    this.event(muted ? 'mute' : 'unmute', { source });
  });

  constructor(private opt: VoiceOption, private page: PageContext | undefined, private h: VoiceHandlers, private startMuted = false, private startupCard?: string) {}

  get wasReady() { return this.reachedReady; }
  private reachedReady = false;

  private set(state: VoiceState, model?: string) {
    voiceStore.set((s) => ({ ...s, state, active: this.opt.key, model: model ?? s.model, error: state === 'error' ? s.error : null, activity: state === 'idle' ? null : s.activity }));
  }

  async start() {
    this.gate.reset();
    this.gate.muted = this.startMuted;
    voiceStore.set((s) => ({ ...s, muted: this.startMuted, aid: null, serverNotice: null, activity: null, readyAt: null, usage: null }));
    this.set('connecting', '');
    const startMessage = import('./voiceStart').then(m => m.prepareVoiceStart(this.opt, this.page, this.startupCard)).catch(() => {
      if (!this.closed) this.fail('Sprachsitzung konnte nicht geladen werden. Bitte erneut versuchen.');
      return null;
    });
    if (this.startupCard) {
      this.localVoice = globalThis.speechSynthesis?.getVoices().find(voice => voice.localService && /^de(?:-|$)/i.test(voice.lang));
      if (this.localVoice) this.openingModule = import('./cardOpening').catch(() => null);
      this.connect(startMessage);
    } else {
      this.startMessage = await startMessage;
      if (this.closed || !this.startMessage) return;
    }
    try {
      this.stream = await this.openMic();
      this.gate.applyTracks();
      this.event('mic.permission', { state: 'granted' });
    } catch (err) {
      this.event('mic.permission', { state: 'denied', name: (err as Error)?.name ?? 'Error' });
      this.fail('Kein Mikrofonzugriff – bitte im Browser erlauben.');
      return;
    }
    if (this.closed) return this.cleanup();
    try { await this.setupAudio(); }
    catch { this.fail('Audio konnte nicht gestartet werden. Bitte erneut versuchen.'); return; }
    if (this.closed) return this.cleanup();
    for (const pcm of this.earlyAudio.splice(0)) this.play(pcm);
    if (!this.startupCard) this.connect();
  }

  private async setupAudio() {
    try {
      this.ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
      this.ctx.createMediaStreamSource(this.stream!); // throws on engines that cannot mix rates
    } catch {
      await this.ctx?.close().catch(() => /* ignored */ {});
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    const ctx = this.ctx;
    ctx.onstatechange = () => this.event('audio.ctx_state', { state: ctx.state });
    this.watchDevices();
    await Promise.all([ctx.audioWorklet.addModule('/worklets/mic-capture.js'), ctx.audioWorklet.addModule('/worklets/pcm-player.js')]);
    const src = ctx.createMediaStreamSource(this.stream!);
    this.src = src;
    this.mic = new AudioWorkletNode(ctx, 'mic-capture', { processorOptions: { targetRate: 24000 } });
    this.mic.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      levels.mic = this.gate.muted ? 0 : Math.min(1, e.data.rms * 4);
      this.watchOnset();
      const ws = this.ws;
      if (this.stopOpening) return; // isolated local speaker output never goes to the vendor as user speech
      if (!this.ready && this.startupCard && !this.gate.muted && !companionMuted()) {
        this.earlyMic.push(e.data.pcm);
        if (this.earlyMic.length > 100) this.earlyMic.shift(); // two seconds, only until the provider gets ready
      }
      this.gate.frame(e.data.pcm, !companionMuted() && this.ready && ws?.readyState === WebSocket.OPEN, (pcm) => ws!.send(pcm));
    };
    src.connect(this.mic);
    if (this.micDirty) { this.micDirty = false; void this.switchMic(); }
    this.player = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [1], processorOptions: { sourceRate: 24000 } });
    this.player.port.onmessage = (e: MessageEvent<{ rms: number; buffered: number }>) => {
      levels.speaker = Math.min(1, e.data.rms * 3.5);
      this.cursor.player(e.data.buffered);
      const st = voiceStore.get().state;
      if (e.data.buffered > 0.02) {
        this.decay = 0;
        if (st !== 'speaking') this.set('speaking');
      } else if (st === 'speaking' && ++this.decay > 9) this.set('listening'); // ~300 ms of silence
    };
    this.player.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private connect(startMessage?: Promise<(() => unknown) | null>) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ provider: this.opt.provider });
    if (this.opt.variant) q.set('variant', this.opt.variant);
    const ws = new WebSocket(`${proto}//${location.host}/api/voice?${q}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.readyTimer = window.setTimeout(() => !this.ready && !this.closed && this.fail(`${this.opt.label} antwortet nicht.`), READY_TIMEOUT_MS);
    const sendStart = (message: (() => unknown) | null) => {
      if (!message || this.closed || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ ...(message() as object), ...(this.localVoice ? { localCardOpening: true } : {}), ...(this.h.conversation ? { conversation: this.h.conversation() } : {}) }));
      // round 11: "zeichne das" means the canvas on the stage; the gateway learns every change of it
      this.event('ws.open', {});
      this.flushEvents();
      this.unwatchFocus?.();
      this.unwatchFocus = watchFocusedCanvas((id) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'focus', focusedCanvasId: id })); });
    };
    ws.onopen = () => {
      if (startMessage) void startMessage.then(sendStart);
      else sendStart(this.startMessage);
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (this.player) this.play(e.data);
        else if (this.earlyAudio.length < 100) this.earlyAudio.push(e.data);
        return;
      }
      let m: VoiceServerMsg;
      try {
        m = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onerror = () => {
      this.event('ws.error', {});
      if (!this.ready && !this.closed) this.fail('Sprachverbindung fehlgeschlagen.');
    };
    ws.onclose = (e) => { this.event('ws.close', { code: e.code }); this.onGone(); };
  }

  private play(pcm: ArrayBuffer) {
    this.cursor.audio(pcm.byteLength);
    this.player?.port.postMessage(pcm, [pcm]);
  }

  private async speakOpening(text: string) {
    const deadline = performance.now() + 250;
    const speech = await this.openingModule;
    if (this.closed) return;
    if (!speech || !this.localVoice || !text || this.stopOpening || performance.now() > deadline) {
      this.sendJson({ type: 'card_opening_result', playing: false });
      return;
    }
    this.earlyMic = [];
    this.stopOpening = speech.speakCardOpening(this.localVoice, text, () => {
      this.sendJson({ type: 'card_opening_result', playing: true });
      this.event('card.opening.audio', { local: true });
      this.set('speaking');
      this.h.onTranscript('assistant', text, true, false, false, false, { quiet: true });
    }, (played) => {
      this.stopOpening = null;
      if (this.closed) return;
      if (!played) this.sendJson({ type: 'card_opening_result', playing: false });
      else {
        this.sendJson({ type: 'card_opening_end' });
        this.set(this.ready ? 'listening' : 'connecting');
      }
    });
  }

  private handle(m: VoiceServerMsg) {
    switch (m.type) {
      case 'card_opening':
        void this.speakOpening(m.text);
        break;
      case 'ready':
        this.reachedReady = true;
        this.ready = true;
        this.cursor.start();
        voiceStore.set((s) => ({ ...s, readyAt: Date.now() })); // the session timer in the dock runs from here, like the billing clock
        this.set(this.stopOpening ? voiceStore.get().state : 'listening', m.model);
        const frames = this.earlyMic.splice(0);
        if (!this.stopOpening && !this.gate.muted && !companionMuted() && this.ws?.readyState === WebSocket.OPEN) {
          for (const frame of frames) this.ws.send(frame);
        }
        if (this.gate.muted) this.sendJson({ type: 'mute', muted: true, source: 'dock' });
        break;
      case 'session':
        voiceStore.set((s) => ({ ...s, aid: typeof m.aid === 'string' ? m.aid.replace(/^a#/i, '').toLowerCase() : null }));
        break;
      case 'memory':
        if (typeof m.summary === 'string' && typeof m.conversationId === 'string') this.h.onMemory?.(m.conversationId, m.summary, m.upto);
        break;
      case 'rollover':
        this.rollover = m.message ?? 'Neue Sitzung im selben Gespräch …';
        break;
      case 'notice':
        voiceStore.set((s) => ({ ...s, serverNotice: m.message }));
        this.h.onNotice?.(m.message);
        break;
      case 'mute':
        break;
      case 'transcript': {
        const text = m.delta ?? m.text ?? '';
        this.h.onTranscript(m.role, text, m.final, m.delta !== undefined, m.typed, m.replace, { quiet: m.quiet, context: m.context });
        if (m.role === 'assistant') this.cursor.transcript(text, m.final, m.delta !== undefined);
        if (m.role === 'user' && m.final) { this.cursor.reset(); this.set('thinking'); } // a new user turn: the earlier answer is over
        break;
      }
      case 'speech_started':
        this.h.onSpeechStart?.(); // the placeholder shows even when barge-in is blocked (muted: the controller ignores it)
        if (!this.gate.allowBargeIn()) break;
        this.player?.port.postMessage('flush');
        this.cursor.reset();
        levels.speaker = 0;
        this.set('listening');
        break;
      case 'tool':
        this.h.onTool(m);
        break;
      case 'activity':
        if (isActivity(m)) this.showActivity(m);
        break;
      case 'viz':
        this.h.onViz(m.spec);
        break;
      case 'handoff':
        this.h.onHandoff(m);
        break;
      case 'claude_proposal':
        this.h.onClaudeProposal(m);
        break;
      case 'main_agent_prompt':
        this.h.onMainAgentPrompt?.(m);
        break;
      case 'usage':
        voiceStore.set((s) => ({ ...s, usage: { seconds: m.seconds, costUsd: m.costUsd, ...(typeof m.dayUsd === 'number' ? { dayUsd: m.dayUsd } : {}) } }));
        this.h.onUsage(m.seconds, m.costUsd, m.dayUsd);
        break;
      case 'error':
        if (m.fallback) {
          this.closed = true;
          const wasMuted = this.gate.muted; // a provider change must not open the mic he closed
          this.cleanup();
          this.h.onFallback(m.fallback, m.message, wasMuted);
        } else this.fail(m.message);
        break;
      case 'closed':
        this.onGone();
        break;
    }
  }

  /**
   * Local speech onset from the mic level: the bubble "Du sprichst …" appears before the vendor's VAD answers (GPT-Live has no speech-start event).
   * Not while the assistant's own voice plays (its echo is no speech of his), not muted, not before the session is ready.
   */
  private watchOnset() {
    const st = voiceStore.get().state;
    if (this.gate.muted || companionMuted() || !this.ready || st === 'speaking' || st === 'connecting') { this.onset.reset(); return; }
    const o = this.onset.feed(levels.mic);
    if (o === 'onset') this.h.onSpeechStart?.();
    else if (o === 'active') this.h.onSpeechActive?.();
  }

  /** The newest activity line in the dock (finished ones fade after a few seconds) and the same event to the native host. */
  private showActivity(e: ActivityEvent) {
    forwardActivity(nativeHost, e);
    voiceStore.set((s) => ({ ...s, activity: nextActivity(s.activity, e) }));
    if (e.phase === 'done' || e.phase === 'fail' || e.phase === 'heard') {
      setTimeout(() => voiceStore.set((s) => (s.activity?.id === e.id && s.activity.phase === e.phase ? { ...s, activity: null } : s)), ACTIVITY_LINGER_MS);
    }
  }

  /** The relay or vendor ended the session without an `error` message first. */
  private onGone() {
    if (this.closed) return;
    if (this.rollover !== null) { // the time cap: no error, the controller continues in a new session of the same conversation
      const message = this.rollover, wasMuted = this.gate.muted; // a new session must not open the mic he closed
      this.stop(false);
      this.h.onRollover?.(message, wasMuted);
      return;
    }
    if (!this.ready) this.fail(`${this.opt.label}: Verbindung beendet, bevor die Sitzung bereit war.`);
    else {
      this.h.onError('Sprachverbindung getrennt.');
      this.stop(false);
    }
  }

  /** Florian clicked another element (or another scene) during the session: the gateway re-reads the page server-side. */
  updatePage(page: PageContext | undefined) {
    if (!page || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'page', page: { slug: page.slug, t: page.t, sceneId: page.sceneId, pointId: page.pointId } }));
  }

  /** `suggestion`: the text came from a link, not from him; it must not count as his own words for the voice action tools. */
  sendText(text: string, suggestion = false) {
    this.ws?.send(JSON.stringify({ type: 'text', text, focusedCanvasId: focusedCanvasId(), ...(suggestion ? { source: 'suggestion' } : {}) }));
  }

  /**
   * The chosen microphone (micChoice.ts), else the system default. A chosen device that is gone or busy falls back to
   * the default: a session never fails because of the picker.
   */
  private async openMic(): Promise<MediaStream> {
    const pref = micPreference();
    if (pref) {
      try {
        const id = matchMic(await navigator.mediaDevices.enumerateDevices(), pref);
        if (id) return await navigator.mediaDevices.getUserMedia({ audio: { ...MIC, deviceId: { exact: id } } });
        this.event('mic.device', { found: false });
      } catch (err) {
        this.event('mic.device', { found: true, error: (err as Error)?.name ?? 'Error' });
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: MIC });
  }

  /** Label of the microphone the session hears right now (null: none open). */
  get micLabel(): string | null { return this.stream?.getAudioTracks()[0]?.label ?? null; }

  /**
   * Re-open the microphone after the choice changed, in the running session: same socket, same context, same mute
   * state. The new source is wired in before the old tracks stop, so no frame is lost beyond the switch itself.
   */
  switchMic(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (!this.ctx || !this.mic || !this.stream) { this.micDirty = true; return Promise.resolve(true); }
    if (sameMic(this.micLabel, micPreference()) && micPreference()) return Promise.resolve(true);
    const run = async () => {
      let next: MediaStream;
      try { next = await this.openMic(); } catch (err) { this.event('mic.switch', { ok: false, error: (err as Error)?.name ?? 'Error' }); return false; }
      if (this.closed || !this.ctx || !this.mic) { next.getTracks().forEach((t) => t.stop()); return false; }
      const old = this.stream, oldSrc = this.src;
      this.stream = next;
      this.gate.applyTracks(); // a muted session stays muted on the new device
      const src = this.ctx.createMediaStreamSource(next);
      src.connect(this.mic);
      this.src = src;
      try { oldSrc?.disconnect(); } catch { /* already gone */ }
      old?.getTracks().forEach((t) => t.stop());
      this.event('mic.switch', { ok: true, chosen: Boolean(micPreference()) });
      return true;
    };
    const p = (this.switching ?? Promise.resolve(true)).then(run, run).finally(() => { if (this.switching === p) this.switching = null; });
    this.switching = p;
    return p;
  }

  get muted() { return this.gate.muted; }
  setMuted(on: boolean, source: 'dock' | 'hotkey' = 'dock') { return this.gate.set(on, source); }

  private sendJson(o: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  /** Client-side diagnostics for the session trace: type + small data only, never audio or text. Queued until the socket is open. */
  event(type: string, data: unknown) {
    const e = { ts: Date.now(), type, data };
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'client_event', event: e }));
    else if (this.pending.length < 50) this.pending.push(e);
  }

  /** True when the event went out on an open socket (it is not queued: the caller keeps it otherwise). */
  eventNow(type: string, data: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'client_event', event: { ts: Date.now(), type, data } }));
    return true;
  }

  private flushEvents() {
    for (const { ts, data } of drainClientErrors()) this.sendJson({ type: 'client_event', event: { ts, type: 'error', data } });
    for (const event of this.pending.splice(0)) this.sendJson({ type: 'client_event', event });
  }

  private watchDevices() {
    const md = navigator.mediaDevices;
    const onChange = () => { this.gate.applyTracks(); this.event('audio.devicechange', {}); };
    md?.addEventListener?.('devicechange', onChange);
    let perm: PermissionStatus | null = null;
    const onPerm = () => { this.gate.applyTracks(); this.event('mic.permission', { state: perm?.state }); };
    navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((p) => { perm = p; p.addEventListener('change', onPerm); }, () => {});
    this.offDevice = () => { md?.removeEventListener?.('devicechange', onChange); perm?.removeEventListener('change', onPerm); };
  }

  interrupt() {
    this.stopOpening?.();
    this.player?.port.postMessage('flush');
    this.cursor.reset();
    levels.speaker = 0;
    this.ws?.send(JSON.stringify({ type: 'interrupt' }));
    this.set('listening');
  }

  stop(notify = true) {
    if (this.closed && !this.ws && !this.ctx) return;
    this.closed = true;
    if (notify && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'stop' }));
    this.cleanup();
    this.set('idle');
  }

  private fail(message: string) {
    this.closed = true;
    this.cleanup();
    voiceStore.set((s) => ({ ...s, state: 'error', active: this.opt.key, error: message }));
    this.h.onError(message);
  }

  private cleanup() {
    this.stopOpening?.();
    this.earlyAudio = [];
    this.earlyMic = [];
    this.ready = false;
    this.cursor.stop();
    this.gate.reset();
    voiceStore.set((s) => ({ ...s, muted: false }));
    this.offDevice?.();
    this.offDevice = null;
    this.unwatchFocus?.();
    this.unwatchFocus = null;
    clearTimeout(this.readyTimer);
    if (this.ws) {
      this.ws.onclose = this.ws.onmessage = this.ws.onerror = null;
      if (this.ws.readyState <= WebSocket.OPEN) this.ws.close();
      this.ws = null;
    }
    this.mic?.port.close();
    this.player?.port.close();
    this.mic = this.player = null;
    try { this.src?.disconnect(); } catch { /* already gone */ }
    this.src = null;
    this.micDirty = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => /* ignored */ {});
    this.ctx = null;
    levels.mic = levels.speaker = 0;
  }
}
