import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { queueLoginLink, resumeLoginQueue } from '../src/loginQueue.js';
test('durable admission is immediate, private, coalesced, and an ambiguous claim is not replayed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-login-queue-'));
  process.env.BRIDGE_LOGIN_QUEUE_DIR = dir;
  const script = path.join(dir, 'notify'), log = path.join(dir, 'calls');
  await fs.writeFile(script, `#!/bin/sh\necho call >> '${log}'\nsleep 1\necho 'QUEUED: outbox 123'\nexit 75\n`, { mode: 0o700 });
  process.env.BRIDGE_NOTIFY_BIN = script;
  const url = 'https://desk.app.mintapis.com/device?pair=' + 'a'.repeat(43) + '#k=fake-link';
  try {
    const started = Date.now();
    assert.deepEqual(await queueLoginLink({ url }), { queued: true });
    assert(Date.now() - started < 500);
    assert.deepEqual(await queueLoginLink({ url }), { queued: true });
    await new Promise(r => setTimeout(r, 1400));
    assert.equal((await fs.readFile(log, 'utf8')).trim(), 'call');
    const name = (await fs.readdir(dir)).find(n => n.endsWith('.json'));
    assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o600);
    const record = await fs.readFile(path.join(dir, name), 'utf8');
    assert(!record.includes(url)); assert.match(record, /queued-in-notify/);
    await resumeLoginQueue();
    assert.equal((await fs.readFile(log, 'utf8')).trim(), 'call');
    await assert.rejects(queueLoginLink({ url: 'https://foreign.test/' }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
