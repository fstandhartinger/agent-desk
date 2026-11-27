import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { BridgeHub } from '../../gateway/src/bridgeHub.js';

async function waitFor(check) {
  const signal = AbortSignal.timeout(4000);
  while (!check()) await delay(20, undefined, { signal });
}

test('a real bridge acknowledges the drain handshake and a replacement reopens admission', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-drain-test-'));
  process.env.BRIDGE_HOME = dir;
  process.env.BRIDGE_LOGIN_QUEUE_DIR = path.join(dir, 'login-links');
  process.env.DESK_SESSIONS_DIR = path.join(dir, 'sessions');
  await fs.mkdir(path.join(dir, 'jobs'));
  const { startBridge } = await import('../src/bridge.js');
  const listener = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(listener, 'listening');
  const hub = new BridgeHub();
  listener.on('connection', (ws) => hub.attach(ws, 'lechonk'));
  const url = `ws://127.0.0.1:${listener.address().port}`;
  const start = () => startBridge({ url, token: 'offline-test' });
  const bridge = start();
  let replacement;
  t.after(async () => {
    bridge.close();
    replacement?.close();
    await new Promise((resolve) => listener.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  await waitFor(() => hub.status()[0]?.maintenanceSupported);
  bridge.toggleDrain();
  await waitFor(() => hub.maintenance === 'ready');
  await assert.rejects(hub.call('claude.list'), /gewartet/);
  bridge.close();
  await waitFor(() => !hub.isConnected());
  assert.equal(hub.maintenance, 'ready');

  replacement = start();
  await waitFor(() => hub.maintenance === null);
  assert.deepEqual(await hub.call('claude.list'), { sessions: [] });
});
