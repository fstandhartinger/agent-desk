// Critic round 4, P2-1: the search existence oracle. "Hit or no hit" for a query that holds a piece of a secret tells an
// injected model whether that piece exists, so it could brute-force a value prefix term by term. ctx.search and
// chats.search refuse such terms, and drop hits whose matched text was redacted (see ctx.js / chats.js).

import { secretish } from './redactPatterns.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRAILING = new Set(['"', "'", '`', ')', ']', '}', '>', '.', ',', ';', ':', '!', '?']);
/**
 * Does one search term look like a fragment of a secret? >= 8 chars without whitespace, letters and digits mixed, and
 * random-looking: >= 3 letter/digit switches ("Zq7xWv2P"), or lower + upper case with >= 2 digits. Job slugs
 * ("explainer-desk-upgrades-20261028"), model ids ("deepseek-v4.1-flash") and whole UUIDs stay searchable.
 */
export function looksLikeSecretFragment(term) {
  const lead = String(term ?? '').trim().replace(/^["'`([{<]+/, '');
  let end = lead.length;
  while (end > 0 && TRAILING.has(lead[end - 1])) end -= 1; // a loop, not /[…]+$/ (quadratic on a run of them, critic r7)
  const t = lead.slice(0, end);
  if (t.length < 8 || /\s/.test(t) || UUID.test(t)) return false;
  const digits = (t.match(/\d/g) || []).length;
  if (!digits || !/[A-Za-z]/.test(t)) return false;
  const switches = (t.match(/[A-Za-z](?=\d)|\d(?=[A-Za-z])/g) || []).length;
  return switches >= 3 || (/[a-z]/.test(t) && /[A-Z]/.test(t) && digits >= 2);
}

export const SECRET_QUERY_ERROR = 'Suchbegriff sieht wie ein Teil eines Schlüssels oder Tokens aus; danach wird nicht gesucht. '
  + 'Bitte mit Wörtern suchen (query term looks like a secret fragment; search with words instead).';

/** Throws when any whitespace-separated piece of the query looks like a secret fragment. */
export function assertNoSecretFragment(query) {
  const pieces = String(query ?? '').split(/\s+|\|/).filter(Boolean);
  if (pieces.some(looksLikeSecretFragment)) throw new Error(SECRET_QUERY_ERROR);
}

// ---- hits inside secrets ----------------------------------------------------------------------------------------------
const SEP = /[\s"'`=:,;(){}[\]<>\\|]/;

/** The raw token (between separators) that holds text[i, i + len). */
export function tokenAround(text, i, len) {
  let a = i;
  let b = i + len;
  while (a > 0 && !SEP.test(text[a - 1])) a--;
  while (b < text.length && !SEP.test(text[b])) b++;
  return text.slice(a, b);
}

const secretLooking = (tok) => tok.length >= 12 && (secretish(tok, 'weak') || looksLikeSecretFragment(tok));

/**
 * Was every hit on `term` in `raw` swallowed by redaction because it sits inside a secret-looking token? Then the hit
 * must not count. A term that vanished for other reasons (an env-dump line hidden, the rest of an env line redacted)
 * is not inside a secret, so its hit stays (it shows the redacted context).
 */
export function hitInSecret(raw, safe, term) {
  const t = String(term).toLowerCase();
  if (!t || String(safe).toLowerCase().includes(t)) return false;
  const low = String(raw).toLowerCase();
  let found = false;
  for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + 1)) {
    if (!secretLooking(tokenAround(raw, i, t.length))) return false;
    found = true;
  }
  return found;
}
