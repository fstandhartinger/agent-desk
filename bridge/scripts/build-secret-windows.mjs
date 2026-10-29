#!/usr/bin/env node
// Builds ~/.config/agent-desk/secret-windows.json (0600): salted SHA-256 hashes of every 16-char window of every secret value
// in this host's secret stores (secretSources() in src/secretValues.js: discovered by walking the home directory: env,
// token/secret/key files, ssh keys, wallets, JSON/TOML credential files, netrc, git-credentials, npmrc, ...), minus non-secrets (name skip list, config-looking values,
// values that occur in the public agent-desk repo or the git remotes). Run on Sandy; the Sandy bridge pushes the file to
// LeChonk itself (src/windowSync.js; manual copy: README). Prints counts only, never a value.
// Usage: node scripts/build-secret-windows.mjs [--out <file>] [--home <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildWindowFile, windowFile } from '../src/secretValues.js';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const home = arg('--home') || process.env.BRIDGE_HOME || os.homedir();
const out = arg('--out') || windowFile(home);

// Every tracked file of this checkout is public (github.com/fstandhartinger/agent-desk): a value found there is no secret.
function repoText() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  let files = [];
  try { files = execFileSync('git', ['-C', repo, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean); } catch { return ''; }
  const parts = [];
  for (const f of files) {
    try {
      const p = path.join(repo, f);
      if (fs.statSync(p).size <= 2 * 1024 * 1024) parts.push(fs.readFileSync(p, 'utf8'));
    } catch { /* deleted or unreadable */ }
  }
  return parts.join('\n');
}

const r = buildWindowFile(home, out, { extraPublic: repoText() });
console.log(`secret-windows: ${r.values} values, ${r.windows} window hashes -> ${out.replace(home, '~')} (0600)`);
