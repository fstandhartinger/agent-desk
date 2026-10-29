// The canvas through the real gateway: text agent tools, illustrator, auto-illustration, refusal guard, bus + SSE endpoints,
// Claude canvas blocks. OpenRouter is a local fake that answers the agent (SSE) and the illustrator (JSON).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

let openrouter;
let agent; // (body, i) -> SSE text for the desk agent
let illustrator; // (body, i) -> {content?, tool_calls?}
let gw;
let bridge;
let cookie;
let agentCalls = 0;
let illustratorCalls = 0;
const LEDGER = { entries: [{ date: '2026-10-01', amount: 5, currency: 'USD', counterparty: 'OpenAI', purpose: 'API', category: 'LLM-APIs', kg: true }], totals: [], totalsEurApprox: [{ key: 'LLM-APIs', sumEur: 165, count: 33 }, { key: 'GPU', sumEur: 99.5, count: 4 }], source: { kind: 'board', ref: 'Board #22 · Eintrag 25697', asOf: '2026-10-24' } };

before(async () => {
  openrouter = await fakeServer((req, res, body) => {
    const isIllustrator = String(body.messages?.[0]?.content).includes('illustrator of Florian');
    if (isIllustrator) {
      const out = illustrator(body, illustratorCalls++);
      const message = { content: out.content ?? '', tool_calls: (out.tool_calls ?? []).map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 500, completion_tokens: 100, cost: 0.0007 } }));
    }
    return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(agent(body, agentCalls++));
  });
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_MODEL: 'test/canvas', DESK_CANVAS_DEBOUNCE_MS: '20', DESK_CANVAS_EARLY: '0', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'ledger.entries': () => LEDGER, 'ctx.core': () => 'x' });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => {
  openrouter.seen.length = 0;
  bridge.requests.length = 0;
  agentCalls = 0;
  illustratorCalls = 0;
});

const chat = (content) => fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: [{ role: 'user', content }] }) });
const agentSeen = () => openrouter.seen.map((r) => r.body).filter((b) => !String(b.messages?.[0]?.content).includes('illustrator of Florian'));
const illustratorSeen = () => openrouter.seen.map((r) => r.body).filter((b) => String(b.messages?.[0]?.content).includes('illustrator of Florian'));
const afterTool = (body) => body.messages.some((m) => m.role === 'tool');
const toolCall = (name, args) => completionStream({ toolCalls: [{ id: 'call_1', name, args: JSON.stringify(args) }] });
const pie = (extra = {}) => JSON.stringify({ v: 2, id: 'geld', kind: 'pie', title: 'Wohin das Geld geht', unit: 'EUR', items: [{ label: 'LLM-APIs', value: 165 }, { label: 'GPU', value: 99.5 }], sources: [], ...extra });
const phases = (events) => events.filter((e) => e.type === 'canvas').map((e) => `${e.phase}:${e.id}:${e.by}`);

