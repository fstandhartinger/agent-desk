// Value-based redaction (critic round 2, P0-1, defense in depth): the bridge knows the real secret VALUES of its host
// (every secret store, see secretSources(); critic round 4 widened it from four env files) and replaces every exact
// occurrence before a string leaves the bridge, whatever shape the surrounding text has. The values live only in this
// module's memory: never logged, never exported (only the count is readable, for tests and the startup line).
//
// Critic round 3, P0-1 (b): fragments. Every 16-char window of every value is known as a salted SHA-256 hash, and outgoing
// text is scanned with a sliding window, so a cut snippet that holds only part of a value is masked too. Windows of the
// local values are hashed in memory (per-process salt); windows of the Sandy values come from a hash file
// (~/.config/agent-desk/secret-windows.json, 0600, built on Sandy and pushed to LeChonk by the Sandy bridge, windowSync.js),
// so the LeChonk bridge masks Sandy secrets without ever holding them in plain text.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPlaceholder } from './redactPatterns.js';

const R = '[REDACTED]';
const MIN_LEN = 12;
const MIN_PASSWORD_LEN = 8;
const PASSWORD_NAME = /PASSWORD|PASSWD|PASSWORT|_PASS$|_PWD$/;
export const WINDOW = 16;
const RECHECK_MS = 5_000; // stat the files at most this often; reload when a file appears, disappears or changes mtime
// Values that are config, not secrets: versions/IPs/dates (digits WITH separators), paths, booleans, bare origins, mail
// addresses, plain words without digits. Long pure-digit values (account / connection ids of 12+ digits) stay in.
const NOT_SECRET = [
  /^(?=.*[.:,_-])[\d.:,_-]+$/,
  /^(?:~|\.{0,2}\/)[^\s]*$/,
  /^(?:true|false|null|none|yes|no)$/i,
  /^https?:\/\/[^/@\s?#]+\/?$/i,
  /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
  /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?$/, // a lowercase host name (imap.example.net:993)
  /^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?$/, // an ISO timestamp
  /^<[^>]*>$|^\[[A-Z_]+\]$/, // tokenizer specials and doc placeholders (<|endoftext|>, [PAD])
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // the NAME of a variable (OPENROUTER_API_KEY), not its value
];
const PLAIN_WORD = /^[A-Za-z][A-Za-z._-]*$/; // shorter than 16 chars: a user name or a word, not a secret
// Critic round 3, P1-3: names whose values are identifiers, not secrets (their values showed up in every GitHub URL).
// Round 4 (the wider store list): URIs, hosts, sender addresses, domains and public keys too.
const NOT_SECRET_NAME = /(?:_USER|_USERNAME|_EMAIL|_ENDPOINT|_ID|_HOST|_PORT|_REGION|_IP|_URI|_BASE|_FROM|_IMAP|_SMTP|_DOMAIN|_ADDRESS|_DATE|_AT|_TIME|_TYPE|_NAME|_SCOPES?|_SUPPORTED|_METHODS?|_CLASS|_ENV|_VAR|_FILE|_PATH)$|SUBDOMAIN|^NAMECHEAP_(?:API_USER|CLIENT_IP)$|^(?!.*(?:TOKEN|SECRET|PASSW|PRIVATE)).*PUBLI(?:C|SHABLE)/;
const URL_NAME = /_URL$/;
const HAS_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i;
// Secret-looking names in the bridge's own environment (BRIDGE_TOKEN, OPENAI_API_KEY, ...).
const ENV_SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PWD|CREDENTIALS?|AUTH|COOKIE|FINGERPRINT|PRIVATE|SEED|MNEMONIC|DSN|WEBHOOK)/;

export const windowFile = (home) => path.join(home, '.config', 'agent-desk', 'secret-windows.json');

