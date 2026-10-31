import http from 'node:http';
import { createArtifactService, artifactInstructions } from './artifacts.js';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { audit, setAuditSink } from './audit.js';
import { bridgeFailures, login, logout, originOk, readSession, requestLoginLink, safeEqual } from './auth.js';
import { BRIDGE_HOST, BridgeHub } from './bridgeHub.js';
import { ensureSimple, normalizeCanvas } from './canvas.js';
import { createCanvasBus } from './canvasBus.js';
import { createCanvasSession, createIllustrator } from './illustrator.js';
import { handleChat } from './chat.js';
import { handleClaudeApi } from './claudeApi.js';
import { cfg } from './config.js';
import { handleExplainer } from './explainer.js';
import { handleHandoff, handleHandoffDiscard } from './handoff.js';
import { handleClaudeProposal, handleClaudeProposalDiscard } from './claudeProposal.js';
import { attachKnowledge } from './knowledge.js';
import { clientIp, openSse, sendJson } from './http.js';
import { limits } from './limits.js';
import { TEXT } from './messages.js';
import { snapshot as providerSnapshot } from './providerHealth.js';
import { startProviderProbes } from './providerProbe.js';
import { short, warmRedact } from './redact.js';
import { warmWebRead } from './webRead.js';
import { serveStatic } from './static.js';
import { TOOL_DEFS, runTool } from './tools.js';
import { loadPageContext } from './page.js';
import { handleTranscribe } from './transcribe.js';
import { createActivityViz } from './viz.js';
import { handleVoiceUpgrade } from './voice/index.js';

const EXPLAINER_ROUTE = /^\/api\/explainer\/([^/]+)\/([^/]+|end-frames\/\d{3}\.png)$/;

function securityHeaders() {
  const wsOrigin = cfg.deskOrigin().replace(/^http/, 'ws');
  return {
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ${wsOrigin}; frame-src 'self'; frame-ancestors 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'`,
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
  };
}

/** SSE of the canvas bus: replay of the ring after Last-Event-ID (or ?since=), then live. */
function streamCanvas(req, res, url, bus) {
  let last = Number(req.headers['last-event-id'] ?? url.searchParams.get('since') ?? 0);
  if (!Number.isFinite(last) || last < 0) last = 0;
  const sse = openSse(res);
  const deliver = (event, seq) => {
    if (seq <= last) return;
    last = seq;
    sse.send(event, seq);
  };
  const unsubscribe = bus.subscribe(deliver);
  for (const { event, seq } of bus.replay(last)) deliver(event, seq);
  res.on('close', unsubscribe);
}

