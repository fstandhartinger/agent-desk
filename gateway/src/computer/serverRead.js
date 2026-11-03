// server_read for the computer loop (item F): FIXED read verbs through the existing bridge methods, R0, nothing writes. The answer is data.
// Job names pass the same deny list as the bridge (sealed, wallet, reaxsign, secrets...) before any call, so a refusal never depends on the bridge alone.
import { redact } from '../redact.js';

const HOSTS = ['sandy', 'lechonk'];
const NAME = /^(?!.*\.\.)[A-Za-z0-9][\w.-]{0,119}$/;
const DENIED = /^(?:\.git|\.ssh|\.gnupg|\.env.*|\.?secrets?|\.?credentials?|\.?tokens?|\.notify)$|sealed|wallet|reaxsign|coldkey|mnemonic|seed[-_ ]?phrase|private[-_]?key/i;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,99}\.(?:service|timer)$/;
const MAX = 6000;

export const SERVER_OPS = ['job_status', 'list_jobs', 'job_file', 'board_threads', 'board_read', 'board_search', 'board_recent', 'quota', 'disk', 'load', 'units', 'running_jobs', 'journal'];
export const isDeniedName = (name) => DENIED.test(String(name ?? ''));

const fail = (reason) => Object.assign(new Error(reason), { refusal: true });
function jobName(v) {
  if (typeof v !== 'string' || !NAME.test(v)) throw fail('ungültiger Jobname');
  if (isDeniedName(v)) throw fail('path not allowed or not found');
  return v;
}
const int = (v, lo, hi, d) => (v === undefined ? d : Number.isInteger(v) && v >= lo && v <= hi ? v : (() => { throw fail('ungültige Zahl'); })());
const str = (v, max = 200) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : (() => { throw fail('ungültiger Text'); })());
const OPS_ID = { quota: 'quota_status', disk: 'disk', load: 'load', units: 'units', running_jobs: 'jobs_running' };

const text = (r) => (typeof r === 'string' ? r : typeof r?.text === 'string' ? r.text : JSON.stringify(r));

/** {ok, text, host} | {ok:false, text}; never throws. `args.host` is sandy or lechonk (ops default to sandy). */
export async function serverRead(args, hub) {
  try {
    if (!args || typeof args !== 'object') throw fail('Argumente fehlen');
    const { op } = args;
    if (!SERVER_OPS.includes(op)) throw fail(`unbekannte Operation; erlaubt: ${SERVER_OPS.join(', ')}`);
    if (args.host !== undefined && !HOSTS.includes(args.host)) throw fail('host ist sandy oder lechonk');
    if (!hub?.call) throw fail('keine Verbindung zur Werkstatt');
    let method, params, host = args.host;
    if (op === 'job_status') [method, params] = ['jobs.get', { name: jobName(args.name) }];
    else if (op === 'list_jobs') [method, params] = ['jobs.list', { filter: args.filter === undefined ? undefined : str(args.filter, 60), activeOnly: args.activeOnly === true ? true : undefined, limit: int(args.limit, 1, 40, 15) }];
    else if (op === 'job_file') {
      if (!['STATE', 'RESULT'].includes(args.file)) throw fail('file ist STATE oder RESULT');
      [method, params] = ['ctx.read', { path: `/home/flori/jobs/${jobName(args.name)}/${args.file}.md`, limit: 200 }];
    } else if (op === 'board_threads') [method, params, host] = ['board.threads', {}, host ?? 'sandy'];
    else if (op === 'board_read') [method, params, host] = ['board.read', { thread: str(args.thread, 80), limit: int(args.limit, 1, 40, 15) }, host ?? 'sandy'];
    else if (op === 'board_search') [method, params, host] = ['board.search', { query: str(args.query, 120) }, host ?? 'sandy'];
    else if (op === 'board_recent') [method, params, host] = ['board.recent', { hours: int(args.hours, 1, 48, 6), limit: int(args.limit, 1, 40, 20) }, 'sandy'];
    else if (OPS_ID[op]) [method, params, host] = ['ops.run', { command: OPS_ID[op] }, host ?? 'sandy'];
    else {
      const unit = args.unit === undefined ? undefined : str(args.unit, 100);
      if (unit !== undefined && (!UNIT.test(unit) || isDeniedName(unit))) throw fail('unit muss ein einfacher Name mit .service oder .timer sein');
      if ((unit === undefined) === (args.job === undefined)) throw fail('genau eines von unit oder job');
      [method, params] = ['journal.tail', { ...(unit ? { unit } : { job: jobName(args.job) }), lines: int(args.lines, 1, 200, 100) }];
    }
    const result = await hub.call(method, params, host ? { host } : undefined);
    return { ok: true, host: host ?? hub.pick?.(method) ?? 'bridge', text: redact(text(result)).slice(0, MAX) };
  } catch (err) {
    return { ok: false, text: redact(`ERROR: ${err.refusal ? err.message : `nicht verfügbar (${String(err?.message ?? err).slice(0, 100)})`}`) };
  }
}
