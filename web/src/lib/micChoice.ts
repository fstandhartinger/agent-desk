/**
 * The microphone he picked in the Screen Agent overlay (or tray). Stored by its Windows name, because the
 * Screen Agent lists devices through Windows and the browser's device ids are per-origin hashes.
 * null = the system default.
 */
const KEY = 'desk.micLabel';

export function micPreference(): string | null {
  try { const v = globalThis.localStorage?.getItem(KEY); return v && v.trim() ? v : null; } catch { return null; }
}

export function setMicPreference(label: string | null) {
  try {
    if (label && label.trim()) globalThis.localStorage?.setItem(KEY, label.trim().slice(0, 200));
    else globalThis.localStorage?.removeItem(KEY);
  } catch { /* private mode: the choice lasts for this page only */ }
}

export interface MicDevice { deviceId: string; label: string; kind: string }

/**
 * The browser device for a Windows device name. Chromium names inputs like Windows does, sometimes with a
 * USB id suffix ("Mikrofon (Brio) (046d:085e)"); its "default"/"communications" aliases carry a prefix and are skipped.
 */
export function matchMic(devices: MicDevice[], label: string | null): string | null {
  if (!label) return null;
  const want = label.trim().toLowerCase();
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const name = (d: MicDevice) => d.label.trim().toLowerCase();
  return (inputs.find((d) => name(d) === want) ?? inputs.find((d) => name(d).startsWith(want + ' (')) ?? inputs.find((d) => want.length >= 4 && name(d).includes(want)))?.deviceId ?? null;
}

/** Same label (suffix-tolerant): the running track already is the chosen device. */
export function sameMic(trackLabel: string | null | undefined, label: string | null): boolean {
  if (!label) return true;
  if (!trackLabel) return false;
  const a = trackLabel.trim().toLowerCase(), b = label.trim().toLowerCase();
  return a === b || a.startsWith(b + ' (');
}
