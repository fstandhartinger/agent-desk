// Screen Agent action commands: the prompt rides the long poll as {fresh:false, prompt:{id,text}} (an old app ignores it), the app answers
// on POST .../commands/:id/result. Delivery to exactly one poller, queue + expiry, no-app timeout, result route auth.
import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setEnv, login, listen, fakeServer } from './helpers/env.js';

setEnv({});
const { createApp } = await import('../src/server.js');
const { createScreenVision, COMMAND_CODES } = await import('../src/screenVision.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (deviceId) => ({ deviceId, scopes: ['screen'] });
const T = { received: 80, done: 120, ttl: 40, keep: 1000 };
function visionWith(sid = 's1', t = T) {
  const v = createScreenVision({ commandTimeouts: t });
  const off = v.attach(sid, { kind: 'voice', trace() {}, setContext: () => 'sent' });
  return { v, off, sid };
}
const parked = (v, sid, device, ms = 1000) => v.poll(sid, rec(device), undefined, ms);

it('a parked poll gets {fresh:false, prompt:{id,text}} exactly once, to exactly one poller; the result completes the command', async () => {
  const { v, off, sid } = visionWith('s1', { ...T, received: 1000, ttl: 1000 });
  const a = parked(v, sid, 'devA'), b = parked(v, sid, 'devB');
  const cmd = v.command(sid, { type: 'main-agent-prompt', text: 'Hallo Prompt' });
  const winner = await Promise.race([a.then((x) => ['A', x]), b.then((x) => ['B', x])]);
  const answer = winner[1];
  assert.equal(answer.fresh, false, 'an old app reads fresh:false and ignores the rest');
  assert.deepEqual(Object.keys(answer.prompt).sort(), ['id', 'text']);
  assert.match(answer.prompt.id, /^p[0-9a-f]{16}$/);
  assert.equal(answer.prompt.text, 'Hallo Prompt');
  const other = await (winner[0] === 'A' ? Promise.race([b, sleep(50).then(() => 'none')]) : Promise.race([a, sleep(50).then(() => 'none')]));
  assert.ok(other === 'none' || !other.prompt, 'the other poller gets no prompt');
  // a later poll gets nothing: delivered once
  assert.equal((await parked(v, sid, 'devA', 30)).prompt, undefined);
  const dev = winner[0] === 'A' ? 'devA' : 'devB';
  v.commandResult(sid, rec(dev), answer.prompt.id, { state: 'received' });
  v.commandResult(sid, rec(dev), answer.prompt.id, { state: 'done', code: 'typed', landed: true, chars: 12 });
  assert.deepEqual(await cmd, { id: answer.prompt.id, delivered: true, state: 'done', code: 'typed', landed: true, chars: 12 });
  off();
});

it('queued when no poll is parked but the Screen Agent is attached; delivered at the next poll; expires after the ttl', async () => {
  const { v, off, sid } = visionWith();
  v.seen(sid); // attached through a recent poll
  const cmd = v.command(sid, { type: 'main-agent-prompt', text: 'queued' });
  const got = await parked(v, sid, 'devA', 500);
  assert.equal(got.prompt.text, 'queued');
  v.commandResult(sid, rec('devA'), got.prompt.id, { state: 'done', code: 'typed-unverified', landed: null });
  assert.equal((await cmd).code, 'typed-unverified');
  // expired: nobody polls within ttl -> the poll after it gets nothing, and the command ended with no-app
  const late = v.command(sid, { type: 'main-agent-prompt', text: 'too late' });
  await sleep(60);
  assert.equal((await parked(v, sid, 'devA', 30)).prompt, undefined);
  assert.equal((await late).code, 'no-app');
  off();
});

it('an old app (never answers): no-app after the received window, and the prompt is withdrawn, never typed later', async () => {
  const { v, off, sid } = visionWith();
  const poll = parked(v, sid, 'devOld');
  const t0 = Date.now();
  const res = await v.command(sid, { type: 'main-agent-prompt', text: 'x' });
  assert.deepEqual({ d: res.delivered, c: res.code }, { d: false, c: 'no-app' });
  assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 400);
  assert.equal((await poll).fresh, false); // the old app parsed it as a normal fresh:false answer
  assert.equal((await parked(v, sid, 'devOld', 30)).prompt, undefined);
  off();
});

it('received but no final answer within the done window: timeout (delivered, outcome unknown)', async () => {
  const { v, off, sid } = visionWith();
  const poll = parked(v, sid, 'devA');
  const cmd = v.command(sid, { type: 'main-agent-prompt', text: 'x' });
  const { prompt } = await poll;
  v.commandResult(sid, rec('devA'), prompt.id, { state: 'received' });
  const res = await cmd;
  assert.deepEqual({ d: res.delivered, c: res.code }, { d: true, c: 'timeout' });
  off();
});

