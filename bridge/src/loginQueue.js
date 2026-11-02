// Durable admission is deliberately separate from Telegram delivery: a slow notifier must never look like
// a failed send and invite a duplicate. Files are private and the link is removed after notifier ownership.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { loginLink } from './notify.js';

const directory = () => process.env.BRIDGE_LOGIN_QUEUE_DIR || path.join(os.homedir(), '.local', 'state', 'agent-desk', 'login-links');
const running = new Set();
async function deliver(file) {
  if (running.has(file)) return;
  running.add(file);
  try {
    const item = JSON.parse(await fs.readFile(file, 'utf8'));
    if (item.state !== 'queued') return;
    if (item.expiresAt <= Date.now()) { await fs.unlink(file); return; }
    // Claim durably before launching notify. After a crash an ambiguous delivery is never replayed.
    await fs.writeFile(file, JSON.stringify({ ...item, state: 'sending' }), { mode: 0o600 });
    const result = await loginLink({ url: item.url });
    // notify either delivered or owns the durable outbox. Never automatically retry ambiguous results.
    await fs.writeFile(file, JSON.stringify({ state: result.sent ? 'sent' : result.queued ? 'queued-in-notify' : 'unknown', expiresAt: item.expiresAt }), { mode: 0o600 });
  } catch { /* Fail closed on an ambiguous delivery; never print a link or retry it. */ }
  finally { running.delete(file); }
}
export async function resumeLoginQueue() {
  const dir = directory();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of await fs.readdir(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const item = JSON.parse(await fs.readFile(file, 'utf8'));
      if (item.expiresAt <= Date.now()) await fs.unlink(file);
      else if (item.state === 'queued') void deliver(file);
    } catch { /* Do not expose private queue data. */ }
  }
}
export async function queueLoginLink({ url } = {}) {
  if (typeof url !== 'string' || url.length > 600 || !/^https:\/\/desk\.app\.mintapis\.com\/[^\s"'`<>\\]*$/.test(url)) throw new Error('invalid Desk login link');
  const dir = directory();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const id = crypto.createHash('sha256').update(url).digest('hex'), file = path.join(dir, id + '.json');
  const item = { url, state: 'queued', expiresAt: Date.now() + 10 * 60_000 };
  // Exclusive create coalesces a repeat even across bridge/gateway reconnects.
  try { await fs.writeFile(file, JSON.stringify(item), { mode: 0o600, flag: 'wx' }); }
  catch (err) { if (err.code !== 'EEXIST') throw new Error('login queue unavailable'); }
  setImmediate(() => void deliver(file));
  return { queued: true };
}
