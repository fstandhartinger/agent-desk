// Handoff proposals (docs/UPGRADES-1028.md §4). The model can only PROPOSE (tool handoff_propose): the proposal is
// stored here, keyed by id + session, and shown to Florian as a button. Only his click (POST /api/handoff with the
// session cookie, same-origin) posts ONE board entry through the bridge method board.handoff. One-time use, 10/day.
import crypto from 'node:crypto';
import { audit as defaultAudit } from './audit.js';
import { originOk } from './auth.js';
import { readJson, sendJson } from './http.js';
import { redact, short } from './redact.js';

export const HANDOFF_LIMITS = { perDay: 10, ttlMs: 24 * 3600_000, maxOpen: 50, title: 120, task: 4000, why: 400 };
const ID = /^h[0-9a-f]{16}$/;

const clip = (text, max) => {
  const flat = redact(String(text ?? '')).trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function createHandoffStore({ now = () => Date.now() } = {}) {
  const open = new Map(); // `${sid}\u0000${id}` -> proposal
  const used = []; // timestamps of executed handoffs (rolling 24 h)
  let pending = 0; // taken proposals whose bridge post is still running: they hold a slot until commit / release

  const prune = () => {
    const t = now();
    for (const [key, p] of open) if (t - p.at > HANDOFF_LIMITS.ttlMs) open.delete(key);
    while (open.size > HANDOFF_LIMITS.maxOpen) open.delete(open.keys().next().value);
    while (used.length && t - used[0] > 24 * 3600_000) used.shift();
  };

  return {
    propose({ sid, title, task, why }) {
      prune();
      const proposal = { id: `h${crypto.randomBytes(8).toString('hex')}`, sid: sid ?? null, title: clip(title, HANDOFF_LIMITS.title), task: clip(task, HANDOFF_LIMITS.task), why: why ? clip(why, HANDOFF_LIMITS.why) : undefined, at: now() };
      if (!proposal.title || !proposal.task) throw new Error('handoff needs a title and a task');
      open.set(`${proposal.sid}\u0000${proposal.id}`, proposal);
      return proposal;
    },
    /** Removes and returns the proposal (one-time use) or a reason why not. */
    take(sid, id) {
      prune();
      if (typeof id !== 'string' || !ID.test(id)) return { error: 'bad-id' };
      const key = `${sid}\u0000${id}`;
      const proposal = open.get(key);
      if (!proposal) return { error: 'unknown' };
      if (used.length + pending >= HANDOFF_LIMITS.perDay) return { error: 'limit' };
      open.delete(key);
      pending += 1;
      // critic r2 P2-4: the daily slot counts only after a successful bridge post (commit); a failed post releases it
      let settled = false;
      const settle = (ok) => { if (settled) return; settled = true; pending -= 1; if (ok) used.push(now()); };
      return { proposal, commit: () => settle(true), release: () => settle(false) };
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
  unknown: 'Diesen Übergabe-Vorschlag gibt es nicht (mehr) – er wurde schon benutzt oder ist abgelaufen',
  limit: 'Heute wurden schon 10 Aufträge übergeben – bitte morgen wieder',
  origin: 'Anfrage von einer fremden Seite abgelehnt',
  failed: 'Die Übergabe an die Agenten hat nicht geklappt',
};

/** POST /api/handoff {id}. The caller (server.js) has already checked the session cookie. */
export async function handleHandoff(req, res, { sid, ip, hub, store = handoffStore, audit = defaultAudit }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  // CSRF: a same-origin Origin header is REQUIRED here (the global check only rejects a foreign one when present)
  if (!req.headers.origin || !originOk(req)) {
    audit({ action: 'handoff.refused', ip, detail: 'origin' });
    return sendJson(res, 403, { error: TEXT.origin });
  }
  const body = await readJson(req, 4096);
  const taken = store.take(sid, body.id);
  if (taken.error) {
    audit({ action: 'handoff.refused', ip, detail: `${taken.error} ${short(String(body.id ?? ''), 40)}` });
    const status = taken.error === 'limit' ? 429 : taken.error === 'bad-id' ? 400 : 404;
    return sendJson(res, status, { error: TEXT[taken.error === 'bad-id' ? 'bad' : taken.error] });
  }
  const { proposal } = taken;
  try {
    const result = await hub.call('board.handoff', { title: proposal.title, task: proposal.task, ...(proposal.why ? { why: proposal.why } : {}) }, { host: hub.pick?.('board.handoff') ?? 'sandy', timeoutMs: 30_000 });
    const entryId = result?.entryId ?? result?.id ?? null;
    taken.commit?.();
    audit({ action: 'handoff.posted', ip, detail: `${proposal.id} entry=${entryId} ${proposal.title}` });
    return sendJson(res, 200, { ok: true, entryId });
  } catch (err) {
    // not restored on purpose: the bridge may have posted before the error came back; a retry needs a new proposal.
    // The daily slot is released: the bridge keeps its own counter, committed only after its post (commitHandoffSlot)
    taken.release?.();
    audit({ action: 'handoff.failed', ip, detail: `${proposal.id} ${short(err.message, 120)}` });
    return sendJson(res, 502, { error: TEXT.failed });
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