// Critic round 5, P0-1 (a) / P1-1: stores are DISCOVERED, not listed. The whole home directory is walked (HOME_DEPTH
// levels; dependency trees, VCS data, venvs, caches, browser profiles, sealed benchmark data and the desk's read targets
// jobs/ and chat transcripts are pruned) for files that are named like a secret store, sit in a secret directory (~/.ssh,
// ~/.mcp-auth, wallets, ~/.secrets*, private/) or are a fixed store. The walk costs about a second on Sandy, so it runs on
// first use (bridge start) and then every SCAN_EVERY_MS in the background (startSecretSourceScan). In between, load()
// re-stats the store files every RECHECK_MS, and the directories that hold stores as well, so a new file next to a
// known store is picked up within seconds.
// Critic r6 P2-6: 5 levels missed project stores like ~/<root>/<proj>/tenants/<t>/<app>/keys/cert.key; 7 levels walk in ~0.9 s on
// Sandy (5: ~0.5 s, 8: ~1.5 s) and cover every store the critic's deeper enumeration found.
const HOME_DEPTH = 7; // files up to ~/a/b/c/d/e/f/<file>
export const SCAN_EVERY_MS = 30 * 60_000;
const PRUNE = /^(?:node_modules|bower_components|\.git|\.hg|\.svn|venvs?|\.venv[\w.-]*|virtualenvs?|site-packages|dist-packages|__pycache__|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.cache|[Cc]ache|caches|Code Cache|GPUCache|Service Worker|IndexedDB|\.npm|\.pnpm-store|\.yarn|\.cargo|\.rustup|\.nvm|\.bun|\.deno|\.dotnet|\.nuget|\.gradle|\.m2|go|snap|flatpak|google-chrome[\w-]*|chromium[\w-]*|BraveSoftware|\.mozilla|agent-profile|File Seek|\.agent-browser-profiles|\.browser-profiles|Trash|\.Trash[\w-]*|fonts|icons|\.next|\.nuxt|\.svelte-kit|\.turbo|\.terraform)$/;
// home-relative directories that are read targets (jobs, transcripts) or bulk data, never stores
const PRUNE_REL = /^(?:jobs|jevbench-sealed|\.local\/lib|\.claude[\w-]*\/projects|\.codex\/(?:sessions|archived_sessions)|\.cline\/(?:tasks|data\/(?:sessions|checkpoint[\w-]*|cache|logs)))$/;
const SECRETISH_FILE = /token|secret|passw|credential|api[-_]?key|apikey|(?:^|[._-])key$|\.key$|\.pem$|\.env(?:$|\.)|^\.env$|^id_(?:rsa|dsa|ecdsa|ed25519)|^\.npmrc$|^\.pypirc$|^\.netrc$|^\.git-credentials$|^\.pgpass$|^rclone\.conf$|^config\.ini$/i;
const JSON_STORE = /(?:^|[._-])(?:auth|credentials?|tokens?|secrets?|web_session|mcp-auth|accounts?)\.json$|^\.claude\.json$/i;
// every file below these is a store candidate (ssh keys without a telling name, wallet files, OAuth caches)
const SECRET_DIR_REL = /^(?:\.ssh|\.mcp-auth|\.bittensor\/wallets|\.bonsai-autoscale|\.secrets[\w-]*|\.antseed[\w-]*|\.claude[\w-]*\/accounts|\.aws|\.kube)\/|^\.docker\/config\.json$/;
const SECRET_DIR_NAME = /^\.?(?:private|secrets?|credentials)$/i;
// documentation and code are never stores (a `.py` file or a systemd unit looks KEY=VALUE-shaped); public keys neither
const NOT_STORE = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|go|rs|rb|php|java|sh|bash|zsh|ps1|md|txt\.bak|html?|css|scss|service|timer|socket|desktop|example|sample|template|tmpl|dist|lock|db|sqlite\d?|journal|log|jsonl|gz|zip|tar|tgz|png|jpe?g|gif|webp|svg|pdf|pub|csv|sock|ansi)$|-journal$|^secret-windows\.json|\.address$|^known_hosts|^authorized_keys|^coldkeypub\.txt$/i;
// strict mode does not apply here: the stores of the host's own secret directories and the home root
const CURATED_REL = /^(?:\.config|\.hermes|\.local\/share|\.ssh|\.mcp-auth|\.bittensor|\.bonsai-autoscale|\.secrets[\w-]*|\.antseed[\w-]*|\.claude[\w-]*|\.codex|\.aws|\.kube)\/|^\.docker\/config\.json$|^[^/]+$/;
const FIXED = ['.netrc', '.git-credentials', '.config/gh/hosts.yml', '.codex/auth.json', '.hermes/auth.json'];
const MAX_STORE_BYTES = 256 * 1024;
const OPENSSH_MAGIC = ['b3BlbnNz', 'aC1rZXkt', 'djE'].join(''); // base64 of "openssh-key-v1", the same in every key
let listCache = { home: null, at: 0, kinds: new Map(), dirs: new Map(), ms: 0 };

