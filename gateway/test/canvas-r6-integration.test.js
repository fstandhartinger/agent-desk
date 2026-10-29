// Round 6 through the real session / gateway: the early illustrator on voice and text, provider turn-done, the Gemini
// transcript repair, voice sessions marking the provider healthy, persisted health, the Gemini probe.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

const healthFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'desk-health-')), 'health.json');
setEnv({ DESK_CANVAS_DEBOUNCE_MS: '20', XAI_API_KEY: 'xai-test', GOOGLE_API_KEY: 'g-test', DESK_HEALTH_FILE: healthFile, EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator } = await import('../src/illustrator.js');
const { TOOL_DEFS, runTool } = await import('../src/tools.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const health = await import('../src/providerHealth.js');
const probe = await import('../src/providerProbe.js');

const FLOW = JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Ablauf', caption: 'Drei Schritte.', sources: [], nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function harness(t, { provider = 'gemini', complete } = {}) {
  const bus = createCanvasBus();
  const completions = [];
  const illustrator = createIllustrator({ bus, hub: {}, run: async () => ({ ok: true, content: '{}' }), audit: () => {}, complete: complete ?? (async (c) => { completions.push(c); return { message: { content: FLOW, tool_calls: [] }, costUsd: 0 }; }) });
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
  let emit;
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult() {} };
  const deps = {
    sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool, makeCtx: (page) => ({ page, hub: {}, audit: () => {} }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    createCanvas: ({ emit: out, page, provider: p }) => createCanvasSession({ bus, illustrator, by: 'voice', provider: p, emit: out, page, ctx: {}, debounceMs: () => 20 }),
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  msg({ type: 'start' });
  return { ws, msg, emit: (e) => emit(e), bus, completions, canvas: () => ws.sent.filter((m) => m.type === 'canvas'), transcripts: () => ws.sent.filter((m) => m.type === 'transcript' && m.final) };
}

describe('voice: early illustrator', () => {
  it('the final user transcript publishes pending at once (before the assistant says a word) and ready follows; nothing is drawn twice', async (t) => {
    const h = harness(t);
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'speech_started' });
    h.emit({ t: 'transcript', role: 'user', delta: 'Erkläre mir die Architektur ', final: false });
    h.emit({ t: 'transcript', role: 'user', delta: 'vom Agent Desk Gateway.', final: false });
    assert.equal(h.canvas().length, 0, 'still listening');
    h.emit({ t: 'transcript', role: 'user', final: true });
    assert.deepEqual(h.canvas().map((e) => [e.phase, e.by, e.provider]), [['pending', 'auto', 'gemini']]);
    await tick(30);
    assert.deepEqual(h.canvas().map((e) => e.phase), ['pending', 'ready']);
    assert.match(h.completions[0].messages[1].content, /Anfrage: Erkläre mir die Architektur vom Agent Desk Gateway\./);
    h.emit({ t: 'transcript', role: 'assistant', delta: 'Der Gateway nimmt Anfragen an. Er ruft den Agenten. Dann geht es an die Bridge.', final: false });
    h.emit({ t: 'turn_done' });
    await tick(60);
    assert.equal(h.completions.length, 1, 'turn_done does not start a second run');
  });

  it('works for Gemini-style turns: the user transcript is only complete when the assistant starts to talk', async (t) => {
    const h = harness(t);
    h.emit({ t: 'transcript', role: 'user', delta: 'Wie funktioniert die Video-Sendeblockierung?', final: false });
    assert.equal(h.canvas().length, 0);
    h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich sehe mir das direkt an.', final: false });
    assert.deepEqual(h.canvas().map((e) => e.phase), ['pending']);
  });

  it('typed text starts it too; a user who forbids drawing does not', async (t) => {
    const h = harness(t);
    h.msg({ type: 'text', text: 'Wie funktioniert das genau? Bitte nicht zeichnen.' });
    assert.equal(h.canvas().length, 0);
    h.msg({ type: 'text', text: 'Und wie funktioniert das andere?' });
    assert.deepEqual(h.canvas().map((e) => e.phase), ['pending']);
  });

  it('turn_done (the transcript never flushed a final answer) still illustrates an explanatory answer', async (t) => {
    const h = harness(t);
    h.emit({ t: 'transcript', role: 'user', delta: 'Danke dir und noch eine Sache', final: true });
    h.emit({ t: 'transcript', role: 'assistant', delta: 'Der Agent ruft notify auf. Notify prüft den Link. Dann geht es raus.', final: false });
    h.emit({ t: 'turn_done' });
    await tick(80);
    assert.equal(h.completions.length, 1);
    assert.deepEqual(h.canvas().map((e) => e.phase), ['ready']);
  });
});

