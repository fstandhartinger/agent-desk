// Real-vendor check of screen vision: passive context triggers no reply; "was siehst du" is answered concretely and truly; without an agent it says it sees nothing.
// node test/manual/voice-screen-live.mjs <xai|openai|gemini> <pcm dir with see.pcm> <jpeg dir with s1.jpg s2.jpg> [noagent]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { handleVoiceUpgrade } from '../../src/voice/index.js';
import { TOOL_DEFS } from '../../src/tools.js';
import { createDeviceMedia } from '../../src/deviceMedia.js';
import { createScreenVision } from '../../src/screenVision.js';

const [, , provider = 'openai', dir = '/tmp', jpegs = '/tmp', mode = ''] = process.argv;
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const vision = createScreenVision({ media: createDeviceMedia({ env: process.env }), artifacts: { screen: () => ({ ids: [] }), setScreen: async () => ({}) } });
const SID = 'live';
const tools = [];
const deps = {
  wss: new WebSocketServer({ noServer: true }), sid: SID, toolDefs: TOOL_DEFS, vision,
  async runTool(name, args) {
    tools.push(name); log('TOOL', name, JSON.stringify(args).slice(0, 80));
    if (name === 'look_at_screen') { const r = await vision.look(SID, args.question); log('LOOK', JSON.stringify(r).slice(0, 240)); return { ok: true, summary: name, content: JSON.stringify(r) }; }
    return { ok: true, summary: name, content: '{"hinweis":"nichts gefunden"}' };
  },
  makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} }, audit: (e) => { if (/no_answer|unanswered|stale/.test(e.action)) log('AUDIT', e.action, e.detail); },
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
  openTrace: () => ({ event: (t, d) => { if (/^screen\.(context|vision|attach)/.test(t)) log('TRACE', t, JSON.stringify({ how: d.how, chars: d.chars, ms: d.ms, costUsd: d.costUsd, changed: d.changed })); }, close() {} }),
};
const server = http.createServer();
server.on('upgrade', (req, socket, head) => handleVoiceUpgrade(req, socket, head, deps));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice?provider=${provider}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CH = 24000 * 2 * 0.04;
const assistant = [];
const finals = [];
let v = 0;
const frame = (f, reason, commandId) => vision.frame(SID, { deviceId: 'd' }, { deviceId: 'd', frameVersion: v++, jpeg: readFileSync(`${jpegs}/${f}`).toString('base64'), process: 'chrome', title: 'Dashboard', masked: 0, ids: [], reason, ...(commandId ? { commandId } : {}) });
async function agent() { // a Screen Agent's command loop
  for (;;) { const c = await Promise.resolve().then(() => vision.poll(SID, { deviceId: 'd' })).catch(() => null); if (!c) return; if (c.fresh) { log('fresh frame asked'); log('fresh ->', JSON.stringify(await frame('s2.jpg', 'fresh', c.id)).slice(0, 120)); } }
}
const silence = async (ms) => { for (let i = 0; i < ms / 40; i++) { ws.send(Buffer.alloc(CH)); await sleep(40); } };
async function run() {
  await silence(500);
  if (mode !== 'noagent') {
    agent();
    log('start frame', JSON.stringify(await frame('s1.jpg', 'start')).slice(0, 120));
    await silence(1000);
    log('interval frame', JSON.stringify(await frame('s2.jpg', 'interval')).slice(0, 120));
    await silence(14000);
    log(assistant.length ? `FAIL passive context produced speech: ${assistant.join(' ').slice(0, 200)}` : 'PASS no reply to passive context in 15 s');
  }
  const b = readFileSync(`${dir}/see.pcm`);
  for (let o = 0; o < b.length; o += CH) { ws.send(b.subarray(o, o + CH)); await sleep(40); }
  await silence(38000);
  const said = `${finals.join(' ')} ${assistant.join('')}`;
  log('ANSWER', said.slice(0, 500));
  log('RESULT', provider, mode || 'agent', JSON.stringify({ tools, numbers: /12[.\s,]?480|3[.\s,]?(215|390)|zwölf|dreitausend/i.test(said), denies: /kein(en)? (bild|zugriff)|sehe (deinen|den) bildschirm nicht|nicht sehen/i.test(said) }));
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(300);
  process.exit(0);
}
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.type === 'transcript' && m.role === 'assistant') { if (m.final) { assistant.length = 0; assistant.push(m.text); finals.push(m.text); } else assistant.push(m.delta ?? ''); }
  if (m.type === 'transcript' && m.final) log(m.role.toUpperCase(), m.text.slice(0, 260));
  if (['error', 'notice', 'closed'].includes(m.type)) log('EVENT', JSON.stringify(m).slice(0, 160));
  if (m.type === 'ready') run().catch((e) => { log('FAIL', e.message); process.exit(1); });
});
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de' })));
setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 120_000);
