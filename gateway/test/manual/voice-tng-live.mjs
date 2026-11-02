// Real-vendor replay of the 2 Nov incident: first question, barge-in with "newest TNG mail", silent 90 s while muted, a follow-up after unmute.
// node test/manual/voice-tng-live.mjs <xai|openai|gemini> <pcm dir>   (24 kHz PCM from ElevenLabs: q1.pcm, tng.pcm, q3.pcm; tools are stubs with the reference mail)
import http from 'node:http';
import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { handleVoiceUpgrade } from '../../src/voice/index.js';
import { TOOL_DEFS } from '../../src/tools.js';

const [, , provider = 'openai', dir = '/tmp', muteSeconds = '90'] = process.argv;
const pcm = (n) => readFileSync(`${dir}/${n}.pcm`);
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const t0 = Date.now();
const toolCalls = [];
const STUB = {
  mail_search: () => JSON.stringify({ messages: [{ account: 'gmail', uid: '37156', date: 'Mon, 2 Nov 2026 11:45:35', from: 'Benjamin Merkel <benjamin.merkel@tngtech.com>', subject: 'Re: TrustedTokens als EU-Miner auf SN92 – Integrationsbeschreibung' }, { account: 'gmail', uid: '36859', date: 'Fri, 30 Oct 2026 12:46:41', from: 'Benjamin Merkel <benjamin.merkel@tngtech.com>', subject: 'Re: TrustedTokens als EU-Miner auf SN92' }] }),
  mail_read: () => JSON.stringify({ from: 'Benjamin Merkel', date: '2 Nov 2026 11:45', subject: 'Re: TrustedTokens als EU-Miner auf SN92', body: 'Hallo Florian, danke für die Integrationsbeschreibung, wir melden uns mit Rückfragen.' }),
  knowledge_read: () => JSON.stringify({ topic: 'tng', content: 'TNG Technology Consulting: Partner, betreibt TrustedTokens. Keine Mails in diesem Wissen.' }),
};
const deps = {
  wss: new WebSocketServer({ noServer: true }), sid: 'live', toolDefs: TOOL_DEFS,
  async runTool(name, args) { toolCalls.push(name); log('TOOL', name, JSON.stringify(args).slice(0, 90)); return { ok: true, summary: name, content: (STUB[name] ?? (() => '{"hinweis":"nichts gefunden"}'))() }; },
  makeCtx: (page) => ({ page }), limits: { check: () => ({ ok: true }), addCost() {} }, audit: (e) => { if (/barge|watchdog|no_answer|unanswered|stale|mute/.test(e.action)) log('AUDIT', e.action, e.detail); },
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
};
const server = http.createServer();
server.on('upgrade', (req, socket, head) => handleVoiceUpgrade(req, socket, head, deps));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice?provider=${provider}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CH = 24000 * 2 * 0.04;
let closed = false;
let answerAudio = 0;
const assistant = [];
async function say(b, trail = 0) {
  for (let o = 0; o < b.length; o += CH) { ws.send(b.subarray(o, o + CH)); await sleep(40); }
  for (let i = 0; i < trail / 40; i++) { ws.send(Buffer.alloc(CH)); await sleep(40); }
}
async function silent(ms) { for (let i = 0; i < ms / 40 && !closed; i++) { ws.send(Buffer.alloc(CH)); await sleep(40); } }
const waitFor = async (re, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(assistant.join(' '))) return true; ws.readyState === 1 && ws.send(Buffer.alloc(CH)); await sleep(40); } return false; };
ws.on('message', async (data, isBinary) => {
  if (isBinary) { answerAudio += data.length; return; }
  const m = JSON.parse(data.toString());
  if (m.type === 'transcript' && m.final) { log(m.role.toUpperCase(), m.text.slice(0, 220)); if (m.role === 'assistant') assistant.push(m.text); }
  else if (m.type === 'transcript' && m.role === 'assistant') assistant.push(m.delta);
  else if (['ready', 'error', 'notice', 'closed', 'mute'].includes(m.type)) log('EVENT', JSON.stringify(m).slice(0, 160));
  if (m.type === 'ready') run().catch((e) => { log('FAIL', e.message); process.exit(1); });
});
ws.on('close', () => { closed = true; });
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', page: { slug: 'inbound-people-20261102-n5bj31qg3v', title: 'Eingehende Personen', t: 1 } })));
async function run() {
  await silent(800);
  await say(pcm('q1'), 800); // an answer starts
  const started = answerAudio;
  for (let i = 0; i < 300 && answerAudio === started; i++) { ws.send(Buffer.alloc(CH)); await sleep(40); }
  log('assistant audio is running: barge-in with the TNG question');
  await say(pcm('tng'), 900);
  const ok = await waitFor(/merkel|trustedtokens|benjamin/i, 45000);
  log(ok ? 'PASS answer names the mail' : 'FAIL no answer naming the mail', 'tools:', toolCalls.join(','));
  await silent(4000);
  const before = assistant.length;
  ws.send(JSON.stringify({ type: 'mute', muted: true, source: 'test' }));
  log(`muted, no frames for ${muteSeconds} s`);
  await sleep(Number(muteSeconds) * 1000);
  const survived = !closed;
  log(survived ? 'session survived the mute' : 'FAIL vendor closed during mute', 'assistant turns during mute:', assistant.length - before);
  ws.send(JSON.stringify({ type: 'mute', muted: false }));
  await silent(5000);
  log('after unmute, silent 5 s, new assistant text:', assistant.length - before);
  await say(pcm('q3'), 900);
  const again = await waitFor(/\w{4,}/, 1) && (await (async () => { const n = assistant.length; const end = Date.now() + 30000; while (Date.now() < end && assistant.length === n) { ws.send(Buffer.alloc(CH)); await sleep(40); } return assistant.length > n; })());
  log(again ? 'PASS same session answers after unmute' : 'FAIL no answer after unmute');
  ws.send(JSON.stringify({ type: 'stop' }));
  await sleep(500);
  log('RESULT', provider, JSON.stringify({ answered: ok, tools: toolCalls, survivedMute: survived, answeredAfterUnmute: again }));
  process.exit(ok && again ? 0 : 1);
}
setTimeout(() => { log('TIMEOUT'); process.exit(2); }, 300_000);
