// End to end against real services: real vendor, real trace service, real registry. Prints the a# id. node test/manual/voice-trace-e2e.mjs <provider> <pcm dir>
import http from 'node:http';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { handleVoiceUpgrade } from '../../src/voice/index.js';
import { TOOL_DEFS } from '../../src/tools.js';
import { createTraceService } from '../../src/trace.js';

const [, , provider = 'xai', dir = '/tmp'] = process.argv;
const traces = createTraceService({ log: (l) => console.log('LOG', String(l).slice(0, 200)) });
const STUB = { mail_search: () => JSON.stringify({ messages: [{ account: 'gmail', uid: '37156', date: 'Mon, 2 Nov 2026 11:45:35', from: 'Benjamin Merkel', subject: 'Re: TrustedTokens als EU-Miner auf SN92' }] }), mail_read: () => JSON.stringify({ from: 'Benjamin Merkel', subject: 'Re: TrustedTokens als EU-Miner auf SN92', body: 'Wir melden uns mit Rückfragen.' }) };
const deps = {
  wss: new WebSocketServer({ noServer: true }), sid: 'e2e-test', toolDefs: TOOL_DEFS, makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, audit() {},
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
  async runTool(name) { return { ok: true, summary: name, content: (STUB[name] ?? (() => '{"hinweis":"nichts gefunden"}'))() }; },
  openTrace: ({ provider: p }) => traces.open({ provider: p, kind: 'voice', sid: 'e2e-test' }),
};
const server = http.createServer();
server.on('upgrade', (req, socket, head) => handleVoiceUpgrade(req, socket, head, deps));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice?provider=${provider}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CH = 24000 * 2 * 0.04;
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', page: { slug: 'e2e-trace-test', title: 'E2E-Test' }, client: { app: 'web', version: 'e2e', commit: 'local', device: 'desktop' }, entry: { path: 'card>interactive>desk', page_aid: 'f12977', card: '19124' } })));
ws.on('message', async (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.type === 'session') console.log('SESSION', m.aid);
  if (m.type === 'transcript' && m.final) console.log(m.role, m.text.slice(0, 160));
  if (m.type !== 'ready') return;
  await sleep(500);
  const b = readFileSync(`${dir}/tng.pcm`);
  for (let o = 0; o < b.length; o += CH) { ws.send(b.subarray(o, o + CH)); await sleep(40); }
  for (let i = 0; i < 400; i++) { ws.send(Buffer.alloc(CH)); await sleep(40); }
  ws.send(JSON.stringify({ type: 'mute', muted: true, source: 'dock' }));
  await sleep(2000);
  ws.send(JSON.stringify({ type: 'mute', muted: false, source: 'dock' }));
  ws.send(JSON.stringify({ type: 'client_event', event: { ts: Date.now(), type: 'ws.open', data: {} } }));
  await sleep(500);
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(3000);
  process.exit(0);
});
setTimeout(() => process.exit(2), 60_000);
