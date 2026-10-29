// Critic round 6, slice r7: P2-8 (the connect log counts the hashes of the rebuilt file). Synthetic values in a temp HOME only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-critic6-'));
process.env.BRIDGE_HOME = home;
const sv = await import('../src/secretValues.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('P2-8: secretWindowCount() reports the rebuilt hash file at once, not the cached old one', () => {
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'synth-a.env'), syn('SYNTH_A_TOKEN=Zq7x·Wv2P·Lk9m·Rt4Y·bN8c·Hs3G\n'));
  sv.resetSecretValues();
  sv.buildWindowFile(home);
  const first = sv.secretWindowCount();
  assert.ok(first > 0);
  fs.writeFileSync(path.join(home, '.config', 'synth-b.env'), syn('SYNTH_B_TOKEN=Qm4n·Bv8X·cZ2L·kJh6·GfDs·9aPo·1Iu\n'));
  sv.scanSecretSources(home);
  const r = sv.buildWindowFile(home); // within RECHECK_MS of the first count: the cache must not answer
  assert.equal(sv.secretWindowCount(), r.windows);
  assert.ok(r.windows > first);
});
