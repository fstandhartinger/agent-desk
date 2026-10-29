// Critic round 4, P2-4: the fragment hash file (secret-windows.json, salted hashes only, never a value) reaches LeChonk
// without a manual copy. The Sandy bridge rebuilds it when a secret store changed and pushes it over the existing ssh
// alias (scp to a temp name, then chmod 600 + mv); a failed push is logged and retried on the next tick, never fatal.
// The LeChonk bridge logs a warning when its copy is missing or older than 24 h.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { refreshWindowFileIfStale, windowFile } from './secretValues.js';

const execFileP = promisify(execFile);
export const PUSH_EVERY_MS = 5 * 60_000; // check for changed stores this often
export const REPUSH_MS = 12 * 3600_000; // push at least this often, so the LeChonk copy never looks stale
export const STALE_MS = 24 * 3600_000;
const REMOTE_DIR = '.config/agent-desk'; // relative to the remote home
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

const markerOf = (wf) => `${wf}.pushed`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * One sync tick on Sandy: rebuild when stale, push when rebuilt, changed since the last push, or the last push is older
 * than REPUSH_MS. target null: rebuild only. Returns { rebuilt, pushed, error? }. `run(cmd, args)` is injectable for tests.
 */
export async function syncWindowFile(home, { target = 'lechonk', log = () => {}, run = (cmd, args) => execFileP(cmd, args, { timeout: 60_000 }), now = Date.now() } = {}) {
  let rebuilt = false;
  try { rebuilt = refreshWindowFileIfStale(home); } catch (err) { log(`secret-windows rebuild failed: ${err.message}`); }
  if (rebuilt) log('secret-windows.json rebuilt from the secret stores');
  if (!target) return { rebuilt, pushed: false };
  const wf = windowFile(home);
  let buf;
  try { buf = fs.readFileSync(wf); } catch { return { rebuilt, pushed: false }; }
  const hash = sha(buf);
  let marker = {};
  try { marker = JSON.parse(fs.readFileSync(markerOf(wf), 'utf8')); } catch { /* never pushed */ }
  if (!rebuilt && marker.sha === hash && now - (marker.at ?? 0) < REPUSH_MS) return { rebuilt, pushed: false };
  const remote = `${REMOTE_DIR}/secret-windows.json`;
  try {
    await run('ssh', [...SSH_OPTS, target, `umask 077 && mkdir -p ${REMOTE_DIR}`]);
    await run('scp', ['-q', ...SSH_OPTS, wf, `${target}:${remote}.tmp`]);
    await run('ssh', [...SSH_OPTS, target, `chmod 600 ${remote}.tmp && mv -f ${remote}.tmp ${remote}`]);
  } catch (err) {
    const msg = String(err?.stderr || err?.message || err).split('\n')[0].slice(0, 160);
    log(`secret-windows push to ${target} failed (retry in ${PUSH_EVERY_MS / 60_000} min): ${msg}`);
    return { rebuilt, pushed: false, error: msg };
  }
  fs.writeFileSync(markerOf(wf), JSON.stringify({ sha: hash, at: now, target }), { mode: 0o600 });
  log(`secret-windows.json pushed to ${target}`);
  return { rebuilt, pushed: true };
}

/** LeChonk: a warning line when the hash file is missing or older than STALE_MS; null when it is fresh. */
export function windowFileAgeWarning(home, now = Date.now()) {
  let st;
  try { st = fs.statSync(windowFile(home)); } catch { return 'secret-windows.json missing: Sandy secret fragments are not guarded on this host'; }
  const age = now - st.mtimeMs;
  if (age <= STALE_MS) return null;
  return `secret-windows.json is ${Math.round(age / 3600_000)} h old (> 24 h): the Sandy bridge push may be failing`;
}
