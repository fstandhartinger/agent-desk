import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { sendJson } from './http.js';
import { TEXT } from './messages.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = [process.env.DESK_PUBLIC_DIR, path.resolve(here, '../public'), path.resolve(here, 'public')].find((dir) => dir && existsSync(dir));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt', '.map']);
const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const files = new Map(); // absolute path -> {raw, br, gz, type, compressible}

async function load(file) {
  let entry = files.get(file);
  if (!entry) {
    const ext = path.extname(file);
    const raw = await readFile(file);
    entry = { raw, type: TYPES[ext] || 'application/octet-stream', compressible: COMPRESSIBLE.has(ext) && raw.length > 512 };
    if (entry.compressible) [entry.br, entry.gz] = await Promise.all([brotli(raw), gzip(raw)]);
    files.set(file, entry);
  }
  return entry;
}

async function resolveFile(pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (relative.includes('\0')) return null;
  const target = path.join(ROOT, path.normalize(relative));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  const info = await stat(target).catch(() => null);
  if (info?.isFile()) return target;
  // Unknown paths with an extension are real 404s; extensionless ones belong to the SPA.
  return path.extname(relative) ? null : path.join(ROOT, 'index.html');
}

export async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: TEXT.methodNotAllowed });
  const file = ROOT && (await resolveFile(pathname));
  if (!file || !existsSync(file)) return sendJson(res, 404, { error: TEXT.notFound });
  const entry = await load(file);
  const accept = String(req.headers['accept-encoding'] || '');
  const encoding = entry.compressible && (/\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gz' : null);
  const body = encoding ? entry[encoding] : entry.raw;
  const isHtml = file.endsWith('.html');
  res.writeHead(200, {
    'content-type': entry.type,
    'content-length': body.length,
    'cache-control': isHtml || !file.includes(`${path.sep}assets${path.sep}`) ? 'no-cache' : 'public, max-age=31536000, immutable',
    vary: 'Accept-Encoding',
    ...(encoding && { 'content-encoding': encoding === 'br' ? 'br' : 'gzip' }),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
