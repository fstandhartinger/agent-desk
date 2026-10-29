// Critic round 5, P0-1 (a) / P1-1: secret stores are discovered in the whole home directory, not listed. A throwaway home
// gets stores in every place the critic found real ones; an independent enumerator in the style of the critic's
// coverage.mjs walks it, and every value it finds must be in the bridge's value list. All values are generated at run time
// (no literal secret in the repository, P2-4).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-secret-discovery-'));
const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-discovery-mirror-'));
fs.rmSync(mirror, { recursive: true });
process.env.BRIDGE_HOME = home;
process.env.BRIDGE_NOTES_MIRROR = mirror;
const write = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };

// deterministic random-looking values (xorshift), built here instead of written as literals
let seed = 0x2545f491;
const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const pick = (abc, n) => Array.from({ length: n }, () => abc[next() % abc.length]).join('');
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const rnd = (n = 32) => { let v; do v = pick(ALNUM, n); while (!/\d/.test(v) || !/[a-z]/.test(v) || !/[A-Z]/.test(v)); return v; };
const hex = (n = 32) => { let v; do v = pick('0123456789abcdef', n); while (!/[a-f]/.test(v) || !/\d/.test(v)); return v; };
const b64 = (n = 70) => pick(`${ALNUM}+/`, n);
const WORDS = ['able', 'acid', 'aunt', 'bean', 'cave', 'dial', 'echo', 'fern', 'gulf', 'hint', 'iris', 'jade', 'kiln'];
const phrase = () => Array.from({ length: 12 }, () => WORDS[next() % WORDS.length]).join(' ');

const S = {}; // planted secrets: name -> value
const N = {}; // planted non-secrets that must stay out of the list
const BEGIN = (kind) => `-----${'BEGIN'} ${kind} PRIVATE KEY-----`;
const END = (kind) => `-----${'END'} ${kind} PRIVATE KEY-----`;

