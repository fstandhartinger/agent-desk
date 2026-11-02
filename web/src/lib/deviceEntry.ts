/** A pairing nonce identifies one short-lived request. The app's polling credential never reaches a URL. */
export function pairingId(loc: { pathname: string; search: string }): string | null {
  if (loc.pathname !== '/device') return null;
  const value = new URLSearchParams(loc.search).get('pair');
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function companionEntry(loc: { pathname: string; search: string }): boolean {
  return loc.pathname === '/device' && new URLSearchParams(loc.search).get('companion') === '1';
}

export function deviceLoginContext(loc: { pathname: string; search: string }): boolean {
  return loc.pathname === '/device' || new URLSearchParams(loc.search).get('companion') === '1';
}

/** Only the native app's one-use loopback listener may receive browser confirmation. Never accept a remote redirect. */
export function pairingCallback(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/ScreenAgent\/[A-Za-z0-9_-]{43}\/\?proof=[A-Za-z0-9_-]{43}$/.exec(value);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) return null;
  return value;
}
