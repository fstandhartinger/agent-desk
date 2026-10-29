import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translate as gemini, setupMessage, MODELS } from '../src/voice/gemini.js';
import { translate as openai, sessionStart } from '../src/voice/openai.js';
import { translate as xai, sessionUpdate } from '../src/voice/xai.js';
import { unavailableError } from '../src/voice/adapter.js';
import { estimateCost } from '../src/voice/prices.js';

const frames = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const tools = [{ name: 'job_status', description: 'd', parameters: { type: 'object', properties: {} } }];

// recorded frames from a real Gemini Live session (audio payloads elided to "<b64 n>", re-inflated here)
const inflate = (f) => JSON.parse(JSON.stringify(f).replace(/"<b64 (\d+)>"/g, (_, n) => `"${'A'.repeat(Number(n))}"`));

test('gemini: recorded tool session translates to ready, transcripts, audio, tool_call, turn_done', () => {
  const events = frames('frames-gemini-job-status.json').flatMap((f) => gemini(inflate(f)));
  const types = new Set(events.map((e) => e.t));
  for (const t of ['ready', 'audio', 'transcript', 'tool_call', 'turn_done', 'speech_started']) assert.ok(types.has(t), t);
  const call = events.find((e) => e.t === 'tool_call');
  assert.deepEqual([call.name, call.args], ['job_status', { name: 'reax2-next-steps' }]);
  const user = events.filter((e) => e.t === 'transcript' && e.role === 'user').map((e) => e.delta).join('');
  assert.match(user, /Stand vom Job/);
  const assistant = events.filter((e) => e.t === 'transcript' && e.role === 'assistant').map((e) => e.delta).join('');
  assert.match(assistant, /reax2-next-steps/);
});

test('gemini: interrupted maps to speech_started; setup uses thinking only for the extended model', () => {
  assert.deepEqual(gemini({ serverContent: { interrupted: true } }), [{ t: 'speech_started' }]);
  const ext = setupMessage({ instructions: 'x', tools }).setup;
  assert.equal(ext.model, MODELS.thinking);
  assert.equal(ext.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(setupMessage({ instructions: 'x', tools, model: MODELS.fast }).setup.generationConfig.thinkingConfig, undefined);
  assert.equal(ext.tools[0].functionDeclarations[0].name, 'job_status');
});

test('openai: session.start carries gpt-live-1 + the configured fast delegate (r10 default gpt-6.1-sol / low) with function tools', () => {
  const s = sessionStart({ instructions: 'x', tools }).session;
  assert.equal(s.model, 'gpt-live-1');
  assert.deepEqual(s.delegation.responses.reasoning, { effort: 'low' });
  assert.equal(s.delegation.responses.model, 'gpt-6.1-sol');
  assert.equal(s.delegation.responses.tools[0].type, 'function');
});

test('openai: the delegate never runs at high / xhigh / max (Astra rule); env overrides model and effort', async () => {
  const { delegateConfig } = await import('../src/voice/openai.js');
  assert.deepEqual(delegateConfig('gpt-6-astra', 'high'), { model: 'gpt-6-astra', reasoning: { effort: 'medium' } });
  assert.deepEqual(delegateConfig('gpt-6-astra', 'xhigh'), { model: 'gpt-6-astra', reasoning: { effort: 'medium' } });
  assert.deepEqual(delegateConfig('gpt-6.1-sol', 'low'), { model: 'gpt-6.1-sol', reasoning: { effort: 'low' } });
  process.env.DESK_OPENAI_DELEGATE_MODEL = 'gpt-6-astra';
  process.env.DESK_OPENAI_DELEGATE_EFFORT = 'max';
  try { assert.deepEqual(delegateConfig(), { model: 'gpt-6-astra', reasoning: { effort: 'medium' } }); } finally { delete process.env.DESK_OPENAI_DELEGATE_MODEL; delete process.env.DESK_OPENAI_DELEGATE_EFFORT; }
});

test('openai: documented events translate (audio, transcripts, nested function call, credit error)', () => {
  assert.deepEqual(openai({ type: 'session.output_audio.delta', delta: Buffer.from([1, 0]).toString('base64') })[0].pcm, Buffer.from([1, 0]));
  assert.deepEqual(openai({ type: 'session.input_transcript.delta', delta: 'hi' }), [{ t: 'transcript', role: 'user', delta: 'hi', final: false }]);
  const call = openai({ type: 'response.event', delegation_id: 'd', event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'job_status', arguments: '{"name":"x"}' } } });
  assert.deepEqual(call, [{ t: 'tool_call', id: 'c1', name: 'job_status', args: { name: 'x' } }]);
  assert.deepEqual(openai({ type: 'response.event', event: { type: 'response.completed' } }), [{ t: 'turn_done' }]);
  const err = openai({ type: 'error', error: { code: 'credit_balance_exhausted', message: 'You have no credits' } })[0];
  assert.equal(err.fallback, 'gemini');
});

test('xai: documented events translate; session.update has pcm 24k, server_vad and function tools', () => {
  const u = sessionUpdate({ instructions: 'x', tools }).session;
  assert.equal(u.turn_detection.type, 'server_vad');
  assert.equal(u.audio.input.format.rate, 24000);
  assert.equal(u.tools[0].type, 'function');
  const state = {};
  assert.equal(xai({ type: 'session.updated' }, state)[0].t, 'ready');
  assert.deepEqual(xai({ type: 'session.updated' }, state), []);
  assert.equal(xai({ type: 'response.output_audio.delta', delta: 'AAA=' })[0].t, 'audio');
  assert.deepEqual(xai({ type: 'response.function_call_arguments.done', call_id: 'c', name: 'n', arguments: '{"a":1}' }), [{ t: 'tool_call', id: 'c', name: 'n', args: { a: 1 } }]);
});

test('fallback mapping: 401/402/403 and credit codes become the German fallback error', () => {
  for (const status of [401, 402, 403]) {
    const e = unavailableError('xai', { status });
    assert.equal(e.message, 'Grok Voice ist gerade nicht verfügbar (xAI-Guthaben aufgebraucht)');
    assert.equal(e.fallback, 'gemini');
  }
  assert.equal(unavailableError('openai', { code: 'insufficient_quota' }).fallback, 'gemini');
  assert.equal(unavailableError('xai', { status: 500 }), null);
  assert.equal(unavailableError('gemini', { status: 403 }).fallback, undefined);
});

test('cost estimate scales with seconds and is provider specific', () => {
  assert.ok(estimateCost('openai', 60) > estimateCost('xai', 60));
  assert.equal(estimateCost('gemini', 0), 0);
});
