// Voice + canvas: the session hands canvas tools to the real tools, mirrors canvas events onto the WS, returns
// canvas_draw at once, triggers auto-illustration / the refusal guard from transcripts; the three adapters carry the tools.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_DEBOUNCE_MS: '20', DESK_CANVAS_EARLY: '0' }); // the early illustrator has its own tests (canvas-early.test.js)
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator } = await import('../src/illustrator.js');
const { TOOL_DEFS, runTool } = await import('../src/tools.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const { geminiDeclarations } = await import('../src/voice/schema.js');
const { setupMessage, createGemini } = await import('../src/voice/gemini.js');
const { sessionUpdate } = await import('../src/voice/xai.js');
const { sessionStart } = await import('../src/voice/openai.js');

const CANVAS_TOOLS = ['canvas_draw', 'canvas_render', 'ledger_spend', 'code_outline'];
const pie = JSON.stringify({ v: 2, id: 'geld', kind: 'flow', title: 'Geld', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], sources: [] });

function harness(t, { complete } = {}) {
  const bus = createCanvasBus();
  const completions = [];
  const illustrator = createIllustrator({ bus, hub: {}, run: async () => ({ ok: true, content: 'x' }), audit: () => {}, complete: complete ?? (async (c) => { completions.push(c); return { message: { content: pie, tool_calls: [] }, costUsd: 0 }; }) });
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
  const results = [];
  let emit;
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult: (...a) => results.push(a) };
  const deps = {
    sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool, makeCtx: (page) => ({ page, hub: {}, audit: () => {} }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    createCanvas: ({ emit: out, page, provider }) => createCanvasSession({ bus, illustrator, by: 'voice', provider, emit: out, page, ctx: {}, debounceMs: () => 20 }),
  };
  runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: 'stop' }));
  msg({ type: 'start' });
  const canvasEvents = () => ws.sent.filter((m) => m.type === 'canvas');
  return { ws, msg, emit: (e) => emit(e), results, bus, completions, canvasEvents };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('canvas_draw from a voice agent: result goes back at once, pending + ready are mirrored to the WS and the bus (by:"voice")', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(t, { complete: async () => { await gate; return { message: { content: pie, tool_calls: [] }, costUsd: 0 }; } });
  h.emit({ t: 'ready', model: 'm' });
  h.emit({ t: 'tool_call', id: 'c1', name: 'canvas_draw', args: { request: 'Torte der Ausgaben mit 165', kind: 'flow', id: 'geld' } });
  await tick(10);
  assert.equal(h.results.length, 1, 'tool result is back although the illustrator is still working');
  assert.deepEqual(JSON.parse(h.results[0][2]), { ok: true, id: 'geld', status: 'zeichne' });
  assert.deepEqual(h.canvasEvents().map((e) => e.phase), ['pending']);
  assert.equal(h.canvasEvents()[0].by, 'voice');
  assert.equal(h.canvasEvents()[0].provider, 'gemini');
  const toolEvents = h.ws.sent.filter((m) => m.type === 'tool').map((m) => m.status);
  assert.deepEqual(toolEvents, ['start', 'done']);
  release();
  await tick(30);
  assert.deepEqual(h.canvasEvents().map((e) => e.phase), ['pending', 'ready']);
  assert.equal(h.bus.latest()[0].id, 'geld');
});

test('canvas_render by voice validates; an invalid spec is an error result for the model', async (t) => {
  const h = harness(t);
  h.emit({ t: 'tool_call', id: 'c1', name: 'canvas_render', args: { kind: 'flow', title: 'F', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } });
  h.emit({ t: 'tool_call', id: 'c2', name: 'canvas_render', args: { kind: 'flow', title: 'F', nodes: [] } });
  await tick(10);
  assert.equal(JSON.parse(h.results[0][2]).shown, true);
  assert.match(h.results[1][2], /^ERROR: flow needs "nodes"/);
  assert.deepEqual(h.canvasEvents().map((e) => e.phase), ['ready']);
});