export function createApp() {
  const hub = new BridgeHub();
  const artifacts = createArtifactService();
  attachKnowledge(hub);
  setAuditSink((line) => hub.call('audit.append', line).catch(() => {}));
  const canvasBus = createCanvasBus();
  const illustrator = createIllustrator({ bus: canvasBus, hub });
  // A Claude Code session drew something (```desk-canvas block -> bridge event {kind:"canvas", spec}): validate and publish.
  hub.on('evt', ({ topic, data }) => {
    if (typeof topic !== 'string' || !topic.startsWith('claude:') || data?.kind !== 'canvas') return;
    const result = normalizeCanvas(data.spec);
    if (!result.ok) return audit({ action: 'canvas.claude.invalid', actor: 'claude', detail: result.error });
    const { spec } = ensureSimple(result.spec); // upgrades 28 Oct (§5): simple by default, the full version as detail
    canvasBus.publish({ phase: 'ready', id: spec.id, kind: spec.kind, title: spec.title, spec, by: 'claude' }, { owner: topic }); // round 12: each Claude session owns its ids
    audit({ action: 'canvas.claude', actor: 'claude', detail: `${spec.id} ${spec.kind}` });
  });
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const bridgeWss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });

  async function route(req, res) {
    const url = new URL(req.url, 'http://desk.local');
    const { pathname } = url;
    const ip = clientIp(req);

    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, bridges: hub.status().map((b) => b.host) });
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    if (req.method === 'POST' && req.headers.origin && !originOk(req)) return sendJson(res, 403, { error: TEXT.badOrigin });
    if (pathname === '/api/auth/login' && req.method === 'POST') return login(req, res);
    if (pathname === '/api/auth/logout' && req.method === 'POST') return logout(req, res);
    if (pathname === '/api/auth/request-link' && req.method === 'POST') return requestLoginLink(req, res, { hub });

    const session = readSession(req);
    if (!session) return sendJson(res, 401, { error: TEXT.loginRequired });
    const { sid } = session;

    if (pathname === '/api/auth/me') return sendJson(res, 200, { ok: true, sid });
    if (await artifacts.route(req, res, url, sid)) return;
    if (pathname === '/api/status') {
      return sendJson(res, 200, { ok: true, bridges: hub.statusAll(), providers: providerSnapshot(), models: { text: cfg.textModel(), viz: cfg.vizModel() }, ...limits.snapshot() });
    }
    if (pathname === '/api/canvas' && req.method === 'GET') return sendJson(res, 200, { canvases: canvasBus.latest() });
    if (pathname === '/api/canvas/events' && req.method === 'GET') return streamCanvas(req, res, url, canvasBus);
    if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res, { sid, ip, hub, limits, canvasBus, illustrator, artifacts });
    if (pathname === '/api/handoff') return handleHandoff(req, res, { sid, ip, hub });
    if (pathname === '/api/handoff/discard') return handleHandoffDiscard(req, res, { sid, ip });
    if (pathname === '/api/claude/proposal/discard') return handleClaudeProposalDiscard(req, res, { sid, ip });
    if (pathname === '/api/claude/proposal') return handleClaudeProposal(req, res, { sid, ip, hub, limits });
    if (pathname === '/api/transcribe' && req.method === 'POST') return handleTranscribe(req, res, { sid, ip, limits });
    const explainer = EXPLAINER_ROUTE.exec(pathname);
    if (explainer) return handleExplainer(req, res, explainer[1], explainer[2]);
    if (await handleClaudeApi(req, res, url, { sid, ip, hub, limits })) return undefined;
    return sendJson(res, 404, { error: TEXT.notFound });
  }

  const server = http.createServer((req, res) => {
    for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value);
    route(req, res).catch((err) => {
      if (!err.status) console.error(`unhandled: ${short(err.stack || err.message, 500)}`);
      if (res.headersSent) return res.end();
      return sendJson(res, err.status || 500, { error: err.status ? short(err.message, 160) : TEXT.internal }, err.retryAfter ? { 'retry-after': String(err.retryAfter) } : {});
    });
  });

  const reject = (socket, status, text) => {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\n\r\n`);
    socket.destroy();
  };

  function upgradeBridge(req, socket, head, url) {
    const ip = clientIp(req);
    if (bridgeFailures.retryAfter(ip)) return reject(socket, 429, 'Too Many Requests');
    const given = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? '';
    if (!cfg.bridgeToken() || !safeEqual(given, cfg.bridgeToken())) {
      bridgeFailures.fail(ip);
      audit({ action: 'bridge.auth_fail', ip, actor: 'anonymous' });
      return reject(socket, 401, 'Unauthorized');
    }
    const host = url.searchParams.get('host') ?? 'lechonk';
    if (!BRIDGE_HOST.test(host)) return reject(socket, 400, 'Bad Request');
    bridgeWss.handleUpgrade(req, socket, head, (ws) => {
      hub.attach(ws, host);
      audit({ action: 'bridge.connect', detail: host, actor: 'bridge' });
    });
  }

  function upgradeVoice(req, socket, head) {
    const ip = clientIp(req);
    const session = readSession(req);
    if (!session || !originOk(req)) return reject(socket, 401, 'Unauthorized');
    const { sid } = session;
    const gate = limits.check(sid, 'voice');
    const spend = limits.check(sid, 'spend');
    if (!gate.ok || !spend.ok) return reject(socket, 429, 'Too Many Requests');
    const startedAt = Date.now();
    limits.voiceOpen(sid);
    socket.once('close', () => limits.voiceClose(sid, (Date.now() - startedAt) / 1000));
    handleVoiceUpgrade(req, socket, head, {
      wss: voiceWss,
      toolDefs: TOOL_DEFS,
      loadPage: loadPageContext,
      runTool,
      artifactInstructions: () => artifactInstructions(artifacts.get(sid)),
      registerText: (send) => artifacts.registerVoice(sid, send),
      makeCtx: (page) => ({ artifacts, hub, page, limits, sid, ip, maxChars: 2500, audit: (entry) => audit({ ip, ...entry }) }),
      limits,
      audit: (entry) => audit({ ip, ...entry }),
      createViz: (emit) => createActivityViz({ emit, model: cfg.vizModel() }),
      createCanvas: ({ emit, page, provider, onFacts, focusedId }) => createCanvasSession({ bus: canvasBus, illustrator, by: 'voice', provider, emit, page, onFacts, focusedId, ctx: { sid, ip, limits } }),
      sid,
      prewarm: true, // warm the bridge's ledger cache at session start (round 10)
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://desk.local');
    socket.on('error', () => socket.destroy());
    if (url.pathname === '/bridge') return upgradeBridge(req, socket, head, url);
    if (url.pathname === '/api/voice') return upgradeVoice(req, socket, head);
    return reject(socket, 404, 'Not Found');
  });

  return { server, hub, canvasBus, illustrator, artifacts };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const name of ['DESK_ACCESS_CODE', 'DESK_SESSION_SECRET', 'BRIDGE_TOKEN', 'OPENROUTER_API_KEY']) {
    if (!process.env[name]) console.warn(`warning: ${name} is not set`);
  }
  const { server } = createApp();
  startProviderProbes();
  warmRedact(); // critic r7: the redact / page workers start now, not on the first big tool result (~40-70 ms)
  warmWebRead();
  server.listen(cfg.port(), () => console.log(`agent-desk gateway listening on :${cfg.port()}`));
  process.on('unhandledRejection', (err) => console.error(`unhandledRejection: ${short(String(err?.stack || err), 500)}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
