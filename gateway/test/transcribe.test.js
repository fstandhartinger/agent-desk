import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fakeServer, login, setEnv, startGateway } from './helpers/env.js';

let openai;
let models;
let behaviour; // model -> {status, body}
let gw;
let eleven;
let elevenBehaviour = {};
let cookie;
const AUDIO = Buffer.alloc(4000, 7);

before(async () => {
  openai = await fakeServer((req, res) => {
    if (req.url === '/v1/models') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
    const model = /name="model"\r\n\r\n([^\r]+)/.exec(openai.seen.at(-1).raw.toString('latin1'))?.[1];
    const { status = 200, body = { text: ' Guten Morgen Florian. ' } } = behaviour[model] ?? {};
    return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  eleven = await fakeServer((req, res) => {
    const { status = 200, body = { text: ' Hallo Desk. ' } } = elevenBehaviour;
    return res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  setEnv({ OPENAI_API_KEY: 'sk-test-openai', OPENAI_BASE_URL: `${openai.url}/v1`, ELEVENLABS_API_KEY: '', ELEVENLABS_BASE_URL: `${eleven.url}/v1` });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
});
after(() => { gw.close(); openai.close(); eleven.close(); });
beforeEach(async () => {
  openai.seen.length = 0;
  (await import('../src/transcribe.js')).resetTranscribeForTests();
});

const send = (body = AUDIO, type = 'audio/webm;codecs=opus') => fetch(`${gw.base}/api/transcribe`, { method: 'POST', headers: { cookie, 'content-type': type }, body });
const modelsUsed = () => openai.seen.filter((r) => r.url.includes('transcriptions')).map((r) => /name="model"\r\n\r\n([^\r]+)/.exec(r.raw.toString('latin1'))[1]);

describe('POST /api/transcribe', () => {
  it('prefers gpt-live-transcribe, sends German and returns trimmed text', async () => {
    models = ['whisper-1', 'gpt-live-transcribe', 'gpt-4o-transcribe'];
    behaviour = {};
    const res = await send();
    assert.deepEqual(await res.json(), { text: 'Guten Morgen Florian.' });
    assert.deepEqual(modelsUsed(), ['gpt-live-transcribe']);
    const upload = openai.seen.at(-1);
    assert.match(upload.raw.toString('latin1'), /name="language"\r\n\r\nde/);
    assert.equal(upload.headers.authorization, 'Bearer sk-test-openai');
  });

  it('falls through to the next model when one does not accept the endpoint, then remembers', async () => {
    models = ['gpt-live-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
    behaviour = { 'gpt-live-transcribe': { status: 400, body: { error: { message: 'model not supported' } } } };
    assert.equal((await send()).status, 200);
    assert.deepEqual(modelsUsed(), ['gpt-live-transcribe', 'gpt-4o-transcribe']);
    openai.seen.length = 0;
    await send();
    assert.deepEqual(modelsUsed(), ['gpt-4o-transcribe']);
  });

  it('uses whisper-1 when nothing better exists', async () => {
    models = ['whisper-1', 'gpt-4o'];
    behaviour = {};
    await send();
    assert.deepEqual(modelsUsed(), ['whisper-1']);
  });

  it('reports exhausted credit without leaking vendor details', async () => {
    models = ['gpt-4o-transcribe'];
    behaviour = { 'gpt-4o-transcribe': { status: 429, body: { error: { code: 'insufficient_quota', message: 'secret org details' } } } };
    const res = await send();
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: 'Der Diktat-Anbieter hat kein Guthaben mehr' });
  });

  it('validates content type, size and the cookie', async () => {
    models = ['whisper-1'];
    behaviour = {};
    assert.equal((await send(AUDIO, 'text/plain')).status, 415);
    assert.equal((await send(Buffer.alloc(10))).status, 400);
    assert.equal((await send(Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
    const anonymous = await fetch(`${gw.base}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: AUDIO });
    assert.equal(anonymous.status, 401);
  });
});

describe('POST /api/transcribe with ElevenLabs', () => {
  before(() => setEnv({ ELEVENLABS_API_KEY: 'xi-test' }));
  after(() => setEnv({ ELEVENLABS_API_KEY: '' }));

  it('uses Scribe first and never touches OpenAI when it works', async () => {
    elevenBehaviour = {};
    const res = await send();
    assert.deepEqual(await res.json(), { text: 'Hallo Desk.' });
    const upload = eleven.seen.at(-1).raw.toString('latin1');
    assert.match(upload, /name="model_id"\r\n\r\nscribe_v2/);
    assert.match(upload, /name="language_code"\r\n\r\ndeu/);
    assert.equal(eleven.seen.at(-1).headers['xi-api-key'], 'xi-test');
    assert.deepEqual(modelsUsed(), []);
  });

  it('falls back to OpenAI when Scribe fails', async () => {
    elevenBehaviour = { status: 500, body: { detail: 'down' } };
    models = ['gpt-4o-transcribe'];
    behaviour = {};
    const res = await send();
    assert.deepEqual(await res.json(), { text: 'Guten Morgen Florian.' });
    assert.deepEqual(modelsUsed(), ['gpt-4o-transcribe']);
  });
});