describe('voice: Gemini transcript and provider health', () => {
  it('the final Gemini transcript has its compounds hyphenated again; other providers are untouched', async (t) => {
    const gemini = harness(t);
    gemini.emit({ t: 'transcript', role: 'assistant', delta: 'Das gilt für die KryptoEmissionen ', final: false });
    gemini.emit({ t: 'transcript', role: 'assistant', delta: 'und die GPUServerkosten.', final: false });
    gemini.emit({ t: 'turn_done' });
    assert.equal(gemini.transcripts().at(-1).text, 'Das gilt für die Krypto-Emissionen und die GPU-Serverkosten.');
    const xai = harness(t, { provider: 'xai' });
    xai.emit({ t: 'transcript', role: 'assistant', delta: 'KryptoEmissionen', final: false });
    xai.emit({ t: 'turn_done' });
    assert.equal(xai.transcripts().at(-1).text, 'KryptoEmissionen');
  });

  it('a voice session that produced audio counts as healthy even when the adapter never reported ready', async (t) => {
    health.resetProviderHealthForTests();
    const h = harness(t, { provider: 'xai' });
    assert.equal(health.snapshot().xai.ok, null);
    h.emit({ t: 'audio', pcm: Buffer.alloc(4) });
    assert.equal(health.snapshot().xai.ok, true);
  });
});

describe('provider health survives a restart; Gemini is probed', () => {
  it('a success is written to DESK_HEALTH_FILE and read by a fresh process; failures are not persisted; old entries are ignored', async () => {
    fs.rmSync(healthFile, { force: true });
    health.resetProviderHealthForTests();
    health.markOk('xai');
    health.markFailure('openai', 'Kein Guthaben');
    const saved = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    assert.deepEqual(Object.keys(saved), ['xai']);
    const fresh = await import('../src/providerHealth.js?restart1');
    assert.equal(fresh.snapshot().xai.ok, true, 'ok=null never shows after a successful session today');
    assert.equal(fresh.snapshot().openai.ok, null);
    fs.writeFileSync(healthFile, JSON.stringify({ xai: Date.now() - 2 * 24 * 3600_000 }));
    const stale = await import('../src/providerHealth.js?restart2');
    assert.equal(stale.snapshot().xai.ok, null);
  });

  it('the Gemini probe marks a valid key ok and a rejected one failed; a transient error changes nothing', async () => {
    const google = await fakeServer((req, res) => res.writeHead(google.status, { 'content-type': 'application/json' }).end('{}'));
    process.env.GOOGLE_BASE_URL = google.url;
    probe.resetProbesForTests();
    health.resetProviderHealthForTests();
    google.status = 200;
    await probe.probeProviders();
    assert.equal(health.snapshot().gemini.ok, true);
    assert.equal(google.seen.at(-1).headers['x-goog-api-key'], 'g-test');
    google.status = 403;
    await probe.probeProviders();
    assert.deepEqual([health.snapshot().gemini.ok, health.snapshot().gemini.reason], [false, 'Schlüssel abgelehnt']);
    health.resetProviderHealthForTests();
    google.status = 500;
    await probe.probeProviders();
    assert.equal(health.snapshot().gemini.ok, null);
    google.close();
    delete process.env.GOOGLE_BASE_URL;
  });
});