before(() => {
  // project secret files (a project secret file) and code checkouts
  write('proj-a/.secrets.env', `APP_SECRET=${S.appSecret = hex(32)}\nSTRIPE_WEBHOOK_SECRET=whsec_${S.whsec = rnd(32)}\nAPP_NAME=proj-a\n`);
  write('proj-b/work/.r2.env', `R2_ACCESS_KEY_ID=${N.r2Id = rnd(20)}\nR2_SECRET_ACCESS_KEY=${S.r2 = rnd(40)}\n`);
  write('proj-b/work/.backup.key', `${S.backupKey = rnd(44)}\n`);
  write('code/app-c/.env', `SESSION_SECRET=${S.session = rnd(48)}\nGOOGLE_CLIENT_SECRET=${S.google = rnd(35)}\nMODEL=${N.model = 'synth-model-v4.1-flash'}\nNODE_ENV=production\n`);
  write('code/app-d/api/.env.local', `DATABASE_URL=postgres://app:${S.dbPw = rnd(20)}@db.example.test:5432/app\nSTRIPE_PUBLISHABLE_KEY=pk_live_${N.pk = rnd(24)}\n`);
  write('code/app-d/api/node_modules/dep/.env', `DEP_TOKEN=${N.nodeModules = rnd(30)}\n`);
  write('proj-e/proxy/proxy.env', `PROXY_MASTER_KEY=sk-${S.proxyKey = rnd(30)}\n`);
  write('proj-e/proxy/postgres.env', `POSTGRES_PASSWORD=${S.pg = rnd(14)}\n`);
  write('code/k8s/secrets/app.yaml', `kind: Secret\napi_key: >-\n  ${S.yamlFolded = rnd(36)}\nregion: eu-central-1\n`);
  write('a/b/c/d/.env', `DEEP_API_KEY=${S.deep = rnd(30)}\n`); // depth 5
  write('a/b/c/d/e/f/.env', `DEEPER_API_KEY=${S.deeper = rnd(30)}\n`); // depth 7 (critic r6 P2-6)
  write('a/b/c/d/e/f/g/.env', `TOO_DEEP_API_KEY=${N.tooDeep = rnd(30)}\n`); // depth 8: beyond the walk
  write('_archive/old-a/svc/CREDENTIALS.env', `SVC_ADMIN_PASSWORD=${S.archived = rnd(18)}\n`);
  write('apps/app-f/.private/report-token', `${S.reportToken = rnd(40)}\n`);
  // home-root token files, ssh keys, wallets, TOML, OAuth caches, account backups
  write('.npmrc', `//registry.npmjs.org/:_authToken=npm_${S.npm = rnd(36)}\n`);
  write('.synth-org-token', `${S.orgToken = rnd(40)}\n`);
  write('.ssh/synth-server-key', `${BEGIN('OPENSSH')}\n${S.sshLine1 = b64(70)}\n${S.sshLine2 = b64(70)}\n${END('OPENSSH')}\n`);
  write('.ssh/id_ed25519', `${BEGIN('OPENSSH')}\n${S.sshId = b64(70)}\n${END('OPENSSH')}\n`);
  write('.ssh/id_ed25519.pub', `ssh-ed25519 ${N.pub = b64(68)} synth@host\n`);
  write('.bittensor/wallets/wallet-a/coldkey', JSON.stringify({ accountId: `0x${hex(64)}`, privateKey: `0x${S.coldPriv = hex(64)}`, publicKey: `0x${N.coldPub = hex(64)}`, secretPhrase: S.coldPhrase = phrase(), secretSeed: `0x${S.coldSeed = hex(64)}`, ss58Address: `5${rnd(47)}` }));
  write('.local/share/tool-g/credentials.toml', `[auth]\ntool_api_key = "${S.toml = rnd(40)}"\nuser = "synth"\n`);
  write('.mcp-auth/mcp-remote-v1/abc_tokens.json', JSON.stringify({ access_token: S.mcpAccess = rnd(40), refresh_token: S.mcpRefresh = rnd(40), token_type: 'Bearer' }));
  write('.mcp-auth/mcp-remote-v1/abc_client_info.json', JSON.stringify({ client_id: N.mcpClientId = rnd(20), client_secret: S.mcpClientSecret = rnd(40) }));
  write('.mcp-auth/mcp-remote-v1/abc_discovery_state_1.json', JSON.stringify({ token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], authorizationServerUrl: 'https://auth.example.test' }));
  write('.claude/accounts/backups/credentials.20261001.json', JSON.stringify({ claudeAiOauth: { accessToken: S.claudeBackup = rnd(60), refreshToken: S.claudeRefresh = rnd(60), expiresAt: 1 } }));
  write('.claude.json', JSON.stringify({ additionalModelOptionsCache: [{ value: N.modelOption = 'synth-fable-5-1[1m]', label: 'x' }], mcpServers: { brave: { env: [{ name: 'BRAVE_API_KEY', value: S.mcpEnv = rnd(31) }] } } }));
  write('.claude-A/sessions/123.abcdef.key', JSON.stringify({ peerToken: S.peer = rnd(43) }));
  write('.bonsai-autoscale/creds-a.json', JSON.stringify(Object.fromEntries([['user' + 'name', 'synth'], ['pass' + 'word', S.dirPw = rnd(16)], ['api_token', S.dirTok = rnd(40)]])) /* key names joined at run time: no username/password pair for secret scanners (critic r7 P2-3) */);
  write('.antseed/synth.key', `${S.antseed = hex(64)}\n`);
  // noise in store-like files: a tokenizer config, a script, browser profiles, the read targets
  write('.jev-local/models/synth/tokenizer_config.json', JSON.stringify({ tokenizer_class: N.tokenizer = 'Synth2TokenizerFast', bos_token: '<s>' }));
  write('bin/synth-job-secrets', `#!/bin/bash\nexport SYNTH_TOKEN=$(cat ~/.synth-org-token)\nsecrets=${N.script = rnd(30)}\n`);
  write('.config/google-chrome/Default/Login Data secret', `${N.chrome = rnd(30)}\n`);
  write('jobs/synth-cos/input/.env', `JOB_SECRET=${N.jobsEnv = rnd(30)}\n`);
  write('.claude/projects/synth/transcript-token.json', JSON.stringify({ access_token: N.transcript = rnd(40) }));
  // a pasted prompt export in a job (the round-5 P0 shape): the bridge must mask the value
  write('jobs/synth-prompts-export.md', `chrome windows.\n\nmeta geheimcode: ${S.appSecret}\n\nis the work still running?\n`);
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(mirror, { recursive: true, force: true });
});

