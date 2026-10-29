// Critic round 2, P0-1 (2): value-based redaction. Every value here is synthetic and lives in a temp HOME only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGateway } from './helpers.js';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-secret-values-'));
process.env.BRIDGE_HOME = home;
process.env.DESK_AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-'));
// shapes no pattern recognises: only the value list can catch them
const V = {
  dev: syn('aa_9·zQQ9·synt·hDev·Valu·e0Kx·7Lm2·Pn4R·t6Vw·8'),
  quoted: syn('synt·hQuo·ted.·Valu·e-01·23/x·yz'),
  single: syn('synt·hSin·gle0·1234·5678·9'),
  desk: syn('desk·EnvS·ynth·0123·4567·89AB'),
  hermes: syn('herm·esEn·vSyn·th01·2345·6789'),
  hermesDot: syn('herm·esDo·tSyn·th01·2345·6789'),
  later: syn('late·rAdd·edSy·nth0·1234·5678·9'),
  numeric: '2718281828459045235',
  dbUrl: syn('postgres://synthuser:Synt·hDbP·w012·3456@db.example.test/x'),
};
// not secrets (must survive): critic round 3 over-redaction shapes
const NS = {
  user: 'synthgithubuser42',
  ip: '203.0.113.77-synth',
  id: syn('synt·hAcc·ount·Id01·2345·6789'),
  endpoint: 'https://api.example.test/v1/synth',
  url: 'https://example.test/synth/path0123',
  word: 'Supervisorrole',
  gitPublic: syn('Synt·hGit·Auth·orNa·me20·26'),
};
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
write('.config/dev-secrets.env', [
  '# comment line',
  `export ABLITERATION_LIKE_KEY=${V.dev}`,
  `QUOTED_SECRET="${V.quoted}"`,
  `SINGLE_SECRET='${V.single}' # trailing comment`,
  `SYNTH_CONNECTION_PIN=${V.numeric}`,
  'SOME_IP=203.0.113.250',
  syn('SHOR·T_SE·CRET·=sho·rt1'),
  'SOME_PORT=8080',
  'SOME_ORIGIN=https://example.test',
  'SOME_PATH=/home/someone/data/file.txt',
  syn('SOME·_VER·SION·=202·6.10·.28-·1234'),
  // critic round 3, P1-3: identifiers by name, plain words and public strings by value
  `SYNTH_API_USER=${NS.user}`,
  `SYNTH_CLIENT_IP=${NS.ip}`,
  `SYNTH_ACCOUNT_ID=${NS.id}`,
  `SYNTH_ENDPOINT=${NS.endpoint}`,
  `SYNTH_PLAIN_URL=${NS.url}`,
  `SYNTH_DB_URL=${V.dbUrl}`,
  `SYNTH_WORDISH=${NS.word}`,
  `SYNTH_PUBLIC_THING=${NS.gitPublic}`,
].join('\n'));
write('.gitconfig', `[user]\n\tname = ${NS.gitPublic}\n`);
write('.config/agent-desk/bridge.env', `DESK_THING=${V.desk}\n`);
write('.hermes/tools.env', `HERMES_THING=${V.hermes}\n`);
write('.hermes/.env', `HERMES_DOT=${V.hermesDot}\n`);
write('AGENTS.md', `# Synthetic AGENTS\nIn a transcript: {'X': '${V.dev}'} and plain ${V.desk} and ${V.hermesDot}.\nPort 8080 at https://example.test stays.\n`);

const { redact, redactDeep } = await import('../src/redact.js');
const { parseEnvValues, secretValueCount, secretWindowCount, resetSecretValues, buildWindowFile, windowFile, refreshWindowFileIfStale, redactValues } = await import('../src/secretValues.js');
const { startBridge } = await import('../src/bridge.js');

let gw;
let bridge;
before(async () => {
  gw = await fakeGateway();
  bridge = startBridge({ url: gw.url, token: 'test-token-not-secret', host: 'testhost' });
  await gw.connected;
});
after(async () => {
  bridge.close();
  await gw.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(process.env.DESK_AUDIT_DIR, { recursive: true, force: true });
});

test('parseEnvValues: export, quotes, trailing comments', () => {
  assert.deepEqual(parseEnvValues(`export A=1\nB="x y" \nC='z' # c\nD=w # c\n# E=no\nnot a line`), ['1', 'x y', 'z', 'w']);
});

test('every value from the four sources is replaced, in any context', () => {
  for (const [name, v] of Object.entries(V)) {
    if (name === 'later' || name === 'dbUrl') continue;
    const out = redact(`ctx (${v}) "${v}" ${v}x`);
    assert.ok(!out.includes(v), name);
    assert.equal(out.split('[REDACTED]').length - 1, 3, name);
  }
  assert.ok(secretValueCount() >= 6);
});

test('short values and config-looking values are not in the list (no over-redaction)', () => {
  const text = 'short1 203.0.113.250 Port 8080, https://example.test, /home/someone/data/file.txt, 2026.10.28-1234';
  assert.equal(redact(text), text);
});

test('redactDeep (the bridge dispatch path) scrubs nested strings', () => {
  const out = redactDeep({ hits: [{ snippet: `env dump ${V.single}` }], n: 3 });
  assert.equal(out.hits[0].snippet, 'env dump [REDACTED]');
  assert.equal(out.n, 3);
});

