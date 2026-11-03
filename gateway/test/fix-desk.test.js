// v0.1.7 fix-desk: the critic's findings on the desk branch. Synthetic data only (public repo).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactService } from '../src/artifacts.js';

const card = (id, n, title) => ({ id, title, summary: '', kind: 'card', refs: [{ kind: 'card', label: 'Karte', target: `card:${n}` }] });
function cardService(rows) {
  const seen = [];
  const service = createArtifactService({ env: { ARTIFACTS_URL: 'https://fake.test', ARTIFACTS_DESK_TOKEN: 'fake' }, fetchImpl: async (url) => {
    const u = new URL(String(url)); seen.push(u.pathname + u.search);
    if (u.pathname === '/v1/search') { const q = u.searchParams.get('q'); return Response.json({ items: rows.filter(r => r.refs.some(x => x.target === `card:${q}`)) }); }
    const ids = u.searchParams.get('ids').split(',');
    return Response.json({ items: rows.filter(r => ids.includes(r.id)), unknown: ids.filter(i => !rows.some(r => r.id === i)) });
  } });
  return { service, seen };
}
it('M1: artifact_resolve takes card numbers and card:N', async () => {
  const { service } = cardService([card('dbc8f1', 19209, 'Lock the engine')]);
  assert.deepEqual((await service.resolve('s', ['19209'])).items.map(i => i.id), ['dbc8f1']);
  assert.deepEqual((await service.resolve('s', ['card:19209'])).items.map(i => i.id), ['dbc8f1']);
  const bad = await service.resolve('s', ['card:777']);
  assert.deepEqual(bad.items, []); assert.deepEqual(bad.invalid, ['card:777']);
});
it('M1: a six-digit card number is a card first and an id only when no such card exists', async () => {
  const { service, seen } = cardService([card('dbc8f1', 192090, 'Six digit card'), card('624670', 5, 'Has a digit-only id')]);
  assert.deepEqual((await service.resolve('s', ['192090'])).items.map(i => i.id), ['dbc8f1']);
  assert(!seen.some(p => p.includes('ids=192090')), 'not read as an a# id');
  assert.deepEqual((await service.resolve('s2', ['624670'])).items.map(i => i.id), ['624670'], 'no card 624670: falls back to the id');
});

// ---- M4: caption ledger ----
const { limits, CAPTION_DAY_USD, CAPTION_HOUR_USD, Limits } = await import('../src/limits.js');
const { createDeviceMedia } = await import('../src/deviceMedia.js');
const wavOf = (s) => { const pcm = Buffer.alloc(s * 32000); const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40); return Buffer.concat([h, pcm]); };
it('M4: captions stop at USD 1/hour and 2/day per device with code caption-budget, and never touch the shared cap', async () => {
  const media = createDeviceMedia({ env: { OPENROUTER_API_KEY: 'k' }, fetchImpl: async () => Response.json({ text: 'x', usage: { seconds: 1, cost: 0.4 } }) });
  const shared = limits.costToday();
  const ok = await media.caption(wavOf(1), [], 'dev-ledger');
  assert.equal(ok.cost, 0.4);
  await media.caption(wavOf(1), [], 'dev-ledger'); await media.caption(wavOf(1), [], 'dev-ledger'); // 1.2 > hour cap
  await assert.rejects(media.caption(wavOf(1), [], 'dev-ledger'), e => e.status === 429 && e.code === 'caption-budget' && e.body.scope === 'hour' && e.retryAfter >= 1);
  await media.caption(wavOf(1), [], 'dev-other'); // another device is unaffected
  assert.equal(limits.costToday(), shared, 'shared Desk cap untouched, so dictation keeps working');
  assert.ok(limits.snapshot().captionTodayUsd >= 1.6, 'caption spend stays visible next to spendTodayUsd');
});
it('M4: the day cap bites after the hour window moves on', () => {
  const l = new Limits(), t0 = Date.parse('2026-11-03T10:00:00Z');
  for (let h = 0; h < 2; h++) { l.captionAdd('d', CAPTION_HOUR_USD, t0 + h * 3_600_000); }
  assert.equal(l.captionCheck('d', t0 + 2 * 3_600_000).ok, false);
  assert.equal(l.captionCheck('d', t0 + 2 * 3_600_000).scope, 'day');
  assert.equal(CAPTION_DAY_USD, 2);
});
