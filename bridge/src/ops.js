// ops.run: a FIXED allowlist of read-only commands (id -> argv). No free-form argv, no shell, 20 s timeout, output redacted.
// Every entry was checked to be read-only on Sandy (28 Oct 2026): `agent-board inbox` and `read` mark entries read and are
// deliberately NOT here; `threads` only lists.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { redact } from './redact.js';

const MAX_OUT = 8 * 1024;
const TIMEOUT_MS = 20_000;
const home = () => process.env.BRIDGE_HOME || os.homedir();
const bin = (name) => process.env[`BRIDGE_OPS_BIN_${name.toUpperCase().replace(/-/g, '_')}`] || path.join(home(), 'bin', name);

/** id -> [executable, ...argv]; resolved lazily so tests can point the binaries at stubs. */
export const COMMANDS = {
  quota_status: () => [bin('quota-pace'), 'status'],
  asks_open: () => [bin('ask'), 'list'],
  board_threads: () => [bin('agent-board'), 'threads'],
  sched_list: () => [bin('sched'), 'list'],
  disk: () => ['/bin/df', '-h', '/'],
  jobs_running: () => ['/usr/bin/systemctl', '--user', 'list-units', 'job-*', '--no-legend'],
};

/** Pure argv builder (tested): refuses everything outside the map. */
export function buildArgv(command) {
  if (typeof command !== 'string' || !Object.hasOwn(COMMANDS, command)) {
    throw new Error(`unknown command; allowed: ${Object.keys(COMMANDS).join(', ')}`);
  }
  return COMMANDS[command]();
}

export async function run({ command } = {}) {
  const [file, ...args] = buildArgv(command);
  // Minimal environment: no tokens of the bridge process reach the command.
  const env = { PATH: `${path.join(home(), 'bin')}:/usr/local/bin:/usr/bin:/bin`, HOME: home(), AGENT_BOARD_NAME: 'desk:bridge', LANG: 'C.UTF-8' };
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = redact(String(stdout || (err ? stderr : '')));
      if (err && !stdout) return reject(new Error(redact(`${command} failed: ${(stderr || err.message).slice(0, 200)}`)));
      resolve({ command, text: text.slice(0, MAX_OUT), truncated: text.length > MAX_OUT });
    });
  });
}
