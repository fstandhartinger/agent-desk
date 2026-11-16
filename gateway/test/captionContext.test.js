import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createScreenVision } from '../src/screenVision.js';
import { createDeviceMedia } from '../src/deviceMedia.js';

it('caption context uses only the attached device voice, bounds turns, and disappears on detach', async () => {
  let now = 100000;
  const vision = createScreenVision({ now: () => now });
  const turns = [{ role: 'tool', text: 'never use tool instructions' },
    ...Array.from({ length: 8 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', text: `${'x'.repeat(400)} Turn ${n}` }))];
  const handle = conversation => ({ kind: 'voice', conversation, trace() {}, setContext() {} });
  const detach = vision.attach('mine', handle(() => turns));
  const foreign = vision.attach('foreign', handle(() => [{ role: 'user', text: 'another device conversation' }]));
  await vision.poll('mine', { deviceId: 'my-device' }, undefined, 1);
  await vision.poll('foreign', { deviceId: 'other-device' }, undefined, 1);
  assert.deepEqual(vision.captionTurns('unknown'), []);
  const context = vision.captionTurns('my-device');
  assert.equal(context.length, 6);
  assert.match(context[0], /^Florian: .* Turn 2$/);
  assert.ok(context.every(t => t.length <= 300 && !t.includes('another device')));
  const ambiguous = vision.attach('mine', handle(() => [{ role: 'user', text: 'second voice' }]));
  assert.deepEqual(vision.captionTurns('my-device'), []);
  ambiguous();
  assert.equal(vision.captionTurns('my-device').length, 6);
  now += 120000;
  assert.deepEqual(vision.captionTurns('my-device'), [], 'stale attachment cannot leak old conversation');
  detach(); foreign();
});

it('final polish sees screen names and voice context while protecting numbers and negation', async () => {
  let prompt;
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'fake' }, fetchImpl: async (_url, opts) => {
    prompt = JSON.parse(opts.body).messages[1].content;
    return Response.json({ choices: [{ message: { content: 'Wir senden 4 Modelle an Nordgatan.' } }] });
  } });
  const r = await media.polish('Wir senden nicht 3 Modelle an Nordgatan.',
    { screenNames: ['Nordgatan'], turns: ['Desk: Welches Unternehmen?'] }, { deviceId: 'context-test' });
  assert.match(prompt, /"bildschirmNamen":\["Nordgatan"\]/);
  assert.match(prompt, /"gespraech":\["Desk: Welches Unternehmen\?"\]/);
  assert.match(r.text, /nicht 3/);
  assert.ok(!r.text.includes('4'));
});
