// Real-session test (uses the real TOOL_DEFS; exits 1 if the vendor never reaches ready): node test/voice-live.mjs <xai|openai|gemini> [fast] [fixture=question|job]
// Fake browser -> handleVoiceUpgrade -> vendor. Saves the answer as /tmp/voice-<provider>-<fixture>.wav and the
// vendor frames (audio payloads elided) as test/fixtures/frames-<provider>.json when RECORD=1.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { handleVoiceUpgrade } from '../src/voice/index.js';
import { TOOL_DEFS } from '../src/tools.js';

const [, , provider = 'gemini', ...flags] = process.argv;
const fast = flags.includes('fast');
const fixture = flags.includes('job') ? 'job-status' : 'question';
const pcm = readFileSync(new URL(`./fixtures/${fixture}-de.pcm`, import.meta.url));

const frames = [];
const origEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function (ev, data, isBinary) {
  if (ev === 'message' && this._url?.startsWith('wss://') && !this._url.includes('127.0.0.1')) {
    try { frames.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  }
  return origEmit.call(this, ev, data, isBinary);
};

const toolCalls = [];
const deps = {
  wss: new WebSocketServer({ noServer: true }),
  sid: 'live-test',
  toolDefs: TOOL_DEFS, // the real production definitions: vendors reject schemas they dislike at setup time
  async runTool(name, args) {
    toolCalls.push({ name, args });
    return { summary: `job ${args.name}`, content: `Job ${args.name}: Status läuft. Phase 3 von 5 abgeschlossen, nächster Schritt ist der Review durch den Critic. Letzte Aktivität vor 4 Minuten.` };
  },
  makeCtx: (page) => ({ page }),
  limits: { check: () => ({ ok: true }), addCost: () => {} },
  audit: (e) => console.log('audit', JSON.stringify(e)),
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
};
const server = http.createServer();
server.on('upgrade', (req, socket, head) => handleVoiceUpgrade(req, socket, head, deps));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/voice?provider=${provider}${fast ? '&model=fast' : ''}`);
const audio = [];
const transcripts = [];
const events = [];
let tStart = 0;
let tFirstAudio = 0;
let lastAudioAt = 0;
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    if (!tFirstAudio) tFirstAudio = Date.now();
    lastAudioAt = Date.now();
    audio.push(Buffer.from(data));
    return;
  }
  const m = JSON.parse(data.toString());
  events.push(m);
  if (m.type === 'transcript' && m.final) transcripts.push(`${m.role}: ${m.text}`);
  if (m.type !== 'transcript') console.log('event', JSON.stringify(m).slice(0, 200));
  if (m.type === 'ready') stream();
});

async function stream() {
  tStart = Date.now();
  const chunk = 24000 * 2 * 0.04;
  for (let o = 0; o < pcm.length; o += chunk) {
    ws.send(pcm.subarray(o, o + chunk));
    await new Promise((r) => setTimeout(r, 40));
  }
  tStart = Date.now(); // latency counted from end of the question
  for (let i = 0; i < 400; i++) { // trailing silence so server VAD ends the turn
    ws.send(Buffer.alloc(chunk));
    await new Promise((r) => setTimeout(r, 40));
    if (tFirstAudio && Date.now() - lastAudioAt > 7000) break;
  }
  await new Promise((r) => setTimeout(r, 1500));
  ws.send(JSON.stringify({ type: 'stop' }));
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', page: { slug: 'demo', title: 'Demo-Explainer', t: 12 } })));
ws.on('close', () => {
  const all = Buffer.concat(audio);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + all.length, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(24000, 24); hdr.writeUInt32LE(48000, 28);
  hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(all.length, 40);
  const wav = `/tmp/voice-${provider}${fast ? '-fast' : ''}-${fixture}.wav`;
  writeFileSync(wav, Buffer.concat([hdr, all]));
  console.log('transcripts', transcripts);
  console.log('toolCalls', JSON.stringify(toolCalls));
  console.log(`audio ${(all.length / 48000).toFixed(1)} s -> ${wav}; first-audio latency ${tFirstAudio ? tFirstAudio - tStart : 'none'} ms`);
  if (process.env.RECORD) {
    const slim = frames.map((f) => JSON.parse(JSON.stringify(f, (k, v) => (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=]+$/.test(v) ? `<b64 ${v.length}>` : v))));
    writeFileSync(new URL(`./fixtures/frames-${provider}${fast ? '-fast' : ''}-${fixture}.json`, import.meta.url), JSON.stringify(slim.slice(0, 400), null, 1));
  }
  server.close();
  process.exit(events.some((e) => e.type === 'ready') ? 0 : 1);
});
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 90_000);
