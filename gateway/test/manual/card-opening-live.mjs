// Real-vendor check of the card-opening pre-render (job desk-card-opening-tts-20261123): renders the opening lines of synthetic
// card summaries in the central voice, then runs a voice session with a fake vendor and a fake card lookup and measures how
// long the start path takes to send card_opening with the audio. Run on Sandy under `bash -lc` (keys from the environment).
//   node test/manual/card-opening-live.mjs [outDir]
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createCardOpeningAudio } from '../../src/cardOpeningAudio.js';
import { cardOpening } from '../../src/cardStartup.js';
import { runVoiceSession } from '../../src/voice/session.js';

const out = process.argv[2] ?? '/tmp/card-opening-live';
mkdirSync(out, { recursive: true });
const cards = [
  { id: '90001', title: 'Hosting-Budget für Sandy erhöhen', status: 'offen' },
  { id: '90002', title: 'REAX 1.4 Kandidat mit Karpo-Duo', status: 'erledigt' },
  { id: '90003', title: 'JevBench Release v1.8.20 freigeben', status: 'beantwortet' },
];
const hub = new EventEmitter();
hub.hostsFor = () => ['sandy'];
hub.call = async () => ({ cards });
const logs = [];
const svc = createCardOpeningAudio({ hub, log: (l) => { logs.push(JSON.parse(l)); console.log(l); } });
const t0 = Date.now();
await svc.poll();
while (!svc.idle()) await new Promise((r) => setTimeout(r, 100));
console.log(`pre-render of ${cards.length} lines: ${Date.now() - t0} ms total`);
for (const card of cards) {
  const hit = svc.get(cardOpening(card));
  if (hit) writeFileSync(`${out}/${card.id}-${hit.voice}.wav`, Buffer.from(hit.data, 'base64'));
  console.log(card.id, hit ? `${hit.voice} ${hit.durationMs} ms audio, ${hit.bytes} B` : 'MISSING');
}

// Start path: fake vendor (never ready before the opening), summary lookup answers at once like the warm Sandy bridge.
const ws = new EventEmitter();
ws.OPEN = 1; ws.readyState = 1; ws.sent = [];
ws.send = (d) => ws.sent.push({ at: performance.now(), m: typeof d === 'string' ? JSON.parse(d) : d });
ws.close = () => { ws.readyState = 3; };
const traces = [];
const deps = {
  sid: 'live', toolDefs: [], audit() {}, makeCtx: () => ({}), limits: { check: () => ({ ok: true }), addCost() {} },
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), runTool: async () => ({ summary: 's', content: '' }),
  openingAudio: svc, loadStartupCard: async (ref, o) => (o?.summary ? cards[0] : { ...cards[0], text: cards[0].title }),
  openTrace: () => ({ event: (type, data) => traces.push([type, data]), close() {} }),
};
runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: () => ({ sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult() {}, close() {} }) });
const startAt = performance.now();
ws.emit('message', Buffer.from(JSON.stringify({ type: 'start', client: { app: 'screen-agent' }, startupCard: 'card:90001', localCardOpening: true })), false);
for (let i = 0; i < 50 && !ws.sent.some((s) => s.m.type === 'card_opening'); i++) await new Promise((r) => setTimeout(r, 5));
const opening = ws.sent.find((s) => s.m.type === 'card_opening');
console.log(`card_opening after ${(opening.at - startAt).toFixed(1)} ms, audio ${opening.m.audio ? `${opening.m.audio.voice}, ${JSON.stringify(opening.m).length} B JSON` : 'none'}`);
ws.emit('message', Buffer.from(JSON.stringify({ type: 'card_opening_result', playing: true, source: 'prerendered', voice: opening.m.audio?.voice })), false);
console.log('traces', JSON.stringify(traces.filter(([t]) => t.startsWith('card.startup'))));
ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false);
writeFileSync(`${out}/opening-message.json`, JSON.stringify(opening.m));
process.exit(0);