it('failed with a code is reported as failed; the first final answer stands', async () => {
  const { v, off, sid } = visionWith();
  const poll = parked(v, sid, 'devA');
  const cmd = v.command(sid, { type: 'main-agent-prompt', text: 'x' });
  const { prompt } = await poll;
  v.commandResult(sid, rec('devA'), prompt.id, { state: 'failed', code: 'no-field' });
  v.commandResult(sid, rec('devA'), prompt.id, { state: 'done', code: 'typed' });
  assert.deepEqual(await cmd, { id: prompt.id, delivered: true, state: 'failed', code: 'no-field', landed: null, chars: undefined });
  off();
});

it('not attached: no-device at once, no wait', async () => {
  const v = createScreenVision({ commandTimeouts: T });
  const t0 = Date.now();
  assert.deepEqual(await v.command('nobody', { type: 'main-agent-prompt', text: 'x' }), { delivered: false, code: 'no-device' });
  assert.ok(Date.now() - t0 < 30);
});

it('the result body is validated: states, codes (list, <= 40), landed, chars; no text comes back', async () => {
  const { v, off, sid } = visionWith();
  const poll = parked(v, sid, 'devA');
  const cmd = v.command(sid, { type: 'main-agent-prompt', text: 'x' });
  const { prompt } = await poll;
  const bad = [{}, { state: 'weird' }, { state: 'done' }, { state: 'done', code: 'nope' }, { state: 'done', code: 'x'.repeat(41) }, { state: 'done', code: 'typed', landed: 'yes' }, { state: 'done', code: 'typed', chars: -1 }, { state: 'done', code: 'typed', chars: 1.5 }, { state: 'done', code: 'typed', text: 'secret text' }, null, [], 'done'];
  for (const body of bad) assert.throws(() => v.commandResult(sid, rec('devA'), prompt.id, body), (e) => e.status === 400, JSON.stringify(body));
  assert.deepEqual(COMMAND_CODES, ['typed', 'typed-unverified', 'no-window', 'no-foreground', 'no-field', 'wrong-focus', 'interrupted', 'busy', 'no-session']);
  v.commandResult(sid, rec('devA'), prompt.id, { state: 'done', code: 'typed', landed: false, chars: 1 });
  await cmd;
  off();
});

// ---- the HTTP route ----
let app, base, cookie, sid, tokenA, tokenB, devA, devB, registry, rows = [];
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
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  });
  Object.assign(process.env, { ARTIFACTS_URL: registry.url, ARTIFACTS_DESK_TOKEN: 'fake' });
  app = createApp({ deviceOptions: { vision: createScreenVision({ commandTimeouts: { ...T, received: 1500, done: 3000, ttl: 3000 } }) } });
  base = `http://127.0.0.1:${await listen(app.server)}`;
  cookie = (await login(base)).cookie;
  sid = (await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json()).sid;
  const pair = async () => (await (await fetch(base + '/api/device/pair', { method: 'POST', headers: { cookie, origin: process.env.DESK_ORIGIN } })).json());
  ({ token: tokenA, deviceId: devA } = await pair());
  ({ token: tokenB, deviceId: devB } = await pair());
});
after(() => { app.server.close(); registry.close(); });
const send = (token, path, body, method = 'POST') => fetch(`${base}/api/device/session/${sid}/${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

it('route: a real long poll delivers the prompt; a foreign device and unknown ids get 404; the owner posts received then done', async () => {
  const vision = app.devices.vision;
  const off = vision.attach(sid, { kind: 'voice', trace() {}, setContext: () => 'sent' });
  const poll = send(tokenA, 'commands', null, 'GET');
  await sleep(50);
  const cmd = vision.command(sid, { type: 'main-agent-prompt', text: 'Route Prompt' });
  const answer = await (await poll).json();
  assert.equal(answer.fresh, false);
  assert.equal(answer.prompt.text, 'Route Prompt');
  const path = `commands/${answer.prompt.id}/result`;
  assert.equal((await send(tokenB, path, { state: 'done', code: 'typed' })).status, 404, 'a command delivered to another device');
  assert.equal((await send(tokenA, `commands/p${'0'.repeat(16)}/result`, { state: 'done', code: 'typed' })).status, 404, 'unknown id');
  assert.ok((await send(tokenA, 'commands/p123/result', { state: 'done', code: 'typed' })).status >= 400, 'malformed id never matches');
  assert.equal((await send(tokenA, path, { state: 'done', code: 'typed', text: 'leak' })).status, 400);
  assert.equal((await send(tokenA, path, { state: 'received' })).status, 200);
  assert.equal((await send(tokenA, path, { state: 'done', code: 'typed', landed: true, chars: 12 })).status, 200);
  assert.equal((await cmd).code, 'typed');
  assert.equal((await fetch(`${base}/api/device/session/${sid}/${path}`, { method: 'POST', body: '{}' })).status, 401, 'no device token');
  off();
});

it('route: without a session the result is 404 (nothing to report on)', async () => {
  assert.equal((await send(tokenA, `commands/p${'a'.repeat(16)}/result`, { state: 'received' })).status, 404);
});