describe('text agent draws', () => {
  it('canvas_render: status line, tool chips, a ready canvas event on the chat stream and on GET /api/canvas', async () => {
    const spec = { kind: 'flow', title: 'Video-Versand', id: 'video-send-block', sources: [{ label: 'STATE', ref: '/x/STATE.md' }], nodes: [{ id: 'agent', label: 'Agent' }, { id: 'guard', label: 'Link-Prüfung', shape: 'diamond' }, { id: 'out', label: 'Telegram' }], edges: [{ from: 'agent', to: 'guard' }, { from: 'guard', to: 'out', label: 'mit Link' }] };
    agent = (b) => (!afterTool(b) ? toolCall('canvas_render', spec) : completionStream({ text: 'Ich habe es aufgezeichnet.' }));
    const events = await readSse(await chat('Wie funktioniert die Video-Sendeblockierung?'), () => false);
    assert.equal(events.find((e) => e.type === 'status').text, 'Ich zeichne dir das auf …');
    const canvasEvent = events.find((e) => e.type === 'canvas');
    assert.deepEqual([canvasEvent.phase, canvasEvent.id, canvasEvent.kind, canvasEvent.by], ['ready', 'video-send-block', 'flow', 'text']);
    assert.equal(canvasEvent.spec.nodes.length, 3);
    assert.ok(events.findIndex((e) => e.type === 'canvas') < events.findIndex((e) => e.type === 'done'));
    assert.equal(events.filter((e) => e.type === 'tool').at(-1).status, 'done');
    const toolResult = agentSeen().at(1).messages.at(-1);
    assert.deepEqual(JSON.parse(toolResult.content), { ok: true, id: 'video-send-block', kind: 'flow', title: 'Video-Versand', shown: true });
    assert.equal(illustratorCalls, 0, 'a canvas tool ran, so no automatic illustration');
    const list = await (await fetch(`${gw.base}/api/canvas`, { headers: { cookie } })).json();
    assert.equal(list.canvases[0].id, 'video-send-block');
    assert.equal(list.canvases[0].spec.kind, 'flow');
  });

  it('canvas_render with an invalid spec gives the model the short English error (and draws nothing)', async () => {
    agent = (b) => (!afterTool(b) ? toolCall('canvas_render', { kind: 'pie', title: 'Kaputt', items: [{ label: 'x', value: 'viel' }] }) : completionStream({ text: 'Moment.' }));
    const events = await readSse(await chat('Zeig die Verteilung'), () => false);
    assert.equal(events.filter((e) => e.type === 'canvas').length, 0);
    assert.equal(events.filter((e) => e.type === 'tool').at(-1).status, 'error');
    assert.match(agentSeen().at(1).messages.at(-1).content, /ERROR: items\[0\] "x": value must be a number/);
  });

  it('canvas_draw returns at once; pending then ready follow; the illustrator reads the ledger through the bridge', async () => {
    agent = (b) => (!afterTool(b) ? toolCall('canvas_draw', { request: 'Torte: Wofür geht das Geld drauf (nach Kategorie)', kind: 'pie', id: 'geld' }) : completionStream({ text: 'Ich zeichne dir das auf.' }));
    illustrator = (_b, i) => (i === 0 ? { tool_calls: [{ id: 'l1', name: 'ledger_spend', args: { groupBy: 'category' } }] } : { content: pie() });
    const t0 = Date.now();
    const events = await readSse(await chat('Wofür geben wir das Geld aus? Zeig es mir.'), () => false);
    assert.equal(events.find((e) => e.type === 'status').text, 'Ich zeichne dir das auf …');
    assert.deepEqual(phases(events), ['pending:geld:text', 'ready:geld:text']);
    const toolDone = events.find((e) => e.type === 'tool' && e.status === 'done');
    assert.match(agentSeen().at(1).messages.at(-1).content, /"status": "zeichne"/);
    assert.ok(toolDone.ms < 500);
    const ready = events.find((e) => e.phase === 'ready');
    assert.deepEqual(ready.spec.items.map((i) => [i.label, i.value]), [['LLM-APIs', 165], ['GPU', 99.5]]);
    assert.deepEqual(ready.spec.sources, [{ label: 'Ledger (Board #22)', ref: 'Board #22 · Eintrag 25697' }]);
    assert.deepEqual(bridge.requests.filter((r) => r.method === 'ledger.entries').map((r) => r.params), [{ groupBy: 'category' }]);
    assert.ok(Date.now() - t0 < 5000);
    // cost of the illustrator run is part of the daily spend
    const status = await (await fetch(`${gw.base}/api/status`, { headers: { cookie } })).json();
    assert.ok(status.spendTodayUsd >= 0.0007);
  });

  it('auto-illustration: an explanatory answer without any canvas tool is drawn by the gateway, by:"auto"', async () => {
    agent = () => completionStream({ text: 'Das Geld geht vor allem an LLM-APIs (165 Euro). Danach kommen GPUs (99,50 Euro). Der Rest ist klein.' });
    illustrator = () => ({ content: pie({ sources: [{ label: 'Gespräch', ref: 'Gespräch' }] }) });
    const events = await readSse(await chat('Wofür geben wir das Geld aus?'), () => false);
    assert.equal(events.at(-1).type, 'canvas');
    assert.deepEqual(phases(events), ['ready:geld:auto']);
    assert.ok(events.findIndex((e) => e.type === 'done') < events.findIndex((e) => e.type === 'canvas'));
    assert.equal(illustratorCalls, 1);
    assert.match(illustratorSeen().at(0).messages[1].content, /Illustriere die letzte Antwort/);
    assert.match(illustratorSeen().at(0).messages[1].content, /Agent: Das Geld geht vor allem/);
  });

  it('no automatic drawing for a plain answer to a plain question', async () => {
    agent = () => completionStream({ text: 'Ja, der Job läuft.' });
    const events = await readSse(await chat('Läuft der Job?'), () => false);
    assert.equal(events.filter((e) => e.type === 'canvas').length, 0);
    assert.equal(illustratorCalls, 0);
  });

  it('refusal guard: "kann leider keine Diagramme" never reaches the user; the gateway draws the user request itself', async () => {
    agent = () => completionStream({ text: 'Ich kann leider keine Diagramme direkt auf der Canvas für dich erstellen. Die Ausgaben sind 165 Euro.' });
    illustrator = () => ({ content: pie({ sources: [] }) });
    const events = await readSse(await chat('Zeig mir die Ausgaben'), () => false);
    const shown = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.ok(!/keine Diagramme/i.test(shown), shown);
    assert.match(shown, /Ich zeichne es dir auf\./);
    assert.match(shown, /Die Ausgaben sind 165 Euro/);
    assert.deepEqual(phases(events), ['pending:zeig-mir-die-ausgaben:auto', 'ready:zeig-mir-die-ausgaben:auto']);
    assert.match(illustratorSeen().at(0).messages[1].content, /Anfrage: Zeig mir die Ausgaben/);
  });

  it('a failing illustrator run ends as an error event on the stream, never a hang', async () => {
    agent = (b) => (!afterTool(b) ? toolCall('canvas_draw', { request: 'Zeichne etwas', id: 'kaputt' }) : completionStream({ text: 'ok' }));
    illustrator = () => ({ content: 'kein json' });
    const events = await readSse(await chat('Zeichne etwas'), () => false);
    assert.deepEqual(phases(events), ['pending:kaputt:text', 'error:kaputt:text']);
    assert.match(events.find((e) => e.phase === 'error').message, /^Zeichnung fehlgeschlagen:/);
  });

  it('the Activity VizSpec generator makes no model call any more (DESK_ACTIVITY_VIZ is off)', async () => {
    agent = () => completionStream({ text: 'Ja.' });
    const events = await readSse(await chat('Läuft der Job?'), () => false);
    assert.equal(events.filter((e) => e.type === 'viz').length, 0);
    assert.equal(openrouter.seen.length, 1);
  });
});

