// Discovery job (15 Nov 2026): the start briefing falls back to the laptop mirror when the Screen Agent sends no main-session
// messages (its 512 kB byte tail of a huge transcript held none: "main-session:no-messages"). Synthetic data only.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({});
const { createBriefing } = await import('../src/briefing.js');

const mirror = { source: 'laptop-mirror', session: 'Fake/0000aaaa', day: '2026-11-15', updatedAt: '2026-11-15T19:55:00Z', messages: [{ role: 'user', at: '2026-11-15T19:10:00Z', text: 'Fake planning figure: 500 units' }, { role: 'assistant', at: '2026-11-15T19:12:00Z', text: 'Fake note taken' }] };
const hub = (laptop) => ({ calls: [], async call(method) { this.calls.push(method); if (method === 'laptop.recent') { if (laptop instanceof Error) throw laptop; return laptop; } return method === 'board.recent' ? { entries: [] } : method === 'notify.cardsRecent' ? { cards: [] } : { state: 'fake' }; } });

it('uses the laptop mirror when the device part has no main-session messages', async () => {
  const b = createBriefing({ hub: hub(mirror), sourceMs: 200, totalMs: 400 });
  b.deviceIn('s1', { windows: [{ process: 'code', title: 'Fake' }] });
  const r = await b.collect('s1');
  assert.match(r.text, /laptop-mirror/);
  assert.match(r.text, /Fake planning figure: 500 units/);
  assert.ok(!r.missing.includes('laptop'));
});

it('keeps the Screen Agent main session when it has messages; a failing mirror is then not "missing"', async () => {
  const b = createBriefing({ hub: hub(new Error('laptop mirror not available')), sourceMs: 200, totalMs: 400 });
  b.deviceIn('s2', { windows: [], mainSession: { source: 'vscode', messages: [{ role: 'user', at: '2026-11-15T10:00:00Z', text: 'Fake from the app' }] } });
  const r = await b.collect('s2');
  assert.match(r.text, /Fake from the app/);
  assert.ok(!r.missing.includes('laptop'));
});

it('reports the mirror as missing only when it was needed', async () => {
  const b = createBriefing({ hub: hub(new Error('laptop mirror not available')), sourceMs: 200, totalMs: 400 });
  b.deviceIn('s3', { windows: [] });
  const r = await b.collect('s3');
  assert.ok(r.missing.includes('laptop'));
});
