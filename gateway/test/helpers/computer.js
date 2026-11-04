// Fakes for the computer-run tests (item F): the app, the voice session and the loop model. No real provider, no network.
import { createComputer, validateResult } from '../../src/computer/run.js';

/** The app: `h.app(wire)` returns the body it would POST (validated like the route does), or null for "no answer". */
export function fakeVision() {
  const sent = [], cmds = new Map();
  const v = {
    sent, ready: true, device: 'dev1', app: () => ({ ok: true, code: 'done' }), autoAnswerStart: true,
    computerReady: () => v.ready,
    computerDevice: () => v.device,
    computerCommand: (sid, id) => cmds.get(id),
    computerSend: async (sid, wire, opts = {}) => {
      sent.push(wire);
      if (opts.fire) return { ok: true, code: 'sent' };
      const cmd = { late: null };
      cmds.set(wire.id, cmd);
      const body = await v.app(wire);
      if (body === null) return { ok: false, code: 'unclear', note: 'timeout' };
      const clean = validateResult(body);
      cmd.settled = true;
      return clean;
    },
    ofOp: (op) => sent.filter((w) => w.op === op),
  };
  return v;
}

/** What web/src/lib/clientInfo.ts really sends in the voice start message, as seen in trace a#4d63c3. */
export const SCREEN_AGENT = { app: 'screen-agent', version: '0.1.8', commit: '3add1fe11b26', device: 'windows' };

export function fakeSession(extra = {}) {
  const s = { client: SCREEN_AGENT, said: [], events: [], activities: [], say: (t) => { s.said.push(t); return true; }, trace: (type, data) => s.events.push({ type, ...data }), activity: (a) => s.activities.push(a), ...extra };
  return s;
}

/** A scripted loop model: each entry is a tool call {name, args} (or a function of the messages that returns one). Records every messages array it was given. */
export function scriptedModel(script, { costUsd = 0.01 } = {}) {
  const calls = [];
  let i = 0;
  const complete = async ({ messages, model }) => {
    calls.push({ model, messages: structuredClone(messages) });
    const step = typeof script[i] === 'function' ? script[i](messages) : script[i];
    i += 1;
    if (!step) return { message: { content: '', tool_calls: [] }, usage: { in: 10, out: 5 }, costUsd, ms: 5 };
    return { message: { content: '', tool_calls: [{ id: `t${i}`, name: step.name, args: JSON.stringify(step.args ?? {}) }] }, usage: { in: 100, out: 20 }, costUsd, ms: 5 };
  };
  complete.calls = calls;
  return complete;
}

export function setup({ script = [], app, tickMs = 1e9, start = 1_000_000, read, costUsd } = {}) {
  const clock = { t: start, now: () => clock.t };
  const vision = fakeVision();
  if (app) vision.app = app;
  const model = scriptedModel(script, { costUsd });
  const session = fakeSession();
  const audits = [];
  const hub = { call: async () => ({ text: 'ok' }) };
  const computer = createComputer({ vision, hub, now: clock.now, complete: model, tickMs, audit: (e) => audits.push(e), ...(read ? { read } : {}), limits: { check: () => ({ ok: true }), addCost() {} } });
  const detach = computer.attach('s1', session);
  return { clock, vision, model, session, computer, detach, audits, hub };
}

export const flush = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
export async function until(cond, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
}