describe('canvas bus endpoints', () => {
  const get = (path, headers = {}) => fetch(`${gw.base}${path}`, { headers: { cookie, ...headers } });
  const draw = async (id, title) => {
    agent = (b) => (!afterTool(b) ? toolCall('canvas_render', { kind: 'table', id, title, columns: ['Name', 'Wert'], rows: [['Alpha', 'eins'], ['Beta', 'zwei']] }) : completionStream({ text: 'ok' }));
    await readSse(await chat(`Tabelle ${title}`), () => false);
  };

  it('both endpoints need the cookie', async () => {
    assert.equal((await fetch(`${gw.base}/api/canvas`)).status, 401);
    assert.equal((await fetch(`${gw.base}/api/canvas/events`)).status, 401);
  });

  it('GET /api/canvas: latest ready per id, newest first, max 20', async () => {
    for (let i = 0; i < 23; i += 1) await draw(`liste-${i}`, `Liste ${i}`);
    await draw('liste-5', 'Liste 5 neu');
    const { canvases } = await (await get('/api/canvas')).json();
    assert.equal(canvases.length, 20);
    assert.deepEqual([canvases[0].id, canvases[0].title], ['liste-5', 'Liste 5 neu']);
    assert.equal(new Set(canvases.map((c) => c.id)).size, 20);
    assert.ok(canvases.every((c) => c.phase === 'ready' && c.spec));
  });

  it('GET /api/canvas/events streams live events with ids and replays after Last-Event-ID', async () => {
    const live = get('/api/canvas/events');
    const res = await live;
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reading = readSse(res, (e) => e.some((x) => x.id === 'live-1'), 4000);
    await new Promise((r) => setTimeout(r, 100));
    await draw('live-1', 'Live eins');
    const seen = await reading;
    const ev = seen.find((e) => e.id === 'live-1');
    assert.deepEqual([ev.type, ev.phase, ev.by, typeof ev.at], ['canvas', 'ready', 'text', 'number']);
    assert.ok(Number(ev._id) > 0);

    await draw('live-2', 'Live zwei');
    const replay = await readSse(await get('/api/canvas/events', { 'last-event-id': ev._id }), (e) => e.some((x) => x.id === 'live-2'), 3000);
    assert.ok(replay.some((e) => e.id === 'live-2'));
    assert.ok(!replay.some((e) => e.id === 'live-1'), 'events up to Last-Event-ID are not replayed again');
    const full = await readSse(await get('/api/canvas/events'), (e) => e.some((x) => x.id === 'live-2'), 3000);
    assert.ok(full.length <= 50 && full.some((e) => e.id === 'live-1'));
  });

  it('a Claude session block {kind:"canvas", spec} on the bridge becomes a by:"claude" canvas; an invalid one is audited, not shown', async () => {
    const reading = readSse(await get('/api/canvas/events'), (e) => e.some((x) => x.by === 'claude'), 3000);
    await new Promise((r) => setTimeout(r, 100));
    bridge.emit('claude:d20261024-abc123', { seq: 4, kind: 'canvas', spec: { kind: 'sequence', title: 'Claude zeichnet', actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], messages: [{ from: 'a', to: 'b', label: 'hi' }] } });
    bridge.emit('claude:d20261024-abc123', { seq: 5, kind: 'canvas', spec: { kind: 'radar', title: 'kaputt' } });
    bridge.emit('claude:d20261024-abc123', { seq: 6, kind: 'text', text: 'normal' });
    const seen = await reading;
    const ev = seen.find((e) => e.by === 'claude');
    assert.deepEqual([ev.phase, ev.id, ev.kind, ev.spec.actors.length], ['ready', 'claude-zeichnet', 'sequence', 2]);
    const { canvases } = await (await get('/api/canvas')).json();
    assert.ok(!canvases.some((c) => c.title === 'kaputt'));
  });
});
