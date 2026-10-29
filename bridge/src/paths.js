import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// BRIDGE_HOME exists for tests; the service always runs with the real home.
export const HOME = process.env.BRIDGE_HOME || os.homedir();
export const CANON_JOBS = path.join(HOME, 'jobs');
// The normal-shell jobs path may be a stale job-unit view or an NFS mount; the stable live Sandy view comes first.
const JOB_VIEWS = process.env.BRIDGE_HOME ? [CANON_JOBS] : ['/srv/sandy-jobs-mnt/jobs', CANON_JOBS];
export const NOT_AVAILABLE = 'path not allowed or not found';
export const MAX_READ_BYTES = 512 * 1024;
// The desk's private knowledge index (written by scripts/knowledge) and the laptop's memory mirror.
export const KNOWLEDGE_DIR = path.join(HOME, 'desk-knowledge');
export const LAPTOP_MIRROR = path.join(HOME, 'data', 'laptop-mirror');

// Deny by path segment / file name, never by substring: job names such as tng-trustedtokens-mining-… must stay readable.
// Upgrade wave 28 Oct: also the notify store (~/.notify), browser profiles (home-IP Chrome, Chrome, Firefox), cookie / login
// databases, git credentials and the dev-secrets / bridge / hermes env files.
const DENIED_SEGMENT = /^(\.git|\.ssh|\.gnupg|\.env.*|\.?secrets?|\.?credentials?|\.?tokens?|\.notify|\.mozilla|firefox|chromium|google-chrome(-.*)?|home-browser|home-chrome.*|chrome-(home|profile).*|browser-profiles?|User Data)$|sealed|wallet|reaxsign/i;
const DENIED_FILE = /\.(key|pem|p12|pfx|env)$|^id_(rsa|dsa|ecdsa|ed25519)$|^auth\.json$|^\.netrc$|^\.git-credentials$|^dev-secrets\.env$|^(bridge|secrets)\.env$|(?:^|[._-])(?:secrets?|credentials?|tokens?)\.[^.]+$|\.(sqlite3?|sqlite-wal|sqlite-shm|vscdb)$|^cookies.*\.json$|\.har$|^\.credentials\.json$|^tokens?[^/]*\.json$|^(cookies?|login data|web data|local state|logins\.json|key[34]\.db)(-journal|-wal)?$/i;

export function isDenied(p) {
  const segments = String(p).split(/[\\/]/).filter(Boolean);
  const file = segments.at(-1) ?? '';
  // "storage_state….json" as two tests: /storage[_-]state.*\.json$/ rescanned to the end from every "storage_state" (critic r7)
  return segments.some((s) => DENIED_SEGMENT.test(s)) || DENIED_FILE.test(file) || (/storage[_-]state/i.test(file) && /\.json$/i.test(file) && !/[\n\r\u2028\u2029]/.test(file));
}

export function claudeProjectDirs() {
  return ['.claude', '.claude-A', '.claude-C'].map((d) => path.join(HOME, d, 'projects'));
}

export function jobsRoot() {
  for (const dir of JOB_VIEWS) {
    try {
      if (fs.readdirSync(dir).length > 0) return dir;
    } catch { /* try next view */ }
  }
  return CANON_JOBS;
}

/** Map any job-view prefix to the canonical /home/flori/jobs path shown to the gateway. */
export function toCanonical(p) {
  for (const view of JOB_VIEWS) {
    if (p === view || p.startsWith(view + path.sep)) return CANON_JOBS + p.slice(view.length);
  }
  return p;
}

/** Map the canonical jobs path to the live view used for actual reads. */
export function fromCanonical(p) {
  if (p === CANON_JOBS || p.startsWith(CANON_JOBS + path.sep)) return jobsRoot() + p.slice(CANON_JOBS.length);
  return p;
}

const FILE_ALLOW = [
  path.join(HOME, 'AGENTS.md'),
  path.join(HOME, 'DECISIONS.md'),
  path.join(HOME, 'STATE.md'),
  path.join(HOME, 'CLAUDE.md'),
  path.join(HOME, '.hermes', 'model-economy-policy.md'),
];

function dirAllow() {
  return [
    ...JOB_VIEWS.map((d) => ({ dir: d })),
    // Code the agents explain on the canvas (code.outline, read_file). ~/bin is flat: its files, not the folders below it.
    { dir: path.join(HOME, 'work', 'agent-desk') },
    { dir: path.join(HOME, 'Dev', 'explainer-pages') },
    { dir: path.join(HOME, 'work', 'explainer-pages') },
    { dir: path.join(HOME, 'bin'), flat: true },
    { dir: path.join(HOME, '.agents', 'skills') },
    { dir: path.join(HOME, '.claude', 'skills') },
    { dir: path.join(HOME, 'desk-sessions') },
    { dir: KNOWLEDGE_DIR },
    { dir: LAPTOP_MIRROR },
    ...claudeProjectDirs().map((d) => ({ dir: d, ext: '.jsonl' })),
  ];
}

function within(dir, p) {
  return p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}

function realOrNull(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

const inFlat = (dir, p) => p === dir || path.dirname(p) === dir;
const inside = ({ dir, flat }, p) => (flat ? inFlat(dir, p) : within(dir, p));

function lexicallyAllowed(abs) {
  if (FILE_ALLOW.includes(abs)) return true;
  return dirAllow().some((root) => inside(root, abs) && (!root.ext || abs.endsWith(root.ext)));
}

/**
 * Resolve a requested path against the allowlist. Returns the real path (for reads) or throws.
 * The lexical allowlist and deny checks run first, so a path outside the allowed trees never touches the file system
 * and "not allowed" is indistinguishable from "not found". The realpath is then checked again, so symlinks cannot
 * leave the allowed trees.
 */
export function resolveAllowed(requested) {
  const fail = () => new Error(NOT_AVAILABLE);
  if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw fail();
  const abs = path.resolve(requested.startsWith('~') ? path.join(HOME, requested.slice(1)) : requested);
  if (isDenied(abs) || !lexicallyAllowed(abs)) throw fail();
  const real = realOrNull(abs);
  if (!real || isDenied(real)) throw fail();
  for (const f of FILE_ALLOW) {
    if (abs === f && real === realOrNull(f)) return real;
  }
  for (const root of dirAllow()) {
    const { dir, ext } = root;
    const realDir = realOrNull(dir);
    if (!realDir || !inside(root, abs) || !inside({ ...root, dir: realDir }, real)) continue;
    if (ext && !real.endsWith(ext)) continue;
    return real;
  }
  throw fail();
}
