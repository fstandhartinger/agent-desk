import crypto from 'node:crypto';
import fs from 'node:fs';
import { audit } from './audit.js';
import { cfg } from './config.js';
import { clientIp, readJson, sendJson } from './http.js';
import { FailureLimiter } from './limits.js';
import { TEXT, inMinutes, tooManyAttempts } from './messages.js';

export const COOKIE_NAME = 'desk_s';
const revokedFile = () => process.env.DESK_REVOKED_FILE || '/tmp/agent-desk-revoked-sessions.json';
const MAX_AGE_S = 30 * 24 * 3600;
const perIp = new FailureLimiter(5, 15 * 60_000);
const overall = new FailureLimiter(40, 15 * 60_000);

// IPs that logged in successfully within the cookie lifetime are exempt from the all-IP backstop, so strangers
// guessing codes cannot lock Florian out of a fresh login; their own per-IP limit still applies. Memory only.
const knownIps = new Map();
const MAX_KNOWN_IPS = 200;

function rememberIp(ip, now = Date.now()) {
  knownIps.delete(ip);
  knownIps.set(ip, now);
  while (knownIps.size > MAX_KNOWN_IPS) knownIps.delete(knownIps.keys().next().value);
}

const isKnownIp = (ip, now = Date.now()) => now - (knownIps.get(ip) ?? -Infinity) < MAX_AGE_S * 1000;

/**
 * Logged-out session ids (sid -> cookie expiry in ms). The cookie itself is stateless, so logout is a denylist,
 * kept in memory and mirrored to a small file under /tmp: it survives a gateway restart but not a redeploy that
 * replaces the container; after such a redeploy a copied old cookie works again until its 30 days run out.
 * Rotating DESK_SESSION_SECRET revokes every session at once.
 */
const revoked = new Map();
try {
  for (const [sid, exp] of Object.entries(JSON.parse(fs.readFileSync(revokedFile(), 'utf8')))) if (exp > Date.now()) revoked.set(sid, exp);
} catch {
  // no file yet
}

function persistRevoked(now = Date.now()) {
  for (const [sid, exp] of revoked) if (exp <= now) revoked.delete(sid);
  try {
    fs.writeFileSync(revokedFile(), JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
  } catch {
    // read-only file system: the denylist then lives in memory only
  }
}

export function revokeSession(session) {
  if (!session?.sid) return;
  revoked.set(session.sid, session.exp);
  persistRevoked();
}

const hmac = (data) => crypto.createHmac('sha256', cfg.sessionSecret()).update(data).digest('base64url');

/**
 * Login links for Telegram: `L1.<expiry ms>.<nonce>.<mac>`, signed with a key derived from DESK_SESSION_SECRET, valid
 * until expiry (at most 7 days) and for LINK_MAX_USES logins (phone + desktop + laptop). The master access code never
 * has to leave the server. Uses are counted in memory + /tmp like the logout denylist.
 */
const LINK_MAX_USES = 3;
const LINK_MAX_TTL_MS = 7 * 24 * 3600_000;
const linkUses = new Map();
const linkMac = (body) => crypto.createHmac('sha256', crypto.createHmac('sha256', cfg.sessionSecret()).update('login-link-v1').digest()).update(body).digest('base64url');

export function mintLoginLink(ttlMs = 24 * 3600_000, now = Date.now()) {
  const body = `L1.${now + Math.min(ttlMs, LINK_MAX_TTL_MS)}.${crypto.randomBytes(9).toString('base64url')}`;
  return `${body}.${linkMac(body)}`;
}

/** True (and one use consumed) for a valid, unexpired, not used-up login link. */
function useLoginLink(code, now = Date.now()) {
  const m = /^(L1\.(\d{13})\.([A-Za-z0-9_-]{12}))\.([A-Za-z0-9_-]{43})$/.exec(code);
  if (!m || !cfg.sessionSecret() || !safeEqual(m[4], linkMac(m[1]))) return false;
  const exp = Number(m[2]);
  if (exp <= now || exp - now > LINK_MAX_TTL_MS) return false;
  const used = linkUses.get(m[3])?.n ?? 0;
  if (used >= LINK_MAX_USES) return false;
  linkUses.set(m[3], { n: used + 1, exp });
  for (const [k, v] of linkUses) if (v.exp <= now) linkUses.delete(k);
  try { fs.writeFileSync(linkUsesFile(), JSON.stringify(Object.fromEntries(linkUses)), { mode: 0o600 }); } catch { /* memory only */ }
  return true;
}
const linkUsesFile = () => process.env.DESK_LINK_USES_FILE || '/tmp/agent-desk-link-uses.json';
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(linkUsesFile(), 'utf8')))) if (v.exp > Date.now()) linkUses.set(k, v);
} catch {
  // no file yet
}

/** Constant-time string comparison that also hides the length. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function issueCookie(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + MAX_AGE_S * 1000, sid: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
  return `${COOKIE_NAME}=${payload}.${hmac(payload)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`;
}

export const clearCookie = () => `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

/** Returns the session payload {iat, exp, sid} or null for a missing, forged or expired cookie. */
export function readSession(req, now = Date.now()) {
  if (!cfg.sessionSecret()) return null;
  const raw = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return null;
  const [payload, mac] = raw.slice(COOKIE_NAME.length + 1).split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(hmac(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof session.sid !== 'string' || !(session.exp > now) || !(session.iat <= now + 60_000) || revoked.has(session.sid)) return null;
    return session;
  } catch {
    return null;
  }
}

