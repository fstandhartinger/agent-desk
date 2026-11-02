/** Mic mute at the device edge: while muted no PCM frame is handed to the socket, the capture track is disabled and local barge-in is blocked. */
export class MuteGate {
  muted = false;
  dropped = 0;
  constructor(private tracks: () => { enabled: boolean }[], private onChange: (muted: boolean, source: string) => void) {}

  /** Idempotent; returns whether the state changed. */
  set(on: boolean, source = 'dock'): boolean {
    if (on === this.muted) return false;
    this.muted = on;
    this.applyTracks();
    this.onChange(on, source);
    return true;
  }

  /** Re-assert after a device or permission change: a new track must not start live while muted. */
  applyTracks() {
    for (const t of this.tracks()) t.enabled = !this.muted;
  }

  /** The single gate every captured frame passes. */
  frame(pcm: ArrayBuffer, canSend: boolean, send: (pcm: ArrayBuffer) => void): boolean {
    if (this.muted) { this.dropped++; return false; }
    if (!canSend) return false;
    send(pcm);
    return true;
  }

  allowBargeIn() { return !this.muted; }
  reset() { this.muted = false; this.dropped = 0; }
}
