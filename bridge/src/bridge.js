import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import * as ctx from './ctx.js';
import * as board from './board.js';
import * as jobs from './jobs.js';
import * as chats from './chats.js';
import * as skills from './skills.js';
import * as discord from './discord.js';
import * as mail from './mail.js';
import * as ops from './ops.js';
import * as audit from './audit.js';
import * as ledger from './ledger.js';
import { outline } from './outline.js';
import { loginLink } from './notify.js';
import { knowledge } from './knowledge.js';
import { startNotesMirror } from './notesMirror.js';
import { createClaude } from './claude.js';
import { redact, redactDeep, redactDeepAsync } from './redact.js';
import { secretValueCount, secretWindowCount, scanSecretSources, startSecretSourceScan } from './secretValues.js';
import { syncWindowFile, windowFileAgeWarning, PUSH_EVERY_MS } from './windowSync.js';
import { HOME } from './paths.js';

const VERSION = '1.0.0';
const PING_MS = 20_000;
const DEAD_AFTER_MS = 65_000;
const REQ_TIMEOUT_MS = 28_000;
const NO_CLAUDE = { start() {}, send() {}, stop() {}, list() {}, get() {}, restore() {}, shutdown() {}, running: () => 0, max: 0 };

const log = (msg) => console.log(`${new Date().toISOString()} bridge ${redact(String(msg))}`);

/** Hosts the bridge may run as (the gateway allowlists the same names). */
export const HOSTS = ['lechonk', 'sandy'];

// Per-method time budgets; everything else uses REQ_TIMEOUT_MS. The gateway must wait at least as long for these.
export const METHOD_TIMEOUT_MS = {
  'discord.list': 85_000,
  'discord.read': 85_000,
  'mail.search': 40_000,
  'mail.read': 40_000,
  'ops.run': 30_000,
};

/**
 * Methods per host. Shared read methods run everywhere; host-specific ones register only where their tools exist:
 * Claude Code sessions, the login-link notifier and the audit sink live on LeChonk; Discord (home-IP Chrome), mail,
 * the read-only ops commands and the board handoff live on Sandy. The Sandy bridge serves ONLY this allowlist.
 */
