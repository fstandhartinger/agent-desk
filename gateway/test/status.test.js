import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { completionStream, connectFakeBridge, fakeServer, login, readSse, setEnv, startGateway } from './helpers/env.js';

let xai;
let openai;
let openrouter;
let gw;
let bridge;
let cookie;
let health;
let probe;

before(async () => {
  xai = await fakeServer((req, res) => res.writeHead(xai.status, { 'content-type': 'application/json' }).end(JSON.stringify(xai.body)));
  openai = await fakeServer((req, res) => res.writeHead(openai.status, { 'content-type': 'application/json' }).end(JSON.stringify(openai.body)));
  openrouter = await fakeServer((req, res) => (openrouter.status === 200
    ? res.writeHead(200, { 'content-type': 'text/event-stream' }).end(completionStream({ text: 'ok' }))
    : res.writeHead(openrouter.status, { 'content-type': 'application/json' }).end('{"error":{"message":"nope"}}')));
  setEnv({ XAI_API_KEY: 'xai-test', OPENAI_API_KEY: 'sk-test', GOOGLE_API_KEY: 'g-test', ELEVENLABS_API_KEY: 'el-test', XAI_BASE_URL: xai.url, OPENAI_BASE_URL: openai.url, OPENROUTER_BASE_URL: openrouter.url, EXPLAINER_ORIGIN: 'http://127.0.0.1:9' });
  health = await import('../src/providerHealth.js');
  probe = await import('../src/providerProbe.js');
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
  bridge = await connectFakeBridge(gw.port, { 'claude.list': () => ({ sessions: [] }), 'audit.append': () => ({}) });
});
after(() => { bridge.ws.close(); gw.close(); xai.close(); openai.close(); openrouter.close(); });
beforeEach(() => {
  health.resetProviderHealthForTests();
  probe.resetProbesForTests();
  Object.assign(xai, { status: 200, body: { data: [] } });
  Object.assign(openai, { status: 200, body: { data: [] } });
  Object.assign(openrouter, { status: 200 });
});

const status = async () => (await fetch(`${gw.base}/api/status`, { headers: { cookie } })).json();

describe('/api/status', () => {
  it('reports configured and usable per provider under the keys the UI uses (gemini, not google)', async () => {
    const { providers } = await status();
    assert.deepEqual(Object.keys(providers).sort(), ['elevenlabs', 'gemini', 'openai', 'openrouter', 'xai']);
    for (const p of Object.values(providers)) assert.deepEqual([p.configured, p.ok], [true, null]);
    health.markFailure('gemini', 'Schlüssel abgelehnt');
    const after = (await status()).providers.gemini;
    assert.deepEqual([after.configured, after.ok, after.reason], [true, false, 'Schlüssel abgelehnt']);
  });

  it('keeps bridges[].claude.running live from claude:list events', async () => {
    const running = async () => (await status()).bridges[0].claude.running;
    assert.equal(await running(), 0);
    bridge.emit('claude:list', { sid: 'd20261024-aaaaaa', state: 'running' });
    bridge.emit('claude:list', { sid: 'd20261024-bbbbbb', state: 'starting' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await running(), 2);
    bridge.emit('claude:list', { sid: 'd20261024-aaaaaa', state: 'idle' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await running(), 1);
  });
});

describe('provider probes', () => {
  it('xAI: 403 (no credits) → failed with a German reason; 200 → ok again', async () => {
    Object.assign(xai, { status: 403, body: { error: 'Your team has either used all available credits' } });
    await probe.probeProviders();
    assert.deepEqual([health.snapshot().xai.ok, health.snapshot().xai.reason], [false, 'Kein Guthaben']);
    Object.assign(xai, { status: 200, body: { data: [] } });
    await probe.probeProviders();
    assert.equal(health.snapshot().xai.ok, true);
  });

  it('OpenAI: an embedding that answers insufficient_quota / credit_balance_exhausted → failed', async () => {
    Object.assign(openai, { status: 429, body: { error: { type: 'insufficient_quota', code: 'credit_balance_exhausted', message: 'You have no credits remaining' } } });
    await probe.probeProviders();
    assert.deepEqual([health.snapshot().openai.ok, health.snapshot().openai.reason], [false, 'Kein Guthaben']);
    assert.match(openai.seen.at(-1).url, /\/embeddings$/);
    assert.equal(openai.seen.at(-1).body.input, 'a');
  });

  it('a transient error (500) changes nothing; the probe does not hide a real failure reported by a voice session', async () => {
    Object.assign(openai, { status: 500, body: {} });
    await probe.probeProviders();
    assert.equal(health.snapshot().openai.ok, null);
    health.markFailure('openai', 'Live-Sitzung abgelehnt');
    Object.assign(openai, { status: 200, body: { data: [] } });
    await probe.probeProviders();
    assert.deepEqual([health.snapshot().openai.ok, health.snapshot().openai.reason], [false, 'Live-Sitzung abgelehnt']);
  });

  it('a real OpenRouter chat marks the provider ok, a 402 marks it failed', async () => {
    const chat = () => fetch(`${gw.base}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: 'c', messages: [{ role: 'user', content: 'hi' }] }) });
    await readSse(await chat(), (e) => e.some((x) => x.type === 'done'));
    assert.equal(health.snapshot().openrouter.ok, true);
    openrouter.status = 402;
    const events = await readSse(await chat(), (e) => e.some((x) => x.type === 'error'));
    assert.equal(events.find((e) => e.type === 'error').message, 'Beim Textmodell-Anbieter ist kein Guthaben mehr da');
    assert.equal(health.snapshot().openrouter.ok, false);
  });
});
