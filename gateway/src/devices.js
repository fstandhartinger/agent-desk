import crypto from 'node:crypto';
import fs from 'node:fs';
import { artifactId } from './artifacts.js';
import { cfg } from './config.js';
import { originOk, readSession } from './auth.js';
import { readBody, readJson, sendJson, clientIp } from './http.js';
import { createDeviceMedia, deviceError as fail, deviceIds, imageBytes, dictateContext, correctionPair, wavDuration } from './deviceMedia.js';

const SCOPES = ['dictate', 'dictionary', 'screen', 'exists'];
const TTL = 90 * 24 * 3600_000;
export function createDeviceService({ artifacts, env = process.env, now = Date.now, fetchImpl = fetch, media = createDeviceMedia({ env, fetchImpl }) } = {}) {
  const file = env.DESK_DEVICES_FILE || '/tmp/agent-desk-devices.json';
  let records = [];
  try { records = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(records)) throw Error('format'); }
  catch (err) { if (err.code !== 'ENOENT') throw fail('Gerätespeicher kann nicht gelesen werden.', 503); }
  const hash = token => crypto.createHmac('sha256', cfg.sessionSecret()).update(token).digest('hex');
  const hits = new Map();
  function rate(key, max) {
    const time = now(), entry = hits.get(key);
    if (!entry || entry.until <= time) {
      for (const [k, v] of hits) if (v.until <= time) hits.delete(k);
      if (hits.size >= 5000) throw fail('Zu viele Anfragen.', 429);
      hits.set(key, { n: 1, until: time + 60000 }); return;
    }
    if (++entry.n > max) throw Object.assign(fail('Zu viele Anfragen.', 429), { retryAfter: Math.ceil((entry.until - time) / 1000) });
  }
  function persist(next) {
    const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); records = next; }
    catch { try { fs.unlinkSync(tmp); } catch {} throw fail('Gerätespeicher nicht verfügbar.', 503); }
  }
  const list = sid => records.filter(r => r.sid === sid && r.expiresAt > now()).map(({ hash: _, sid: __, ...rest }) => rest);
  let dict = null;
  async function registry(path, body) {
    if (!env.ARTIFACTS_URL || !env.ARTIFACTS_DESK_TOKEN) throw fail('Registry ist nicht eingerichtet.', 503);
    try {
      const res = await fetchImpl(new URL(path, env.ARTIFACTS_URL), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${env.ARTIFACTS_DESK_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw Error('upstream');
      let length = 0; const chunks = [];
      for await (const chunk of res.body) { length += chunk.length; if (length > 1000000) throw Error('size'); chunks.push(Buffer.from(chunk)); }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch { throw fail('Registry ist nicht erreichbar.', 502); }
  }
  async function dictionary() {
    if (!dict || dict.expires <= now()) dict = { value: await registry('/v1/dictionary'), expires: now() + 300000 };
    return structuredClone(dict.value);
  }
  async function route(req, res, url) {
    const path = url.pathname;
    if (!path.startsWith('/api/device/')) return false;
    res.setHeader('cache-control', 'no-store');
    // No CORS headers, no cross-origin requests (including reads), no cookie fallback for native APIs.
    if (req.headers.origin && !originOk(req)) throw fail('Zugriff verweigert.', 403);
    const management = path === '/api/device/pair' || path === '/api/device/list' || path.startsWith('/api/device/revoke/');
    if (management) {
      const session = readSession(req);
      if (!session) throw fail('Bitte anmelden.', 401);
      if (req.method !== 'GET' && !originOk(req)) throw fail('Zugriff verweigert.', 403);
      rate(`manage:${session.sid}`, 20);
      if (path === '/api/device/list' && req.method === 'GET') sendJson(res, 200, { devices: list(session.sid) });
      else if (path === '/api/device/pair' && req.method === 'POST') {
        const token = crypto.randomBytes(32).toString('base64url'), deviceId = crypto.randomUUID(), expiresAt = now() + TTL;
        const active = records.filter(r => r.expiresAt > now());
        if (active.length >= 1000 || list(session.sid).length >= 20) throw fail('Gerätelimit erreicht.', 429);
        persist([...active, { deviceId, hash: hash(token), sid: session.sid, expiresAt, scopes: SCOPES }]);
        sendJson(res, 200, { token, deviceId, expiresAt });
      } else if (path.startsWith('/api/device/revoke/') && req.method === 'DELETE') {
        const id = path.slice('/api/device/revoke/'.length);
        if (!list(session.sid).some(r => r.deviceId === id)) throw fail('Gerät nicht gefunden.', 404);
        persist(records.filter(r => r.deviceId !== id || r.sid !== session.sid)); sendJson(res, 200, { ok: true });
      } else throw fail('Methode nicht erlaubt.', 405);
      return true;
    }
    rate(`ip:${clientIp(req)}`, 240);
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
    const record = token && cfg.sessionSecret() && records.find(r => r.hash === hash(token) && r.expiresAt > now());
    if (!record) throw fail('Gerätezugang ungültig.', 401);
    rate(`device:${record.deviceId}`, 120);
    const target = /^\/api\/device\/session\/([^/]+)\/(screen|highlight)$/.exec(path);
    const scope = target ? 'screen' : path.split('/')[3];
    if (!record.scopes.includes(scope)) throw fail('Zugriff verweigert.', 403);
    if (target && target[1] !== record.sid) throw fail('Fremde Sitzung.', 403);
    if (path === '/api/device/exists' && req.method === 'GET') {
      const ids = deviceIds(url.searchParams.get('ids') === '' ? [] : (url.searchParams.get('ids') ?? '').split(','));
      const result = ids.length ? await registry(`/v1/exists?ids=${ids.join(',')}`) : { known: [] };
      sendJson(res, 200, { known: deviceIds((result.known ?? []).map(artifactId)).filter(id => ids.includes(id)) });
    } else if (path === '/api/device/dictionary' && req.method === 'GET') sendJson(res, 200, await dictionary());
    else if (path === '/api/device/dictionary/learn' && req.method === 'POST') {
      const { from, to } = correctionPair(await readJson(req, 2048));
      await registry('/v1/dictionary', { term: to, replace_from: [from], source: 'learned' }); dict = null;
      sendJson(res, 200, { ok: true });
    } else if (target && target[2] === 'screen' && req.method === 'POST') {
      const body = await readJson(req, 8192), ids = deviceIds(body.ids);
      if (!Number.isSafeInteger(body.frameVersion) || body.frameVersion < 0 || !body.window || typeof body.window.blocked !== 'boolean' || typeof body.window.process !== 'string' || body.window.process.length > 100) throw fail('Ungültiger Bildschirm-Kontext.');
      sendJson(res, 200, await artifacts.setScreen(record.sid, { ids: body.window.blocked ? [] : ids, window: { process: body.window.blocked ? '' : body.window.process, blocked: body.window.blocked }, frameVersion: body.frameVersion }));
    } else if (target && target[2] === 'highlight' && req.method === 'POST') {
      rate(`media:${record.deviceId}`, 12);
      const body = await readJson(req, 4 * 1024 * 1024 + 8192), ids = deviceIds(body.ids);
      const crop = imageBytes(body.crop, 2 * 1024 * 1024, 'png'), context = body.context === undefined ? null : imageBytes(body.context, 1024 * 1024, 'jpeg');
      const box = body.bbox;
      if (!box || ['x', 'y', 'w', 'h'].some(k => !Number.isSafeInteger(box[k]) || Math.abs(box[k]) > 100000) || box.w <= 0 || box.h <= 0) throw fail('Ungültiger Bildausschnitt.');
      const summary = await media.highlight(crop, context, { x: box.x, y: box.y, w: box.w, h: box.h }, ids);
      artifacts.contextTurn(record.sid, `[Markierung] Ich habe auf dem Bildschirm etwas markiert: ${summary} (IDs: ${ids.map(id => `a#${id}`).join(', ')})`);
      artifacts.addHighlight(record.sid, summary, ids);
      sendJson(res, 200, { ok: true, summary });
    } else if (path === '/api/device/dictate' && req.method === 'POST') {
      rate(`media:${record.deviceId}`, 12);
      if (!/^multipart\/form-data;\s*boundary=/i.test(req.headers['content-type'] ?? '')) throw fail('Multipart erforderlich.', 415);
      const bytes = await readBody(req, 60 * 32000 + 65536);
      let form;
      try { form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type'] } }).formData(); } catch { throw fail('Ungültiges Multipart.'); }
      const audio = form.get('audio');
      if (!audio || typeof audio.arrayBuffer !== 'function' || audio.size > 60 * 32000 + 4096 || form.getAll('audio').length !== 1 || form.getAll('context').length !== 1) throw fail('Audio fehlt oder ist zu groß.', audio?.size > 60 * 32000 + 4096 ? 413 : 400);
      let ctx; try { ctx = JSON.parse(form.get('context')); } catch { throw fail('Ungültiger Kontext.'); }
      ctx = dictateContext(ctx);
      const buffer = Buffer.from(await audio.arrayBuffer());
      wavDuration(buffer);
      sendJson(res, 200, await media.dictate(buffer, ctx, dictionary().catch(() => ({ items: [] }))));
    } else throw fail('Methode oder Route nicht erlaubt.', 405);
    return true;
  }
  return { route, dictionary };
}
