// Handoff proposals (docs/UPGRADES-1028.md §4). The model can only PROPOSE (tool handoff_propose): the proposal is
// stored here, keyed by id + session, and shown to Florian as a button. Only his click (POST /api/handoff with the
// session cookie, same-origin) posts ONE board entry through the bridge method board.handoff. One-time use, 10/day.
//
// a#41d6d2 (14 Nov 2026): the board refused the post ("Thread #31 is archived"), the click said only "hat nicht geklappt", the retry said
// "abgelaufen" (take() had deleted the proposal), and session_trace showed none of it. Now: a failure BEFORE anything reached the board
// (bridge offline, `not-posted:` from the bridge) puts the proposal back; an unclear one (timeout, connection lost) keeps the one-time
// rule and says so; every click and its outcome is a trace event of the proposing session (and a context note for a live voice model).
import crypto from 'node:crypto';
import { audit as defaultAudit } from './audit.js';
import { originOk } from './auth.js';
import { readJson, sendJson } from './http.js';
import { TEXT as MSG } from './messages.js';
import { redact, short } from './redact.js';

export const HANDOFF_LIMITS = { perDay: 10, ttlMs: 24 * 3600_000, maxOpen: 50, maxDone: 100, title: 120, task: 4000, why: 400 };
const ID = /^h[0-9a-f]{16}$/;

