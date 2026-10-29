import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';
import { syn } from './synthetic.js';

let openrouter;
let script; // function(requestBody, index) -> stream text | {status, body}
let gw;
let bridge;
let cookie;
const SECRET = syn('sk-o·r-v1·-012·3456·789a·bcde·f012·3456·789a·bcde·f');

before(async () => {
  openrouter = await fakeServer((req, res, body) => {
    const reply = script(body, openrouter.seen.length - 1);
    if (typeof reply === 'object') return res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
    return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(reply);
  });
  setEnv({ OPENROUTER_BASE_URL: openrouter.url, DESK_TEXT_MODEL: 'test/model', DESK_ALLOWED_MODELS: 'test/other', EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, {
    'ctx.core': ({ name }) => `# ${name}\nLeChonk ist die zweite Werkstatt. key=${SECRET}`,
    'jobs.list': () => { throw new Error('jobs backend down'); },
  });
});
after(() => { bridge.ws.close(); gw.close(); openrouter.close(); });
beforeEach(() => { openrouter.seen.length = 0; });

const chat = (body, headers = {}) => fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const ask = (content, extra = {}) => ({ conversationId: 'c1', messages: [{ role: 'user', content }], ...extra });
const toolCall = (name, args, id = 'call_1') => completionStream({ toolCalls: [{ id, name, args: JSON.stringify(args) }] });

describe('POST /api/chat', () => {
  it('runs a tool round and streams tool, delta and done events', async () => {
    script = (_body, i) => (i === 0 ? toolCall('read_core_doc', { name: 'AGENTS' }) : completionStream({ text: 'LeChonk ist die zweite Werkstatt.', cost: 0.0004 }));
    const res = await chat(ask('Was steht in AGENTS.md über LeChonk?'));
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const events = await readSse(res, (e) => e.some((x) => x.type === 'done' || x.type === 'error'));

    const types = events.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t !== 'delta'), ['status', 'tool', 'tool', 'done']);
    assert.equal(events.find((e) => e.type === 'status').text, 'Ich lese AGENTS …');
    const [start, done] = events.filter((e) => e.type === 'tool');
    assert.deepEqual([start.status, start.name, start.args], ['start', 'read_core_doc', { name: 'AGENTS' }]);
    assert.equal(done.status, 'done');
    assert.ok(done.summary.length <= 200 && done.ms >= 0);
    assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'LeChonk ist die zweite Werkstatt.');
    const final = events.at(-1);
    assert.deepEqual([final.usage, final.model], [{ in: 200, out: 40 }, 'test/model']);
    assert.ok(Math.abs(final.costUsd - 0.0005) < 1e-9);
  });

  it('recovers a near-miss before emitting chat tool chips', async () => {
    script = (_body, i) => i === 0 ? toolCall('read_core_do', { name: 'AGENTS' }) : completionStream({ text: 'Gelesen.' });
    const events = await readSse(await chat(ask('Lies AGENTS')), (e) => e.some((x) => x.type === 'done'));
    const tools = events.filter((e) => e.type === 'tool');
    assert.equal(tools.length, 2);
    assert.deepEqual(tools.map((e) => [e.name, e.status]), [['read_core_doc', 'start'], ['read_core_doc', 'done']]);
  });

  it('feeds the tool result (secrets scrubbed again) and the system prompt back to the model', async () => {
    script = (_b, i) => (i === 0 ? toolCall('read_core_doc', { name: 'AGENTS' }) : completionStream({ text: 'ok' }));
    await readSse(await chat(ask('hi')), (e) => e.some((x) => x.type === 'done'));
    const [first, second] = openrouter.seen.map((r) => r.body);
    assert.match(first.messages[0].content, /Desk-Agent/);
    assert.equal(first.tools.length, (await import('../src/tools.js')).TOOL_DEFS.length);
    assert.equal(first.stream, true);
    const toolMsg = second.messages.at(-1);
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.match(toolMsg.content, /LeChonk/);
    assert.ok(!toolMsg.content.includes(SECRET) && toolMsg.content.includes('[REDACTED]'));
    assert.equal(second.messages.at(-2).tool_calls[0].function.name, 'read_core_doc');
    assert.equal(openrouter.seen[0].headers.authorization, 'Bearer or-test-key');
  });

  it('reports a failing tool as an error event and keeps going', async () => {
    script = (_b, i) => (i === 0 ? toolCall('list_jobs', {}) : completionStream({ text: 'Das Werkzeug ist ausgefallen.' }));
    const events = await readSse(await chat(ask('Jobs?')), (e) => e.some((x) => x.type === 'done'));
    const tool = events.filter((e) => e.type === 'tool').at(-1);
    assert.equal(tool.status, 'error');
    assert.match(tool.summary, /jobs backend down/);
    assert.equal(events.at(-1).type, 'done');
  });

  it('stops after 8 tool rounds and forces a tool-free answer', async () => {
    script = (body, i) => (body.tools ? toolCall('board_threads', {}, `call_${i}`) : completionStream({ text: 'Zusammenfassung.' }));
    const events = await readSse(await chat(ask('endlos')), (e) => e.some((x) => x.type === 'done'));
    assert.equal(openrouter.seen.length, 9);
    assert.equal(openrouter.seen.at(-1).body.tools, undefined);
    assert.equal(events.filter((e) => e.type === 'tool' && e.status === 'start').length, 8);
    assert.equal(events.at(-1).type, 'done');
  });

  it('turns vendor failures into a sanitised error event', async () => {
    script = () => ({ status: 401, body: { error: { message: `bad key ${SECRET}` } } });
    const events = await readSse(await chat(ask('hi')), (e) => e.some((x) => x.type === 'error'));
    const error = events.find((e) => e.type === 'error');
    assert.equal(error.message, 'Der Zugang zum Textmodell wurde abgelehnt');
    assert.ok(!JSON.stringify(events).includes(SECRET));
  });

  it('only accepts allow-listed model overrides', async () => {
    script = () => completionStream({ text: 'x' });
    await readSse(await chat(ask('a', { model: 'test/other' })), (e) => e.some((x) => x.type === 'done'));
    await readSse(await chat(ask('b', { model: 'expensive/model' })), (e) => e.some((x) => x.type === 'done'));
    assert.deepEqual(openrouter.seen.map((r) => r.body.model), ['test/other', 'test/model']);
  });

  it('validates the request and requires the cookie', async () => {
    assert.equal((await chat({ messages: [] })).status, 400);
    assert.equal((await chat({ messages: [{ role: 'assistant', content: 'x' }] })).status, 400);
    assert.equal((await chat({ messages: [{ role: 'system', content: 'x' }] })).status, 400);
    assert.equal((await chat(ask('x'), { cookie: '' })).status, 401);
    assert.equal(openrouter.seen.length, 0);
  });

  it('enforces 40 chats per 10 minutes and the daily spend cap', async () => {
    const { limits } = await import('../src/limits.js');
    const { readSession } = await import('../src/auth.js');
    const { sid } = readSession({ headers: { cookie } });
    script = () => completionStream({ text: 'x' });
    limits.rate.set(`chat:${sid}`, Array.from({ length: 40 }, () => Date.now()));
    const blocked = await chat(ask('zu viel'));
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    limits.rate.clear();
    limits.addCost(1000);
    assert.equal((await chat(ask('teuer'))).status, 429);
    limits.cost.clear();
  });
});

