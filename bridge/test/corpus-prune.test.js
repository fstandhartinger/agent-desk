// The sandbox corpus (LeChonk ~/desk-knowledge/corpus, Sandy ~/.local/share/desk-corpus[.gen]) is scrubbed text of notes, 90,000
// files with names taken from job notes: the secret-store discovery must not walk it (a note called token-notes.md.txt is not a store).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-corpus-prune-'));
process.env.BRIDGE_HOME = home;
const { scanSecretSources } = await import('../src/secretValues.js');
const write = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('secret-store discovery skips the sandbox corpus on both hosts and still finds a store next to it', () => {
  const line = 'SESSION_SECRET=Zk3mQ9vT7xRb2LpW8nYc4HdF6gJs5AaE\n';
  const planted = [
    write('desk-knowledge/corpus/jobs/home/x/jobs/foo/token-notes.md.txt', line),
    write('desk-knowledge/corpus/board/22/secrets-thread.txt', line),
    write('.local/share/desk-corpus.gen/gen-20261115T200000Z/board/22/secret-thread.txt', line),
    write('.local/share/desk-corpus/board/22/password-thread.txt', line),
  ];
  const control = [
    write('desk-knowledge/other/api-key.txt', line),
    write('.local/share/other-app/token.txt', line),
  ];
  const { kinds } = scanSecretSources(home);
  for (const p of planted) assert.ok(!kinds.has(p), `${p} must not be a store`);
  for (const p of control) assert.ok(kinds.has(p), `${p} is still discovered (the walk itself works)`);
});