/** Store kind of a home-relative file: 'curated' (secret directories, home root), 'strict' (anywhere else) or null. */
export function storeKind(rel) {
  const name = path.posix.basename(rel);
  if (NOT_STORE.test(name)) return null;
  const dirs = path.posix.dirname(rel).split('/');
  if (!SECRET_DIR_REL.test(rel) && !dirs.some((d) => SECRET_DIR_NAME.test(d)) && !SECRETISH_FILE.test(name) && !JSON_STORE.test(name)) return null;
  return CURATED_REL.test(rel) ? 'curated' : 'strict';
}

/** One directory of the walk: store files into `kinds`, subdirectories onto `stack`. */
function visit(home, rel, depth, entries, kinds, dirs, stack, statFile) {
  let held = false;
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (depth > 1 && stack && !PRUNE.test(e.name) && !PRUNE_REL.test(r)) stack.push([r, depth - 1]);
      continue;
    }
    if (!e.isFile() && !(e.isSymbolicLink() && statFile(path.join(home, r)))) continue; // symlinked dirs are not followed
    const kind = storeKind(r);
    if (kind) { kinds.set(path.join(home, r), kind); held = true; }
  }
  if (held) dirs.set(path.join(home, rel), { rel, depth });
}

const isFileSync = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function finishScan(home, kinds, dirs, t0) {
  for (const f of FIXED) { const p = path.join(home, f); if (!kinds.has(p) && isFileSync(p)) kinds.set(p, 'curated'); }
  const stamped = new Map();
  for (const [d, info] of dirs) { try { stamped.set(d, { ...info, mtimeMs: fs.statSync(d).mtimeMs }); } catch { /* gone */ } }
  return { home, at: Date.now(), kinds, dirs: stamped, ms: Date.now() - t0 };
}

/** Walk the home directory now (synchronous; bridge start, build script, tests). */
export function scanSecretSources(home) {
  const t0 = Date.now();
  const kinds = new Map();
  const dirs = new Map();
  const stack = [['', HOME_DEPTH]];
  while (stack.length) {
    const [rel, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(home, rel), { withFileTypes: true }); } catch { continue; }
    visit(home, rel, depth, entries, kinds, dirs, stack, isFileSync);
  }
  listCache = finishScan(home, kinds, dirs, t0);
  return listCache;
}

/** The same walk without blocking the event loop (the periodic rescan of the bridge). */
export async function scanSecretSourcesAsync(home) {
  const t0 = Date.now();
  const kinds = new Map();
  const dirs = new Map();
  const stack = [['', HOME_DEPTH]];
  const links = [];
  while (stack.length) {
    const [rel, depth] = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(home, rel), { withFileTypes: true }); } catch { continue; }
    visit(home, rel, depth, entries, kinds, dirs, stack, (p) => { links.push(p); return false; });
  }
  for (const p of links) { // symlinked files, resolved after the walk
    try { if ((await fs.promises.stat(p)).isFile()) { const k = storeKind(path.relative(home, p)); if (k) kinds.set(p, k); } } catch { /* dangling */ }
  }
  listCache = finishScan(home, kinds, dirs, t0);
  return listCache;
}

