// Critic round 4, P2-4: the Sandy bridge pushes the hash file to LeChonk; LeChonk warns when its copy is stale.
// Synthetic values in a throwaway home; ssh/scp are mocked.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-window-sync-'));
process.env.BRIDGE_HOME = home;
fs.mkdirSync(path.join(home, '.config'), { recursive: true });
const env = path.join(home, '.config', 'synth-sync.env');
fs.writeFileSync(env, syn('SYNT·H_SY·NC_T·OKEN·=syn·thSy·ncVa·lue0·aa1b·b2cc·3dd\n'));
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { syncWindowFile, windowFileAgeWarning, REPUSH_MS } = await import('../src/windowSync.js');
const { windowFile, resetSecretValues } = await import('../src/secretValues.js');

const recorder = (fail = false) => {
  const calls = [];
  return { calls, run: async (cmd, args) => { calls.push([cmd, ...args]); if (fail) throw Object.assign(new Error('ssh: connect timed out'), { stderr: 'ssh: connect to host lechonk: timed out\n' }); } };
};

test('rebuild + push on the first tick; no push when nothing changed; push again after a store change', async () => {
  resetSecretValues();
  const logs = [];
  const r1 = recorder();
  const a = await syncWindowFile(home, { target: 'lechonk', run: r1.run, log: (m) => logs.push(m) });
  assert.deepEqual(a, { rebuilt: true, pushed: true });
  assert.equal(r1.calls.length, 3);
  assert.equal(r1.calls[1][0], 'scp');
  assert.ok(r1.calls[1].includes(windowFile(home)) && r1.calls[1].at(-1) === 'lechonk:.config/agent-desk/secret-windows.json.tmp');
  assert.match(r1.calls[2].at(-1), /chmod 600 .*\.tmp && mv -f/);
  assert.equal((fs.statSync(windowFile(home)).mode & 0o777).toString(8), '600');
  assert.ok(!JSON.stringify(logs).includes('synthSyncValue'));

  const r2 = recorder();
  assert.deepEqual(await syncWindowFile(home, { target: 'lechonk', run: r2.run }), { rebuilt: false, pushed: false });
  assert.equal(r2.calls.length, 0);

  resetSecretValues();
  const later = Date.now() / 1000 + 5;
  fs.writeFileSync(env, syn('SYNT·H_SY·NC_T·OKEN·=syn·thSy·ncVa·lue0·aa1b·b2cc·3ee\n'));
  fs.utimesSync(env, later, later);
  const r3 = recorder();
  assert.deepEqual(await syncWindowFile(home, { target: 'lechonk', run: r3.run }), { rebuilt: true, pushed: true });
});

test('a failed push is logged, not fatal, and retried on the next tick; a 12 h old push is repeated', async () => {
  const logs = [];
  fs.rmSync(`${windowFile(home)}.pushed`, { force: true });
  const bad = recorder(true);
  const r = await syncWindowFile(home, { target: 'lechonk', run: bad.run, log: (m) => logs.push(m) });
  assert.equal(r.pushed, false);
  assert.match(logs.join('\n'), /push to lechonk failed .*timed out/);
  const good = recorder();
  assert.equal((await syncWindowFile(home, { target: 'lechonk', run: good.run })).pushed, true);
  const again = recorder();
  assert.equal((await syncWindowFile(home, { target: 'lechonk', run: again.run, now: Date.now() + REPUSH_MS + 1000 })).pushed, true);
});

test('target null rebuilds only', async () => {
  const r = recorder();
  assert.equal((await syncWindowFile(home, { target: null, run: r.run })).pushed, false);
  assert.equal(r.calls.length, 0);
});

test('windowFileAgeWarning: fresh -> null, older than 24 h or missing -> a warning', () => {
  assert.equal(windowFileAgeWarning(home), null);
  assert.match(windowFileAgeWarning(home, Date.now() + 25 * 3600_000), /25 h old/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-window-none-'));
  assert.match(windowFileAgeWarning(empty), /missing/);
  fs.rmSync(empty, { recursive: true, force: true });
});