/** Origin must be the desk itself (WebSocket upgrades and cross-site POST protection). */
export function originOk(req) {
  return req.headers.origin === cfg.deskOrigin();
}

export async function login(req, res) {
  const ip = clientIp(req);
  const wait = Math.max(perIp.retryAfter(ip), isKnownIp(ip) ? 0 : overall.retryAfter('all'));
  if (wait) return sendJson(res, 429, { error: tooManyAttempts(wait), retryAfter: wait }, { 'retry-after': String(wait) });
  if (!cfg.accessCode() || !cfg.sessionSecret()) return sendJson(res, 503, { error: TEXT.loginNotConfigured });
  const body = await readJson(req, 4096);
  const viaLink = typeof body.code === 'string' && body.code.startsWith('L1.') && useLoginLink(body.code);
  if (!viaLink && (typeof body.code !== 'string' || !safeEqual(body.code, cfg.accessCode()))) {
    perIp.fail(ip);
    overall.fail('all');
    audit({ action: 'login.fail', ip, actor: 'anonymous' });
    return sendJson(res, 401, { error: TEXT.wrongCode });
  }
  perIp.reset(ip);
  rememberIp(ip);
  audit({ action: viaLink ? 'login.ok.link' : 'login.ok', ip });
  sendJson(res, 200, { ok: true }, { 'set-cookie': issueCookie() });
}

// "Neuen Login-Link per Telegram schicken" (Gate): no cookie yet, so the limits are global - 1 per 10 minutes, 4 per day.
const linkRequests = [];
const LINK_REQUEST_WINDOWS = [[1, 10 * 60_000], [4, 24 * 3600_000]];
const NEXT_PATH = /^\/(\?[^#\s\\]*)?$/;

/** Same-origin target the login link opens: "/" or "/?x=…"; anything else is refused. */
export function safeNext(value) {
  if (value === undefined || value === null || value === '') return '/';
  return typeof value === 'string' && value.length <= 500 && NEXT_PATH.test(value) ? value : null;
}

export async function requestLoginLink(req, res, { hub }) {
  const ip = clientIp(req);
  const body = await readJson(req, 2048);
  const next = safeNext(body.next);
  if (next === null) return sendJson(res, 400, { error: TEXT.badNext });
  if (!cfg.sessionSecret()) return sendJson(res, 503, { error: TEXT.loginNotConfigured });
  const now = Date.now();
  while (linkRequests.length && now - linkRequests[0] >= LINK_REQUEST_WINDOWS.at(-1)[1]) linkRequests.shift();
  let wait = 0;
  for (const [max, windowMs] of LINK_REQUEST_WINDOWS) {
    const recent = linkRequests.filter((t) => now - t < windowMs);
    if (recent.length >= max) wait = Math.max(wait, Math.ceil((recent[recent.length - max] + windowMs - now) / 1000));
  }
  if (wait) {
    audit({ action: 'login.request_link.limited', ip, actor: 'anonymous' });
    return sendJson(res, 429, { error: TEXT.linkLimited(inMinutes(wait)), retryAfter: wait }, { 'retry-after': String(wait) });
  }
  linkRequests.push(now);
  // Test hook for critics: with DESK_TEST_DRYRUN=1 in the environment (never set in production) the header x-desk-dry-run: 1
  // signs the link but sends nothing. Without the env var the header is ignored (a real link goes out).
  if (process.env.DESK_TEST_DRYRUN === '1' && req.headers['x-desk-dry-run'] === '1') {
    linkRequests.splice(linkRequests.lastIndexOf(now), 1); // a dry run uses no allowance
    mintLoginLink();
    audit({ action: 'login.request_link.dryrun', ip, actor: 'anonymous', detail: next });
    return sendJson(res, 200, { ok: true, dryRun: true });
  }
  try {
    const url = `${cfg.deskOrigin()}${next}#k=${mintLoginLink()}`;
    const result = await hub.call('notify.loginLink', { url });
    if (result?.sent !== true) throw new Error('not sent');
  } catch {
    linkRequests.splice(linkRequests.lastIndexOf(now), 1); // nothing was sent: do not burn the allowance
    audit({ action: 'login.request_link.fail', ip, actor: 'anonymous' });
    return sendJson(res, 502, { error: TEXT.linkNotSent });
  }
  audit({ action: 'login.request_link', ip, actor: 'anonymous', detail: next });
  return sendJson(res, 200, { ok: true });
}

export function logout(req, res) {
  const session = readSession(req);
  if (session) {
    revokeSession(session);
    audit({ action: 'logout', ip: clientIp(req) });
  }
  sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
}

/** Failed-bridge-token limiter, shared with server.js. */
export const bridgeFailures = new FailureLimiter(10, 15 * 60_000);

export function resetLoginLimitsForTests() {
  revoked.clear();
  perIp.hits.clear();
  overall.hits.clear();
  knownIps.clear();
  linkUses.clear();
  linkRequests.length = 0;
}