const sv = await import('../src/secretValues.js');
const ctx = await import('../src/ctx.js');

// An independent enumerator in the style of critic-5's coverage.mjs: its own walk, its own name list, a generic extractor.
function coverageStyle(root) {
  const PRUNE = /^(?:node_modules|\.git|\.cache|google-chrome.*|chromium.*|jobs|projects|venv.*|\.venv|site-packages)$/;
  const NAME = /^\.env|\.env$|\.env\.|token|secret|credential|\.key$|\.pem$|^\.npmrc$|_tokens\.json$|^auth\.json$|identity\.key$|\.toml$|\.ya?ml$/i;
  const DIR = /(?:^|\/)(?:\.ssh|\.bittensor\/wallets|\.mcp-auth|\.secrets[^/]*|\.?private|\.bonsai-autoscale|\.claude[^/]*\/accounts)(?:\/|$)/;
  const files = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 5 && !PRUNE.test(e.name)) walk(p, depth + 1); continue; }
      const rel = path.relative(root, p);
      if (/\.(?:py|js|md|pub|log)$|known_hosts/.test(e.name)) continue;
      if (NAME.test(e.name) || DIR.test(path.dirname(rel)) || e.name === '.claude.json') files.push(p);
    }
  };
  walk(root, 1);
  const SKEY = /token|secret|passw|api[_-]?key|apikey|private|access[_-]?key|credential|refresh|auth|seed|phrase|password|_pat$/i;
  const strong = (v) => v.length >= 16 && /\d/.test(v) && /[A-Za-z]/.test(v) && !/\s/.test(v) && !/^https?:\/\/[^@]*$/.test(v);
  const found = new Map();
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (t.startsWith('#!')) continue; // a script, not a store
    const out = [];
    try {
      const walkJson = (d, k) => { if (typeof d === 'string') { if (SKEY.test(k)) out.push([k, d]); } else if (d && typeof d === 'object') for (const [kk, vv] of Object.entries(d)) walkJson(vv, kk === 'value' && d.name ? d.name : kk); };
      walkJson(JSON.parse(t), '');
    } catch {
      const lines = t.split(/\r?\n/);
      lines.forEach((l, i) => {
        let m;
        if ((m = l.match(/^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s*["']?([^"'\s#]*)/))) out.push([m[1], /^[>|]-?$/.test(m[2]) ? (lines[i + 1] ?? '').trim() : m[2]]);
        else if ((m = l.match(/_authToken=(\S+)/))) out.push(['NPM_AUTH', m[1]]);
        else if (/^[A-Za-z0-9+/=_.:-]{16,}$/.test(l.trim())) out.push(['LINE', l.trim()]);
      });
    }
    for (const [k, v0] of out) {
      const v = String(v0).replace(/^["']|["']$/g, '');
      if (k !== 'LINE' && !SKEY.test(k)) continue;
      if (strong(v) && !/_ID$|PUBLISHABLE|_type$|tokenizer/i.test(k)) found.set(v, `${path.relative(root, f)}:${k}`);
    }
  }
  return found;
}

test('discovery: every value an independent coverage-style enumerator finds in the home is in the bridge list', () => {
  sv.resetSecretValues();
  const bridge = new Set(sv.collectSecretValues(home, { env: {}, pub: '' }));
  const found = coverageStyle(home);
  assert.ok(found.size >= 25, `enumerator found ${found.size}`);
  const missing = [...found].filter(([v]) => ![...bridge].some((b) => b === v || b.includes(v))).map(([, where]) => where);
  assert.deepEqual(missing, []);
});

test('discovery: every planted secret is in the list, the noise and the read targets are not', () => {
  sv.resetSecretValues();
  const vals = new Set(sv.collectSecretValues(home, { env: {}, pub: '' }));
  for (const [k, v] of Object.entries(S)) assert.ok(vals.has(v) || [...vals].some((x) => x.includes(v)), k);
  for (const [k, v] of Object.entries(N)) assert.ok(![...vals].some((x) => x.includes(v)), k);
  for (const v of vals) assert.ok(!/^client_secret_/.test(v), 'OAuth method names are no secrets');
  const files = sv.secretSources(home).map((f) => path.relative(home, f));
  for (const f of ['jobs/synth-cos/input/.env', '.claude/projects/synth/transcript-token.json', 'code/app-d/api/node_modules/dep/.env']) assert.ok(!files.includes(f), f);
  assert.ok(files.includes('a/b/c/d/.env') && files.includes('.bittensor/wallets/wallet-a/coldkey') && files.includes('.ssh/synth-server-key'));
});

test('discovery: the async rescan finds the same files; a new store next to a known one is seen without a rescan', async () => {
  sv.resetSecretValues();
  const sync = new Set(sv.secretSources(home));
  await sv.scanSecretSourcesAsync(home);
  assert.deepEqual(new Set(sv.secretSources(home)), sync);
  assert.ok(sv.secretSourceStats().files === sync.size && sv.secretSourceStats().ms >= 0);
  const added = rnd(40);
  assert.equal(sv.redactValues(`x ${added} y`), `x ${added} y`); // loads the list
  await new Promise((r) => setTimeout(r, 20)); // a new directory mtime
  write('proj-a/.secrets.env.bak-20261028', `CRON_SECRET=${added}\n`);
  await new Promise((r) => setTimeout(r, 5_100)); // RECHECK_MS
  assert.equal(sv.redactValues(`x ${added} y`), 'x [REDACTED] y');
});

test('read_file of a pasted prompt export: "meta geheimcode: <hex>" is masked (critic-5 P0-1)', async () => {
  sv.resetSecretValues();
  const r = await ctx.read({ path: path.join(home, 'jobs/synth-prompts-export.md') });
  const text = JSON.stringify(r);
  assert.ok(!text.includes(S.appSecret), 'value list');
  assert.ok(!text.includes(S.appSecret.slice(4, 20)), 'fragment');
  assert.ok(text.includes('meta geheimcode'));
});

test('hash file: a touched store with the same values is no rebuild (no new salt, no push); a new value is', () => {
  sv.resetSecretValues();
  const out = sv.windowFile(home);
  sv.buildWindowFile(home, out, { values: sv.collectSecretValues(home, { env: {}, pub: '' }) });
  sv.buildWindowFile(home, out); // the same set as refreshWindowFileIfStale computes it
  const before = fs.readFileSync(out, 'utf8');
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(home, '.claude.json'), later, later);
  assert.equal(sv.refreshWindowFileIfStale(home), false);
  assert.equal(fs.readFileSync(out, 'utf8'), before);
  assert.ok(!before.includes(S.appSecret) && JSON.parse(before).set.length === 64);
  const evenLater = new Date(Date.now() + 10_000);
  write('.synth-org-token', `${rnd(40)}\n`);
  fs.utimesSync(path.join(home, '.synth-org-token'), evenLater, evenLater);
  assert.equal(sv.refreshWindowFileIfStale(home), true);
  assert.notEqual(fs.readFileSync(out, 'utf8'), before);
});