/** Cheap check between walks: a directory that holds stores changed (a file was added): list it again, one level. */
function refreshStoreDirs(home) {
  for (const [d, info] of listCache.dirs) {
    let m;
    try { m = fs.statSync(d).mtimeMs; } catch { continue; }
    if (m === info.mtimeMs) continue;
    info.mtimeMs = m;
    try { visit(home, info.rel, info.depth, fs.readdirSync(d, { withFileTypes: true }), listCache.kinds, new Map(), null, isFileSync); } catch { /* gone */ }
  }
}

/** Every secret store file of a host (paths only). */
export function secretSources(home) {
  if (listCache.home !== home || Date.now() - listCache.at > SCAN_EVERY_MS * 2) scanSecretSources(home); // the timer missed
  return [...listCache.kinds.keys()].filter(isFileSync);
}

/** Last walk: { files, dirs, ms } counts (startup line, tests). */
export const secretSourceStats = () => ({ files: listCache.kinds.size, dirs: listCache.dirs.size, ms: listCache.ms });

let scanTimer = null;
/** Bridge: rescan the home directory every SCAN_EVERY_MS in the background. */
export function startSecretSourceScan(home = process.env.BRIDGE_HOME || process.env.HOME || os.homedir(), { log = () => {} } = {}) {
  if (scanTimer) return scanTimer;
  scanTimer = setInterval(() => {
    scanSecretSourcesAsync(home).then((c) => log(`secret stores rescanned: ${c.kinds.size} files in ${c.ms} ms`))
      .catch((err) => log(`secret store rescan failed: ${err.message}`));
  }, SCAN_EVERY_MS);
  scanTimer.unref?.();
  return scanTimer;
}

/** Tests: forget the cached store list. */
export function resetSecretSources() { listCache = { home: null, at: 0, kinds: new Map(), dirs: new Map(), ms: 0 }; }

const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;
const CODE_LINE = /^\s*(?:import|from|def|class|function|const|let|var|if|for|while|return|async|await|try|except|module\.exports)\b|\bself\.|=>|[;{}]\s*$|^\s*\[[^\]]+\]\s*$/;
const SECRET_JSON_KEY = /token(?!iz)|secret|passw|api[_-]?key|apikey|private[_-]?key|access[_-]?key|cookie|credential|refresh|bearer|session[_-]?key|auth[_-]?key|verifier|seed|mnemonic|phrase|^auth$|^key$/i;
// a key/value name in an INI/TOML/YAML or unparsed env file that names a secret (strict stores need one)
const SECRET_NAME = /key|token|secret|passw|pwd|^pass$|_pass$|credential|auth|cookie|private|seed|mnemonic|phrase|dsn|webhook|salt|bearer|refresh|signing/i;
const envName = (key) => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** KEY=VALUE-shaped text: most non-comment lines are env assignments and none looks like code. */
export function isEnvShaped(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return false;
  if (lines.some((l) => CODE_LINE.test(l))) return false;
  return lines.filter((l) => ENV_LINE.test(l)).length >= Math.max(1, Math.ceil(lines.length * 0.6));
}

function jsonEntries(data, out, key = '', depth = 0) {
  if (depth > 8 || out.length > 500) return;
  if (typeof data === 'string') {
    // a value with spaces is a description, unless it is a seed phrase
    if (key && SECRET_JSON_KEY.test(key) && (!/\s/.test(data) || /seed|mnemonic|phrase/i.test(key))) out.push([envName(key) || 'JSON_SECRET', data]);
    return;
  }
  if (Array.isArray(data)) { for (const v of data) jsonEntries(v, out, key, depth + 1); return; }
  if (data && typeof data === 'object') {
    // {"name": "BRAVE_API_KEY", "value": "…"} (MCP env lists) and browser cookies {"name", "value", "domain"}; a bare
    // "value" is anything (a model option, an experiment flag)
    const named = typeof data.value === 'string' && (typeof data.domain === 'string' || SECRET_NAME.test(String(data.name ?? data.key ?? '')));
    if (named && !/\s/.test(data.value)) out.push([envName(data.name ?? data.key ?? 'cookie') || 'JSON_SECRET', data.value]);
    for (const [k, v] of Object.entries(data)) if (k !== 'value') jsonEntries(v, out, k, depth + 1);
  }
}

