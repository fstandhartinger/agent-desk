import { audit } from './audit.js';
import { SID, bridgeError, eventsOf, formatChatContext, sessionsOf, startClaudeSession } from './claudeSessions.js';
import { openSse, readJson, sendJson } from './http.js';
import { loadPageContext } from './page.js';
import { TEXT } from './messages.js';
import { short } from './redact.js';

const HOST = /^[a-z0-9-]{1,24}$/;
const MODELS = new Set(['opus', 'sonnet']);
const ROUTE = /^\/api\/claude\/sessions(?:\/([^/]+)(?:\/(messages|stop|events))?)?$/;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function hostOf(value) {
  const host = value ?? 'lechonk';
  if (typeof host !== 'string' || !HOST.test(host)) throw badRequest(TEXT.badHost);
  return host;
}

async function bridge(hub, method, params, host) {
  try {
    return await hub.call(method, params, { host });
  } catch (err) {
    throw bridgeError(err);
  }
}

const clip = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);

/** Page context for PROMPT.md: title, scene, point and narration come from the published explainer; the browser's own title is the fallback. */
async function pageForClaude(raw) {
  if (!raw || typeof raw.slug !== 'string') return undefined;
  const page = { slug: raw.slug.slice(0, 80), title: clip(raw.title, 200), t: Number(raw.t) || 0, sceneId: clip(raw.sceneId, 60), pointId: clip(raw.pointId, 60), transcriptNear: clip(raw.transcriptNear, 1500) };
  const loaded = await loadPageContext(page).catch(() => null);
  return loaded ? { ...page, title: loaded.title, sceneId: loaded.sceneId, point: loaded.point, transcriptNear: loaded.transcriptNear || page.transcriptNear } : page;
}

/** Handles /api/claude/sessions*; returns false when the URL is not ours. */
export async function handleClaudeApi(req, res, url, { sid, ip, hub, limits }) {
  const match = ROUTE.exec(url.pathname);
  if (!match) return false;
  const [, id, action] = match;
  if (id && !SID.test(id)) throw badRequest(TEXT.badSession);
  const host = hostOf(url.searchParams.get('host') ?? undefined);

  if (!id && req.method === 'GET') {
    sendJson(res, 200, sessionsOf(await bridge(hub, 'claude.list', {}, host)));
  } else if (!id && req.method === 'POST') {
    const body = await readJson(req, 100_000);
    if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 20_000) throw badRequest(TEXT.promptRequired);
    if (body.model !== undefined && !MODELS.has(body.model)) throw badRequest(TEXT.badModel);
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : short(body.prompt, 60);
    const chatContext = formatChatContext(body.chatContext);
    const page = await pageForClaude(body.page);
    const result = await startClaudeSession({ hub, limits, sid, audit, ip, host: hostOf(body.host), title, prompt: body.prompt, model: body.model, page, chatContext });
    sendJson(res, 200, { sid: result.sid });
  } else if (id && action === 'messages' && req.method === 'POST') {
    const body = await readJson(req, 100_000);
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20_000) throw badRequest(TEXT.textRequired);
    await bridge(hub, 'claude.send', { sid: id, text: body.text }, host);
    audit({ action: 'claude.send', ip, detail: `${id}: ${body.text}` });
    sendJson(res, 200, { ok: true });
  } else if (id && action === 'stop' && req.method === 'POST') {
    await bridge(hub, 'claude.stop', { sid: id }, host);
    audit({ action: 'claude.stop', ip, detail: id });
    sendJson(res, 200, { ok: true });
  } else if (id && action === 'events' && req.method === 'GET') {
    await streamEvents(req, res, url, id, hub, host);
  } else {
    sendJson(res, 405, { error: TEXT.methodNotAllowed });
  }
  return true;
}

/** SSE: replay from Last-Event-ID / ?since= via claude.get, then live events; reconnects of the bridge trigger a gap-fill replay. */
async function streamEvents(req, res, url, id, hub, host) {
  let last = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
  if (!Number.isFinite(last) || last < 0) last = 0;
  const sse = openSse(res);
  const buffered = [];
  let replaying = true;

  const deliver = (event) => {
    if (typeof event?.seq === 'number') {
      if (event.seq <= last) return;
      last = event.seq;
    }
    sse.send(event, event?.seq);
  };
  const replay = async () => {
    replaying = true;
    try {
      for (const event of eventsOf(await hub.call('claude.get', { sid: id, sinceSeq: last }, { host }))) deliver(event);
    } catch (err) {
      sse.send({ seq: last, ts: new Date().toISOString(), kind: 'error', message: short(err.message, 160) });
    }
    for (const event of buffered.splice(0)) deliver(event);
    replaying = false;
  };
  const unsubscribe = hub.subscribe(`claude:${id}`, (event) => (replaying ? buffered.push(event) : deliver(event)));
  const onUp = (upHost) => upHost === host && replay();
  hub.on('bridge-up', onUp);
  res.on('close', () => {
    unsubscribe();
    hub.off('bridge-up', onUp);
  });
  await replay();
}
