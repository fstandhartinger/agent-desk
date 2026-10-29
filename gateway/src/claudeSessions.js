import { TEXT } from './messages.js';
import { short } from './redact.js';

export const MAX_RUNNING = 3;
export const SID = /^d\d{8}-[0-9a-f]{6}$/;
const BUSY = new Set(['starting', 'running']);

export const eventsOf = (result) => (Array.isArray(result) ? result : result?.events || []);
export const sessionsOf = (result) => (Array.isArray(result) ? result : result?.sessions || []);

/** Bridge failures map to 503 (offline) or 502 so HTTP callers get a meaningful status. */
export function bridgeError(err) {
  if (err.status) return err;
  return Object.assign(err, { status: /offline|getrennt/.test(err.message) ? 503 : 502 });
}

const CHAT_TURNS = 12;
const CHAT_BYTES = 6000;
const CHAT_LABEL = { user: 'Florian', assistant: 'Desk-Agent' };

/** Last 12 chat turns, at most 6 KB (newest kept), as the transcript block for a Claude session's PROMPT.md. */
export function formatChatContext(input) {
  if (typeof input === 'string') return input.slice(-CHAT_BYTES);
  if (!Array.isArray(input)) return undefined;
  const lines = [];
  let size = 0;
  for (const m of input.slice(-CHAT_TURNS).reverse()) {
    if (typeof m?.content !== 'string' || !CHAT_LABEL[m.role]) continue;
    const line = `${CHAT_LABEL[m.role]}: ${m.content.trim().slice(0, 1500)}`;
    if (size + line.length > CHAT_BYTES) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join('\n') || undefined;
}

/** The hub refused before anything left the gateway (no bridge connection): the call cannot have run. */
export const notSent = (err, host) => err?.message === TEXT.bridgeOffline(host);

function refuse(message, retryAfter) {
  return Object.assign(new Error(message), { status: 429, retryAfter });
}

/** Start a Claude Code session on a bridge, enforcing the running cap and the daily start limit. */
export async function startClaudeSession({ hub, limits, sid, audit, ip, host = 'lechonk', title, prompt, model = 'sonnet', page, chatContext }) {
  const sessions = sessionsOf(await hub.call('claude.list', {}, { host }).catch((err) => { throw bridgeError(err); }));
  if (sessions.filter((s) => BUSY.has(s.state)).length >= MAX_RUNNING) throw refuse(TEXT.claudeBusy(MAX_RUNNING), 60);
  const gate = limits.check(sid, 'claudeStart');
  if (!gate.ok) throw refuse(gate.reason, gate.retryAfter);
  // critic r2 P2-4: past this call a session may exist even when an error comes back (only "offline" means nothing was sent)
  const result = await hub.call('claude.start', { title, prompt, page, chatContext, model, effort: 'medium' }, { host }).catch((err) => { throw Object.assign(bridgeError(err), { mayHaveRun: !notSent(err, host) }); });
  audit({ action: 'claude.start', ip, detail: `${result?.sid} ${model}: ${short(title, 80)}` });
  return result;
}
