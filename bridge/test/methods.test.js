import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGateway } from './helpers.js';

// The three round-5 methods over the real wire (fake gateway <-> startBridge).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-methods-home-'));
process.env.BRIDGE_HOME = home;
process.env.DESK_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-'));
process.env.DESK_SESSIONS_DIR = path.join(home, 'desk-sessions');
const fixture = fs.readFileSync(new URL('./fixtures/tax-lines.txt', import.meta.url), 'utf8');
const bin = path.join(home, 'agent-board');
fs.writeFileSync(bin, `#!/bin/sh\ncat '${new URL('./fixtures/tax-lines.txt', import.meta.url).pathname}'\n`, { mode: 0o755 });
const notifyLog = path.join(home, 'notify.log');
const notifyBin = path.join(home, 'notify-fake');
fs.writeFileSync(notifyBin, `#!/bin/sh\nprintf '%s|' "$@" > '${notifyLog}'\necho sent\n`, { mode: 0o755 });
process.env.BRIDGE_BOARD_BIN = bin;
process.env.BRIDGE_NOTIFY_BIN = notifyBin;
process.env.LEDGER_EXPORT = path.join(home, 'no-export.md');
const { startBridge } = await import('../src/bridge.js');

let gw;
let bridge;
before(async () => {
  fs.mkdirSync(path.join(home, 'work', 'agent-desk', 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, 'work', 'agent-desk', 'src', 'a.js'), "// entry\nimport './b.js';\n");
  fs.writeFileSync(path.join(home, 'work', 'agent-desk', 'src', 'b.js'), 'export {}\n');
  gw = await fakeGateway();
  bridge = startBridge({ url: gw.url, token: 'test-token-not-secret', host: 'testhost' });
  await gw.connected;
});
after(async () => {
  bridge.close();
  await gw.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('hello lists the three new methods', () => {
  for (const m of ['ledger.entries', 'code.outline', 'notify.loginLink']) assert.ok(gw.hello.caps.includes(m), m);
});

test('ledger.entries over the wire: synthetic fixture, group by counterparty, filters', async () => {
  const all = await gw.call('ledger.entries', {});
  assert.equal(all.source.kind, 'board');
  assert.equal(all.count, 27);
  assert.equal(all.unparsed, 0);
  assert.ok(all.totals.length > 3 && all.totalsEurApprox.length > 1);
  const by = await gw.call('ledger.entries', { groupBy: 'counterparty', from: '2026-10-20', to: '2026-10-20', kgOnly: true });
  assert.ok(by.entries.every((e) => e.date === '2026-10-20' && e.kg === true));
  assert.ok(by.totals.some((t) => t.key === 'GammaAPI Ltd'));
  await assert.rejects(gw.call('ledger.entries', { groupBy: 'weekday' }), /groupBy/);
});

test('code.outline over the wire; a path outside the read roots is refused', async () => {
  const r = await gw.call('code.outline', { path: path.join(home, 'work', 'agent-desk') });
  assert.deepEqual(r.files.map((f) => [f.path, f.imports]), [['src/a.js', ['src/b.js']], ['src/b.js', []]]);
  await assert.rejects(gw.call('code.outline', { path: '/etc' }), /not allowed or not found/);
});

test('notify.loginLink over the wire sends the card once; a foreign url is an error and sends nothing', async () => {
  const url = 'https://desk.app.mintapis.com/?login=zzz';
  const r = await gw.call('notify.loginLink', { url });
  assert.deepEqual(r, { sent: true, detail: 'sent' });
  assert.match(fs.readFileSync(notifyLog, 'utf8'), /^now\|--requested\|✅ ERLEDIGT\nWorum geht's: Your Agent Desk login link/);
  fs.rmSync(notifyLog);
  await assert.rejects(gw.call('notify.loginLink', { url: 'https://evil.example/' }), /desk\.app\.mintapis\.com/);
  assert.ok(!fs.existsSync(notifyLog));
});
