// Critic round 2: P2-9 (OpenRouter privacy routing) and P2-5 (the Claude proposal prompt is redacted). Synthetic values only.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { completeChat, completeJSON, postOpenRouter, resetPrivacyRouting, streamChat } from '../src/llm.js';
import { openRouterJSON } from '../src/viz.js';
import { createClaudeProposalStore } from '../src/claudeProposal.js';
import { syn } from './synthetic.js';

const realFetch = globalThis.fetch;
let bodies;
let replies;
const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const json = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), { status: 200 });

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key-not-secret';
  resetPrivacyRouting();
  bodies = [];
  replies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = replies.shift();
    return next ? next() : json('{"ok":true}');
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const drain = async (gen) => { for await (const _ of gen) { /* consume */ } };

describe('OpenRouter privacy routing (P2-9)', () => {
  it('every call path sends data_collection deny and zdr', async () => {
    replies.push(() => sse('hallo'));
    await drain(streamChat({ model: 'm/a', messages: [{ role: 'user', content: 'x' }] }));
    await completeChat({ model: 'm/b', messages: [{ role: 'user', content: 'x' }] });
    await completeJSON({ model: 'm/c', messages: [{ role: 'user', content: 'x' }] });
    await openRouterJSON({ model: 'm/d', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(bodies.length, 4);
    for (const b of bodies) assert.deepEqual(b.provider, { data_collection: 'deny', zdr: true }, b.model);
  });

  it('no ZDR endpoint (404) -> one retry without zdr but with data_collection deny, remembered for the model', async () => {
    const warn = console.warn;
    const warned = [];
    console.warn = (m) => warned.push(m);
    try {
      replies.push(() => new Response('{"error":{"message":"No endpoints found matching your data policy"}}', { status: 404 }));
      const out = await completeChat({ model: 'm/nozdr', messages: [{ role: 'user', content: 'x' }] });
      assert.equal(out.message.content, '{"ok":true}');
      assert.deepEqual(bodies.map((b) => b.provider), [{ data_collection: 'deny', zdr: true }, { data_collection: 'deny' }]);
      await completeChat({ model: 'm/nozdr', messages: [{ role: 'user', content: 'x' }] });
      assert.deepEqual(bodies[2].provider, { data_collection: 'deny' });
      await completeChat({ model: 'm/other', messages: [{ role: 'user', content: 'x' }] });
      assert.deepEqual(bodies[3].provider, { data_collection: 'deny', zdr: true });
      assert.equal(warned.length, 1);
      assert.match(warned[0], /no zero-data-retention endpoint for m\/nozdr/);
    } finally {
      console.warn = warn;
    }
  });

  it('other errors are not retried', async () => {
    replies.push(() => new Response('{}', { status: 402 }));
    const r = await postOpenRouter('https://example.test/chat/completions', {}, { model: 'm/e' });
    assert.equal(r.status, 402);
    assert.equal(bodies.length, 1);
  });

  it('a caller-set provider field is kept and the privacy fields win', async () => {
    await postOpenRouter('https://example.test/chat/completions', {}, { model: 'm/f', provider: { sort: 'latency', data_collection: 'allow' } });
    assert.deepEqual(bodies[0].provider, { sort: 'latency', data_collection: 'deny', zdr: true });
  });
});

describe('Claude proposal prompt is redacted (P2-5)', () => {
  it('stores and shows the prompt without the secret', () => {
    const store = createClaudeProposalStore();
    const p = store.propose({ sid: 'a', prompt: syn("Prüfe das Setup: {'SYNTH_API_KEY': 'synt·hPro·posa·lVal·ue01·2345·6789'} und berichte.") });
    assert.ok(!p.prompt.includes(syn('synt·hPro·posa·lVal·ue01·2345·6789')), p.prompt);
    assert.match(p.prompt, /\[REDACTED\]/);
    assert.match(p.prompt, /^Prüfe das Setup/);
  });
});
