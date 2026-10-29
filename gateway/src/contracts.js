// Module contracts shared by the gateway slices (see docs/SPEC.md). Each slice implements its own file and must
// keep these exported signatures; the lead integrates. Do not change a signature without telling the lead.
//
// bridgeHub.js  (gateway-core)
//   export class BridgeHub {
//     attach(ws, host)                               // called by server.js on an authenticated /bridge upgrade
//     async call(method, params, {host='lechonk', timeoutMs=30000}={}) -> result   (throws Error on ok:false/timeout)
//     subscribe(topic, fn) -> unsubscribe            // topic e.g. 'claude:<sid>'
//     status() -> [{host, connected, since, caps, claude:{running,max}}]
//   }
//
// tools.js  (gateway-core)
//   export const TOOL_DEFS            // [{name, description, parameters(JSON schema)}] — the table in SPEC "Agent tools"
//   export async function runTool(name, args, ctx) -> {summary: string(<=200), content: string(<=6000)}
//     ctx = {hub, page, audit, limits, maxChars}
//
// audit.js / limits.js  (gateway-core)
//   export function audit(entry) ; export const limits = { check(sid, kind) -> {ok, retryAfter?}, addCost(usd), costToday() }
//
// page.js  (gateway-core)
//   export async function loadPageContext(page) -> {slug,title,context,point?,transcriptNear}  // fills from points.json
//
// llm.js  (gateway-core)
//   export async function* streamChat({model, messages, tools, signal}) // OpenRouter, yields {delta}|{toolCalls}|{usage,costUsd}
//   export async function completeJSON({model, messages, maxTokens}) -> object|null
//
// viz.js  (viz slice)
//   export function createVizGenerator({emit, model}) -> { noteTurn({role, text}), noteEvent(evt), close() }
//     debounced (~1.2 s), at most one model call in flight, emit({type:'viz', spec}) with a validated VizSpec.
//
// voice/index.js  (voice slice)
//   export function handleVoiceUpgrade(req, socket, head, deps)
//     deps = {wss (noServer WebSocketServer), toolDefs, runTool(name,args,ctx), makeCtx(page), limits, audit,
//             createViz: (emit) => vizGenerator, sid}
//
// canvas.js / canvasBus.js / illustrator.js  (generative canvas, docs/CANVAS.md)
//   export function normalizeCanvas(spec) -> {ok:true, spec} | {ok:false, error}      // THE CanvasSpec validator (pure)
//   export function createCanvasBus() -> {publish(partial), subscribe(fn), replay(sinceSeq), latest()}
//   export function createIllustrator({bus, hub}) -> {draw(job), cancel(key), inflight()}
//   export function createCanvasSession({bus, illustrator, by, provider, emit, page, ctx}) -> {render(spec), draw({request,kind,id}),
//     autoTurn({userText, answerText}), startTurn(), userTurn(text), question(), noteTurn(), noteTool(), idle(), close()}   // one per chat request / voice session
//   tools.runTool ctx gains `canvas` (a canvas session) for canvas_render / canvas_draw.
//   voice deps gain `createCanvas({emit, page, provider}) -> canvas session`.
export {};