describe('text chat: early illustrator through /api/chat', () => {
  let openrouter; let gw; let bridge; let cookie; let agent; let agentCalls = 0; let illustratorCalls = 0;
  before(async () => {
    openrouter = await fakeServer((req, res, body) => {
      if (String(body.messages?.[0]?.content).includes('illustrator of Florian')) {
        illustratorCalls += 1;
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: FLOW, tool_calls: [] } }], usage: { cost: 0.0005 } }));
      }
      return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(agent(body, agentCalls++));
    });
    setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_CANVAS_MODEL: 'test/canvas' });
    gw = await startGateway();
    cookie = (await login(gw.base)).cookie;
    bridge = await connectFakeBridge(gw.port, { 'ledger.entries': () => ({}) });
  });
  after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
  const chat = (content) => fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: [{ role: 'user', content }] }) });

  it('an explanatory question gets pending before the agent\'s first token and exactly one canvas when the agent only talks', async () => {
    agent = () => completionStream({ text: 'Der Agent ruft notify auf. Notify prüft den Link. Dann geht es raus. Das ist der Ablauf.' });
    const events = await readSse(await chat('Wie funktioniert die Video-Sendeblockierung?'), () => false);
    const kinds = events.map((e) => (e.type === 'canvas' ? `canvas:${e.phase}` : e.type));
    assert.equal(kinds[0], 'canvas:pending', kinds.join(','));
    assert.ok(kinds.indexOf('canvas:pending') < kinds.indexOf('delta'));
    assert.equal(events.filter((e) => e.type === 'canvas' && e.phase === 'ready').length, 1);
    assert.equal(illustratorCalls, 1, 'the auto trigger after the answer did not start a second run');
  });

  it('the agent\'s canvas_render in the same turn replaces the early canvas (same id), no second canvas', async () => {
    illustratorCalls = 0;
    const spec = { kind: 'flow', title: 'Fertig vom Agenten', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], sources: [{ label: 'x', ref: '/x' }] };
    agent = (b) => (b.messages.some((m) => m.role === 'tool') ? completionStream({ text: 'Fertig.' }) : completionStream({ toolCalls: [{ id: 'c1', name: 'canvas_render', args: JSON.stringify(spec) }] }));
    const events = await readSse(await chat('Wie funktioniert der Login-Link?'), () => false);
    const ids = new Set(events.filter((e) => e.type === 'canvas').map((e) => e.id));
    assert.equal(ids.size, 1, [...ids].join(','));
    assert.equal(events.filter((e) => e.type === 'canvas' && e.phase === 'ready').at(-1).spec.title, 'Fertig vom Agenten');
  });

  it('a question that forbids drawing starts nothing', async () => {
    illustratorCalls = 0;
    agent = () => completionStream({ text: 'Erst A, dann B. Danach C. Und fertig, so einfach.' });
    const events = await readSse(await chat('Wie funktioniert der Login-Link? Bitte ohne Bild.'), () => false);
    assert.equal(events.filter((e) => e.type === 'canvas').length, 0);
    assert.equal(illustratorCalls, 0);
  });

  it('"Ich zeichne es dir auf." appears at most once in a turn, even across tool rounds', async () => {
    illustratorCalls = 0;
    let round = 0;
    agent = (b) => {
      round += 1;
      if (b.messages.some((m) => m.role === 'tool')) return completionStream({ text: 'Ich kann leider keine Diagramme direkt zeichnen. Das Ergebnis steht oben.' });
      return completionStream({ text: 'Ich kann leider keine Diagramme erstellen. ', toolCalls: [{ id: 'k1', name: 'read_core_doc', args: JSON.stringify({ name: 'AGENTS' }) }] });
    };
    const events = await readSse(await chat('Zeig mir den Ablauf kurz'), () => false);
    const shown = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.equal((shown.match(/Ich zeichne es dir auf\./g) ?? []).length, 1, shown);
    assert.ok(round >= 2);
  });
});
