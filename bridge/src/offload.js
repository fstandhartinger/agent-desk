// Untrusted-text work off the event loop, with a hard time budget (critic round 7, P1-1 / P2-1). This file exists twice,
// byte-identical: gateway/src/offload.js and bridge/src/offload.js (each with offloadWorker.js next to it);
// gateway/test/redact-sync.test.js fails when the copies differ.
//
// createPool(): async. run(module, fn, args, budgetMs) runs `fn` of `module` in a worker thread; when it takes longer than
//   the budget the worker is terminated (that stops any regex) and the promise rejects with code 'budget'.
// createSyncRunner(): the same for callers that must stay synchronous (redact() has ~70 call sites). The main thread blocks
//   in Atomics.wait for at most the budget, then the worker is terminated. Small inputs never come here (fast path).
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

const WORKER = new URL('./offloadWorker.js', import.meta.url);
const budgetError = (ms) => Object.assign(new Error(`offload budget of ${ms} ms exceeded`), { code: 'budget' });

export function createPool({ size = 2, preload = [], maxQueue = 64 } = {}) {
  const idle = [];
  const queue = [];
  let live = 0;
  let seq = 0;
  const spawn = () => {
    const w = new Worker(WORKER, { workerData: { preload } });
    live += 1;
    w.unref();
    w.on('error', () => {}); // a crash surfaces as 'exit' below
    w.on('exit', () => { live -= 1; w.dead = true; const job = w.job; w.job = null; if (job) job.fail(new Error('offload worker exited')); pump(); });
    w.on('message', (msg) => {
      const job = w.job;
      if (!job || msg.id !== job.id) return;
      w.job = null;
      if (msg.error !== undefined) job.fail(new Error(msg.error)); else job.done(msg.result);
      w.unref();
      idle.push(w);
      pump();
    });
    return w;
  };
  function start(w, job) {
    w.job = job;
    w.ref();
    job.timer = setTimeout(() => { if (w.job === job) { w.job = null; job.fail(budgetError(job.budgetMs)); w.terminate(); } }, job.budgetMs);
    w.postMessage({ id: job.id, mod: job.mod, fn: job.fn, args: job.args });
  }
  function pump() {
    while (queue.length) {
      let w = idle.pop();
      while (w?.dead) w = idle.pop();
      if (!w && live < size) w = spawn();
      if (!w) return;
      start(w, queue.shift());
    }
  }
  return {
    run(mod, fn, args, budgetMs = 1500) {
      if (queue.length >= maxQueue) return Promise.reject(Object.assign(new Error('offload queue full'), { code: 'busy' }));
      return new Promise((resolve, reject) => {
        const job = { id: ++seq, mod: String(mod), fn, args, budgetMs };
        job.done = (v) => { clearTimeout(job.timer); resolve(v); };
        job.fail = (e) => { clearTimeout(job.timer); reject(e); };
        queue.push(job);
        pump();
      });
    },
    /** Terminates every worker (tests). */
    async close() { await Promise.all(idle.splice(0).map((w) => w.terminate())); },
  };
}

export function createSyncRunner({ preload = [], startupMs = 10_000 } = {}) {
  let w = null;
  let port = null;
  let flag = null;
  let seq = 0;
  const kill = () => { w?.terminate(); port?.close(); w = null; port = null; };
  const wait = (ms) => Atomics.wait(flag, 0, 0, ms) !== 'timed-out';
  function start() {
    flag = new Int32Array(new SharedArrayBuffer(4));
    const channel = new MessageChannel();
    w = new Worker(WORKER, { workerData: { preload, flag, port: channel.port2 }, transferList: [channel.port2] });
    w.unref();
    w.on('error', () => {});
    port = channel.port1;
    port.unref();
    // the worker loads its modules first and says "ready" (startup does not count against a task's budget)
    if (!wait(startupMs) || !receiveMessageOnPort(port)?.message?.ready) { kill(); return false; }
    return true;
  }
  return {
    /** Runs fn of mod with args; throws code 'budget' after budgetMs (the worker is then replaced on the next call). */
    run(mod, fn, args, budgetMs = 1500) {
      if (!w && !start()) throw budgetError(startupMs);
      const id = ++seq;
      Atomics.store(flag, 0, 0);
      port.postMessage({ id, mod: String(mod), fn, args });
      if (!wait(budgetMs)) { kill(); throw budgetError(budgetMs); }
      let msg;
      do msg = receiveMessageOnPort(port)?.message; while (msg && msg.id !== id);
      if (!msg) { kill(); throw new Error('offload worker gave no answer'); }
      if (msg.error !== undefined) throw new Error(msg.error);
      return msg.result;
    },
    close() { kill(); },
  };
}
