import { cfg } from './config.js';
import { sendJson } from './http.js';
import { TEXT } from './messages.js';

const SLUG = /^[a-z0-9-]{3,80}$/;
const NAMED_FILES = new Set(['index.html', 'stage.html', 'explainer-core.js', 'timeline.js', 'timeline.json', 'points.json', 'audio.mp3', 'words.json', 'metadata.json', 'card.json']);
const ASSET = /^[a-z0-9_-]+\.(png|jpg|svg|webp|woff2|css|js)$/;
const TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8', css: 'text/css; charset=utf-8',
  mp3: 'audio/mpeg', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', woff2: 'font/woff2',
};
const TTL_MS = 10 * 60_000;
const MAX_ENTRY_BYTES = 8_000_000;
const MAX_CACHE_BYTES = 64_000_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
// The stage and player pages carry inline script/style by design; they are Florian's own published explainers.
export const EXPLAINER_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'";

const cache = new Map(); // "slug/file" -> {status, type, body, exp}
let cacheBytes = 0;

export const validPath = (slug, file) => SLUG.test(slug) && (NAMED_FILES.has(file) || ASSET.test(file) || /^end-frames\/\d{3}\.png$/.test(file));
const extOf = (file) => file.slice(file.lastIndexOf('.') + 1);

function remember(key, entry) {
  const old = cache.get(key);
  if (old) cacheBytes -= old.body.length;
  while (cacheBytes + entry.body.length > MAX_CACHE_BYTES && cache.size) {
    const [oldestKey, oldest] = cache.entries().next().value;
    cache.delete(oldestKey);
    cacheBytes -= oldest.body.length;
  }
  cache.set(key, entry);
  cacheBytes += entry.body.length;
}

async function fetchUpstream(slug, file, headers = {}) {
  return fetch(`${cfg.explainerOrigin()}/p/${slug}/${file}`, { headers, redirect: 'error', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
}

/** Cached body of an explainer file, or null when upstream does not have it. */
export async function fetchExplainerFile(slug, file) {
  if (!validPath(slug, file)) return null;
  const key = `${slug}/${file}`;
  const hit = cache.get(key);
  if (file !== 'card.json' && hit && hit.exp > Date.now()) return hit;
  const upstream = await fetchUpstream(slug, file);
  if (!upstream.ok) return null;
  const body = Buffer.from(await upstream.arrayBuffer());
  const entry = { status: 200, type: TYPES[extOf(file)], body, exp: Date.now() + TTL_MS };
  if (file !== 'card.json' && body.length <= MAX_ENTRY_BYTES) remember(key, entry);
  return entry;
}

export async function fetchExplainerJson(slug, file) {
  try {
    const entry = await fetchExplainerFile(slug, file);
    return entry ? JSON.parse(entry.body.toString('utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * PRIVATE explainer files (context.json, deepdive.md): fetched with the bearer token, cached like the others, never reachable
 * through validPath/handleExplainer (the browser proxy). Without token or on 404 the result is null (cached, so the fallback is cheap).
 */
const PRIVATE_FILES = new Set(['context.json', 'deepdive.md']);
export async function fetchExplainerPrivate(slug, file) {
  const token = cfg.explainerContextToken();
  if (!token || !SLUG.test(slug) || !PRIVATE_FILES.has(file)) return null;
  const key = `private:${slug}/${file}`;
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.status === 200 ? hit.body : null;
  try {
    const upstream = await fetchUpstream(slug, file, { authorization: `Bearer ${token}` });
    if (!upstream.ok) {
      remember(key, { status: upstream.status, body: Buffer.alloc(0), exp: Date.now() + TTL_MS });
      return null;
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length <= MAX_ENTRY_BYTES) remember(key, { status: 200, body, exp: Date.now() + TTL_MS });
    return body;
  } catch {
    return null; // network trouble: not cached, the next session tries again
  }
}

const COMMON = { 'cache-control': 'private, max-age=600', 'content-security-policy': EXPLAINER_CSP };

async function streamAudio(req, res, slug, file) {
  const upstream = await fetchUpstream(slug, file, req.headers.range ? { range: req.headers.range } : {});
  if (!upstream.ok && upstream.status !== 206) return sendJson(res, upstream.status === 404 ? 404 : 502, { error: TEXT.explainerMissing });
  const headers = { ...COMMON, 'content-type': TYPES.mp3, 'accept-ranges': 'bytes' };
  for (const name of ['content-length', 'content-range']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  if (req.method === 'HEAD' || !upstream.body) return res.end();
  const reader = upstream.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
  }
  res.end();
}

export async function handleExplainer(req, res, slug, file) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: TEXT.methodNotAllowed });
  if (!validPath(slug, file)) return sendJson(res, 400, { error: TEXT.explainerPath });
  try {
    if (file === 'audio.mp3') return await streamAudio(req, res, slug, file);
    const entry = await fetchExplainerFile(slug, file);
    if (!entry) return sendJson(res, 404, { error: TEXT.notFound });
    res.writeHead(200, { ...COMMON, ...(file === 'card.json' ? { 'cache-control': 'no-store' } : {}), 'content-type': entry.type, 'content-length': entry.body.length });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
  } catch {
    if (!res.headersSent) sendJson(res, 502, { error: TEXT.explainerDown });
    else res.destroy();
  }
}

export function clearExplainerCacheForTests() {
  cache.clear();
  cacheBytes = 0;
}
