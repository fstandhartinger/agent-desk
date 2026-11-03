// journal.tail: the last lines of ONE named user unit or job unit (voice computer runs, read-only). The unit pattern is anchored with no globs,
// argv is fixed (`--unit=<name>`, `--` last), at most 200 lines, output redacted. A job name that the deny list covers (sealed, wallet, ...) is refused.
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';
import { isDenied } from './paths.js';

const MAX_LINES = 200;
const MAX_OUT = 16 * 1024;
const TIMEOUT_MS = 15_000;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,99}\.(?:service|timer)$/;
const JOB = /^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,119}$/;
const home = () => process.env.BRIDGE_HOME || os.homedir();
const bin = () => process.env.BRIDGE_JOURNALCTL || '/usr/bin/journalctl';

/** Pure argv builder (tested): {unit} or {job}, never both, never a glob. */
export function buildArgv({ unit, job, lines } = {}) {
  if ((unit === undefined) === (job === undefined)) throw new Error('give exactly one of unit or job');
  const name = unit !== undefined ? unit : `job-${job}.service`;
  if (unit !== undefined && (typeof unit !== 'string' || !UNIT.test(unit))) throw new Error('unit must be a plain name ending in .service or .timer');
  if (job !== undefined && (typeof job !== 'string' || !JOB.test(job))) throw new Error('invalid job name');
  if (isDenied(name) || isDenied(job ?? '')) throw new Error('path not allowed or not found');
  const n = lines === undefined ? 100 : lines;
  if (!Number.isInteger(n) || n < 1) throw new Error('lines must be a positive integer');
  return [bin(), '--user', '--no-pager', '-o', 'short-iso', '-n', String(Math.min(n, MAX_LINES)), `--unit=${name}`, '--'];
}

export async function tail(params = {}) {
  const [file, ...args] = buildArgv(params);
  const env = { PATH: `${path.join(home(), 'bin')}:/usr/local/bin:/usr/bin:/bin`, HOME: home(), LANG: 'C.UTF-8' };
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = redact(String(stdout || (err ? stderr : '')));
      if (err && !stdout) return reject(new Error(redact(`journal failed: ${(stderr || err.message).slice(0, 200)}`)));
      resolve({ unit: args.find((a) => a.startsWith('--unit='))?.slice(7), text: text.slice(-MAX_OUT), truncated: text.length > MAX_OUT });
    });
  });
}
