import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { test } from 'node:test';
import { BridgeHub } from '../src/bridgeHub.js';

class BridgeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) {
    const frame = JSON.parse(raw);
    this.sent.push(frame);
    this.emit(frame.t, frame);
    if (frame.method === 'claude.list' || frame.method === 'claude.get') this.success(frame.id);
  }
  receive(frame) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  success(id) { this.receive({ t: 'res', id, ok: true, result: {} }); }
  hello(boot, caps = []) { this.receive({ t: 'hello', boot, caps }); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

const initialBoot = '8352a913-7f7d-49cd-8195-7d24186224d4';
const request = '9a2fa955-2303-4d95-8d7e-9434de046d83';
const nextBoot = 'b97f2e38-d933-4c25-af1c-d80ed6845ff4';
function attach(t, hub, host, boot, caps) {
  const ws = new BridgeSocket();
  hub.attach(ws, host);
  t.after(() => ws.close());
  if (boot) ws.hello(boot, caps);
  return ws;
}
async function barrier(ws) {
  const waiting = once(ws, 'drain-check', { signal: AbortSignal.timeout(3000) });
  ws.receive({ t: 'drain-request', request });
  return (await waiting)[0].id;
}

test('drain waits for existing clients and RPCs, fences LeChonk, then resumes after the replacement hello', async (t) => {
  let clientsBusy = true;
  const hub = new BridgeHub({ clientsBusy: () => clientsBusy });
  const lechonk = attach(t, hub, 'lechonk', initialBoot, ['ledger.entries', 'map.discover']);
  const sandy = attach(t, hub, 'sandy', initialBoot, ['ledger.entries']);
  sandy.receive({ t: 'drain-request', request });
  assert.equal(hub.maintenance, null);

  const waiting = barrier(lechonk);
  assert.equal(hub.maintenance, 'waiting');
  assert.ok(!lechonk.sent.some(({ t }) => t === 'drain-check'));
  const existing = hub.call('map.discover', {}, { host: 'lechonk' });
  const existingId = lechonk.sent.at(-1).id;
  clientsBusy = false;
  const id = await waiting;
  assert.equal(hub.maintenance, 'frozen');
  assert.equal(hub.pick('ledger.entries'), 'sandy');
  await assert.rejects(hub.call('code.outline'), /gewartet/);
  await assert.rejects(hub.call('map.discover'), /gewartet/);
  lechonk.receive({ t: 'drain-ready', id });
  assert.equal(hub.maintenance, 'frozen');

  lechonk.success(existingId);
  assert.deepEqual(await existing, {});
  lechonk.receive({ t: 'drain-ready', id: nextBoot });
  assert.equal(hub.maintenance, 'frozen');
  lechonk.receive({ t: 'drain-ready', id });
  assert.equal(hub.maintenance, 'ready');
  assert.equal(lechonk.sent.at(-1).t, 'drain-granted');

  let replay;
  hub.on('bridge-up', (host) => { replay = hub.call('claude.get', {}, { host }); });
  lechonk.close();
  const replacement = attach(t, hub, 'lechonk');
  assert.equal(hub.maintenance, 'ready');
  assert.equal(replay, undefined);
  replacement.hello(nextBoot, ['map.discover']);
  assert.equal(hub.maintenance, null);
  assert.deepEqual(await replay, {});
  const newCall = hub.call('map.discover');
  replacement.success(replacement.sent.at(-1).id);
  assert.deepEqual(await newCall, {});
});

test('same-process reconnect requires a fresh barrier and the operator can cancel', async (t) => {
  const hub = new BridgeHub();
  const lechonk = attach(t, hub, 'lechonk', initialBoot);
  const id = await barrier(lechonk);
  lechonk.receive({ t: 'drain-ready', id });
  assert.equal(hub.maintenance, 'ready');
  lechonk.close();

  const reconnected = attach(t, hub, 'lechonk', initialBoot);
  assert.equal(hub.maintenance, 'ready');
  assert.ok(!reconnected.sent.some((frame) => frame.method === 'claude.list'));
  const fresh = await barrier(reconnected);
  assert.ok(reconnected.sent.some((frame) => frame.method === 'claude.list'));
  assert.notEqual(fresh, id);
  reconnected.receive({ t: 'drain-ready', id });
  assert.equal(hub.maintenance, 'frozen');
  reconnected.receive({ t: 'drain-cancel', request });
  assert.equal(hub.maintenance, null);
  assert.equal(reconnected.sent.at(-1).t, 'drain-cancelled');
});

test('legacy bridge remains routable and cannot start a drain without a boot ID', (t) => {
  const hub = new BridgeHub();
  const ws = attach(t, hub, 'lechonk');
  ws.hello();
  ws.receive({ t: 'drain-request', request });
  assert.equal(hub.maintenance, null);
  assert.deepEqual(hub.hostsFor('map.discover'), ['lechonk']);
});

test('the gateway lets a pending chat finish and rejects new chat and voice admissions during a drain', async (t) => {
  const { default: WebSocket } = await import('ws');
  const { completionStream, connectFakeBridge, DESK_ORIGIN, fakeServer, login, setEnv, startGateway } = await import('./helpers/env.js');
  const providerArrived = Promise.withResolvers();
  let response;
  const provider = await fakeServer((_, res) => {
    response = res;
    providerArrived.resolve();
  });
  t.after(() => provider.close());
  setEnv({ OPENROUTER_BASE_URL: provider.url, DESK_RESEARCH: 'off' });
  const app = await startGateway();
  t.after(() => app.close());
  const { cookie } = await login(app.base);
  const { ws, requests } = await connectFakeBridge(app.port, {
    'claude.list': () => ({ sessions: [] }),
    'audit.append': () => ({ ok: true }),
    'notify.loginLink': () => ({ queued: true }),
  });
  t.after(() => ws.close());
  const frame = (data) => ws.send(JSON.stringify(data));
  frame({ t: 'hello', boot: initialBoot, caps: ['claude.list', 'audit.append'] });

  const chat = () => fetch(`${app.base}/api/chat`, {
    method: 'POST',
    headers: { cookie, origin: DESK_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Name one color.' }] }),
  });
  const existing = chat();
  await Promise.race([providerArrived.promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('local provider did not receive chat')), 3500);
    timer.unref();
  })]);
  const checked = Promise.withResolvers();
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.t === 'drain-check') checked.resolve(msg);
  });
  frame({ t: 'drain-request', request });
  const { setTimeout: delay } = await import('node:timers/promises');
  const signal = AbortSignal.timeout(5000);
  while (app.hub.maintenance !== 'waiting') await delay(20, undefined, { signal });
  // Leave the original chat open past at least one gateway drain check.
  await delay(300);
  assert.equal(app.hub.maintenance, 'waiting');
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(completionStream({ text: 'Blue.' }));
  const accepted = await existing;
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /Blue\./);
  const { id } = await Promise.race([checked.promise, delay(2500, null, { ref: false })]);
  assert.equal((await chat()).status, 503);
  const voice = new WebSocket(`ws://127.0.0.1:${app.port}/api/voice`, { headers: { cookie, origin: DESK_ORIGIN } });
  const [, denied] = await once(voice, 'unexpected-response', { signal });
  assert.equal(denied.statusCode, 503);
  denied.resume();

  frame({ t: 'drain-ready', id });
  while (app.hub.maintenance !== 'ready') await delay(20, undefined, { signal });
  const requestLink = () => fetch(`${app.base}/api/auth/request-link`, {
    method: 'POST',
    headers: { origin: DESK_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ next: '/' }),
  });
  assert.equal((await requestLink()).status, 503);
  assert.ok(!requests.some((frame) => frame.method === 'notify.loginLink'));
  frame({ t: 'drain-cancel', request });
  while (app.hub.maintenance !== null) await delay(20, undefined, { signal });
  assert.equal((await requestLink()).status, 202);
});

test('drain requests and granted restart windows expire', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const hub = new BridgeHub({ clientsBusy: () => busy });
  let busy = true;
  const ws = attach(t, hub, 'lechonk', initialBoot);
  ws.receive({ t: 'drain-request', request });
  assert.equal(hub.maintenance, 'waiting');
  function advanceWithHeartbeats(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      ws.receive({ t: 'ping' });
      t.mock.timers.tick(Math.min(10_000, ms - elapsed));
    }
  }
  advanceWithHeartbeats(120_000);
  assert.equal(hub.maintenance, null);

  busy = false;
  ws.receive({ t: 'drain-request', request });
  t.mock.timers.tick(250);
  t.mock.timers.tick(1000);
  const { id } = ws.sent.findLast((frame) => frame.t === 'drain-check');
  ws.receive({ t: 'drain-ready', id });
  assert.equal(hub.maintenance, 'ready');
  advanceWithHeartbeats(60_000);
  assert.equal(hub.maintenance, null);
});