const unquote = (raw) => {
  let v = String(raw).trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) return v.slice(1, v.indexOf(q, 1));
  return v.replace(/(?<!\s)\s+[#;][\s\S]*$/, '').trim();
};

/** name = value / name: value lines of INI, TOML ([sections]), YAML (also `key: >-` folded values) and unparsed env files. */
function keyValueEntries(t, out) {
  const lines = t.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[=:](.*)$/); // trim, not \s*(.*?)\s*$ (critic r7)
    if (!m || !SECRET_NAME.test(m[1])) continue;
    let v = m[2].trim();
    if (/^[>|][-+]?$/.test(v)) v = (lines[i + 1] ?? '').trim(); // YAML block scalar: the value is on the next line
    if (v) out.push([m[1], unquote(v)]);
  }
}

/** [name, value] pairs of one store file, by its kind (json, netrc, git-credentials, gh hosts, npmrc, pem, env, ini/toml/yaml, token file). */
export function storeEntries(file, text) {
  const t = String(text);
  if (t.includes('\0') || t.startsWith('#!')) return []; // binary, or a script
  const base = path.basename(file);
  if (/\.json$/i.test(base) || /^\s*[{[]/.test(t)) { // wallet files have no extension
    const out = [];
    try { jsonEntries(JSON.parse(t), out); return out; } catch { if (/\.json$/i.test(base)) return out; }
  }
  if (base === '.netrc') return [...t.matchAll(/\bpassword\s+(\S+)/g)].map((m) => ['NETRC_PASSWORD', m[1]]);
  if (base === '.git-credentials') return [...t.matchAll(/^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:([^\s@/]+)@/gim)].map((m) => ['GIT_CREDENTIAL_PASSWORD', decodeURIComponent(m[1])]);
  if (base === 'hosts.yml') return [...t.matchAll(/^[ \t]*(?:oauth_token|token)\s*:\s*["']?([^\s"']+)/gm)].map((m) => ['GH_OAUTH_TOKEN', m[1]]);
  if (base === '.npmrc') return [...t.matchAll(/(?:_authToken|_auth|_password)\s*=\s*["']?([^\s"']+)/g)].map((m) => ['NPM_AUTH_TOKEN', m[1]]);
  if (/PRIVATE KEY-----/.test(t)) {
    // body lines; the first OpenSSH line ("openssh-key-v1", cipher "none") is the same in every key, so it is no secret
    return t.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9+/=]{16,}$/.test(l) && !l.startsWith(OPENSSH_MAGIC))
      .map((l) => ['PEM_PRIVATE_KEY', l]);
  }
  if (isEnvShaped(t)) return parseEnvEntries(t);
  const out = [];
  keyValueEntries(t, out);
  if (/\.env(?:$|\.)/.test(base) || t.length > 4096) return out; // env-named, or too big for a token file
  // token file: lines that are a single token (an API key, a password, a key per line)
  for (const l of t.split(/\r?\n/).map((x) => x.trim())) {
    if (l && !l.startsWith('#') && !/\s/.test(l) && !/^\[[^\]]*\]$/.test(l) && !/^[\w.-]+\s*[=:]/.test(l)) out.push(['FILE_TOKEN', l]);
  }
  return out;
}

/** KEY=VALUE lines (optional `export`, single/double quotes, trailing ` # comment` on unquoted values) -> [name, value]. */
export function parseEnvEntries(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/(?<!\s)\s+#[\s\S]*$/, '').trim();
    out.push([m[1], v]);
  }
  return out;
}

export const parseEnvValues = (text) => parseEnvEntries(text).map(([, v]) => v);

/** Strings that are public anyway (git remote URLs of this checkout, the git identity): values found there are no secrets. */
function publicText(home) {
  const parts = [];
  try {
    const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    parts.push(execFileSync('git', ['-C', repo, 'config', '--get-regexp', '^remote\\..*\\.url$'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { /* not a checkout */ }
  try { parts.push(fs.readFileSync(path.join(home, '.gitconfig'), 'utf8')); } catch { /* none */ }
  return parts.join('\n');
}

// Strict stores (code checkouts, project folders: anything outside the host's secret directories) hold config next to
// secrets and test fixtures: only secret-named entries with a random-looking value count there.
const strongValue = (v) => !/\s/.test(v) && /[A-Za-z]/.test(v) && ((v.length >= 12 && /\d/.test(v)) || (v.length >= 16 && /[a-z]/.test(v) && /[A-Z]/.test(v)));

/** Is this NAME=value pair a secret worth guarding? (name skip list, value shape, public strings; `strict` for project stores) */
export function isSecretEntry(name, value, pub = '', strict = false) {
  if (typeof value !== 'string') return false;
  const n = name ? envName(name) : '';
  // passwords are often shorter than MIN_LEN (round 4): 8+ chars when the name says password, and not a plain word
  const minLen = n && PASSWORD_NAME.test(n) && !/^[A-Za-z]+$/.test(value) ? MIN_PASSWORD_LEN : MIN_LEN;
  if (value.length < minLen) return false;
  if (NOT_SECRET.some((re) => re.test(value)) || isPlaceholder(value)) return false;
  if (value.length < 16 && PLAIN_WORD.test(value)) return false;
  // snake/kebab words name a mode or a method (client_secret_basic), unless the name says passphrase
  if (/^[a-z]+(?:[_-][a-z]+)+$/.test(value) && !/PASSW|PHRASE|SEED|MNEMONIC/.test(n)) return false;
  if (n && NOT_SECRET_NAME.test(n)) return false;
  if (n && URL_NAME.test(n) && !HAS_USERINFO.test(value)) return false;
  if (pub && pub.includes(value)) return false;
  if (strict) {
    if (HAS_USERINFO.test(value)) return /^[a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:[^\s@/]+@/i.test(value);
    if (n && !['FILE_TOKEN', 'PEM_PRIVATE_KEY'].includes(n) && !SECRET_NAME.test(n)) return false;
    if (!(PASSWORD_NAME.test(n) && value.length >= MIN_PASSWORD_LEN && /[^A-Za-z]/.test(value)) && !strongValue(value)) return false;
  }
  return true;
}

/** Secret values of a host (the files above plus the process environment), filtered. */
export function collectSecretValues(home, { env = process.env, pub = publicText(home) } = {}) {
  const values = new Set();
  for (const f of secretSources(home)) {
    let text;
    try {
      if (fs.statSync(f).size > MAX_STORE_BYTES) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    const strict = (listCache.kinds.get(f) ?? storeKind(path.relative(home, f))) === 'strict';
    for (const [name, v] of storeEntries(f, text)) if (isSecretEntry(name, v, pub, strict)) values.add(v);
  }
  for (const [name, v] of Object.entries(env)) if (ENV_SECRET_NAME.test(name) && isSecretEntry(name, v, pub)) values.add(v);
  return [...values];
}

// ---- 16-char windows ------------------------------------------------------------------------------------------------
// Only windows of "token" characters (no whitespace, quotes or backslash) with a digit or both letter cases are hashed,
// on both sides; prose never forms such a window, so a 200 kB text costs a few ms. A fast keyed rolling hash (32 bit)
// pre-filters, the salted SHA-256 decides.

const isTok = (c) => c > 32 && c < 127 && c !== 34 && c !== 39 && c !== 92 && c !== 96;
const isDigit = (c) => c >= 48 && c <= 57;
const isUpper = (c) => c >= 65 && c <= 90;
const isLower = (c) => c >= 97 && c <= 122;

function rollBase(salt) {
  return (parseInt(salt.slice(0, 8), 16) | 1) >>> 0;
}
const sha = (salt, w) => crypto.createHash('sha256').update(salt).update(w).digest('hex').slice(0, 32);

/** Calls fn(index, rollingHash) for every candidate window of `text`. */
function eachWindow(text, base, fn) {
  const n = text.length;
  if (n < WINDOW) return;
  let pow = 1;
  for (let i = 0; i < WINDOW - 1; i++) pow = Math.imul(pow, base) >>> 0;
  let h = 0;
  let bad = 0;
  let digits = 0;
  let uppers = 0;
  let lowers = 0;
  const add = (c, sign) => {
    if (!isTok(c)) bad += sign;
    else if (isDigit(c)) digits += sign;
    else if (isUpper(c)) uppers += sign;
    else if (isLower(c)) lowers += sign;
  };
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (i >= WINDOW) {
      const out = text.charCodeAt(i - WINDOW);
      add(out, -1);
      h = (h - Math.imul(out, pow)) >>> 0;
    }
    h = (Math.imul(h, base) + c) >>> 0;
    add(c, 1);
    if (i >= WINDOW - 1 && bad === 0 && (digits > 0 || (uppers > 0 && lowers > 0))) fn(i - WINDOW + 1, h);
  }
}

/** Window set of some values: { salt, base, quick: Set<uint32>, hashes: Set<hex> }. */
export function windowSet(values, salt = crypto.randomBytes(16).toString('hex')) {
  const base = rollBase(salt);
  const quick = new Set();
  const hashes = new Set();
  for (const v of values) {
    eachWindow(v, base, (i, h) => {
      quick.add(h);
      hashes.add(sha(salt, v.slice(i, i + WINDOW)));
    });
  }
  return { salt, base, quick, hashes };
}

/** Serialisable form for the hash file (salted hashes only, never a value). */
export function windowFileData(values, { source = os.hostname() } = {}) {
  const ws = windowSet(values);
  return { version: 1, window: WINDOW, source, created: new Date().toISOString(), values: values.length, set: setDigest(values), salt: ws.salt, quick: [...ws.quick], hashes: [...ws.hashes] };
}

/** Digest of a whole value set (unchanged set = no rebuild, no push); one SHA-256 over all values reveals none of them. */
const setDigest = (values) => crypto.createHash('sha256').update('agent-desk-secret-set-v1\0').update([...values].sort().join('\0')).digest('hex');

function windowSetFromFile(data) {
  if (!data || data.version !== 1 || data.window !== WINDOW || typeof data.salt !== 'string' || !Array.isArray(data.hashes)) return null;
  return { salt: data.salt, base: rollBase(data.salt), quick: new Set(data.quick ?? []), hashes: new Set(data.hashes) };
}

/** [start, end) ranges of `text` that hold a window of a known value. */
function fragmentRanges(text, sets) {
  const ranges = [];
  for (const ws of sets) {
    if (!ws || !ws.hashes.size) continue;
    eachWindow(text, ws.base, (i, h) => {
      if (!ws.quick.has(h) || !ws.hashes.has(sha(ws.salt, text.slice(i, i + WINDOW)))) return;
      const last = ranges[ranges.length - 1];
      if (last && i <= last[1] && last.set === ws) last[1] = Math.max(last[1], i + WINDOW);
      else ranges.push(Object.assign([i, i + WINDOW], { set: ws }));
    });
  }
  if (sets.length > 1) ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of ranges) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Build the window hash file from this host's secret values; written 0600. Returns { values, windows } counts only. */
export function buildWindowFile(home, out = windowFile(home), { extraPublic = '', values = null } = {}) {
  const pub = `${publicText(home)}\n${extraPublic}`;
  values ??= collectSecretValues(home, { pub, env: {} }); // the store files only, not this shell's environment
  const data = windowFileData(values);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  const tmp = `${out}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, out);
  state.checkedAt = 0; // critic r6 P2-8: the next count / redact reloads the new file (the connect log said the old count)
  return { values: values.length, windows: data.hashes.length };
}

/** Sandy: rebuild the hash file when a secret store is newer than it (bridge start and every sync tick). Returns true when rebuilt. */
export function refreshWindowFileIfStale(home) {
  const out = windowFile(home);
  let built = 0;
  try { built = fs.statSync(out).mtimeMs; } catch { /* missing */ }
  const newest = Math.max(0, ...secretSources(home).map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }));
  if (!newest || built >= newest) return false;
  // Round 5: stores such as ~/.claude.json and session key files change every few minutes without a new value; a new salt
  // would change the file anyway, so compare the value sets and only touch the file when they agree.
  const values = collectSecretValues(home, { pub: publicText(home), env: {} });
  let old = null;
  try { old = JSON.parse(fs.readFileSync(out, 'utf8')).set ?? null; } catch { /* missing or unreadable */ }
  if (old && old === setDigest(values)) {
    const now = new Date();
    fs.utimesSync(out, now, now);
    return false;
  }
  buildWindowFile(home, out, { values });
  return true;
}

// ---- state ----------------------------------------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

let state = { home: null, stamp: '', checkedAt: 0, list: [], count: 0, sets: [], fileWindows: 0 };

function stampOf(files) {
  return files.map((f) => {
    try { const st = fs.statSync(f); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return ''; }
  }).filter(Boolean).join('|');
}

function load(home) {
  if (listCache.home === home) refreshStoreDirs(home);
  const files = secretSources(home);
  const wf = windowFile(home);
  const stamp = stampOf([...files, wf]);
  if (state.home === home && stamp === state.stamp) return;
  // longest first, so a value that contains another one is replaced whole
  const list = collectSecretValues(home).sort((a, b) => b.length - a.length);
  const sets = [windowSet(list)];
  let fileWindows = 0;
  try {
    const ws = windowSetFromFile(JSON.parse(fs.readFileSync(wf, 'utf8')));
    if (ws) { sets.push(ws); fileWindows = ws.hashes.size; }
  } catch { /* no hash file on this host */ }
  state = {
    home, stamp, checkedAt: Date.now(), count: list.length, sets, fileWindows, list,
  };
}

function current() {
  const home = process.env.BRIDGE_HOME || process.env.HOME || os.homedir(); // BRIDGE_HOME: tests (as in paths.js)
  if (state.home !== home || Date.now() - state.checkedAt > RECHECK_MS) {
    try { load(home); } catch { /* keep the previous set */ }
    state.checkedAt = Date.now();
  }
  return state;
}

/** Replace every exact occurrence of a known secret value. */
export function redactExactValues(text) {
  if (typeof text !== 'string' || text.length < MIN_PASSWORD_LEN) return text;
  // A native substring search per value finds the few present ones; one big alternation over hundreds of values cost
  // ~0.5 ms per kB. The list is longest first, so a value that contains another one is replaced whole.
  const present = current().list.filter((v) => text.includes(v));
  if (!present.length) return text;
  return text.replace(new RegExp(present.map(escapeRe).join('|'), 'g'), R);
}

/**
 * Replace every 16-char window of a known value (local or from the hash file). Run it AFTER the shape patterns: a masked
 * public prefix (a JWT header shared with a known token) must not stop the JWT pattern from seeing the whole token.
 */
export function redactFragments(text) {
  if (typeof text !== 'string' || text.length < WINDOW) return text;
  const ranges = fragmentRanges(text, current().sets);
  if (!ranges.length) return text;
  let res = '';
  let at = 0;
  for (const [a, b] of ranges) { res += text.slice(at, a) + R; at = b; }
  return res + text.slice(at);
}

/** Exact values, then fragments. */
export const redactValues = (text) => redactFragments(redactExactValues(text));

/** Number of loaded values (never the values themselves). */
export const secretValueCount = () => current().count;
/** Number of window hashes loaded from the hash file (0 when there is none). */
export const secretWindowCount = () => current().fileWindows;

/** Tests: forget the cache so the next call reloads (e.g. after switching HOME). */
export function resetSecretValues() {
  resetSecretSources();
  state = { home: null, stamp: '', checkedAt: 0, list: [], count: 0, sets: [], fileWindows: 0 };
}
