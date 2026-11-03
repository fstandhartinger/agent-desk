// Item F, the HTTP side: the device switches the `computer` scope itself; commands ride the poll to a device that holds it; results and beats are validated.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';
import fs from 'node:fs';
import { fakeSession, scriptedModel, until } from './helpers/computer.js';

setEnv({});
const { createApp } = await import('../src/server.js');
const { createScreenVision } = await import('../src/screenVision.js');
const { createComputer } = await import('../src/computer/run.js');

let app, base, cookie, sid, tokenA, tokenB, devA, registry, rows = [], vision, computer, model, session, detach;
before(async () => {
  registry = await fakeServer(async (req, res, body) => {
    const u = new URL(req.url, 'http://fake');
    let data = {};
    if (u.pathname === '/v1/devices' && req.method === 'POST') { const id = randomUUID(); rows.push({ ...body, id, expires_at: new Date(body.expires_at).toISOString() }); data = { id }; }
    else if (u.pathname === '/v1/devices/verify') {
      const row = rows.find((r) => r.hash === body.hash && !r.revoked_at);
      if (!row) { res.writeHead(404, { 'content-type': 'application/json' }).end('{}'); return; }
      data = row;
    }
    else if (u.pathname.startsWith('/v1/devices/') && req.method === 'DELETE') { const row = rows.find((r) => u.pathname.endsWith(r.id)); if (row) row.revoked_at = new Date().toISOString(); }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  Object.assign(process.env, { ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
  vision = createScreenVision({ commandTimeouts: { received: 1500, done: 3000, ttl: 3000, keep: 1000 } });
  model = scriptedModel([{ name: 'ui_windows', args: {} }, { name: 'done', args: { summary: 'x' } }]);
  computer = createComputer({ vision, hub: {}, complete: model, tickMs: 1e9 });
  app = createApp({ deviceOptions: { vision, computer } });
  base = `http://127.0.0.1:${await listen(app.server)}`;
  cookie = (await login(base)).cookie;
  sid = (await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json()).sid;
  const pair = async () => (await (await fetch(base + '/api/device/pair', { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } })).json());
  ({ token: tokenA, deviceId: devA } = await pair());
  ({ token: tokenB } = await pair());
  session = fakeSession();
  detach = computer.attach(sid, session);
  vision.attach(sid, { kind: 'voice', trace() {}, setContext: () => 'sent' });
});
after(() => { detach(); app.server.close(); registry.close(); });
const dev = (token, path, body, method = 'POST') => fetch(`${base}/api/device/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const sess = (token, path, body, method = 'POST') => dev(token, `session/${sid}/${path}`, body, method);
const GOAL = 'Übernimm den Computer und öffne die Seite.';

it('off by default: no computer scope, no command, no result or beat route; the app is not capable', async () => {
  assert.equal((await sess(tokenA, `computer/c${'0'.repeat(16)}/result`, { ok: true, code: 'done' })).status, 403);
  assert.equal((await sess(tokenA, 'computer/beat', { run: `r${'0'.repeat(16)}`, state: 'running' })).status, 403);
  assert.equal(computer.ready(sid), false);
  const r = await computer.begin(sid, { text: GOAL, goalArg: '' });
  assert.equal(r.ok, false);
  assert.match(r.text, /kann das gerade nicht/);
});

it('POST /api/device/computer: device token, {enabled:boolean} only, audited; the answer is the new state', async () => {
  for (const body of [{}, { enabled: 'yes' }, { enabled: true, extra: 1 }, { enabled: 1 }]) assert.equal((await dev(tokenA, 'computer', body)).status, 400, JSON.stringify(body));
  assert.equal((await fetch(`${base}/api/device/computer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 401, 'no token');
  assert.equal((await fetch(`${base}/api/device/computer`, { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN, 'content-type': 'application/json' }, body: '{"enabled":true}' })).status, 401, 'a browser session cannot switch it');
  assert.equal(app.devices.computerEnabled(devA), false);
  const on = await dev(tokenA, 'computer', { enabled: true });
  assert.deepEqual(await on.json(), { ok: true, enabled: true });
  assert.equal(app.devices.computerEnabled(devA), true);
  assert.equal(app.devices.computerEnabled('someone-else'), false);
});

