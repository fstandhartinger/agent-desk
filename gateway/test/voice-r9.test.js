// Round 9 (critic r8 F4/C2): fragmented user transcripts are one question; a new question cancels the old answer and
// voids its tool results. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runVoiceSession } from '../src/voice/session.js';
import { translate as geminiTranslate } from '../src/voice/gemini.js';
import { ToolBatch } from '../src/voice/adapter.js';
import { createOpenAI } from '../src/voice/openai.js';
import { createXai } from '../src/voice/xai.js';

function harness(t, provider = 'openai', { mergeMs = 40, runTool } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.CONNECTING = 0; ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  ws.close = () => { ws.readyState = 3; };
  const log = [];
  const results = [];
  const audits = [];
  let emit;
  const adapter = { sendAudio() {}, sendText() {}, interrupt: () => log.push('interrupt'), sendToolResult: (...a) => results.push(a), close() {} };
  const canvas = {
    startTurn: () => log.push('startTurn'), noteTurn: (t) => log.push(`note:${t.role}:${t.text}`), userTurn: (t) => log.push(`user:${t}`),
    autoTurn() {}, toolStarted() {}, noteTool() {}, turnDone: () => log.push('turnDone'), close() {},
  };
  const deps = {
    sid: 's1', toolDefs: [], audit: (e) => audits.push(e), makeCtx: (p) => ({ page: p }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
    runTool: runTool ?? (async () => ({ summary: 's', content: 'ok' })),
    createCanvas: () => canvas,
  };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', mergeMs, create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  msg({ type: 'start' });
  t.after(() => msg({ type: 'stop' }));
  return { msg, log, results, audits, ws, emit: (e) => emit(e) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userFrag = (h, text) => h.emit({ t: 'transcript', role: 'user', text, final: true });

test('fragments within the merge window are ONE question for the agent side, committed after the last fragment', async (t) => {
  const h = harness(t, 'xai');
  h.emit({ t: 'ready', model: 'm' });
  userFrag(h, 'Wofür');
  userFrag(h, 'geben wir das');
  userFrag(h, 'Geld aus');
  assert.deepEqual(h.log.filter((l) => l.startsWith('user:')), [], 'nothing yet');
  await sleep(120);
  assert.deepEqual(h.log.filter((l) => l.startsWith('user:') || l.startsWith('note:')), ['note:user:Wofür geben wir das Geld aus', 'user:Wofür geben wir das Geld aus']);
  assert.equal(h.log.filter((l) => l === 'startTurn').length, 1, 'one turn start, not one per fragment');
  assert.equal(h.ws.sent.filter((m) => m.type === 'transcript' && m.final).length, 3, 'the browser still sees each fragment');
});

test('audio frames while the user speaks neither split the fragment nor count as an answer in flight', (t) => {
  const h = harness(t, 'openai');
  h.emit({ t: 'transcript', role: 'user', delta: 'Wofür', final: false });
  h.emit({ t: 'audio', pcm: Buffer.alloc(8) });
  h.emit({ t: 'transcript', role: 'user', delta: ' geben wir', final: false });
  h.emit({ t: 'audio', pcm: Buffer.alloc(8) });
  assert.equal(h.ws.sent.filter((m) => m.type === 'transcript' && m.final).length, 0);
  assert.equal(h.log.filter((l) => l === 'interrupt').length, 0);
});

test('a closed sentence is committed at once', (t) => {
  const h = harness(t, 'xai');
  userFrag(h, 'Wofür geben wir das Geld aus?');
  assert.ok(h.log.includes('user:Wofür geben wir das Geld aus?'));
});

test('GPT-Live: fragments interleaved with the old answer still merge, and the old answer is cancelled once', async (t) => {
  const h = harness(t, 'openai');
  h.emit({ t: 'tool_call', id: 'c0', name: 'job_status', args: {} }); // the old answer is in flight
  await sleep(5);
  h.emit({ t: 'transcript', role: 'user', delta: 'Wofür', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Das Gateway ', final: false }); // old answer keeps talking
  h.emit({ t: 'transcript', role: 'user', delta: 'geben wir das', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'läuft auf Sandy.', final: false });
  h.emit({ t: 'transcript', role: 'user', delta: 'Geld aus', final: false });
  h.emit({ t: 'turn_done' });
  await sleep(120);
  const users = h.log.filter((l) => l.startsWith('user:'));
  assert.deepEqual(users, ['user:Wofür geben wir das Geld aus']);
  assert.equal(h.log.filter((l) => l === 'interrupt').length, 1, 'response.cancel once');
  assert.ok(h.audits.some((a) => a.action === 'voice.barge_in'));
});

test('the tool result of the overtaken question is stale: OpenAI/xAI get it without a new response, Gemini gets it marked as old', async (t) => {
  for (const [provider, expectStale] of [['openai', true], ['xai', true], ['gemini', false]]) {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = harness(t, provider, { runTool: async () => { await gate; return { summary: 's', content: 'alt' }; } });
    h.emit({ t: 'tool_call', id: 'old', name: 'job_status', args: {} });
    await sleep(5);
    userFrag(h, 'Und jetzt etwas ganz anderes?');
    release();
    await sleep(20);
    if (expectStale) assert.deepEqual(h.results.map((r) => [r[0], r[3]]), [['old', { stale: true }]], provider);
    else {
      assert.equal(h.results.length, 1, provider);
      assert.match(h.results[0][2], /Ergebnis zu einer früheren Frage/);
      assert.equal(h.results[0][3], undefined);
    }
    assert.ok(h.audits.some((a) => a.action === 'voice.tool.stale'), provider);
  }
});

test('tool calls the overtaken answer still issues (until its turn_done) are stale; the next answer is current again', async (t) => {
  const h = harness(t, 'openai');
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Moment', final: false }); // old answer in flight
  userFrag(h, 'Neue Frage?');
  h.emit({ t: 'tool_call', id: 'old1', name: 'read_file', args: {} }); // the old backend chain keeps calling
  await sleep(10);
  h.emit({ t: 'turn_done' });
  h.emit({ t: 'tool_call', id: 'new1', name: 'read_file', args: {} });
  await sleep(10);
  assert.deepEqual(h.results.map((r) => [r[0], r[3]]), [['old1', { stale: true }], ['new1', undefined]]);
});

test('a tool result of the CURRENT question is delivered normally', async (t) => {
  const h = harness(t, 'openai');
  userFrag(h, 'Was kostet das?');
  h.emit({ t: 'tool_call', id: 'c1', name: 'job_status', args: {} });
  await sleep(10);
  assert.deepEqual(h.results.map((r) => [r[0], r[3]]), [['c1', undefined]]);
});

test('Gemini: toolCallCancellation voids the pending call (its result is never sent)', async (t) => {
  assert.deepEqual(geminiTranslate({ toolCallCancellation: { ids: ['a', 'b'] } }), [{ t: 'tool_cancelled', ids: ['a', 'b'] }]);
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness(t, 'gemini', { runTool: async () => { await gate; return { summary: 's', content: 'x' }; } });
  h.emit({ t: 'tool_call', id: 'a', name: 'job_status', args: {} });
  await sleep(5);
  h.emit({ t: 'tool_cancelled', ids: ['a'] });
  release();
  await sleep(10);
  assert.deepEqual(h.results, []);
});

test('no barge-in when nothing is being answered, and an error "nothing to cancel" is not shown', async (t) => {
  const h = harness(t, 'openai');
  userFrag(h, 'Erste Frage?');
  assert.equal(h.log.filter((l) => l === 'interrupt').length, 0);
  h.emit({ t: 'error', message: 'Cannot cancel: no active response', code: 'response_cancel_not_active', soft: true });
  assert.equal(h.ws.sent.filter((m) => m.type === 'error').length, 0);
});

test('assistant starting a fresh answer completes the question without waiting for the merge window', (t) => {
  const h = harness(t, 'gemini', { mergeMs: 5000 });
  h.emit({ t: 'transcript', role: 'user', delta: 'Wie funktioniert das', final: false });
  h.emit({ t: 'transcript', role: 'assistant', delta: 'Also', final: false });
  assert.ok(h.log.includes('user:Wie funktioniert das'));
});

test('ToolBatch: stale results are released as outputs only, current ones with a response', () => {
  const out = [];
  const b = new ToolBatch((r) => out.push(['current', r.map((x) => x.id)]), (r) => out.push(['stale', r.map((x) => x.id)]));
  b.call(); b.call();
  b.result({ id: 'old', output: 'x', stale: true });
  b.result({ id: 'new', output: 'y' });
  b.responseDone();
  assert.deepEqual(out, [['stale', ['old']], ['current', ['new']]]);
});

test('OpenAI and xAI adapters send response.cancel on interrupt and stale outputs without response.create', async (t) => {
  const { WebSocketServer } = await import('ws');
  for (const [make, name] of [[createOpenAI, 'openai'], [createXai, 'xai']]) {
    const wss = new WebSocketServer({ port: 0 });
    const got = [];
    wss.on('connection', (c) => c.on('message', (d) => got.push(JSON.parse(d.toString()))));
    await new Promise((r) => wss.once('listening', r));
    const a = make({ apiKey: 'k', instructions: 'i', tools: [], url: `ws://127.0.0.1:${wss.address().port}` }, () => {});
    await sleep(80);
    a.interrupt();
    a.sendToolResult('old', 'x', 'out', { stale: true });
    await sleep(80);
    a.close();
    wss.close();
    const types = got.map((m) => m.type);
    if (name === 'xai') assert.ok(types.includes('response.cancel'), name);
    else {
      assert.ok(!types.includes('response.cancel'), 'OpenAI Live rejects response.cancel (live-verified)');
      const steer = got.find((m) => m.type === 'session.instructions.append');
      assert.equal(steer.delegation_id, null);
      assert.match(steer.content, /neue Frage/);
    }
    const outputs = got.filter((m) => m.item?.type === 'function_call_output');
    assert.equal(outputs.length, 1, name);
    assert.ok(!types.includes('response.create'), `${name}: a stale output must not start a response`);
  }
});
