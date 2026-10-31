export type NativeHost = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};
export const nativeHost = () => (window as Window & { chrome?: { webview?: NativeHost } }).chrome?.webview;
let muted = false;
export const companionMuted = () => muted;
export function setCompanionMuted(on: boolean) { muted = on; }

export type HostVoice = { start(provider?: string): void; stop(): void; state(): string };
export function voiceAck(host: Pick<NativeHost, 'postMessage'>, state: string) {
  host.postMessage({ type: 'voice-ack', on: !['idle', 'error'].includes(state), state });
}
export function handleNativeMessage(message: unknown, host: Pick<NativeHost, 'postMessage'>, showIds: (ids: string[]) => void, voice?: HostVoice) {
  if (!message || typeof message !== 'object') return;
  const msg = message as { type?: unknown; on?: unknown; ids?: unknown; provider?: unknown };
  if (msg.type === 'mute' && typeof msg.on === 'boolean') {
    setCompanionMuted(msg.on);
    host.postMessage({ type: 'mute-ack', on: msg.on });
  } else if (msg.type === 'voice' && typeof msg.on === 'boolean' && voice) {
    if (msg.provider !== undefined && (typeof msg.provider !== 'string' || !['xai', 'openai', 'gemini', 'gemini-fast'].includes(msg.provider))) return;
    if (msg.on) { setCompanionMuted(false); voice.start(msg.provider as string | undefined); }
    else { setCompanionMuted(true); voice.stop(); }
    voiceAck(host, voice.state());
  } else if (msg.type === 'screen' && Array.isArray(msg.ids)) {
    showIds([...new Set<string>(msg.ids.filter((id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{6}$/i.test(id)).slice(0, 20).map(id => id.toLowerCase()))]);
  }
}
