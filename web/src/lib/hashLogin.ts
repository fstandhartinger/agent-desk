/** The access code from a `#k=<code>` login link, or null. */
export function codeFromHash(hash: string): string | null {
  const m = hash.match(/^#k=([^&]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]) || null;
  } catch {
    return null;
  }
}

/** Reads and immediately strips the login hash so the code never lingers in the address bar or history. */
export function takeHashCode(): string | null {
  const code = codeFromHash(location.hash);
  if (location.hash.startsWith('#k=')) history.replaceState(null, '', location.pathname + location.search);
  return code;
}