it('a run: the command rides the poll to the device that holds the scope (not to another), the result and beat routes validate', async () => {
  const pollA = sess(tokenA, 'commands', undefined, 'GET');
  const pollB = fetch(`${base}/api/device/session/${sid}/commands`, { headers: { authorization: `Bearer ${tokenB}` }, signal: AbortSignal.timeout(1500) }).then((r) => r.json(), () => null); // device B never switched it on: it must never get a computer command
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(computer.ready(sid), true, 'device A polled with the scope');
  const begin = computer.begin(sid, { text: GOAL, goalArg: '' });
  const answer = await (await pollA).json();
  assert.equal(answer.fresh, false);
  assert.equal(answer.computer.op, 'start');
  assert.equal(answer.computer.goal, GOAL);
  assert.match(answer.computer.id, /^c[0-9a-f]{16}$/);
  assert.match(answer.computer.run, /^r[0-9a-f]{16}$/);
  const path = `computer/${answer.computer.id}/result`;
  // device B: unknown command (404), not a delivered one
  assert.equal((await sess(tokenB, path, { ok: true, code: 'done' })).status, 403, 'B has no scope');
  // validation
  assert.equal((await sess(tokenA, path, { ok: true, code: 'weird' })).status, 400);
  assert.equal((await sess(tokenA, path, { ok: true, code: 'done', text: 'x' })).status, 400);
  assert.equal((await sess(tokenA, path, { ok: true, code: 'done', result: { jpeg: 'A'.repeat(300 * 1024 + 1) } })).status, 400);
  assert.equal((await sess(tokenA, `computer/c${'1'.repeat(16)}/result`, { ok: true, code: 'done' })).status, 404);
  assert.ok((await sess(tokenA, 'computer/cXYZ/result', { ok: true, code: 'done' })).status >= 400, 'malformed ids never match');
  assert.equal((await sess(tokenA, path, { ok: true, code: 'done' })).status, 200);
  assert.equal((await begin).ok, true);
  // the loop's first action reaches the next poll
  const next = await (await sess(tokenA, 'commands', undefined, 'GET')).json();
  assert.equal(next.computer.op, 'action');
  assert.equal(next.computer.tool, 'ui_windows');
  assert.equal((await sess(tokenA, `computer/${next.computer.id}/result`, { ok: true, code: 'done', class: 'R0', rule: 'read', result: { windows: [] } })).status, 200);
  // beats
  const run = answer.computer.run;
  assert.equal((await sess(tokenA, 'computer/beat', { run, state: 'running' })).status, 200);
  assert.deepEqual(await (await sess(tokenA, 'computer/beat', { run, state: 'running' })).json(), computer.isOpen(sid) ? { ok: true } : { ok: false, code: 'no-run' });
  assert.equal((await sess(tokenA, 'computer/beat', { run: 'bad', state: 'running' })).status, 400);
  assert.equal((await sess(tokenA, 'computer/beat', { run, state: 'running', x: 1 })).status, 400);
  await until(() => !computer.isOpen(sid));
  assert.deepEqual(await (await sess(tokenA, 'computer/beat', { run, state: 'running' })).json(), { ok: false, code: 'no-run' });
  assert.equal((await pollB)?.computer, undefined, 'device B got no computer command');
});

it('the app\'s computer.* trace events are accepted on the session trace and the device log (never page text: the app sends labels and lengths only)', async () => {
  const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/computer-contract.json', import.meta.url), 'utf8'));
  const events = FX.traceTypes.map((type) => ({ type, data: { run: `r${'0'.repeat(16)}`, tool: 'ui_click', chars: 5 } }));
  assert.equal((await sess(tokenA, 'trace', { events })).status, 200);
  const log = await dev(tokenA, 'log', { events });
  assert.equal(log.status, 200);
  assert.equal((await log.json()).accepted, events.length);
  assert.equal((await dev(tokenA, 'log', { events: [{ type: 'computer', data: {} }] })).status, 400, 'only computer.<name>');
  assert.equal((await dev(tokenA, 'log', { events: [{ type: 'job.start', data: {} }] })).status, 400, 'other families stay refused');
});

it('a result body over 512 kB is refused; switching the scope off removes it again', async () => {
  const big = await sess(tokenA, `computer/c${'2'.repeat(16)}/result`, { ok: true, code: 'done', result: { text: 'x'.repeat(600 * 1024) } });
  assert.ok(big.status >= 400 && big.status !== 200);
  const off = await dev(tokenA, 'computer', { enabled: false });
  assert.deepEqual(await off.json(), { ok: true, enabled: false });
  assert.equal((await sess(tokenA, 'computer/beat', { run: `r${'0'.repeat(16)}`, state: 'running' })).status, 403);
});

it('revoking the device in the registry takes the scope with it', async () => {
  await dev(tokenA, 'computer', { enabled: true });
  assert.equal(app.devices.computerEnabled(devA), true);
  const res = await fetch(`${base}/api/device/revoke/${devA}`, { method: 'DELETE', headers: { cookie, origin: process.env.DESK_ORIGIN } });
  assert.equal(res.status, 200);
  assert.equal(app.devices.computerEnabled(devA), false);
});
