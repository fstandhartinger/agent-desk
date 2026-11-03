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
