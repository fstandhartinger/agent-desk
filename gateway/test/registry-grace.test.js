// 14 Nov 2026 13:52Z: an artifact-registry restart answered /api/auth/me with 503 and the Desk page fell back to the login gate.
// A paired device verified within the grace window stays signed in while the registry is down; a revoked device (404) never does.
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createDeviceService } from '../src/devices.js';

function service() {
  let mode = 'ok', clock = Date.parse('2026-11-14T13:00:00Z');
  const fetchImpl = async () => {
    if (mode === 'down') throw new Error('ECONNREFUSED');
    if (mode === 'gone') return new Response('{}', { status: 404 });
    return new Response(JSON.stringify({ id: 'd1', expires_at: '2026-12-01T00:00:00Z' }), { status: 200 });
  };
  const svc = createDeviceService({ env: { ARTIFACTS_URL: 'http://registry.test', ARTIFACTS_DESK_TOKEN: 'x' }, now: () => clock, fetchImpl, media: {}, screenText: {}, vision: {}, briefing: {}, computer: {} });
  return { svc, set: (m) => { mode = m; }, advance: (ms) => { clock += ms; } };
}

it('registry down: a device verified within 6 h stays signed in, a never-verified one gets 503', async () => {
  const { svc, set, advance } = service();
  set('down');
  await assert.rejects(svc.authorizeSession({ deviceHash: 'h1' }), (err) => err.status === 503);
  set('ok');
  assert.equal(await svc.authorizeSession({ deviceHash: 'h1' }), true);
  set('down');
  advance(60_000);
  assert.equal(await svc.authorizeSession({ deviceHash: 'h1' }), true);
  advance(7 * 3600_000);
  await assert.rejects(svc.authorizeSession({ deviceHash: 'h1' }), (err) => err.status === 503);
});

it('a revoked device (404) is signed out at once and the grace is forgotten', async () => {
  const { svc, set } = service();
  assert.equal(await svc.authorizeSession({ deviceHash: 'h2' }), true);
  set('gone');
  assert.equal(await svc.authorizeSession({ deviceHash: 'h2' }), false);
  set('down');
  await assert.rejects(svc.authorizeSession({ deviceHash: 'h2' }), (err) => err.status === 503);
});
