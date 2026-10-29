// Critic round 4: every secret store of the host feeds the value list (P0-1 a), and search is no existence oracle for
// secret fragments (P2-1). Every value here is synthetic and lives in a throwaway home only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syn } from './synthetic.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-secret-stores-'));
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-stores-mirror-'));
fs.rmSync(mirror, { recursive: true });
process.env.BRIDGE_HOME = home;
process.env.BRIDGE_NOTES_MIRROR = mirror;
const write = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// No shape pattern recognises these bare values: only the value list (or the oracle guard) can protect them.
const S = {
  envTop: syn('synt·hTop·Env0·aa1b·b2cc·3dd4'),
  envDot: syn('synt·hDot·Env0·aa1b·b2cc·3dd5'),
  envSub: syn('synt·hSub·Env0·aa1b·b2cc·3dd6'),
  tokenFile: syn('synt·hTok·enFi·le0a·a1bb·2cc3'),
  adminToken: syn('synt·hAdm·inTo·k0aa·1bb2·cc3d'),
  keyFile: syn('synt·hKey·File·0aa1·bb2c·c3dd'),
  hermesAuth: syn('synt·hHer·mesA·uth0·aa1b·b2cc'),
  codexAuth: syn('synt·hCod·exAu·th0a·a1bb·2cc3'),
  claudeCred: syn('synt·hCla·udeC·red0·aa1b·b2cc'),
  gitCred: syn('synt·hGit·Cred·0aa1·bb2c·c3dd'),
  ghHosts: syn('synt·hGhH·osts·0aa1·bb2c·c3dd'),
  netrc: syn('synt·hNet·rc0a·a1bb·2cc3·dd4e'),
  pemLine: syn('MIIE·synt·hPem·Line·0aa1·bb2c·c3dd·4ee5·ff6g·g7hh·8'),
  shortPw: 'Pw0rd!x9',
  passwordTxt: syn('synt·hDas·hPw0·aa1b·b2cc·3d'),
  fabro: syn('synt·hFab·roSe·cret·0aa1·bb2c·c3dd·4ee5·ff6g·g7hh·8'),
};
// code and docs that look KEY=VALUE-shaped: never a store
const CODE = { py: syn('synt·hPyN·oise·0aa1·bb2c·c3'), unit: syn('synt·hUni·tNoi·se0a·a1bb·2cc') };