const clip = (text, max) => {
  const flat = redact(String(text ?? '')).trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function createHandoffStore({ now = () => Date.now() } = {}) {
  const open = new Map(); // `${sid}\u0000${id}` -> proposal
  const busy = new Map(); // key -> proposal whose bridge post is running (a second click must not be told "abgelaufen")
  const done = new Map(); // key -> {kind: 'posted'|'unclear', entryId, proposal, at}: what became of a taken proposal, so a later click is answered truthfully
  const used = []; // timestamps of executed handoffs (rolling 24 h)
  let pending = 0; // taken proposals whose bridge post is still running: they hold a slot until commit / release

  const prune = () => {
    const t = now();
    for (const [key, p] of open) if (t - p.at > HANDOFF_LIMITS.ttlMs) open.delete(key);
    while (open.size > HANDOFF_LIMITS.maxOpen) open.delete(open.keys().next().value);
    for (const [key, d] of done) if (t - d.at > HANDOFF_LIMITS.ttlMs) done.delete(key);
    while (done.size > HANDOFF_LIMITS.maxDone) done.delete(done.keys().next().value);
    while (used.length && t - used[0] > 24 * 3600_000) used.shift();
  };

  return {
    /** `trace` / `contextNote` belong to the proposing session: the click's outcome is written into that trace and (voice) told to the live model. */
    propose({ sid, title, task, why, trace, contextNote }) {
      prune();
      const proposal = { id: `h${crypto.randomBytes(8).toString('hex')}`, sid: sid ?? null, title: clip(title, HANDOFF_LIMITS.title), task: clip(task, HANDOFF_LIMITS.task), why: why ? clip(why, HANDOFF_LIMITS.why) : undefined, at: now() };
      if (!proposal.title || !proposal.task) throw new Error('handoff needs a title and a task');
      Object.defineProperties(proposal, { trace: { value: trace ?? null }, contextNote: { value: typeof contextNote === 'function' ? contextNote : null } }); // not enumerable: never serialised
      open.set(`${proposal.sid}\u0000${proposal.id}`, proposal);
      return proposal;
    },
    /** The proposal behind an id in any state (open, running, already used) without changing anything; null when this session never had it. */
    peek(sid, id) {
      if (typeof id !== 'string' || !ID.test(id)) return null;
      const key = `${sid}\u0000${id}`;
      return open.get(key) ?? busy.get(key) ?? done.get(key)?.proposal ?? null;
    },
    /** What became of a proposal that was taken: {kind: 'posted'|'unclear', entryId} (24 h), else null. take() itself answers 'unknown' for those. */
    outcome(sid, id) {
      prune();
      const d = typeof id === 'string' && ID.test(id) ? done.get(`${sid}\u0000${id}`) : null;
      return d ? { kind: d.kind, entryId: d.entryId ?? null } : null;
    },
    /** Removes and returns the proposal (one-time use) or a reason why not. `restore()` puts it back (nothing reached the board). */
    take(sid, id) {
      prune();
      if (typeof id !== 'string' || !ID.test(id)) return { error: 'bad-id' };
      const key = `${sid}\u0000${id}`;
      if (busy.has(key)) return { error: 'busy' };
      const proposal = open.get(key);
      if (!proposal) return { error: 'unknown' };
      if (used.length + pending >= HANDOFF_LIMITS.perDay) return { error: 'limit' };
      open.delete(key);
      busy.set(key, proposal);
      pending += 1;
      // critic r2 P2-4: the daily slot counts only after a successful bridge post (commit); a failed post releases it
      let settled = false;
      const settle = (ok) => { if (settled) return false; settled = true; pending -= 1; busy.delete(key); if (ok) used.push(now()); return true; };
      return {
        proposal,
        commit: (entryId = null) => { if (settle(true)) done.set(key, { kind: 'posted', entryId, proposal, at: now() }); },
        /** The post may have reached the board (timeout, connection lost): the proposal stays gone, a new one is needed. */
        release: () => { if (settle(false)) done.set(key, { kind: 'unclear', proposal, at: now() }); },
        /** The post provably did not reach the board: the same proposal (same id, TTL not extended) is clickable again. */
        restore: () => { if (settle(false)) open.set(key, proposal); },
      };
    },
    /** Florian's "Verwerfen" (critic r2 P2-3): the proposal is gone server-side too. True when it existed. */
    discard(sid, id) {
      prune();
      if (typeof id !== 'string' || !ID.test(id)) return false;
      return open.delete(`${sid}\u0000${id}`);
    },
    size: () => open.size,
  };
}

/** The process-wide store: proposals from text chat and voice sessions land here. */
export const handoffStore = createHandoffStore();

export function proposeHandoff(args, store = handoffStore) {
  return store.propose(args);
}

const TEXT = {
  bad: 'Ungültiger Übergabe-Vorschlag',
  unknown: 'Diesen Übergabe-Vorschlag gibt es nicht (mehr) – er wurde schon benutzt oder ist abgelaufen. Bitte den Desk noch einmal darum bitten.',
  limit: 'Heute wurden schon 10 Aufträge übergeben – bitte morgen wieder',
  origin: 'Anfrage von einer fremden Seite abgelehnt',
  busy: 'Die Übergabe läuft gerade – bitte einen Moment warten.',
  posted: (entryId) => `Diese Übergabe ist schon angekommen${entryId ? ` (Board-Eintrag #${entryId})` : ''} – nichts mehr zu tun.`,
  unclear: 'Unklar, ob die Übergabe angekommen ist – bitte nicht noch einmal klicken; ich prüfe das Board.',
  offline: (host) => `Die Werkstatt auf ${host === 'sandy' ? 'Sandy' : host} ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken.`,
  archived: 'Das Board-Thema für Übergaben war archiviert und ließ sich nicht wieder öffnen – bitte in ein paar Minuten noch einmal klicken.',
  noThread: 'Das Board-Thema für Übergaben gibt es nicht und ließ sich nicht anlegen – bitte in ein paar Minuten noch einmal klicken.',
  invalid: 'Das Board hat den Auftrag wegen seiner Form abgelehnt (nichts wurde gepostet) – bitte den Desk um einen neuen Vorschlag bitten.',
  refused: 'Das Board hat die Übergabe abgelehnt, es wurde nichts gepostet – in ein paar Minuten noch einmal klicken.',
};

/**
 * Why a bridge call failed and what Florian can do next. `posted: false` means nothing reached the board (the proposal can be put back);
 * everything else is unclear. The bridge marks its refusals with `not-posted:` (bridge/src/board.js); an older bridge only says what the board said.
 */
export function describeFailure(err, host = 'sandy') {
  const message = String(err?.message ?? err ?? '');
  const detail = short(redact(message), 160);
  const body = message.replace(/^not-posted:\s*/, '');
  if (message === MSG.bridgeOffline(host)) return { kind: 'offline', posted: false, retry: true, error: TEXT.offline(host), detail };
  // critic S4: only the bridge's own marker or the board's own refusal line at the start counts (the title of the handoff can contain any words)
  const refused = /^not-posted:/.test(message) || /^board failed: agent-board: [^\n]*(?:is archived|No thread matches)/.test(message) || /^unknown method board\.handoff/.test(message);
  if (!refused) return { kind: 'unclear', posted: null, retry: false, error: TEXT.unclear, detail };
  if (/handoff limit reached/i.test(body)) return { kind: 'limit', posted: false, retry: true, error: TEXT.limit, detail };
  if (/is archived|archived thread/i.test(body)) return { kind: 'archived', posted: false, retry: true, error: TEXT.archived, detail };
  if (/no thread matches|no such thread|unknown thread/i.test(body)) return { kind: 'no-thread', posted: false, retry: true, error: TEXT.noThread, detail };
  if (/(?:title|task) required|why too long/i.test(body)) return { kind: 'invalid', posted: false, retry: false, error: TEXT.invalid, detail };
  return { kind: 'refused', posted: false, retry: true, error: TEXT.refused, detail };
}

/** What the card learns from a refusal before any post: German reason, HTTP status, and whether the button should stay active. */
const REFUSALS = {
  'bad-id': { status: 400, text: () => TEXT.bad, retry: false },
  unknown: { status: 404, text: () => TEXT.unknown, retry: false },
  limit: { status: 429, text: () => TEXT.limit, retry: true }, // the proposal stays open (take() refused before removing it)
  busy: { status: 409, text: () => TEXT.busy, retry: true },
  posted: { status: 404, text: (taken) => TEXT.posted(taken.entryId), retry: false },
  unclear: { status: 404, text: () => TEXT.unclear, retry: false },
};

/** POST /api/handoff {id}. The caller (server.js) has already checked the session cookie. */
export async function handleHandoff(req, res, { sid, ip, hub, store = handoffStore, audit = defaultAudit }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  // CSRF: a same-origin Origin header is REQUIRED here (the global check only rejects a foreign one when present)
  if (!req.headers.origin || !originOk(req)) {
    audit({ action: 'handoff.refused', ip, detail: 'origin' });
    return sendJson(res, 403, { error: TEXT.origin, retry: false });
  }
  const body = await readJson(req, 4096);
  const known = store.peek?.(sid, body.id) ?? null; // the proposing session's trace + live-model note ride on the proposal
  const t0 = Date.now();
  const record = (type, data) => { try { known?.trace?.event?.(type, data); } catch { /* advisory: the click must not notice */ } };
  const tellModel = (reason) => { try { known?.contextNote?.(`Florians Klick auf die Übergabe-Karte ist fehlgeschlagen: ${reason}`); } catch { /* no live model, advisory */ } };
  record('handoff.click', { id: short(String(body.id ?? ''), 40), title: known?.title });
  let taken = store.take(sid, body.id);
  if (taken.error === 'unknown') { const was = store.outcome?.(sid, body.id); if (was) taken = { error: was.kind, entryId: was.entryId }; } // used before: say what became of it, not "abgelaufen"
  if (taken.error) {
    const refusal = REFUSALS[taken.error] ?? REFUSALS.unknown;
    const reason = refusal.text(taken);
    audit({ action: 'handoff.refused', ip, detail: `${taken.error} ${short(String(body.id ?? ''), 40)}` });
    record('handoff.refused', { id: short(String(body.id ?? ''), 40), code: taken.error, reason, retry: refusal.retry });
    if (taken.error !== 'posted') tellModel(reason); // a repeated click on a card that already worked needs no alarm
    return sendJson(res, refusal.status, { error: reason, retry: refusal.retry });
  }
  const { proposal } = taken;
  const host = hub.pick?.('board.handoff') ?? 'sandy';
  try {
    const result = await hub.call('board.handoff', { title: proposal.title, task: proposal.task, ...(proposal.why ? { why: proposal.why } : {}) }, { host, timeoutMs: 30_000 });
    const entryId = result?.entryId ?? result?.id ?? null;
    taken.commit?.(entryId);
    const fallback = result?.fallback === true;
    const where = fallback ? { fallback: true, thread: short(String(result.thread ?? ''), 80), ...(Number.isInteger(result.threadId) ? { threadId: result.threadId } : {}), ...(Number.isInteger(result.intendedThreadId) ? { intendedThreadId: result.intendedThreadId } : {}) } : {};
    audit({ action: 'handoff.posted', ip, detail: `${proposal.id} entry=${entryId}${fallback ? ` fallback=${where.thread}` : ''}${result?.reopened ? ' reopened' : ''} ${proposal.title}` });
    record('handoff.posted', { id: proposal.id, entry: entryId, thread: fallback ? where.thread : (result?.thread ?? null), fallback, ...(fallback ? { threadId: where.threadId ?? null, intendedThreadId: where.intendedThreadId ?? null } : {}), ...(result?.reopened ? { reopened: true } : {}), ms: Date.now() - t0 });
    return sendJson(res, 200, { ok: true, entryId, ...where, ...(result?.reopened ? { reopened: true } : {}) });
  } catch (err) {
    const f = describeFailure(err, host);
    // A failure that provably happened before the post is put back (same id, still one-time, same daily slot rules). An unclear one is NOT restored:
    // the bridge may have posted before the error came back, a click would duplicate it. The bridge keeps its own counter, committed only after its post.
    if (f.retry) taken.restore?.(); else taken.release?.();
    audit({ action: 'handoff.failed', ip, detail: `${proposal.id} ${f.kind} retry=${f.retry} ${short(redact(String(err?.message ?? err)), 120)}` });
    record('handoff.failed', { id: proposal.id, kind: f.kind, reason: f.error, retry: f.retry, detail: f.detail, ms: Date.now() - t0 });
    tellModel(f.error);
    return sendJson(res, 502, { error: f.error, retry: f.retry, kind: f.kind });
  }
}

/** POST /api/handoff/discard {id} (critic r2 P2-3): "Verwerfen" removes the proposal from the store. */
export async function handleHandoffDiscard(req, res, { sid, ip, store = handoffStore, audit = defaultAudit }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!req.headers.origin || !originOk(req)) {
    audit({ action: 'handoff.refused', ip, detail: 'discard origin' });
    return sendJson(res, 403, { error: TEXT.origin });
  }
  const body = await readJson(req, 4096);
  if (typeof body.id !== 'string' || !ID.test(body.id)) return sendJson(res, 400, { error: TEXT.bad });
  const removed = store.discard(sid, body.id);
  audit({ action: 'handoff.discarded', ip, detail: `${body.id}${removed ? '' : ' (unknown)'}` });
  return sendJson(res, 200, { ok: true, removed });
}
