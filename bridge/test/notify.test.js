import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginLink, loginCard } from '../src/notify.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-notify-'));
const fake = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};
const URL_OK = 'https://desk.app.mintapis.com/?login=abc123&next=%2F';

test('loginLink runs `notify now --requested <card>` once and reports sent', async () => {
  const log = path.join(dir, 'args.log');
  process.env.BRIDGE_NOTIFY_BIN = fake('ok', `printf '%s\\n---\\n' "$@" >> '${log}'; echo "sent card 4711"`);
  const r = await loginLink({ url: URL_OK });
  assert.deepEqual(r, { sent: true, detail: 'sent card 4711' });
  const args = fs.readFileSync(log, 'utf8').split('\n---\n').filter(Boolean);
  assert.equal(args.length, 3);
  assert.equal(args[0], 'now');
  assert.equal(args[1], '--requested');
  assert.equal(args[2].trim(), loginCard(URL_OK));
  assert.equal(loginCard(URL_OK), `✅ ERLEDIGT\nWorum geht's: Your Agent Desk login link (desk.app.mintapis.com) is ready to open.\n${URL_OK}\nValid for 24 h, 3 uses.`);
});

test('loginLink rejects urls that are not the desk origin, before anything runs', async () => {
  const marker = path.join(dir, 'ran');
  process.env.BRIDGE_NOTIFY_BIN = fake('never', `touch '${marker}'`);
  for (const bad of ['http://desk.app.mintapis.com/x', 'https://desk.app.mintapis.com.evil.com/', 'https://evil.com/?https://desk.app.mintapis.com/', 'https://desk.app.mintapis.com', 'https://desk.app.mintapis.com/ x', 'https://desk.app.mintapis.com/\nTelegram', '', undefined, 42, `https://desk.app.mintapis.com/${'a'.repeat(700)}`]) {
    await assert.rejects(loginLink({ url: bad }), /desk\.app\.mintapis\.com/, String(bad).slice(0, 40));
  }
  assert.ok(!fs.existsSync(marker));
});

test('loginLink: notify refusing (exit 75, NOT SENT) is sent:false and never leaks the link', async () => {
  process.env.BRIDGE_NOTIFY_BIN = fake('refuse', `echo "NOT SENT: pacing limit for ${URL_OK}" >&2; exit 75`);
  const r = await loginLink({ url: URL_OK });
  assert.equal(r.sent, false);
  assert.equal(r.exit, 75);
  assert.match(r.detail, /NOT SENT: pacing limit/);
  assert.ok(!r.detail.includes('abc123'));
});

test('loginLink: a missing notify binary is sent:false, not a crash', async () => {
  process.env.BRIDGE_NOTIFY_BIN = path.join(dir, 'does-not-exist');
  const r = await loginLink({ url: URL_OK });
  assert.equal(r.sent, false);
  assert.ok(r.detail);
  delete process.env.BRIDGE_NOTIFY_BIN;
});

test('the card text passes the real notify guards (dry run, nothing is sent)', { skip: !fs.existsSync(path.join(os.homedir(), 'bin', 'notify')) }, async () => {
  const { execFileSync } = await import('node:child_process');
  let out;
  try {
    out = execFileSync(path.join(os.homedir(), 'bin', 'notify'), ['now', '--dry-run', '--requested', loginCard('https://desk.app.mintapis.com/?login=DRYRUN')], { encoding: 'utf8', timeout: 30_000 });
  } catch (err) { out = `${err.stdout ?? ''}${err.stderr ?? ''}`; }
  assert.match(out, /\[DRY RUN\] would send/);
  assert.ok(!/unclear card|non-English/.test(out), out);
});
