import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setEnv, startGateway } from './helpers/env.js';

setEnv();

let gw;
let auth;
before(async () => {
  gw = await startGateway();
  auth = await import('../src/auth.js');
});
after(() => gw.close());
beforeEach(() => auth.resetLoginLimitsForTests());

const tryLogin = (code, ip = '10.9.9.9') => fetch(`${gw.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ code }) });

describe('login links', () => {
  it('logs in up to three times, then refuses', async () => {
    const link = auth.mintLoginLink();
    for (let i = 0; i < 3; i++) {
      const res = await tryLogin(link);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('set-cookie'), /^desk_s=/);
    }
    assert.equal((await tryLogin(link)).status, 401);
  });

  it('refuses expired, tampered and overlong links', async () => {
    assert.equal((await tryLogin(auth.mintLoginLink(1000, Date.now() - 5000))).status, 401);
    const link = auth.mintLoginLink();
    const [, exp, nonce, mac] = link.split('.');
    assert.equal((await tryLogin(`L1.${Number(exp) + 1}.${nonce}.${mac}`, '10.9.9.8')).status, 401);
    assert.equal((await tryLogin(`L1.${exp}.${nonce}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, '10.9.9.7')).status, 401);
    const far = `L1.${Date.now() + 30 * 24 * 3600_000}.${nonce}`;
    assert.equal((await tryLogin(`${far}.${mac}`, '10.9.9.6')).status, 401);
  });

  it('caps the lifetime at seven days', () => {
    const exp = Number(auth.mintLoginLink(365 * 24 * 3600_000).split('.')[1]);
    assert.ok(exp - Date.now() <= 7 * 24 * 3600_000 + 1000);
  });
});