export function buildMethods(claude, host = 'lechonk') {
  const shared = {
    'ctx.core': ctx.core,
    'ctx.search': ctx.search,
    'ctx.read': ctx.read,
    'ctx.list': ctx.list,
    'ctx.decisionsToday': ctx.decisionsToday,
    'ctx.knowledge': knowledge,
    'jobs.list': jobs.list,
    'jobs.get': jobs.get,
    'board.threads': board.threads,
    'board.read': board.read,
    'board.search': board.search,
    'chats.search': chats.search,
    'chats.recent': chats.recent,
    'chats.read': chats.read,
    'skills.list': skills.list,
    'skills.read': skills.read,
    'ledger.entries': ledger.entries,
    'code.outline': outline,
  };
  if (host === 'sandy') {
    return {
      ...shared,
      'discord.list': discord.list,
      'discord.read': discord.read,
      'mail.search': mail.search,
      'mail.read': mail.read,
      'ops.run': ops.run,
      'board.handoff': board.handoff,
      'board.entry': board.entry,
    };
  }
  return {
    ...shared,
    'claude.start': claude.start,
    'claude.send': claude.send,
    'claude.stop': claude.stop,
    'claude.list': claude.list,
    'claude.get': claude.get,
    'notify.loginLink': loginLink,
    'audit.append': audit.append,
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('bridge method timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Dials the gateway, serves requests, reconnects forever. Returns {close()}. */
export function startBridge({ url, token, host = 'lechonk' }) {
  let ws = null;
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastSeen = 0;

  const send = (frame) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const sandy = host === 'sandy';
  // Claude session events leave the bridge too: same redactDeep as every method result.
  const claude = sandy ? NO_CLAUDE : createClaude({ emit: (topic, data) => send({ t: 'evt', topic, data: redactDeep(data) }) });
  claude.restore();
  const stopJobRefresh = jobs.startJobIndexRefresh();
  const stopNotesMirror = sandy ? () => {} : startNotesMirror({ log });
  const methods = buildMethods(claude, host);

  async function handleReq(frame) {
    const { id, method, params } = frame;
    const fn = methods[method];
    if (!fn) return send({ t: 'res', id, ok: false, error: `unknown method ${String(method).slice(0, 60)}` });
    try {
      const result = await withTimeout(Promise.resolve(fn(params ?? {})), METHOD_TIMEOUT_MS[method] ?? REQ_TIMEOUT_MS);
      send({ t: 'res', id, ok: true, result: await redactDeepAsync(result) });
    } catch (err) {
      send({ t: 'res', id, ok: false, error: redact(String(err?.message ?? err)).slice(0, 400) });
    }
  }

  function onMessage(raw) {
    lastSeen = Date.now();
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    if (frame.t === 'ping') send({ t: 'pong' });
    else if (frame.t === 'req' && frame.id !== undefined) handleReq(frame).catch((err) => log(`req handler failed: ${err.message}`));
  }

  function connect() {
    if (closed) return;
    const target = new URL(url);
    target.searchParams.set('host', host);
    ws = new WebSocket(target, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 10_000 });
    ws.on('open', () => {
      attempt = 0;
      lastSeen = Date.now();
      log(`connected to ${target.origin} (${secretValueCount()} secret values, ${secretWindowCount()} window hashes guarded)`);
      send({ t: 'hello', host, version: VERSION, caps: Object.keys(methods), claude: { running: claude.running(), max: claude.max } });
      pingTimer = setInterval(() => {
        if (Date.now() - lastSeen > DEAD_AFTER_MS) return ws.terminate();
        send({ t: 'ping' });
      }, PING_MS);
    });
    ws.on('message', onMessage);
    ws.on('error', (err) => log(`socket error: ${err.message}`));
    ws.on('close', () => {
      clearInterval(pingTimer);
      if (closed) return;
      const base = Math.min(30_000, 1000 * 2 ** attempt++);
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      log(`disconnected, retry in ${delay} ms`);
      retryTimer = setTimeout(connect, delay);
    });
  }

  connect();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      stopJobRefresh();
      stopNotesMirror();
      claude.shutdown();
      ws?.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DESK_URL, BRIDGE_TOKEN, BRIDGE_HOST } = process.env;
  if (!DESK_URL || !BRIDGE_TOKEN) {
    console.error('DESK_URL and BRIDGE_TOKEN are required');
    process.exit(2);
  }
  const host = BRIDGE_HOST || 'lechonk';
  if (!HOSTS.includes(host)) {
    console.error(`BRIDGE_HOST must be one of ${HOSTS.join(', ')}`);
    process.exit(2);
  }
  // Critic round 5, P0-1 (a): the secret stores are discovered by walking the home directory, now and every 30 min.
  const scan = scanSecretSources(HOME);
  log(`secret stores: ${scan.kinds.size} files found in ${scan.ms} ms (${secretValueCount()} values)`);
  startSecretSourceScan(HOME, { log });
  // Sandy owns the secret stores: rebuild the fragment hash file when one of them changed and push it to LeChonk
  // (BRIDGE_WINDOW_PUSH=<ssh alias>, default lechonk; "off" disables). LeChonk warns when its copy gets stale.
  if (host === 'sandy') {
    const target = process.env.BRIDGE_WINDOW_PUSH || 'lechonk';
    const tick = () => syncWindowFile(HOME, { target: target === 'off' ? null : target, log }).catch((err) => log(`secret-windows sync failed: ${err.message}`));
    tick();
    setInterval(tick, PUSH_EVERY_MS).unref();
  } else {
    const warn = () => { const w = windowFileAgeWarning(HOME); if (w) log(`WARNING ${w}`); };
    warn();
    setInterval(warn, 6 * 3600_000).unref();
  }
  const bridge = startBridge({ url: DESK_URL, token: BRIDGE_TOKEN, host });
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.message ?? err}`));
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err.message}`));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { bridge.close(); process.exit(0); });
}
