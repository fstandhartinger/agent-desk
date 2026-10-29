import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { createGemini } from '../src/voice/gemini.js';
import { createOpenAI } from '../src/voice/openai.js';
import { createXai } from '../src/voice/xai.js';
import { snapshot, resetProviderHealthForTests } from '../src/providerHealth.js';

beforeEach(resetProviderHealthForTests);

// A fake vendor that answers the first client frame with `frames`, then optionally closes with a code.
async function fakeVendor(t, frames, closeCode) {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => {
    ws.once('message', () => {
      for (const f of frames) ws.send(JSON.stringify(f));
      if (closeCode) ws.close(closeCode, 'boom');
    });
  });
  t.after(() => wss.close());
  return `ws://127.0.0.1:${wss.address().port}`;
}

const ADAPTERS = {
  gemini: { create: createGemini, ready: { setupComplete: {} } },
  openai: { create: createOpenAI, ready: { type: 'session.started', session: { model: 'gpt-live-1' } } },
  xai: { create: createXai, ready: { type: 'session.updated' } },
};

for (const [provider, { create, ready }] of Object.entries(ADAPTERS)) {
  test(`${provider}: a translated ready event turns providerHealth green`, async (t) => {
    const url = await fakeVendor(t, [ready]);
    assert.equal(snapshot()[provider].ok, null);
    const adapter = await new Promise((resolve) => {
      const a = create({ apiKey: 'k', instructions: 'x', tools: [], url }, (e) => e.t === 'ready' && resolve(a));
    });
    adapter.close();
    assert.equal(snapshot()[provider].ok, true);
  });

  test(`${provider}: an abnormal vendor close turns providerHealth red`, async (t) => {
    const url = await fakeVendor(t, [], 1011);
    await new Promise((resolve) => {
      create({ apiKey: 'k', instructions: 'x', tools: [], url }, (e) => e.t === 'error' && resolve());
    });
    assert.equal(snapshot()[provider].ok, false);
  });
}
