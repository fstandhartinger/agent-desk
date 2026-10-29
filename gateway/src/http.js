import { TEXT } from './messages.js';
// Small helpers around node:http shared by the route modules.
export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(TEXT.bodyTooLarge), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, maxBytes = 1_000_000) {
  const raw = await readBody(req, maxBytes);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw Object.assign(new Error(TEXT.badJson), { status: 400 });
  }
}

export function clientIp(req) {
  // Behind Coolify's proxy the rightmost X-Forwarded-For entry is the one the proxy appended itself.
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.at(-1) || req.socket.remoteAddress || 'unknown';
}

export function openSse(res, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extraHeaders,
  });
  res.write(': open\n\n');
  const timer = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => clearInterval(timer));
  return {
    send(event, id) {
      if (res.writableEnded || res.destroyed) return;
      res.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify(event)}\n\n`);
    },
  };
}
