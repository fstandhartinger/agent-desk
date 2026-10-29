// Worker side of offload.js (byte-identical in gateway/src and bridge/src). Runs `fn` of a module of this package on the
// posted arguments. Pool mode answers on parentPort; sync mode answers on the transferred port and wakes the waiting main
// thread through the shared flag.
import { parentPort, workerData } from 'node:worker_threads';

const mods = new Map();
const load = (url) => {
  if (!mods.has(url)) mods.set(url, import(url));
  return mods.get(url);
};
const port = workerData.port ?? parentPort;
const flag = workerData.flag;
const answer = (msg) => {
  port.postMessage(msg);
  if (flag) { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }
};

try { await Promise.all((workerData.preload ?? []).map(load)); } catch { /* the task reports the import error */ }
if (flag) answer({ ready: true });
port.on('message', async ({ id, mod, fn, args }) => {
  try {
    const m = await load(mod);
    answer({ id, result: await m[fn](...args) });
  } catch (err) {
    answer({ id, error: String(err?.message ?? err) });
  }
});