test('refusal in the assistant transcript starts the illustrator for the user request at once', async (t) => {
  const h = harness(t);
  h.msg({ type: 'text', text: 'Wofür geben wir das Geld aus? Zeig es mir.' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich kann leider keine Diagramme direkt auf der Canvas für dich erstellen.', final: false });
  h.emit({ t: 'turn_done' });
  await tick(40);
  assert.deepEqual(h.canvasEvents().map((e) => [e.phase, e.by]), [['pending', 'auto'], ['ready', 'auto']]);
  assert.match(h.completions[0].messages[1].content, /Anfrage: Wofür geben wir das Geld aus\? Zeig es mir\./);
});

test('auto-illustration after a finished explanatory voice answer; once per turn; a canvas tool in the turn prevents it', async (t) => {
  const h = harness(t);
  h.msg({ type: 'text', text: 'Wie funktioniert das mit 165 Euro?' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Der Agent ruft notify auf. Notify prüft den Link. Dann geht es raus.', final: false });
  h.emit({ t: 'turn_done' });
  await tick(80);
  assert.deepEqual(h.canvasEvents().map((e) => [e.phase, e.by]), [['ready', 'auto']]);

  h.msg({ type: 'text', text: 'Und wie funktioniert das noch?' });
  h.emit({ t: 'tool_call', id: 'c9', name: 'canvas_render', args: { kind: 'flow', title: 'Schon gezeichnet', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] } });
  await tick(5);
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Der Agent ruft notify auf. Notify prüft den Link. Dann geht es raus.', final: false });
  h.emit({ t: 'turn_done' });
  await tick(80);
  assert.equal(h.completions.length, 1, 'no second illustrator run');
});

test('a non-canvas tool call between partial transcripts postpones the auto drawing to the final answer', async (t) => {
  const h = harness(t);
  h.msg({ type: 'text', text: 'Erklär mir bitte den Ablauf' });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Ich schaue kurz ins Board und sehe nach, was da steht.', final: false });
  h.emit({ t: 'tool_call', id: 't1', name: 'board_threads', args: {} });
  await tick(60);
  assert.equal(h.completions.length, 0, 'the timer was cleared by the tool start');
});

test('user speech transcripts start a new turn (flags reset), so a later explanatory answer is illustrated again', async (t) => {
  const h = harness(t);
  h.emit({ t: 'transcript', role: 'user', delta: 'Wie funktioniert das?', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Erst Schritt eins, dann Schritt zwei und danach Schritt drei.', final: false });
  h.emit({ t: 'turn_done' });
  await tick(80);
  assert.equal(h.completions.length, 1);
  h.emit({ t: 'transcript', role: 'user', delta: 'Und warum?', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Weil es so sicher ist und weil der Guard es verlangt, daher.', final: false });
  h.emit({ t: 'turn_done' });
  await tick(80);
  assert.equal(h.completions.length, 2);
});

// ---- adapters -------------------------------------------------------------------------------------------------

test('all three providers receive the four new tools with their nested schemas', () => {
  const gemini = setupMessage({ instructions: 'x', tools: TOOL_DEFS }).setup.tools[0].functionDeclarations;
  const xai = sessionUpdate({ instructions: 'x', tools: TOOL_DEFS }).session.tools;
  const openai = sessionStart({ instructions: 'x', tools: TOOL_DEFS }).session.delegation.responses.tools;
  for (const [label, list] of [['gemini', gemini], ['xai', xai], ['openai', openai]]) {
    assert.deepEqual(CANVAS_TOOLS.filter((n) => !list.some((t) => t.name === n)), [], label);
    const render = list.find((t) => t.name === 'canvas_render');
    const nodes = render.parameters.properties.nodes;
    assert.equal(nodes.type, 'array', label);
    assert.equal(nodes.items.type, 'object', label);
    assert.equal(nodes.items.properties.shape.enum.includes('diamond'), true, label);
    assert.equal(render.parameters.properties.items.items.properties.value.type, 'number', label);
    assert.equal(render.parameters.properties.rows.items.type, 'array', label);
    assert.deepEqual(render.parameters.required, ['kind', 'title'], label);
    const draw = list.find((t) => t.name === 'canvas_draw');
    assert.deepEqual(Object.keys(draw.parameters.properties), ['request', 'kind', 'id'], label);
    assert.equal(list.find((t) => t.name === 'ledger_spend').parameters.properties.kgOnly.type, 'boolean', label);
    assert.equal(list.find((t) => t.name === 'code_outline').parameters.properties.path.type, 'string', label);
  }
  // nothing but vendor-valid keys leaks into xAI / OpenAI function definitions
  for (const t of [...xai, ...openai]) assert.deepEqual(Object.keys(t).sort(), ['description', 'name', 'parameters', 'type'], t.name);
});

test('gemini: only canvas_draw is declared NON_BLOCKING; the schema stays free of unsupported keys', () => {
  const decls = geminiDeclarations(TOOL_DEFS);
  assert.deepEqual(decls.filter((d) => d.behavior).map((d) => [d.name, d.behavior]), [['canvas_draw', 'NON_BLOCKING']]);
  assert.doesNotMatch(JSON.stringify(decls), /additionalProperties|oneOf|anyOf/);
  const render = decls.find((d) => d.name === 'canvas_render').parameters;
  assert.ok(render.properties.nodes.items.properties.id);
  assert.ok(render.properties.sources.items.properties.ref);
});

test('gemini: the canvas_draw tool response is scheduled WHEN_IDLE (never stalls audio), other tools stay plain', async (t) => {
  const { LANGUAGE_HINT } = await import('../src/voice/gemini.js');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const received = [];
  wss.on('connection', (ws) => ws.on('message', (d) => { received.push(JSON.parse(d.toString())); }));
  t.after(() => wss.close());
  const adapter = createGemini({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: `ws://127.0.0.1:${wss.address().port}` }, () => {});
  await tick(150);
  adapter.sendToolResult('a', 'canvas_draw', '{"ok":true}');
  adapter.sendToolResult('b', 'job_status', 'x');
  await tick(100);
  adapter.close();
  const responses = received.filter((m) => m.toolResponse).map((m) => m.toolResponse.functionResponses[0]);
  // round 10: every result carries the German language reminder (critic r9: Gemini answered q3 in English)
  assert.deepEqual(responses[0].response, { result: '{"ok":true}', hinweis: LANGUAGE_HINT, scheduling: 'WHEN_IDLE' });
  assert.deepEqual(responses[1].response, { result: 'x', hinweis: LANGUAGE_HINT });
  assert.equal(received[0].setup.tools[0].functionDeclarations.find((d) => d.name === 'canvas_draw').behavior, 'NON_BLOCKING');
});

test('openai: a typed turn is a user message for the delegation backend (session.instructions.append needs a delegation_id and failed live)', async (t) => {
  const { createOpenAI, translate } = await import('../src/voice/openai.js');
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  const received = [];
  wss.on('connection', (ws) => ws.on('message', (d) => received.push(JSON.parse(d.toString()))));
  t.after(() => wss.close());
  const adapter = createOpenAI({ apiKey: 'k', instructions: 'x', tools: TOOL_DEFS, url: `ws://127.0.0.1:${wss.address().port}` }, () => {});
  await tick(150);
  adapter.sendText('Wofür geben wir das Geld aus?');
  await tick(100);
  adapter.close();
  const types = received.map((m) => m.type);
  assert.ok(!types.includes('session.instructions.append'));
  const i = types.indexOf('response.item.create');
  assert.deepEqual(received[i].item, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Wofür geben wir das Geld aus?' }] });
  assert.equal(types[i + 1], 'response.create');

  const { startTypedTurn } = await import('../src/voice/openai.js');
  const state = {};
  const done = { type: 'response.event', event: { type: 'response.output_text.done', text: 'Hallo!' } };
  const completed = { type: 'response.event', event: { type: 'response.completed' } };
  assert.deepEqual([...translate(done, state), ...translate(completed, state)], [{ t: 'turn_done' }], 'a spoken turn is transcribed by the voice model, not twice');
  startTypedTurn(state);
  assert.deepEqual(translate(done, state), [], 'fix 28 Oct: the text waits until the backend is finished');
  assert.deepEqual(translate(completed, state), [{ t: 'transcript', role: 'assistant', text: 'Hallo!', final: true }, { t: 'turn_done' }]);
  startTypedTurn(state);
  translate({ type: 'session.input_transcript.delta', delta: 'x' }, state);
  assert.deepEqual([...translate(done, state), ...translate(completed, state)], [{ t: 'turn_done' }], 'speech ends the typed mode');
});
