import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-jobs-'));
process.env.BRIDGE_HOME = home;
const jobs = await import('../src/jobs.js');
const { resolveAllowed, isDenied } = await import('../src/paths.js');

const makeJob = (name, state, ageMs = 0) => {
  const dir = path.join(home, 'jobs', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'STATE.md'), state);
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(dir, t, t);
};

before(() => {
  makeJob('ask-investigate-job-20261024', '# STATE\nWorking on the investigation of sk-abcdefghijklmnop1234\n');
  makeJob('tng-trustedtokens-mining-20261024', '# STATE\nmining\n', 1000);
  makeJob('old-finished-20260101', '# STATE\ndone\n- FINAL DONE\n', 5000);
  makeJob('secrets', 'nope', 10);
  fs.writeFileSync(path.join(home, 'jobs', 'tng-trustedtokens-mining-20261024', 'notes.md'), 'readable');
  fs.writeFileSync(path.join(home, 'jobs', 'tng-trustedtokens-mining-20261024', 'token.json'), '{}');
});

after(() => fs.rmSync(home, { recursive: true, force: true }));

test('job names starting with ask- survive redaction; secret-looking dirs are hidden', async () => {
  const { jobs: list } = await jobs.list({});
  const names = list.map((j) => j.name);
  assert.ok(names.includes('ask-investigate-job-20261024'));
  assert.ok(names.includes('tng-trustedtokens-mining-20261024'));
  assert.ok(!names.includes('secrets'));
  assert.ok(list[0].path.startsWith('/') && !list[0].path.includes('[REDACTED]'));
  assert.match(list.find((j) => j.name === 'ask-investigate-job-20261024').summary, /\[REDACTED\]/);
});

test('activeOnly drops finished jobs, filter narrows, limit caps', async () => {
  jobs.resetJobIndexForTests();
  const active = (await jobs.list({ activeOnly: true })).jobs.map((j) => j.name);
  assert.ok(!active.includes('old-finished-20260101'));
  assert.deepEqual((await jobs.list({ filter: 'TRUSTEDTOKENS' })).jobs.map((j) => j.name), ['tng-trustedtokens-mining-20261024']);
  assert.equal((await jobs.list({ limit: 1 })).jobs.length, 1);
});

test('the index is cached for 30 s: a new job shows up only after the cache expires, a stale cache answers at once', async () => {
  jobs.resetJobIndexForTests();
  await jobs.list({});
  makeJob('brand-new-job-20261024', '# STATE\nnew\n');
  assert.ok(!(await jobs.list({})).jobs.some((j) => j.name === 'brand-new-job-20261024'), 'served from cache');
  const realNow = Date.now;
  Date.now = () => realNow() + 31_000;
  try {
    const stale = await jobs.list({});
    assert.ok(!stale.jobs.some((j) => j.name === 'brand-new-job-20261024'), 'stale answer is immediate, refresh runs in the background');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok((await jobs.list({})).jobs.some((j) => j.name === 'brand-new-job-20261024'));
  } finally {
    Date.now = realNow;
  }
});

test('a filter for a job older than the cached index falls back to a scan', async () => {
  assert.equal((await jobs.list({ filter: 'old-finished' })).jobs.length, 1);
});

test('job_status refuses deny-listed names but reads trustedtokens jobs', async () => {
  const refused = await jobs.get({ name: 'secrets' });
  assert.equal(refused.found, false);
  assert.ok(!refused.candidates.some((c) => c.name === 'secrets'));
  assert.equal((await jobs.get({ name: 'tng-trustedtokens-mining-20261024' })).name, 'tng-trustedtokens-mining-20261024');
});

test('deny list matches path segments and file names, not substrings of job names', () => {
  const readable = ['/jobs/tng-trustedtokens-mining-20261024/STATE.md', '/jobs/ask-investigate-job/notes.md', '/jobs/x/tokenizer.js', '/jobs/x/secretary.md', '/jobs/x/keyboard.md', '/jobs/x/monkey.md'];
  const denied = ['/jobs/x/secrets.env', '/jobs/x/token.json', '/home/flori/.ssh/id_rsa', '/jobs/x/id_rsa', '/jobs/x/server.key', '/jobs/x/cert.pem', '/jobs/x/.env', '/jobs/x/.env.local', '/jobs/x/prod.env', '/jobs/secrets/a.md', '/jobs/x/credentials.json', '/jobs/x/.ssh/config', '/jobs/jevbench-sealed/a', '/jobs/x/auth.json'];
  for (const p of readable) assert.equal(isDenied(p), false, p);
  for (const p of denied) assert.equal(isDenied(p), true, p);
});

test('resolveAllowed gives one generic error for not-allowed and not-found, and never touches paths outside the allowlist', () => {
  const messages = new Set();
  for (const p of ['/etc/os-release', '/etc/definitely-not-there', path.join(home, 'jobs', 'nope-nope', 'x.md'), path.join(home, 'jobs', 'secrets', 'a.md'), path.join(home, 'jobs', 'tng-trustedtokens-mining-20261024', 'token.json')]) {
    try { resolveAllowed(p); assert.fail(`${p} resolved`); } catch (err) { messages.add(err.message); }
  }
  assert.deepEqual([...messages], ['path not allowed or not found']);
  assert.ok(resolveAllowed(path.join(home, 'jobs', 'tng-trustedtokens-mining-20261024', 'notes.md')));
});

test('job_status resolves a misheard name to the closest job and lists the top 3 candidates', async () => {
  makeJob('reax2-next-steps-20261024', '# STATE\nnext steps for reax2\n', 20);
  makeJob('s1m-nextgen-models-20261020', '# STATE\nmodels\n', 30);
  makeJob('unrelated-weather-20261024', '# STATE\nweather\n', 40);
  jobs.resetJobIndexForTests();
  const heard = await jobs.get({ name: 'Rags to Next Steps' });
  assert.equal(heard.name, 'reax2-next-steps-20261024');
  assert.equal(heard.resolvedFrom, 'Rags to Next Steps');
  assert.match(heard.state, /next steps for reax2/);
  assert.equal(heard.candidates[0].name, 'reax2-next-steps-20261024');
  assert.ok(heard.candidates.length <= 3);
  assert.equal((await jobs.get({ name: 'reax-2 next step' })).name, 'reax2-next-steps-20261024', 'typo and split digits');
  assert.equal((await jobs.get({ name: 'reax2-next-steps-20261024' })).resolvedFrom, undefined, 'exact names are not rewritten');
});

test('job_status with an ambiguous or unknown name returns candidates instead of an error', async () => {
  makeJob('reax2-next-steps-20261023', '# STATE\nolder twin\n', 50);
  jobs.resetJobIndexForTests();
  const twin = await jobs.get({ name: 'next steps' });
  assert.equal(twin.found, false, 'two equally good jobs: ask, do not guess');
  assert.deepEqual(twin.candidates.slice(0, 2).map((c) => c.name).sort(), ['reax2-next-steps-20261023', 'reax2-next-steps-20261024']);
  const none = await jobs.get({ name: 'zzzz qqqq' });
  assert.equal(none.found, false);
  assert.deepEqual(none.candidates, []);
  await assert.rejects(jobs.get({ name: '  ' }), /job name required/);
  assert.equal((await jobs.get({ name: '../../etc/passwd' })).found, false, 'path-like input is only ever a search phrase');
});