test('a changed env file is picked up (mtime check)', async () => {
  assert.ok(redact(V.later).includes(V.later));
  write('.hermes/later.env', `LATER=${V.later}\n`);
  resetSecretValues(); // skips the 5 s stat throttle; the reload itself is the mtime/file-set comparison
  assert.equal(redact(V.later), '[REDACTED]');
});

test('ctx.core result over the real bridge socket carries no known value', async () => {
  const r = await gw.call('ctx.core', { name: 'AGENTS', maxChars: 2000 });
  for (const v of [V.dev, V.desk, V.hermesDot]) assert.ok(!r.text.includes(v));
  assert.match(r.text, /Port 8080 at https:\/\/example\.test stays/);
  assert.ok(r.text.includes('[REDACTED]'));
});

test('100 kB result: value redaction stays fast', () => {
  const big = `${'lorem ipsum dolor sit amet 0123 '.repeat(3200)}${V.dev}`;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) redact(big);
  const ms = (performance.now() - t0) / 10;
  assert.ok(!redact(big).includes(V.dev));
  assert.ok(ms < 200, `${ms} ms`);
});

test('the bridge sends method results and claude events through redactDeep', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  assert.match(src, /result: await redactDeepAsync\(result\)/); // critic r7: big strings are redacted off the event loop
  assert.match(src, /t: 'evt', topic, data: redactDeep\(data\)/);
});

test('non-secrets by name (_USER, _IP, _ID, _ENDPOINT, _URL without userinfo) and by value (plain words, git identity) stay', () => {
  for (const [name, v] of Object.entries(NS)) assert.equal(redact(`see ${v} here`), `see ${v} here`, name);
  assert.ok(!redact(`db ${V.dbUrl}`).includes(syn('Synt·hDbP·w012·3456')), 'a URL with userinfo stays a secret');
});

test('fragments: any 16-char window of a known value is masked (cut snippets)', () => {
  for (const frag of [V.dev.slice(5, 21), V.dev.slice(3, 25), V.desk.slice(0, 16), V.hermes.slice(-17)]) {
    const out = redact(`snippet …${frag} weiter`);
    assert.ok(!out.includes(frag), frag.length);
    assert.match(out, /\[REDACTED\]/);
  }
  // a 15-char piece is below the window and an unrelated token stays
  assert.equal(redactValues(syn('abcX·YZ01·2345·6789·qrs normal')), syn('abcX·YZ01·2345·6789·qrs normal'));
});

// A second, "remote" host's values arrive only as salted window hashes.
const REMOTE = { full: syn('remo·teSy·nthS·ecre·t012·3456·789A·BCDE·Fgh'), other: syn('R3mo·teOt·herS·ynth·-Val·ue_0·099') };
test('hash file: built 0600 from another host, holds no value or window in plain text, masks values + fragments here', () => {
  const remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-remote-'));
  try {
    fs.mkdirSync(path.join(remoteHome, '.config'), { recursive: true });
    fs.writeFileSync(path.join(remoteHome, '.config', 'dev-secrets.env'), `A_SECRET=${REMOTE.full}\nB_TOKEN="${REMOTE.other}"\nSYNTH_API_USER=${NS.user}\n`);
    const out = windowFile(home);
    const r = buildWindowFile(remoteHome, out);
    assert.equal(r.values, 2);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const raw = fs.readFileSync(out, 'utf8');
    for (const v of Object.values(REMOTE)) for (let i = 0; i + 16 <= v.length; i++) assert.ok(!raw.includes(v.slice(i, i + 16)));
    assert.ok(!raw.includes(NS.user));
    resetSecretValues();
    assert.ok(secretWindowCount() > 20);
    for (const s of [REMOTE.full, REMOTE.full.slice(4, 20), REMOTE.other.slice(2, 24), `ET=${REMOTE.full.slice(0, 22)}`]) {
      const o = redact(`x ${s} y`);
      assert.ok(!o.includes(s.replace(/^ET=/, '')), s.length);
    }
  } finally { fs.rmSync(remoteHome, { recursive: true, force: true }); }
});

test('hash file: a changed file is reloaded (mtime), a stale one is rebuilt from the local env files', () => {
  const out = windowFile(home);
  fs.writeFileSync(out, JSON.stringify({ version: 1, window: 16, salt: 'ab'.repeat(16), quick: [], hashes: [] }), { mode: 0o600 });
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(out, later, later);
  resetSecretValues();
  assert.equal(secretWindowCount(), 0);
  assert.ok(redact(REMOTE.full).includes(REMOTE.full), 'empty hash file: the remote value is unknown again');
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(out, old, old);
  assert.equal(refreshWindowFileIfStale(home), true);
  assert.equal(refreshWindowFileIfStale(home), false);
  resetSecretValues();
  assert.ok(secretWindowCount() > 0);
  assert.ok(!redact(`frag ${V.dev.slice(2, 20)}`).includes(V.dev.slice(2, 20)));
});

// Target < 50 ms (about 12-18 ms measured alone on Sandy); the bound is looser because test files run in parallel.
test('200 kB text: exact + fragment scan stays fast', () => {
  const parts = [];
  for (let i = 0; i < 2000; i++) parts.push(syn(`{"id":"${(i * 7919).toString(16).padStart(8, '0')}-c45e-75e2-a817-643e93aa${i}","text":"Die Session lief ${i} Minuten ab12·CD34·ef56·GH78"}\n`));
  const big = parts.join('').slice(0, 200_000);
  redactValues(big);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) redactValues(big);
  const ms = (performance.now() - t0) / 10;
  assert.ok(ms < 150, `${ms.toFixed(1)} ms`);
});
