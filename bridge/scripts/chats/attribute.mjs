#!/usr/bin/env node
// Which secret store makes the chat-mirror gate fail? (#86913, 26 Nov 2026) The 16-char windows of every store's accepted values
// (secretSources() + storeEntries() + isSecretEntry(), the same rules as collectSecretValues) and of secret-named environment
// variables are matched in memory against the files the gate named (or every file below <dir>). Prints store PATHS, env variable
// NAMES and file counts only, never a value, a window or any text of the files. A diagnostic: it changes nothing.
// Usage: node attribute.mjs <dir> [<scan-output-file>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanSecretSources, storeEntries, isSecretEntry, WINDOW } from '../../src/secretValues.js';
import { failedPaths } from './resettle.mjs';

const ENV_SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|COOKIE|FINGERPRINT|PRIVATE|SEED|MNEMONIC|DSN|WEBHOOK)/;
const MAX_STORE_BYTES = 256 * 1024;

/** window -> Set of source labels ("~/path/to/store" or "env:NAME"). */
export function sourceWindows(home, env = process.env) {
  const wins = new Map();
  const add = (label, v) => { for (let i = 0; i + WINDOW <= v.length; i += 1) { const w = v.slice(i, i + WINDOW); (wins.get(w) ?? wins.set(w, new Set()).get(w)).add(label); } };
  for (const [f, kind] of scanSecretSources(home).kinds) {
    let text;
    try { if (fs.statSync(f).size > MAX_STORE_BYTES) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const label = f.startsWith(home) ? `~${f.slice(home.length)}` : f;
    for (const [name, v] of storeEntries(f, text)) if (isSecretEntry(name, v, '', kind === 'strict')) add(`${label} (${kind})`, v);
  }
  for (const [name, v] of Object.entries(env)) if (ENV_SECRET_NAME.test(name) && isSecretEntry(name, v)) add(`env:${name}`, v);
  return wins;
}

/** source label -> number of files (of `files`) holding at least one of its windows. */
export function attribute(files, wins) {
  const per = new Map();
  for (const f of files) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const seen = new Set();
    for (let i = 0; i + WINDOW <= t.length; i += 1) { const s = wins.get(t.slice(i, i + WINDOW)); if (s) for (const l of s) seen.add(l); }
    for (const l of seen) per.set(l, (per.get(l) ?? 0) + 1);
  }
  return [...per].sort((a, b) => b[1] - a[1]);
}

function* walk(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walk(p); else if (e.isFile()) yield p;
  }
}

async function main() {
  const [dir, scanFile] = process.argv.slice(2);
  if (!dir || !fs.statSync(dir).isDirectory()) { console.error('usage: attribute.mjs <dir> [<scan-output-file>]'); process.exit(2); }
  const home = process.env.BRIDGE_HOME || process.env.HOME || os.homedir();
  const files = scanFile ? failedPaths(fs.readFileSync(scanFile, 'utf8')).map((r) => path.join(dir, r)) : [...walk(dir)];
  const rows = attribute(files, sourceWindows(home));
  console.log(JSON.stringify({ dir: path.resolve(dir), files: files.length, sources: rows.length }));
  for (const [label, n] of rows) console.log(`${n}\t${label}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