before(() => {
  write('.config/synth-top.env', `SYNTH_TOP_TOKEN=${S.envTop}\n`);
  write('.config/synth-top.env.bak-20261028', `SYNTH_TOP_TOKEN=${S.envDot}\n`);
  write('.config/synthsvc/prod-db.env', `# db\nexport SYNTH_DB_PASSWORD="${S.envSub}"\nSYNTH_DB_HOST=db.internal\n`);
  write('.config/synthsvc/api-token', `${S.tokenFile}\n`);
  write('.config/synth-eu/admin_token', S.adminToken);
  write('.config/synth-keys/partner.key', `${S.keyFile}\n`);
  write('.hermes/auth.json', JSON.stringify({ credential_pool: { synth: [{ id: 'abc123', label: 'synth', access_token: S.hermesAuth, base_url: 'https://api.example.test/v1' }] } }));
  write('.codex/auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: S.codexAuth, account_id: 'synth-account-0123456789' } }));
  write('.claude-B/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: S.claudeCred, expiresAt: 1, scopes: ['user:inference'] } }));
  write('.git-credentials', `https://synthuser:${S.gitCred}@github.com\n`);
  write('.config/gh/hosts.yml', `github.com:\n    user: synthuser\n    oauth_token: ${S.ghHosts}\n    git_protocol: https\n`);
  write('.netrc', `machine api.example.test login synth password ${S.netrc}\n`);
  write('.config/synth-deploy-key', `-----${'BEGIN'} OPENSSH PRIVATE KEY-----\n${S.pemLine}\n-----${'END'} OPENSSH PRIVATE KEY-----\n`);
  write('.config/synth-mail.env', `SYNTH_MAIL_PASSWORD=${S.shortPw}\n`);
  write('.hermes/synth-dashboard-password.txt', `${S.passwordTxt}\nuser: synth\nurl: https://dash.example.test\n`);
  write('.config/synth-fabro.env', syn(`SYNT·H_FA·BRO_·CLIE·NT_I·D=sy·nth-·clie·nt-i·d-01·23\nSYNTH_FABRO_CLIENT_SECRET=${S.fabro}\n`));
  write('.config/synth-tool/secret_scope.py', `import os\nlogger = "${CODE.py}"\nTOKEN = "${CODE.py}"\n`);
  write('.config/synth-scan-secret.service', `[Unit]\nDescription=${CODE.unit}\n[Service]\nExecStart=/bin/true\n`);
  write('.config/google-chrome/Default/Trust Tokens', 'binary\0data');
  // a pasted credentials block (a label line, then the value on its own line) and a line that holds a secret fragment
  write('jobs/synth-job-a/input/notes-a.md', `Zugang zum Testdienst\n\nName: "beispiel"\n\nClient secret\n${S.fabro}\n\nClient ID\nsynth-client-id-0123\n`);
  write('jobs/synth-ops-20261028/notes.md', `Werte für die Ablage: zq${S.fabro.slice(4, 30)}x und ein ganz normaler Satz über Fabro.\n`);
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(mirror, { recursive: true, force: true });
});

const sv = await import('../src/secretValues.js');
const { redact } = await import('../src/redact.js');
const ctx = await import('../src/ctx.js');
const chats = await import('../src/chats.js');
const { looksLikeSecretFragment, hitInSecret } = await import('../src/secretQuery.js');

test('secretSources: every store kind is found; code, units and browser profiles are not', () => {
  sv.resetSecretValues();
  const files = sv.secretSources(home).map((f) => path.relative(home, f));
  for (const f of ['.config/synth-top.env', '.config/synth-top.env.bak-20261028', '.config/synthsvc/prod-db.env', '.config/synthsvc/api-token',
    '.config/synth-eu/admin_token', '.config/synth-keys/partner.key', '.hermes/auth.json', '.codex/auth.json', '.claude-B/.credentials.json',
    '.git-credentials', '.config/gh/hosts.yml', '.netrc', '.config/synth-deploy-key', '.hermes/synth-dashboard-password.txt']) assert.ok(files.includes(f), f);
  for (const f of ['.config/synth-tool/secret_scope.py', '.config/synth-scan-secret.service', '.config/google-chrome/Default/Trust Tokens']) assert.ok(!files.includes(f), f);
});

test('collectSecretValues: values of every store; code noise and identifiers stay out', () => {
  sv.resetSecretValues();
  const vals = new Set(sv.collectSecretValues(home, { env: {}, pub: '' }));
  for (const [k, v] of Object.entries(S)) assert.ok(vals.has(v), k);
  for (const v of Object.values(CODE)) assert.ok(!vals.has(v));
  assert.ok(!vals.has('synth-client-id-0123') && !vals.has('synth-account-0123456789'));
});

test('isEnvShaped / storeEntries: only KEY=VALUE files are parsed as env', () => {
  assert.ok(sv.isEnvShaped('# x\nA_B=1\nexport C="2"\n'));
  assert.ok(!sv.isEnvShaped('import os\nlogger = x\nself._lock = y\n'));
  assert.ok(!sv.isEnvShaped('[Unit]\nDescription=x\nExecStart=/bin/true\n'));
  assert.deepEqual(sv.storeEntries('/x/api-token', 'two words\n'), []);
});

test('read_file: the pasted credentials block of a job shows no value (critic-4 P0-1)', async () => {
  sv.resetSecretValues();
  const r = await ctx.read({ path: path.join(home, 'jobs/synth-job-a/input/notes-a.md') });
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes(S.fabro) && !blob.includes(S.fabro.slice(8, 24)), blob);
  assert.ok(blob.includes('Client ID'), blob);
});

test('looksLikeSecretFragment: random-looking pieces yes, words, slugs, model ids and UUIDs no', () => {
  for (const t of ['Zq7xWv2P', 'aa_9zQQ9synth', 'synthVabroSecret0aa1', '9f8e7d6c5b4a', S.fabro.slice(14, 26)]) assert.ok(looksLikeSecretFragment(t), t);
  for (const t of ['Fabro', 'client secret', 'explainer-desk-upgrades-20261028', 'deepseek-v4.1-flash', 'claude-opus-5-5', 'SN92',
    'FABRO_CLIENT_SECRET', '7e5fc822-a887-4bfc-8065-3941fa80fb41', 'Qwen2TokenizerFast', '2026-10-28']) assert.ok(!looksLikeSecretFragment(t), t);
});

test('hitInSecret: a term inside a redacted secret counts, a term in a redacted env line does not', () => {
  const raw = `Wert zq${S.fabro.slice(4, 30)}x Ende`;
  assert.ok(hitInSecret(raw, 'Wert [REDACTED] Ende', 'abroSecret'));
  assert.ok(!hitInSecret('SYNTH_TOKEN=abc lugubrious', 'SYNTH_TOKEN=[REDACTED]', 'lugubrious'));
});

test('ctx.search and chats.search refuse secret fragments and drop hits inside secrets (P2-1)', async () => {
  sv.resetSecretValues();
  await assert.rejects(ctx.search({ query: S.fabro.slice(14, 24) }), /Schlüssel|secret fragment/);
  await assert.rejects(ctx.search({ query: `Fabro OR ${S.fabro.slice(15, 25)}` }), /Schlüssel|secret fragment/);
  await assert.rejects(ctx.search({ query: `x${S.fabro.slice(16, 26)}.*`, regex: true }), /Schlüssel|secret fragment/);
  await assert.rejects(chats.search({ query: S.fabro.slice(14, 24) }), /Schlüssel|secret fragment/);
  // a letters-only piece of a value is not refused, but its hit inside the (redacted) value does not count
  const piece = S.fabro.slice(5, 16); // "VabroSecret": letters only
  const r = await ctx.search({ query: piece });
  assert.equal(r.hits.length, 0, JSON.stringify(r));
  assert.equal(r.files, 0);
  // natural words still find the file, without the value
  const ok = await ctx.search({ query: 'Fabro normaler Satz' });
  assert.ok(ok.hits.some((h) => h.path.endsWith('synth-ops-20261028/notes.md')), JSON.stringify(ok));
  assert.ok(!JSON.stringify(ok).includes(S.fabro.slice(4, 20)));
});

test('redact: bare store values are masked in any context', () => {
  sv.resetSecretValues();
  for (const [k, v] of Object.entries(S)) assert.ok(!redact(`siehe ${v} hier`).includes(v), k);
});
