import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { TEXT } from './messages.js';

const PING_MS = 20_000;
const DEAD_AFTER_MS = 60_000;
const DRAIN_WAIT_MS = 120_000;
const RESTART_WINDOW_MS = 60_000;
const IDLE_GRACE_MS = 1000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const validId = (value) => typeof value === 'string' && UUID.test(value);

/** Bridge hosts the gateway accepts at upgrade (docs/UPGRADES-1028.md §4). */
export const BRIDGE_HOST = /^(lechonk|sandy)$/;

// Preferred hosts per method, first connected one wins (docs/UPGRADES-1028.md §4 ROUTE). Exact names before prefixes.
// chats.search is fanned out to every host by the tools (callAll); here it only needs a single-host fallback.
export const ROUTE = {
  'notify.cardLink': ['sandy'],
  'notify.cardRead': ['sandy'],
  'notify.cardVoiceSummary': ['sandy'],
  'notify.cardStartup': ['sandy'],
  'notify.cardSummaries': ['sandy'],
  'notify.cardsRecent': ['sandy'],
  'board.recent': ['sandy'],
  'state.current': ['sandy'],
  'ctx.knowledge': ['lechonk', 'sandy'],
  'discord.*': ['sandy'],
  'mail.*': ['sandy'],
  'ops.*': ['sandy'],
  'job.*': ['sandy'],
  'sandbox.*': ['sandy'], // the research shell (bubblewrap) runs on Sandy only (CoS deputy decision #62544)
  'board.*': ['sandy', 'lechonk'],
  'ctx.*': ['sandy', 'lechonk'],
  'jobs.*': ['sandy', 'lechonk'],
  'chats.*': ['sandy', 'lechonk'],
  'skills.*': ['sandy', 'lechonk'],
  'claude.*': ['lechonk'],
  'ledger.*': ['lechonk', 'sandy'],
  'code.*': ['lechonk', 'sandy'],
};
// Methods outside the table (notify.loginLink, audit.append, ...) keep the pre-1028 behaviour: LeChonk only.
const DEFAULT_ROUTE = ['lechonk'];

/** The preference list of hosts for one method. */
export function routeOf(method) {
  const name = String(method);
  return ROUTE[name] ?? ROUTE[`${name.split('.')[0]}.*`] ?? DEFAULT_ROUTE;
}

/** Request/response + pub/sub multiplexer over the bridge WebSockets (one connection per host). */
// Slow bridge methods (bridge/src/bridge.js METHOD_TIMEOUT_MS + a margin): Discord drives the home Chrome, mail logs in over IMAP.
const METHOD_TIMEOUT_MS = { 'discord.list': 90_000, 'discord.read': 90_000, 'mail.search': 45_000, 'mail.read': 45_000, 'ops.run': 35_000, 'job.start': 70_000, 'audio.finish': 125_000, 'sandbox.exec': 40_000 }; // sandbox.exec: the Sandy bridge allows itself 35 s (queue 8 s + 20 s run + grace) // job.start: the bridge allows itself 60 s
export const methodTimeout = (method) => METHOD_TIMEOUT_MS[method] ?? 30_000;

export class BridgeHub extends EventEmitter {
  constructor({ clientsBusy = () => false } = {}) {
    super();
    this.clientsBusy = clientsBusy;
    this.drain = null;
    this.conns = new Map(); // host -> {ws, since, caps, claude, lastSeen, pending: Map}
    this.subs = new Map(); // topic -> Set<fn>
  }

  attach(ws, host) {
    this.conns.get(host)?.ws.close(1000, 'replaced');
    const conn = { ws, host, since: new Date().toISOString(), caps: [], claude: { running: 0, max: 0 }, lastSeen: Date.now(), pending: new Map(), sessions: new Map() };
    this.conns.set(host, conn);

    const timer = setInterval(() => {
      if (Date.now() - conn.lastSeen > DEAD_AFTER_MS) return ws.terminate();
      send(ws, { t: 'ping' });
    }, PING_MS);

    ws.on('message', (data) => {
      conn.lastSeen = Date.now();
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.#onMessage(conn, msg);
    });
    ws.on('close', () => {
      clearInterval(timer);
      if (this.conns.get(host) === conn) this.conns.delete(host);
      for (const { reject, timeout } of conn.pending.values()) {
        clearTimeout(timeout);
        reject(new Error(TEXT.bridgeLost(host)));
      }
      conn.pending.clear();
    });
    ws.on('error', () => ws.terminate());
    conn.deferUp = !this.#canRoute(host);
    if (!conn.deferUp) this.emit('bridge-up', host);
  }

