// #86913 (26 Nov 2026): the Sandy chat-mirror gate failed every run on 900+ old day files. Two false-positive value classes
// (an ssh target `root@<ip>` in a store, the regex literals of a C# file named SecretText.cs) had entered the secret value set,
// and mirror.mjs never re-renders a day file whose transcript did not change. Fixed by narrowing the classes (never the scan)
// and by settling exactly the files the gate names (resettle.mjs) before the whole staged copy is scanned again.
// Every value here is synthetic (documentation IPs, syn() tokens) and lives in a throwaway home only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gate-fp-'));
process.env.BRIDGE_HOME = home;
const { storeKind, isSecretEntry, collectSecretValues, resetSecretValues } = await import('../src/secretValues.js');
const { failedPaths, resettleFile } = await import('../scripts/chats/resettle.mjs');
const { sourceWindows, attribute } = await import('../scripts/chats/attribute.mjs');
const write = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const CHATS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'chats');

const TOKEN = syn('gh·p_Q7·rT2x·Lm9P·aZ4k·Wd8N·sV3b·Hy6C');
const SSH = 'root@203.0.113.45';

test('storeKind: code of any language and tokenizer vocabularies are no stores; real stores still are', () => {
  for (const rel of ['wt/screen-agent-x/src/ScreenAgent.Core/SecretText.cs', 'wt/fw/src/secrets.h', 'wt/fw/src/token_store.cpp',
    'wt/app/Secrets.kt', 'wt/app/KeychainSecrets.swift', 'wt/app/SecretPanel.xaml', 'wt/app/Secrets.csproj',
    'jevbench-private-counts/m/countenv/stage/hf/tokenizer.json', 'models/hf/tokenizer_config.json', 'models/hf/special_tokens_map.json',
    'models/hf/added_tokens.json']) assert.equal(storeKind(rel), null, rel);
  assert.equal(storeKind('.config/dev-secrets.env'), 'curated');
  assert.equal(storeKind('.bonsai-autoscale/config.json'), 'curated');
  for (const rel of ['wt/app/.env', 'wt/app/api.key', 'wt/app/secret-token.txt', 'wt/app/data/credentials.json', 'proj/certs/server.pem', 'proj/secrets.cfg'])
    assert.equal(storeKind(rel), 'strict', rel);
});

test('isSecretEntry: an ssh target user@IPv4[:port] is an address, not a secret; userinfo with a password still is', () => {
  for (const strict of [false, true]) {
    assert.equal(isSecretEntry('RXNODE_SSH', SSH, '', strict), false);
    assert.equal(isSecretEntry('FILE_TOKEN', SSH, '', strict), false);
    assert.equal(isSecretEntry('SSH_TARGET', 'ubuntu@198.51.100.7:2222', '', strict), false);
  }
  assert.equal(isSecretEntry('DB_DSN', syn('ssh://root:Pw9x·Yz12·abcQ@203.0.113.45'), ''), true);
  assert.equal(isSecretEntry('GITHUB_TOKEN', TOKEN, ''), true);
});

test('collectSecretValues: SecretText.cs regexes and an ssh target stay out, the real token stays in', () => {
  write('wt/screen-agent-x/src/ScreenAgent.Core/SecretText.cs', 'static readonly string P = "sk_[A-Za-z0-9]{20,}|chutes_api_[A-Za-z0-9_]+";\n');
  write('.config/dev-secrets.env', `GITHUB_TOKEN=${TOKEN}\nRXNODE_SSH=${SSH}\n`);
  write('wt/app/secret-token.txt', `${SSH}\n`);
  resetSecretValues();
  const values = collectSecretValues(home, { env: {}, pub: '' });
  assert.deepEqual(values, [TOKEN]);
});

test('failedPaths: only relative mirror paths of FAIL lines; hidden names, dot files and escapes are skipped', () => {
  const out = ['{"dir":"/x","files":3,"bytes":1,"failed":5}', 'FAIL secret-shaped text: sessions/a__1__2026-11-01.md',
    'FAIL secret-shaped text: <name hidden>', 'FAIL secret-shaped text: ../outside.md', 'FAIL secret-shaped text: .state.json',
    'FAIL symlink: sessions/link.md', 'FAIL text too complex for the secret check: INDEX.md', 'FAIL secret-shaped text: sessions/a__1__2026-11-01.md'].join('\n');
  assert.deepEqual(failedPaths(out), ['sessions/a__1__2026-11-01.md', 'INDEX.md']);
});

test('resettle + scan: a day file rendered before a value joined the set fails the gate, is settled in place, then passes', () => {
  resetSecretValues();
  const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-gate-mirror-'));
  try {
    fs.mkdirSync(path.join(mirror, 'sessions'));
    const day = path.join(mirror, 'sessions', 'jobs-x__ab12cd34__2026-11-01.md');
    fs.writeFileSync(day, `# Chat\n**Agent:** pushed with the key ${TOKEN} to the box ${SSH}\n`, { mode: 0o600 });
    const old = new Date('2026-11-01T23:59:59Z');
    fs.utimesSync(day, old, old);
    const env = { ...process.env, BRIDGE_HOME: home };
    const scan = () => spawnSync(process.execPath, [path.join(CHATS, 'scan.mjs'), mirror], { encoding: 'utf8', env });
    let r = scan();
    assert.equal(r.status, 3, r.stdout);
    assert.ok(!r.stdout.includes(TOKEN), 'the gate never prints the value');
    const rows = attribute([day], sourceWindows(home, {}));
    assert.deepEqual(rows, [['~/.config/dev-secrets.env (curated)', 1]], 'attribution names the store path only');
    const outFile = path.join(mirror, '..', `${path.basename(mirror)}.scan.out`);
    fs.writeFileSync(outFile, r.stdout);
    const rs = spawnSync(process.execPath, [path.join(CHATS, 'resettle.mjs'), mirror, outFile], { encoding: 'utf8', env });
    fs.rmSync(outFile);
    assert.equal(rs.status, 0, rs.stderr);
    assert.match(rs.stdout, /"listed":1,"settled":1,"unchanged":0,"refused":0/);
    const text = fs.readFileSync(day, 'utf8');
    assert.ok(!text.includes(TOKEN) && text.includes('[REDACTED]') && text.includes(SSH), 'the value is masked, the ssh target stays readable');
    assert.equal(fs.statSync(day).mtimeMs, old.getTime(), 'the day file keeps its day as mtime');
    assert.equal(fs.statSync(day).mode & 0o777, 0o600);
    r = scan();
    assert.equal(r.status, 0, r.stdout);
    assert.equal(resettleFile(mirror, 'sessions/jobs-x__ab12cd34__2026-11-01.md'), 'unchanged');
    fs.symlinkSync(day, path.join(mirror, 'sessions', 'link.md'));
    assert.equal(resettleFile(mirror, 'sessions/link.md'), 'refused', 'a symlink is never written through');
  } finally { fs.rmSync(mirror, { recursive: true, force: true }); }
});

test('ops/desk-chats-push: settles once and gates the whole staged copy again; the push needs a passing scan', () => {
  const s = fs.readFileSync(path.join(CHATS, '..', '..', 'ops', 'desk-chats-push'), 'utf8');
  assert.match(s, /resettle\.mjs" "\$OUT" "\$SCANOUT"\n\s+rc=0; gate \|\| rc=\$\?/);
  assert.ok(s.indexOf('if [ "$rc" -ne 0 ]') < s.indexOf('rsync -a --delete --chmod'), 'no push before a passing gate');
});
