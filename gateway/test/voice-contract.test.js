import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { TOOL_DEFS } from '../src/tools.js';
import { setupMessage } from '../src/voice/gemini.js';
import { sessionUpdate } from '../src/voice/xai.js';
import { sessionStart } from '../src/voice/openai.js';
import { openSocket, closeError } from '../src/voice/adapter.js';
import { toGeminiSchema } from '../src/voice/schema.js';
import { markOk, snapshot, resetProviderHealthForTests } from '../src/providerHealth.js';

const GEMINI_ALLOWED = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum', 'minItems', 'maxItems']);

function walkSchema(schema, visit) {
  visit(schema);
  for (const spec of Object.values(schema.properties ?? {})) walkSchema(spec, visit);
  if (schema.items) walkSchema(schema.items, visit);
}

beforeEach(() => resetProviderHealthForTests());

test('gemini setup built from the REAL TOOL_DEFS only contains OpenAPI-subset keys (close 1007 regression)', () => {
  const decls = setupMessage({ instructions: 'x', tools: TOOL_DEFS }).setup.tools[0].functionDeclarations;
  assert.equal(decls.length, TOOL_DEFS.length);
  for (const d of decls) {
    assert.ok(d.description, d.name);
    if (d.parameters) walkSchema(d.parameters, (s) => { for (const k of Object.keys(s)) assert.ok(GEMINI_ALLOWED.has(k), `${d.name}: ${k}`); });
  }
  assert.doesNotMatch(JSON.stringify(decls), /additionalProperties/);
});

test('gemini conversion keeps descriptions, enums and required; parameterless tools have no parameters', () => {
  const decls = setupMessage({ instructions: 'x', tools: TOOL_DEFS }).setup.tools[0].functionDeclarations;
  const byName = Object.fromEntries(decls.map((d) => [d.name, d]));
  const doc = byName.read_core_doc.parameters;
  assert.deepEqual(doc.required, ['name']);
  assert.deepEqual(doc.properties.name.enum, ['AGENTS', 'DECISIONS', 'STATE', 'CLAUDE', 'MODEL_POLICY']);
  assert.ok(doc.properties.name.description);
  assert.equal('parameters' in byName.board_threads, false);
  assert.equal('required' in byName.list_jobs.parameters, false);
});

test('toGeminiSchema recurses into nested properties and items and drops $schema/default', () => {
  const out = toGeminiSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { a: { type: 'array', default: [], items: { type: 'object', additionalProperties: false, properties: { b: { type: 'string', default: 'z' } } } } } });
  assert.deepEqual(out, { type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } } });
});

test('xAI and OpenAI setups carry every real tool definition', () => {
  assert.equal(sessionUpdate({ instructions: 'x', tools: TOOL_DEFS }).session.tools.length, TOOL_DEFS.length);
  assert.equal(sessionStart({ instructions: 'x', tools: TOOL_DEFS }).session.delegation.responses.tools.length, TOOL_DEFS.length);
});

test('closeError names the provider and a German reason for known and unknown codes', () => {
  assert.deepEqual(closeError('gemini', 1007, 'Invalid JSON payload').message, 'Gemini Voice: Anfrage vom Anbieter abgelehnt (ungültige Daten) (Invalid JSON payload)');
  assert.match(closeError('xai', 1011, '').message, /^Grok Voice: interner Fehler/);
  assert.match(closeError('openai', 4001, '').message, /^OpenAI Voice: Verbindung mit Code 4001/);
  const quota = closeError('openai', 1008, 'You exceeded your current quota');
  assert.equal(quota.fallback, 'gemini');
});

async function vendor(onConnection) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', onConnection);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}`, close: () => { wss.close(); server.close(); } };
}

const collect = (url, provider, readyOn) => new Promise((resolve) => {
  const events = [];
  const emit = (e) => { events.push(e); if (e.t === 'closed') resolve(events); };
  openSocket(url, {}, { provider, emit, onOpen() {}, onMessage: (m) => readyOn && m[readyOn] && emit({ t: 'ready' }) });
});

test('openSocket: abnormal vendor close before ready emits error then closed and marks the provider failed', async () => {
  const v = await vendor((ws) => ws.close(1007, 'Invalid JSON payload received'));
  const events = await collect(v.url, 'gemini');
  v.close();
  assert.deepEqual(events.map((e) => e.t), ['error', 'closed']);
  assert.match(events[0].message, /^Gemini Voice: Anfrage vom Anbieter abgelehnt/);
  assert.match(events[0].message, /Invalid JSON payload/);
  const g = snapshot().gemini;
  assert.equal(g.ok, false);
  assert.match(g.reason, /^Gemini Voice:/);
});

test('openSocket: abnormal close AFTER ready is surfaced too; a normal close is not an error; ready marks ok', async () => {
  const v = await vendor((ws) => { ws.send(JSON.stringify({ setupComplete: {} })); setTimeout(() => ws.close(1011, 'boom'), 20); });
  const events = await collect(v.url, 'xai', 'setupComplete');
  v.close();
  assert.deepEqual(events.map((e) => e.t), ['ready', 'error', 'closed']);
  assert.equal(snapshot().xai.ok, false);
  markOk('xai');
  assert.equal(snapshot().xai.ok, true);

  const ok = await vendor((ws) => ws.close(1000, 'bye'));
  const normal = await collect(ok.url, 'xai');
  ok.close();
  assert.deepEqual(normal.map((e) => e.t), ['closed']);
});

test('voice instructions tell the model how to reach job_status', async () => {
  const { buildInstructions } = await import('../src/voice/instructions.js');
  assert.match(buildInstructions(null), /job_status/);
});
