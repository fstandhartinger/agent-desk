// Claude proposals (critic round 1, P0-1). The model can only PROPOSE a Claude Code task (tool claude_task): the proposal
// is stored here, keyed by id + session, and shown to Florian as a confirm card. Only his click (POST /api/claude/proposal
// {id} with the session cookie and a same-origin Origin) starts the session (claude.start through the shared gate and
// limits) or sends the text into a running one (claude.send). One-time use, 24 h. No model-callable path reaches the bridge.
import crypto from 'node:crypto';
import { audit as defaultAudit } from './audit.js';
import { originOk } from './auth.js';
import { SID, bridgeError, notSent, startClaudeSession } from './claudeSessions.js';
import { readJson, sendJson } from './http.js';
import { redact, short } from './redact.js';

export const CLAUDE_PROPOSAL_LIMITS = { ttlMs: 24 * 3600_000, maxOpen: 50, title: 120, prompt: 20_000 };
const ID = /^c[0-9a-f]{16}$/;
const MODELS = new Set(['opus', 'sonnet']);

const clip = (text, max) => {
  const flat = String(text ?? '').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
};

export function createClaudeProposalStore({ now = () => Date.now() } = {}) {
  const open = new Map(); // `${sid}\u0000${id}` -> proposal

  const prune = () => {
    const t = now();
    for (const [key, p] of open) if (t - p.at > CLAUDE_PROPOSAL_LIMITS.ttlMs) open.delete(key);
    while (open.size > CLAUDE_PROPOSAL_LIMITS.maxOpen) open.delete(open.keys().next().value);
  };

  return {
    propose({ sid, prompt, sessionId, model, title, page, chatContext }) {
      prune();
      if (sessionId !== undefined && !SID.test(sessionId)) throw new Error('invalid session id');
      const text = clip(redact(String(prompt ?? '')), CLAUDE_PROPOSAL_LIMITS.prompt); // critic round 2, P2-5
      if (!text) throw new Error('claude_task needs a prompt');
      const proposal = {
        id: `c${crypto.randomBytes(8).toString('hex')}`, sid: sid ?? null, prompt: text,
        title: clip(title, CLAUDE_PROPOSAL_LIMITS.title) || short(text, 60),
        ...(sessionId ? { sessionId } : {}), ...(MODELS.has(model) ? { model } : {}),
        page: page || undefined, chatContext: chatContext || undefined, at: now(),
      };
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
      open.delete(key);
      return { proposal };
    },
    /** Florian's "Verwerfen" (critic r2 P2-3): the proposal is gone server-side too. True when it existed. */
    discard(sid, id) {
      prune();
      if (typeof id !== 'string' || !ID.test(id)) return false;
      return open.delete(`${sid}\u0000${id}`);
    },
    /** Puts a proposal back (only when nothing was started: the start gate refused it). */
    restore(proposal) {
      open.set(`${proposal.sid}\u0000${proposal.id}`, proposal);
    },
    size: () => open.size,
  };
}

/** The process-wide store: proposals from text chat and voice sessions land here. */
export const claudeProposalStore = createClaudeProposalStore();

/** How many chat turns a new session gets with the prompt (formatChatContext: one "Florian: …" / "Desk-Agent: …" line each). */
export const contextTurnsOf = (p) => (p.sessionId || !p.chatContext ? 0 : (p.chatContext.match(/^(?:Florian|Desk-Agent): /gm)?.length ?? 0));

/** The browser event for a proposal (what the confirm card shows; critic r2 P2-2: also how many chat turns go along). */
export const proposalEvent = (p) => ({ type: 'claude_proposal', id: p.id, prompt: p.prompt, title: p.title, ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.model ? { model: p.model } : {}), contextTurns: contextTurnsOf(p) });

const TEXT = {
  bad: 'Ungültiger Claude-Vorschlag',
  unknown: 'Diesen Claude-Vorschlag gibt es nicht (mehr) – er wurde schon benutzt oder ist abgelaufen',
  origin: 'Anfrage von einer fremden Seite abgelehnt',
  failed: 'Claude konnte nicht gestartet werden',
};

/** POST /api/claude/proposal {id}. The caller (server.js) has already checked the session cookie. */
export async function handleClaudeProposal(req, res, { sid, ip, hub, limits, store = claudeProposalStore, audit = defaultAudit }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  // CSRF: a same-origin Origin header is REQUIRED here (the global check only rejects a foreign one when present)
  if (!req.headers.origin || !originOk(req)) {
    audit({ action: 'claude.proposal.refused', ip, detail: 'origin' });
    return sendJson(res, 403, { error: TEXT.origin });
  }
  const body = await readJson(req, 4096);
  const taken = store.take(sid, body.id);
  if (taken.error) {
    audit({ action: 'claude.proposal.refused', ip, detail: `${taken.error} ${short(String(body.id ?? ''), 40)}` });
    return sendJson(res, taken.error === 'bad-id' ? 400 : 404, { error: TEXT[taken.error === 'bad-id' ? 'bad' : taken.error] });
  }
  const { proposal: p } = taken;
  const host = hub.pick?.('claude.start') ?? 'lechonk';
  try {
    if (p.sessionId) {
      await hub.call('claude.send', { sid: p.sessionId, text: p.prompt }, { host }).catch((err) => { throw Object.assign(err, { mayHaveRun: !notSent(err, host) }); });
      audit({ action: 'claude.send', ip, detail: `${p.sessionId}: ${p.prompt}` });
      return sendJson(res, 200, { ok: true, sid: p.sessionId, sent: true });
    }
    const result = await startClaudeSession({ hub, limits, sid, audit, ip, host, title: p.title, prompt: p.prompt, model: p.model, page: p.page, chatContext: p.chatContext });
    audit({ action: 'claude.proposal.started', ip, detail: `${p.id} ${result?.sid}` });
    return sendJson(res, 200, { ok: true, sid: result?.sid ?? null });
  } catch (err) {
    // critic r2 P2-4: whenever nothing can have run (busy / daily limit, claude.list failed, bridge offline) the proposal
    // stays usable for a later click; after the start / send request reached the bridge it is not restored (it may have run)
    if (!err.mayHaveRun) store.restore(p);
    audit({ action: 'claude.proposal.failed', ip, detail: `${p.id} ${short(err.message, 120)}` });
    const status = err.status === 429 ? 429 : bridgeError(err).status ?? 502;
    return sendJson(res, status, { error: err.status === 429 ? err.message : TEXT.failed }, err.retryAfter ? { 'retry-after': String(err.retryAfter) } : undefined);
  }
}

/** POST /api/claude/proposal/discard {id} (critic r2 P2-3): "Verwerfen" removes the proposal from the store. */
export async function handleClaudeProposalDiscard(req, res, { sid, ip, store = claudeProposalStore, audit = defaultAudit }) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  if (!req.headers.origin || !originOk(req)) {
    audit({ action: 'claude.proposal.refused', ip, detail: 'discard origin' });
    return sendJson(res, 403, { error: TEXT.origin });
  }
  const body = await readJson(req, 4096);
  if (typeof body.id !== 'string' || !ID.test(body.id)) return sendJson(res, 400, { error: TEXT.bad });
  const removed = store.discard(sid, body.id);
  audit({ action: 'claude.proposal.discarded', ip, detail: `${body.id}${removed ? '' : ' (unknown)'}` });
  return sendJson(res, 200, { ok: true, removed });
}
