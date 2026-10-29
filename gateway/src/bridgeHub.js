import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { TEXT } from './messages.js';

const PING_MS = 20_000;
const DEAD_AFTER_MS = 60_000;

/** Bridge hosts the gateway accepts at upgrade (docs/UPGRADES-1028.md §4). */
export const BRIDGE_HOST = /^(lechonk|sandy)$/;

// Preferred hosts per method, first connected one wins (docs/UPGRADES-1028.md §4 ROUTE). Exact names before prefixes.
// chats.search is fanned out to every host by the tools (callAll); here it only needs a single-host fallback.
export const ROUTE = {
  'ctx.knowledge': ['lechonk', 'sandy'],
  'discord.*': ['sandy'],
  'mail.*': ['sandy'],
  'ops.*': ['sandy'],
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
const METHOD_TIMEOUT_MS = { 'discord.list': 90_000, 'discord.read': 90_000, 'mail.search': 45_000, 'mail.read': 45_000, 'ops.run': 35_000 };
export const methodTimeout = (method) => METHOD_TIMEOUT_MS[method] ?? 30_000;

export class BridgeHub extends EventEmitter {
  constructor() {
    super();
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
    this.emit('bridge-up', host);
  }

  #onMessage(conn, msg) {
    switch (msg.t) {
      case 'hello':
        conn.caps = Array.isArray(msg.caps) ? msg.caps : [];
        conn.claude = msg.claude || conn.claude;
        this.#seedSessions(conn);
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

  /** The hello only carries a count; the session list tells which sessions that count is made of. */
  #seedSessions(conn) {
    this.call('claude.list', {}, { host: conn.host, timeoutMs: 10_000 })
      .then((result) => { for (const session of result?.sessions ?? []) trackSession(conn, session); })
      .catch(() => {});
  }

  /** The host a call without explicit host goes to: the first connected host of the route that announced the method. */
  pick(method) {
    const hosts = routeOf(method);
    const live = hosts.filter((h) => this.isConnected(h));
    const capable = live.filter((h) => {
      const caps = this.conns.get(h)?.caps ?? [];
      return !caps.length || caps.includes(method);
    });
    return capable[0] ?? live[0] ?? hosts[0];
  }

  /** Connected hosts of the route for `method` that announced it (for fan-out calls such as chats.search). */
  hostsFor(method) {
    return routeOf(method).filter((h) => this.isConnected(h) && (!(this.conns.get(h)?.caps ?? []).length || this.conns.get(h).caps.includes(method)));
  }

  /** Same call on every given host; resolves [{host, ok, result|error}] in host order, never rejects. */
  callAll(method, params = {}, { hosts = this.hostsFor(method), timeoutMs = methodTimeout(method) } = {}) {
    return Promise.all(hosts.map((host) => this.call(method, params, { host, timeoutMs })
      .then((result) => ({ host, ok: true, result }), (err) => ({ host, ok: false, error: String(err?.message ?? err) }))));
  }

  call(method, params = {}, { host, timeoutMs = methodTimeout(method) } = {}) {
    host ??= this.pick(method);
    const conn = this.conns.get(host);
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
    return [...this.conns.values()].map(({ host, since, caps, claude }) => ({ host, connected: true, since, caps, claude }));
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
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