  #onMessage(conn, msg) {
    switch (msg.t) {
      case 'hello':
        if (this.conns.get(conn.host) !== conn) break;
        conn.caps = Array.isArray(msg.caps) ? msg.caps : [];
        conn.boot = validId(msg.boot) ? msg.boot : null;
        conn.claude = msg.claude || conn.claude;
        conn.helloReceived = true;
        if (conn.host === 'lechonk' && this.drain?.phase === 'ready' && conn.boot && this.drain.boot !== conn.boot) this.#endDrain();
        this.#finishHello(conn);
        break;
      case 'drain-request':
        if (conn.host === 'lechonk' && conn.boot && validId(msg.request) && this.conns.get(conn.host) === conn) this.#beginDrain(conn, msg.request);
        break;
      case 'drain-ready': {
        const drain = this.drain;
        if (this.conns.get('lechonk') !== conn || drain?.conn !== conn || drain.phase !== 'frozen' ||
            msg.id !== drain.id || conn.pending.size || Date.now() >= drain.deadline) break;
        drain.phase = 'ready';
        drain.deadline = Date.now() + RESTART_WINDOW_MS;
        send(conn.ws, { t: 'drain-granted', id: msg.id, deadline: drain.deadline, ttlMs: RESTART_WINDOW_MS });
        break;
      }
      case 'drain-cancel':
        if (this.conns.get('lechonk') === conn && this.drain?.boot === conn.boot && this.drain.request === msg.request) this.#endDrain();
        break;
      case 'ping':
        send(conn.ws, { t: 'pong' });
        break;
      case 'res': {
        const entry = conn.pending.get(msg.id);
        if (!entry) break;
        conn.pending.delete(msg.id);
        clearTimeout(entry.timeout);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(String(msg.error || 'bridge error')));
        break;
      }
      case 'evt':
        if (msg.topic === 'claude:list') trackSession(conn, msg.data);
        if (typeof msg.topic === 'string') for (const fn of this.subs.get(msg.topic) || []) fn(msg.data);
        this.emit('evt', { host: conn.host, topic: msg.topic, data: msg.data }); // for gateway-wide listeners (canvas blocks of Claude sessions)
        break;
      default:
    }
  }

  get maintenance() {
    return this.drain?.phase ?? null;
  }

  get maintenanceFenced() {
    return this.drain?.phase === 'frozen' || this.drain?.phase === 'ready';
  }

  get maintenanceDeadline() {
    return this.drain?.deadline ?? null;
  }

  #endDrain() {
    const { conn, timer, request } = this.drain;
    this.drain = null;
    clearInterval(timer);
    send(conn.ws, { t: 'drain-cancelled', request });
    const current = this.conns.get('lechonk');
    if (current) this.#finishHello(current);
  }

  #finishHello(conn) {
    if (!conn.helloReceived || conn.initialized || !this.#canRoute(conn.host)) return;
    conn.initialized = true;
    this.#seedSessions(conn);
    if (conn.deferUp) this.emit('bridge-up', conn.host);
  }

  #beginDrain(conn, request) {
    // A reconnect of the draining process needs a new barrier. Its old approval cannot be reused.
    if (this.drain?.conn === conn && this.drain.request === request) return;
    if (this.drain) this.#endDrain();
    const drain = { conn, request, boot: conn.boot, id: crypto.randomUUID(), phase: 'waiting', deadline: Date.now() + DRAIN_WAIT_MS };
    this.drain = drain;
    drain.timer = setInterval(() => {
      if (Date.now() >= drain.deadline || (drain.phase !== 'ready' && this.conns.get('lechonk') !== conn)) return this.#endDrain();
      if (drain.phase !== 'waiting') return;
      if (this.clientsBusy() || conn.claude.running) {
        drain.idleSince = null;
        return;
      }
      drain.idleSince ??= Date.now();
      if (Date.now() - drain.idleSince < IDLE_GRACE_MS) return;
      drain.phase = 'frozen';
      send(conn.ws, { t: 'drain-check', id: drain.id, request });
    }, 250);
    drain.timer.unref();
  }

  #canRoute(host) {
    return this.isConnected(host) && (host !== 'lechonk' || !this.maintenanceFenced);
  }

  /** The hello only carries a count; the session list tells which sessions that count is made of. */
  #seedSessions(conn) {
    this.call('claude.list', {}, { host: conn.host, timeoutMs: 10_000 })
      .then((result) => { for (const session of result?.sessions ?? []) trackSession(conn, session); })
      .catch(() => /* ignored */ {});
  }

  /** The host a call without explicit host goes to: the first connected host of the route that announced the method. */
  pick(method) {
    const hosts = routeOf(method);
    const live = hosts.filter((h) => this.#canRoute(h));
    if (hosts[0] === 'lechonk' && this.maintenanceFenced) {
      // Maintenance may route to an existing alternative only if it explicitly serves this method.
      return live.find((host) => this.conns.get(host).caps.includes(method)) ?? 'lechonk';
    }
    const capable = live.filter((h) => {
      const caps = this.conns.get(h)?.caps ?? [];
      return !caps.length || caps.includes(method);
    });
    return capable[0] ?? live[0] ?? hosts[0];
  }

  /** Connected hosts of the route for `method` that announced it (for fan-out calls such as chats.search). */
  hostsFor(method) {
    return routeOf(method).filter((h) => this.#canRoute(h) && (!(this.conns.get(h)?.caps ?? []).length || this.conns.get(h).caps.includes(method)));
  }

  /** Same call on every given host; resolves [{host, ok, result|error}] in host order, never rejects. */
  callAll(method, params = {}, { hosts = this.hostsFor(method), timeoutMs = methodTimeout(method) } = {}) {
    return Promise.all(hosts.map((host) => this.call(method, params, { host, timeoutMs })
      .then((result) => ({ host, ok: true, result }), (err) => ({ host, ok: false, error: String(err?.message ?? err) }))));
  }

  call(method, params = {}, { host, timeoutMs = methodTimeout(method) } = {}) {
    host ??= this.pick(method);
    const conn = this.conns.get(host);
    if (host === 'lechonk' && this.maintenanceFenced) {
      return Promise.reject(Object.assign(new Error(TEXT.bridgeMaintenance), { code: 'BRIDGE_MAINTENANCE', status: 503, retryAfter: 5 }));
    }
    if (!conn || conn.ws.readyState !== 1) return Promise.reject(new Error(TEXT.bridgeOffline(host)));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(TEXT.bridgeSlow));
      }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timeout });
      send(conn.ws, { t: 'req', id, method, params });
    });
  }

  subscribe(topic, fn) {
    if (!this.subs.has(topic)) this.subs.set(topic, new Set());
    this.subs.get(topic).add(fn);
    return () => {
      const set = this.subs.get(topic);
      set?.delete(fn);
      if (set && !set.size) this.subs.delete(topic);
    };
  }

  isConnected(host = 'lechonk') {
    return this.conns.get(host)?.ws.readyState === 1;
  }

  status() {
    return [...this.conns.values()].map(({ host, since, caps, claude, boot }) => ({ host, connected: true, since, caps, claude, ...(host === 'lechonk' && boot ? { maintenanceSupported: true, instance: boot.slice(0, 13) } : {}) }));
  }

  /** status() plus an offline row for every known bridge host that is not connected (/api/status shows both). */
  statusAll() {
    const live = this.status();
    return [...live, ...['lechonk', 'sandy'].filter((h) => !live.some((b) => b.host === h)).map((host) => ({ host, connected: false, caps: [] }))];
  }
}

const BUSY = new Set(['starting', 'running']);

/** Keeps claude.running live from claude:list events ({sid, state, ...} per state change). */
function trackSession(conn, session) {
  if (typeof session?.sid !== 'string') return;
  conn.sessions.set(session.sid, BUSY.has(session.state));
  conn.claude = { ...conn.claude, running: [...conn.sessions.values()].filter(Boolean).length };
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}
