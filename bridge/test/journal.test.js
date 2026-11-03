import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// journal.tail: anchored unit pattern, fixed argv with `--` last, deny list on job names, redacted output, 200 lines at most.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-journal-'));
process.env.BRIDGE_HOME = home;
const stub = path.join(home, 'journalctl');
fs.writeFileSync(stub, '#!/bin/sh\necho "args:$*"\necho "api_key=abcdefghijklmnop"\n', { mode: 0o755 });
process.env.BRIDGE_JOURNALCTL = stub;
const journal = await import('../src/journal.js');

test('buildArgv: one unit or one job, no globs, `--` last, lines capped at 200', () => {
  const a = journal.buildArgv({ unit: 'desk-bridge.service', lines: 5000 });
  assert.deepEqual(a.slice(1), ['--user', '--no-pager', '-o', 'short-iso', '-n', '200', '--unit=desk-bridge.service', '--']);
  assert.equal(journal.buildArgv({ job: 'screen-agent-v017-20261103' }).at(-2), '--unit=job-screen-agent-v017-20261103.service');
  assert.equal(journal.buildArgv({ unit: 'a.timer' })[6], '100', 'default 100 lines');
});

test('buildArgv refuses globs, options, both/neither, paths, denied job names, bad line counts', () => {
  for (const bad of [{}, { unit: 'a.service', job: 'x' }, { unit: '*.service' }, { unit: 'job-*' }, { unit: '--all.service' }, { unit: '-u.service' }, { unit: 'a.service; id' }, { unit: '../x.service' }, { unit: 'sshd' }, { unit: 'a b.service' }, { unit: 5 }, { job: '../etc' }, { job: '-x' }, { job: 'a/b' }, { job: 'x*' }]) {
    assert.throws(() => journal.buildArgv(bad), undefined, JSON.stringify(bad));
  }
  for (const job of ['reaxsign-keys-20261101', 'sealed-bench', 'wallet-check', 'x-coldkey', 'swap-mnemonic-1']) assert.throws(() => journal.buildArgv({ job }), /not allowed/, job);
  assert.throws(() => journal.buildArgv({ unit: 'wallet-sync.service' }), /not allowed/);
  for (const lines of [0, -1, 1.5, '5']) assert.throws(() => journal.buildArgv({ unit: 'a.service', lines }), /lines/, String(lines));
});

test('tail runs the stub with the fixed argv and redacts the output', async () => {
  const r = await journal.tail({ unit: 'a.service', lines: 3 });
  assert.match(r.text, /args:--user --no-pager -o short-iso -n 3 --unit=a.service --/);
  assert.ok(!r.text.includes('abcdefghijklmnop'), 'secret redacted');
  assert.equal(r.unit, 'a.service');
});
