// Real-vendor check of the table-of-contents context (a#41d6d2, 14 Nov 2026: GPT-Live refused the start briefing, "Context append text must not
// exceed 500 tokens", and closed the session after 0 s). Starts a real voice session with the REAL start briefing code fed with a huge synthetic
// overview, optionally on the real explainer page, and checks: the session gets ready, stays open, and answers a typed question; prints every
// trace event about the briefing / trimming.
//   node test/manual/context-toc-live.mjs <openai|xai|gemini> [--page generalist-runde2-konzept-vbpatgsidr]
// --page needs EXPLAINER_ORIGIN and EXPLAINER_CONTEXT_TOKEN (the Sandy container env); without it a synthetic page is used.
// Env: OPENAI_API_KEY / XAI_API_KEY / GOOGLE_API_KEY (names only). Exit 0 = PASS.
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { handleVoiceUpgrade } from '../../src/voice/index.js';
import { TOOL_DEFS } from '../../src/tools.js';
import { createBriefing } from '../../src/briefing.js';
import { loadPageContext } from '../../src/page.js';

const provider = process.argv[2] ?? 'openai';
const slug = process.argv[3] === '--page' ? process.argv[4] : null;
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);

const board = { entries: Array.from({ length: 40 }, (_, i) => ({ id: 31000 - i, thread: `Thread ${i % 9}`, author: 'fake:agent', kind: 'note', at: `2026-11-14T10:${String(59 - i).padStart(2, '0')}:00`, text: `Synthetic board entry ${i} `.repeat(10) })) };
const cards = { cards: Array.from({ length: 20 }, (_, i) => ({ card: String(19200 - i), at: '2026-11-14T09:00:00.000Z', status: '🤖 LÄUFT', headline: `Synthetic card ${i} `.repeat(6), answered: i % 2 === 0 })) };
const hub = { call: async (method) => ({ 'board.recent': board, 'notify.cardsRecent': cards, 'state.current': { state: 'synthetic state\n'.repeat(80), jobsRunning: 3, asksOpen: 2, decisions: ['synthetic decision'], asks: ['synthetic ask'] } })[method] };
const briefing = createBriefing({ hub });
briefing.deviceIn('live', {
  windows: Array.from({ length: 30 }, (_, i) => ({ process: `app${i}`, title: `Window ${i} `.repeat(6) })),
  tabs: Array.from({ length: 40 }, (_, i) => ({ window: 'Browser', title: `Tab ${i} `.repeat(10), active: i === 3 })),
  mainSession: { source: 'vscode', updatedAt: '2026-11-14T10:00:00Z', messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', at: `2026-11-14T10:${String(i).padStart(2, '0')}:00Z`, text: `Synthetic message ${i} `.repeat(40) })) },
  screenText: 'Synthetic screen text. '.repeat(100),
});

const events = [];
const deps = {
  wss: new WebSocketServer({ noServer: true }), sid: 'live', toolDefs: TOOL_DEFS, briefing,
  loadPage: slug ? loadPageContext : undefined,
  async runTool(name, args) { log('TOOL', name, JSON.stringify(args).slice(0, 90)); return { ok: true, summary: name, content: JSON.stringify({ hinweis: 'synthetic tool result', name }) }; },
  makeCtx: (page) => ({ page }), limits: { check: () => ({ ok: true }), addCost() {} }, audit() {},
  createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
  openTrace: () => ({ event: (type, d) => { if (/^(briefing|context|session\.(ready|stop|error))/.test(type)) { events.push(type); log('TRACE', type, JSON.stringify(d).slice(0, 200)); } }, close() {} }),
};
const server = http.createServer();
server.on('upgrade', (req, socket, head) => handleVoiceUpgrade(req, socket, head, deps));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/voice?provider=${provider}`);
let ready = false, closedAt = null, answer = '';
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', page: slug ? { slug, t: 5 } : { slug: 'synthetic', title: 'Synthetische Seite', t: 1 } })));
ws.on('message', (data, isBinary) => {
  if (isBinary) return;
  const m = JSON.parse(data.toString());
  if (m.type === 'transcript' && m.role === 'assistant') answer += m.text ?? m.delta ?? '';
  if (m.type === 'ready') { ready = true; log('READY', m.provider, m.model); }
  if (m.type === 'error') log('ERROR', m.message);
});
ws.on('close', () => { closedAt = Date.now(); });
await new Promise((r) => setTimeout(r, 12_000)); // the briefing goes out as soon as the vendor is ready; a refusing vendor closes within ~3 s
const stayed = closedAt === null;
if (stayed) { ws.send(JSON.stringify({ type: 'text', text: 'Worum geht es auf dieser Seite? Antworte in zwei Sätzen.' })); await new Promise((r) => setTimeout(r, 25_000)); }
ws.send(JSON.stringify({ type: 'stop' }));
await new Promise((r) => setTimeout(r, 500));
const pass = ready && stayed && answer.length > 20;
log('RESULT', provider, JSON.stringify({ ready, stayedOpen: stayed, answerChars: answer.length, briefingTraced: events.includes('briefing.context') || events.includes('briefing.start'), trimmed: events.includes('context.trimmed'), answer: answer.slice(0, 160) }));
process.exit(pass ? 0 : 1);
