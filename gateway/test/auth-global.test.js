import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { CODE, login, setEnv, startGateway } from './helpers/env.js';

setEnv();
let gw;
before(async () => { gw = await startGateway(); });
after(() => gw.close());

const guess = (ip, code) => fetch(`${gw.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ code }) });

it('the all-IP backstop locks out strangers but not an IP that logged in before; its own limit still holds', async () => {
  const florian = '10.20.0.1';
  assert.equal((await login(gw.base, { 'x-forwarded-for': florian })).res.status, 200);

  for (let ip = 1; ip <= 8; ip += 1) for (let i = 0; i < 5; i += 1) assert.equal((await guess(`10.30.0.${ip}`, `wrong-${i}`)).status, 401);

  assert.equal((await guess('10.40.0.1', CODE)).status, 429, 'a new IP is locked out while the backstop is tripped');
  assert.equal((await login(gw.base, { 'x-forwarded-for': florian })).res.status, 200, 'the known IP still gets in');

  for (let i = 0; i < 5; i += 1) assert.equal((await guess(florian, `wrong-${i}`)).status, 401);
  assert.equal((await guess(florian, CODE)).status, 429, 'per-IP limit applies to the known IP too');
});