describe('tool-call markup and the last round', () => {
  const dsml = '<｜DSML｜ calls><｜DSML｜ invoke name="read_file"><｜DSML｜ parameter name="path">/x</｜DSML｜ parameter></｜DSML｜ invoke></｜DSML｜ calls>';

  it('never streams DSML tool-call markup as the answer, and forces a tool-free answer round', async () => {
    script = (body, i) => {
      if (i === 0) return completionStream({ text: `Ich lese die Datei.\n${dsml}` });
      assert.equal(body.tools, undefined, 'the retry offers no tools');
      assert.match(body.messages.at(-1).content, /Antworte jetzt mit dem, was du hast/);
      return completionStream({ text: 'Heute wurde nichts Neues entschieden.' });
    };
    const events = await readSse(await chat(ask('Was hat Florian heute entschieden?')), (e) => e.some((x) => x.type === 'done'));
    const shown = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.ok(!/DSML|<｜|invoke/.test(shown), shown);
    assert.equal(shown, 'Ich lese die Datei.\nHeute wurde nichts Neues entschieden.');
    assert.equal(openrouter.seen.length, 2);
  });

  it('falls back to a German sentence when even the forced round only writes markup', async () => {
    script = () => completionStream({ text: dsml });
    const events = await readSse(await chat(ask('Frage')), (e) => e.some((x) => x.type === 'done'));
    const shown = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.match(shown, /keine verlässliche Antwort/);
    assert.ok(!/DSML/.test(shown));
  });

  it('adds the "answer now" system message on the last allowed round together with tools: none', async () => {
    script = (body, i) => (body.tools ? toolCall('board_threads', {}, `call_${i}`) : completionStream({ text: 'Fertig.' }));
    await readSse(await chat(ask('endlos')), (e) => e.some((x) => x.type === 'done'));
    const last = openrouter.seen.at(-1).body;
    assert.equal(last.tools, undefined);
    assert.deepEqual([last.messages.at(-1).role, /Antworte jetzt mit dem, was du hast/.test(last.messages.at(-1).content)], ['system', true]);
    assert.ok(openrouter.seen.slice(0, -1).every((r) => r.body.tools?.length));
  });

  it('streams one German status line before the first slow tool of a round, then the tool events', async () => {
    script = (_b, i) => (i === 0 ? completionStream({ toolCalls: [{ id: 'a', name: 'list_jobs', args: '{}' }, { id: 'b', name: 'board_threads', args: '{}' }] }) : completionStream({ text: 'ok' }));
    const events = await readSse(await chat(ask('Welche Jobs laufen gerade?')), (e) => e.some((x) => x.type === 'done'));
    const order = events.filter((e) => e.type !== 'delta').map((e) => (e.type === 'tool' ? `tool:${e.name}:${e.status}` : e.type));
    assert.equal(order[0], 'status');
    assert.equal(order.filter((t) => t === 'status').length, 1);
    assert.equal(events[0].text, 'Ich schaue kurz in die Jobs …');
    assert.ok(order.indexOf('status') < order.indexOf('tool:list_jobs:start'));
  });
});
