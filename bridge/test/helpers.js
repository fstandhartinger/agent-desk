import { WebSocketServer } from 'ws';

/** Minimal stand-in for the gateway's /bridge endpoint: collects frames and issues requests. */
export async function fakeGateway() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.on('listening', resolve));
  const gw = {
    url: `ws://127.0.0.1:${wss.address().port}/bridge`,
    hello: null,
    headers: null,
    events: [],
    ws: null,
    pending: new Map(),
    waiters: [],
    nextId: 1,
  };
  let onConnected;
  gw.connected = new Promise((resolve) => { onConnected = resolve; });
  wss.on('connection', (ws, req) => {
    gw.ws = ws;
    gw.headers = req.headers;
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.t === 'hello') { gw.hello = f; onConnected(); }
      else if (f.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
      else if (f.t === 'res') { gw.pending.get(f.id)?.(f); gw.pending.delete(f.id); }
      else if (f.t === 'evt') {
        gw.events.push(f);
        gw.waiters = gw.waiters.filter((w) => !w(f));
      }
    });
  });
  gw.call = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = gw.nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
    gw.pending.set(id, (res) => {
      clearTimeout(timer);
      if (res.ok) resolve(res.result); else reject(new Error(res.error));
    });
    gw.ws.send(JSON.stringify({ t: 'req', id, method, params }));
  });
  /** Resolves with the first (past or future) event frame matching the predicate. */
  gw.waitEvent = (pred, timeoutMs = 180_000) => new Promise((resolve, reject) => {
    const hit = gw.events.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error('timeout waiting for event')), timeoutMs);
    gw.waiters.push((f) => {
      if (!pred(f)) return false;
      clearTimeout(timer);
      resolve(f);
      return true;
    });
  });
  gw.close = () => new Promise((resolve) => { for (const c of wss.clients) c.terminate(); wss.close(resolve); });
  return gw;
}
