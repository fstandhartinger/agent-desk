import { companionMuted } from './companion';
import { createStore } from './store';
import { focusedCanvasId, watchFocusedCanvas } from '../canvas/bus';
import type { ClaudeProposalEvent, HandoffEvent, PageContext, ToolEvent, VizSpec, VoiceServerMsg } from './types';
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
  onTranscript(role: 'user' | 'assistant', text: string, final: boolean, isDelta: boolean, typed?: boolean): void;
  onTool(t: ToolEvent): void;
  onViz(spec: VizSpec): void;
  onHandoff(h: HandoffEvent): void;
  onClaudeProposal(p: ClaudeProposalEvent): void;
  onFallback(provider: string, message: string): void;
  onError(message: string): void;
  onUsage(seconds: number, costUsd: number): void;
}

/** `option` is the user's picker choice and never changes by itself; `active` is the provider of the running session. */
export const voiceStore = createStore<{ state: VoiceState; option: string; active: string; model: string | null; error: string | null; notice: string | null }>({ state: 'idle', option: 'xai', active: 'xai', model: null, error: null, notice: null });

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
  private ready = false;
  private closed = false;
  private decay = 0;
  private readyTimer = 0;
  private unwatchFocus: (() => void) | null = null;

  constructor(private opt: VoiceOption, private page: PageContext | undefined, private h: VoiceHandlers) {}

  private set(state: VoiceState, model?: string) {
    voiceStore.set((s) => ({ ...s, state, active: this.opt.key, model: model ?? s.model, error: state === 'error' ? s.error : null }));
  }

  async start() {
    this.set('connecting', '');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
    } catch {
      this.fail('Kein Mikrofonzugriff – bitte im Browser erlauben.');
      return;
    }
    if (this.closed) return this.cleanup();
    await this.setupAudio();
    if (this.closed) return this.cleanup();
    this.connect();
  }

  private async setupAudio() {
    try {
      this.ctx = new AudioContext({ sampleRate: 24000, latencyHint: 'interactive' });
      this.ctx.createMediaStreamSource(this.stream!); // throws on engines that cannot mix rates
    } catch {
      await this.ctx?.close().catch(() => {});
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    const ctx = this.ctx;
    await Promise.all([ctx.audioWorklet.addModule('/worklets/mic-capture.js'), ctx.audioWorklet.addModule('/worklets/pcm-player.js')]);
    const src = ctx.createMediaStreamSource(this.stream!);
    this.mic = new AudioWorkletNode(ctx, 'mic-capture', { processorOptions: { targetRate: 24000 } });
    this.mic.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      levels.mic = Math.min(1, e.data.rms * 4);
      if (!companionMuted() && this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data.pcm);
    };
    src.connect(this.mic);
    this.player = new AudioWorkletNode(ctx, 'pcm-player', { outputChannelCount: [1], processorOptions: { sourceRate: 24000 } });
    this.player.port.onmessage = (e: MessageEvent<{ rms: number; buffered: number }>) => {
      levels.speaker = Math.min(1, e.data.rms * 3.5);
      const st = voiceStore.get().state;
      if (e.data.buffered > 0.02) {
        this.decay = 0;
        if (st !== 'speaking') this.set('speaking');
      } else if (st === 'speaking' && ++this.decay > 9) this.set('listening'); // ~300 ms of silence
    };
    this.player.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams({ provider: this.opt.provider });
    if (this.opt.variant) q.set('variant', this.opt.variant);
    const ws = new WebSocket(`${proto}//${location.host}/api/voice?${q}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.readyTimer = window.setTimeout(() => !this.ready && !this.closed && this.fail(`${this.opt.label} antwortet nicht.`), READY_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', page: this.page, lang: 'de', focusedCanvasId: focusedCanvasId(), ...(this.opt.variant ? { variant: this.opt.variant } : {}) }));
      // round 11: "zeichne das" means the canvas on the stage; the gateway learns every change of it
      this.unwatchFocus?.();
      this.unwatchFocus = watchFocusedCanvas((id) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'focus', focusedCanvasId: id })); });
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        this.player?.port.postMessage(e.data, [e.data]);
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
      if (!this.ready && !this.closed) this.fail('Sprachverbindung fehlgeschlagen.');
    };
    ws.onclose = () => this.onGone();
  }

  private handle(m: VoiceServerMsg) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.set('listening', m.model);
        break;
      case 'transcript': {
        const text = m.delta ?? m.text ?? '';
        this.h.onTranscript(m.role, text, m.final, m.delta !== undefined, (m as VoiceServerMsg & { typed?: boolean }).typed);
        if (m.role === 'user' && m.final) this.set('thinking');
        break;
      }
      case 'speech_started':
        this.player?.port.postMessage('flush');
        levels.speaker = 0;
        this.set('listening');
        break;
      case 'tool':
        this.h.onTool(m);
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
      case 'usage':
        this.h.onUsage(m.seconds, m.costUsd);
        break;
      case 'error':
        if (m.fallback) {
          this.closed = true;
          this.cleanup();
          this.h.onFallback(m.fallback, m.message);
        } else this.fail(m.message);
        break;
      case 'closed':
        this.onGone();
        break;
    }
  }

  /** The relay or vendor ended the session without an `error` message first. */
  private onGone() {
    if (this.closed) return;
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

  sendText(text: string) {
    this.ws?.send(JSON.stringify({ type: 'text', text, focusedCanvasId: focusedCanvasId() }));
  }

  interrupt() {
    this.player?.port.postMessage('flush');
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
    this.ready = false;
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    levels.mic = levels.speaker = 0;
  }
}
