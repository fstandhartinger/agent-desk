import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { syn } from '../synthetic.js';

export const CODE = 'test-access-code-0123456789';
export const BRIDGE_TOKEN = 'bridge-token-abcdefghijklmnop';
export const DESK_ORIGIN = 'https://desk.test';

export function setEnv(extra = {}) {
  Object.assign(process.env, {
    DESK_ACCESS_CODE: CODE,
    DESK_SESSION_SECRET: syn('sess·ion-·secr·et-0·1234·5678·9abc·def'),
    BRIDGE_TOKEN,
    DESK_ORIGIN,
    DESK_VIZ_GRACE_MS: '0',
    OPENROUTER_API_KEY: 'or-test-key',
    DESK_DEVICES_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-devices-')), 'devices.json'),
    DESK_REVOKED_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-revoked-')), 'revoked.json'),
    DESK_LINK_USES_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-links-')), 'uses.json'),
    ...extra,
  });
}

export async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

export async function startGateway() {
  const { createApp } = await import('../../src/server.js');
  const app = createApp();
  const port = await listen(app.server);
  return { ...app, port, base: `http://127.0.0.1:${port}`, close: () => app.server.close() };
}

export async function login(base, headers = {}) {
  const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ code: CODE }) });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  return { res, cookie };
}

/** Bridge stand-in: dials /bridge and answers requests with handlers[method](params). */
export async function connectFakeBridge(port, handlers, { token = BRIDGE_TOKEN, host = 'lechonk' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge?host=${host}`, { headers: { authorization: `Bearer ${token}` } });
  const requests = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.t !== 'req') return;
    requests.push(msg);
    Promise.resolve()
      .then(() => handlers[msg.method]?.(msg.params))
      .then((result) => ws.send(JSON.stringify(msg.method in handlers ? { t: 'res', id: msg.id, ok: true, result } : { t: 'res', id: msg.id, ok: false, error: 'unknown method' })))
      .catch((err) => ws.send(JSON.stringify({ t: 'res', id: msg.id, ok: false, error: err.message })));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'hello', host, version: 'test', caps: Object.keys(handlers), claude: { running: 0, max: 3 } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ws, requests, emit: (topic, data) => ws.send(JSON.stringify({ t: 'evt', topic, data })) };
}

/** Local HTTP server; handler(req, res, body) gets the parsed JSON body (or raw text). */
export async function fakeServer(handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    let body = raw.toString('utf8');
    try { body = JSON.parse(body); } catch { /* keep text */ }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    handler(req, res, body);
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

/** Reads an SSE response into parsed events; stops when `until(events)` is true or the stream ends. */
export async function readSse(res, until = () => false, timeoutMs = 5000) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  const timer = setTimeout(() => res.body.cancel().catch(() => {}), timeoutMs);
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        const id = block.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim();
        if (data) events.push({ ...JSON.parse(data), _id: id });
      }
      if (until(events)) break;
    }
  } finally {
    clearTimeout(timer);
    res.body.cancel().catch(() => {});
  }
  return events;
}

/** OpenRouter-style SSE body for a scripted completion. */
export function completionStream({ text = '', toolCalls = [], cost = 0.0001 }) {
  const frames = [];
  for (const piece of text.match(/.{1,6}/gs) ?? []) frames.push({ choices: [{ delta: { content: piece } }] });
  toolCalls.forEach((tc, index) => {
    frames.push({ choices: [{ delta: { tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.args.slice(0, 5) } }] } }] });
    frames.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: tc.args.slice(5) } }] } }] });
  });
  frames.push({ choices: [{ delta: {}, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, cost } });
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}
