import { artifactInstructions } from './artifacts.js';
import { audit } from './audit.js';
import { cfg } from './config.js';
import { openSse, readJson, sendJson } from './http.js';
import { streamChat } from './llm.js';
import { loadPageContext } from './page.js';
import { formatChatContext } from './claudeSessions.js';
import { buildInstructions } from './prompt.js';
import { TEXT } from './messages.js';
import { short } from './redact.js';
import { ToolMarkupFilter } from './toolMarkup.js';
import { TOOL_DEFS, pseudoPathRefusal, runTool, statusText, resolveToolName } from './tools.js';
import { createActivityViz } from './viz.js';
import { RefusalFilter, isGermanText, stripCjk } from './canvas.js';
import { conversationKey, createCanvasRegistry, createCanvasSession } from './illustrator.js';
import { createMoneyGuard } from './ledgerViz.js';
import { TaxClaimFilter } from './taxFilter.js';
import { isMoneyQuestion } from './fastPath.js';
import { createProseGuard, LoopDetector, NoResultsClaimFilter, ProseGuardFilter } from './proseGuard.js';

const MAX_TOOL_ROUNDS = 8;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;
const FINAL_ROUND_HINT = 'Antworte jetzt mit dem, was du hast. Keine weiteren Werkzeuge, kein Werkzeug-Markup: eine kurze Antwort auf Deutsch, und sage ehrlich, was du nicht herausfinden konntest.';
// Round 11 (critic r10 defect 1): the canvases each text conversation drew, so "zeichne das" in its next request refines its own one
const conversationCanvases = createCanvasRegistry();
// Round 12 (critic r11 defect 3): the stream repeated itself; the next round (no tools) closes the answer cleanly
const LOOP_HINT = 'Du wiederholst dich. Hör damit auf und schließe die Antwort jetzt ab: fasse in höchstens drei kurzen Sätzen auf Deutsch zusammen, was die Werkzeugergebnisse dieser Runde sagen. Keine Pfade, keine Korrekturen, keine Wiederholung. Alle Werkzeugergebnisse dieser Runde liegen dir vor: behaupte nicht, dass Ergebnisse fehlen.';
// Critic r2 P2-1: a round that only announces tool work ("I'll read both in parallel.") and ends without a tool call
// gets ONE more round with this nudge, so Florian never sees an announcement as the whole answer.
export const ACT_NUDGE = 'Führe die Werkzeugaufrufe jetzt aus und antworte dann auf Deutsch.';
const ANNOUNCE_MAX = 240;
const ANNOUNCE_RE = new RegExp([
  String.raw`^(?:okay|ok|gut|alles klar|klar|sure|alright|einen moment|moment)?[,.!\s]*`,
  '(?:',
  String.raw`(?:i['’]ll|i will|i['’]m going to|i am going to|let me|first,? i['’]ll|now i['’]ll|i['’]m (?:now )?(?:reading|searching|checking|looking|fetching|loading))\b`,
  '|',
  String.raw`(?:ich (?:werde|lese|suche|schaue|schau|prüfe|sehe|hole|rufe|lade|öffne|starte|frage|gucke|durchsuche|sehe mir)|lass mich|lasse mich|ich mache mich)\b`,
  ')',
].join(''), 'i');

/** True for a short text that only says what the model is about to do (no answer content). */
export function isAnnouncement(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > ANNOUNCE_MAX) return false;
  if (!ANNOUNCE_RE.test(t)) return false;
  return /[.:…!]$|\.{3}$/.test(t) || t.split(/(?<=[.!?])\s+/).length <= 2;
}
// Critic r2 P2-7: the model tried invented paths (/home/florian/…) before the one Florian typed. Absolute workshop
// paths in his message are named to it once more, verbatim, as the first ones to read.
const USER_PATH_RE = /(?<![\w/~.])\/home\/flori\/[^\s"'`<>()\[\]{},;]+/g;
export function userPaths(text) {
  const found = String(text ?? '').match(USER_PATH_RE) ?? [];
  return [...new Set(found.map((p) => p.replace(/(?<![.:!?])[.:!?]+$/, '')))].slice(0, 5);
}
export const pathHint = (paths) => `Florian hat diese Pfade genannt: ${paths.join(', ')}. Lies genau diese Pfade wörtlich mit read_file (oder search_files für einen Ordner), bevor du andere suchst; rate keine Pfade.`;
const NO_ANSWER = 'Dazu habe ich gerade keine verlässliche Antwort gefunden. Frag mich gern etwas konkreter, zum Beispiel nach einem Job-Namen.';

function cleanMessages(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_MESSAGES) return null;
  const out = [];
  for (const m of raw) {
    if ((m?.role !== 'user' && m?.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) return null;
    out.push({ role: m.role, content: m.content.slice(0, MAX_CONTENT) });
  }
  return out.at(-1).role === 'user' ? out : null;
}

function parseArgs(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

/** POST /api/chat → SSE. `session` = {sid, ip, hub, limits}. */
export async function handleChat(req, res, { sid, ip, hub, limits, canvasBus, illustrator, artifacts, canvasRegistry = conversationCanvases }) {
  const body = await readJson(req);
  const messages = cleanMessages(body.messages);
  if (!messages) return sendJson(res, 400, { error: TEXT.badMessages });
  const gate = limits.check(sid, 'chat');
  if (!gate.ok) return sendJson(res, 429, { error: gate.reason }, { 'retry-after': String(gate.retryAfter) });
  const spend = limits.check(sid, 'spend');
  if (!spend.ok) return sendJson(res, 429, { error: spend.reason }, { 'retry-after': String(spend.retryAfter) });

  const model = cfg.allowedModels().includes(body.model) ? body.model : cfg.textModel();
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  const sse = openSse(res);
  const send = (event) => sse.send(event);
  let onViz = null;

  const emit = (event) => {
    send(event);
    if (event.type === 'viz') onViz?.();
  };
  const viz = createActivityViz({ emit, model: cfg.vizModel() });
  let canvas = null;
  const lastUser = messages.at(-1).content;
  audit({ action: 'chat', ip, detail: lastUser });
  viz.noteTurn({ role: 'user', text: lastUser });

  const totals = { in: 0, out: 0, costUsd: 0 };
  try {
    const page = await loadPageContext(body.page);
    const convKey = conversationKey(sid, body.conversationId);
    // the canvas the browser shows (undefined: an older client that does not say) + this conversation's own earlier canvases
    const focusedId = Object.hasOwn(body, 'focusedCanvasId') ? (typeof body.focusedCanvasId === 'string' ? body.focusedCanvasId : null) : undefined;
    canvas = canvasBus && illustrator ? createCanvasSession({ bus: canvasBus, illustrator, by: 'text', emit: send, page, focusedId, owner: convKey ?? `text\u0000${sid ?? ''}`, owned: canvasRegistry.ids(convKey), onOwn: (id) => canvasRegistry.note(convKey, id), ctx: { sid, ip, limits } }) : null;
    for (const m of messages) canvas?.noteTurn({ role: m.role, text: m.content });
    // The question is complete: an explanatory one is illustrated at once, in parallel with the agent (docs/CANVAS.md "Früher Zeichner").
    canvas?.startTurn();
    canvas?.userTurn(lastUser);
    const ctx = {
      artifacts, canvas, hub, limits, sid, ip, page: page && { slug: page.slug, t: page.t, sceneId: page.sceneId, pointId: page.pointId, title: page.title, point: page.point, transcriptNear: page.transcriptNear },
      audit: (entry) => audit({ ip, ...entry }),
      chatContext: formatChatContext(messages),
      // Round 10 (critic r9 F2): the deterministic money list replaces the model's money sentences only for a spending
      // question (the illustrator's classifier); ledger_spend as context (Florian's tax-reserve question) keeps the explanation.
      moneyQuestion: isMoneyQuestion(lastUser),
      results: [], // every tool result of this turn: what names and amounts in the prose may come from
    };
    const convo = [{ role: 'system', content: buildInstructions(page) + artifactInstructions(artifacts?.get(sid)) }, ...messages];
    const paths = userPaths(lastUser);
    if (paths.length) convo.push({ role: 'system', content: pathHint(paths) });
    const givenBase = convo.map((m) => m.content).join('\n');
    let given = { n: -1, text: '' };
    ctx.prose = createProseGuard({
      given: () => (given.n === ctx.results.length ? given.text : (given = { n: ctx.results.length, text: [givenBase, ...ctx.results].join('\n') }).text),
      proposalTitles: () => [...(ctx.turnProposals?.values() ?? [])].map((p) => p.title).filter(Boolean),
      checkAmounts: () => ctx.results.length > 0, // amounts are checked against the data the model fetched in this turn
      bridgeHosts: () => { try { return (hub?.status?.() ?? []).filter((b) => b.connected !== false).map((b) => b.host).filter(Boolean); } catch { return []; } },
    });
    const { text, raw } = await runLoop({ model, convo, ctx, send, viz, totals, signal: abort.signal, german: isGermanText(lastUser) });
    const vizArrived = new Promise((resolve) => { onViz = resolve; });
    viz.noteTurn({ role: 'assistant', text });
    canvas?.noteTurn({ role: 'assistant', text });
    send({ type: 'done', usage: { in: totals.in, out: totals.out }, costUsd: totals.costUsd, model });
    audit({ action: 'chat.done', ip, cost_usd: totals.costUsd, detail: `${totals.in}/${totals.out} tokens` });
    // `done` is already out; keep the stream open briefly so the canvas update for this turn can still arrive.
    await Promise.race([vizArrived, new Promise((resolve) => setTimeout(resolve, cfg.vizGraceMs()))]);
    // Explanatory answer without a drawing (or a refusal to draw): the gateway draws it itself, then the stream ends.
    canvas?.autoTurn({ userText: lastUser, answerText: raw });
    await canvas?.idle();
  } catch (err) {
    if (!abort.signal.aborted) send({ type: 'error', message: short(err.message, 200) });
  } finally {
    if (abort.signal.aborted) canvas?.cancelAll();
    canvas?.close();
    viz.close();
    res.end();
  }
}

async function runLoop({ model, convo, ctx, send, viz, totals, signal, german = false }) {
  let finalText = '';
  let rawText = '';
  let forceFinal = false;
  let taxSaid = false;
  let loop = new LoopDetector(); // one per answer (all rounds): the same 6 words for the third time = the model is looping
  let summarized = false;
  let hadResults = false; // critic r7 P2-2: this answer has tool results, so the closing summary may not claim they are missing
  let nudged = false; // P2-1: at most one "now run the tools" round per answer
  const refusal = new RefusalFilter(); // one per turn: "Ich zeichne es dir auf." is said at most once
  for (let round = 0; round <= MAX_TOOL_ROUNDS + 1; round += 1) {
    // Last allowed round (or after the model wrote tool calls as text): no tools, and tell the model to answer now.
    const withTools = round < MAX_TOOL_ROUNDS && !forceFinal;
    if (round > MAX_TOOL_ROUNDS && !summarized) break; // the extra round is only for the summary after a loop
    if (!withTools && !summarized && convo.at(-1)?.content !== FINAL_ROUND_HINT) convo.push({ role: 'system', content: FINAL_ROUND_HINT });
    const filter = new ToolMarkupFilter();
    const tax = new TaxClaimFilter(); // unsourced tax-law sentences (docs/CANVAS.md "Round 9")
    const facts = ctx.prose ? new ProseGuardFilter(ctx.prose, (notes) => ctx.audit?.({ action: 'chat.prose_guard', detail: notes.join('; ') })) : null; // names / amounts / self-corrections (Round 10)
    tax.said = taxSaid;
    let text = '';
    let raw = '';
    let toolCalls = [];
    let held = ''; // after a ledger_spend result the round's text is checked against it before it is shown (money guard)
    // Critic r3 P2-4: a pure announcement ("I'll do all three in parallel.") that is followed by the nudge round is not part of the
    // answer: the start of a round is held back until it is clear that it is not one (40 chars, or the announcement limit).
    let hold = withTools && !nudged;
    let heldOut = '';
    const release = () => {
      hold = false;
      if (heldOut) send({ type: 'delta', text: heldOut });
      heldOut = '';
    };
    const out = (piece) => {
      if (!piece) return;
      text += piece;
      if (!hold) { send({ type: 'delta', text: piece }); return; }
      heldOut += piece;
      const t = text.trim();
      if (t.length > ANNOUNCE_MAX || (t.length >= 40 && !ANNOUNCE_RE.test(t))) release();
    };
    // The model never says it cannot draw: such a sentence becomes "Ich zeichne es dir auf." (the gateway draws it, see chat handler)
    const accept = (piece) => {
      if (!piece) return;
      const shown = german ? stripCjk(piece, ctx.results ?? []) : piece; // a stray CJK glyph in a German answer is a model slip ("ohne弛 Payload"); names from tool results stay
      raw += shown;
      if (ctx.moneyGuard) held += shown;
      else out(refusal.push(shown));
    };
    const checked = (piece) => (facts ? facts.push(piece) : piece);
    const noClaim = summarized && hadResults ? new NoResultsClaimFilter() : null;
    const show = (piece) => accept(checked(tax.push(noClaim ? noClaim.push(piece) : piece)));
    let looped = false;
    const roundCtl = new AbortController();
    try {
      for await (const part of streamChat({ model, messages: convo, tools: withTools ? TOOL_DEFS : undefined, signal: AbortSignal.any([signal, roundCtl.signal]) })) {
        if (part.delta) {
          const piece = filter.push(part.delta);
          if (loop.push(piece)) { looped = true; roundCtl.abort(); break; } // the unfinished sentence that repeats goes nowhere
          show(piece);
        } else if (part.toolCalls) toolCalls = part.toolCalls;
        else if (part.usage) {
          totals.in += part.usage.in;
          totals.out += part.usage.out;
          totals.costUsd += part.costUsd;
        }
      }
    } catch (err) {
      if (!looped || signal.aborted) throw err;
    }
    if (looped) {
      toolCalls = [];
      // a complete sentence the prose guard still held (it waits for the space after the ".") is shown; the unfinished one is not
      tax.buf = '';
      if (facts) {
        const held = facts.buf;
        facts.buf = '';
        const end = [...held.matchAll(/[.!?](?=\s|$)|\n/g)].at(-1);
        if (end) accept(facts.run(held.slice(0, end.index + 1)));
      }
      ctx.audit?.({ action: 'chat.loop', detail: `round ${round}${summarized ? ' (summary looped too: cut)' : ''}` });
    } else {
      show(filter.flush());
      if (noClaim) accept(checked(tax.push(noClaim.flush())));
      accept(checked(tax.flush()));
      if (facts) accept(facts.flush());
    }
    if (ctx.moneyGuard && (held || !toolCalls.length)) {
      // Round 9 (critic r8 F2): after ledger_spend the model's text is only prose without amounts (max 2 sentences per turn); the deterministic list comes once, with the final answer.
      const checked = ctx.moneyGuard.check(held);
      if (!checked.ok) ctx.audit({ action: 'chat.money_guard', detail: checked.reasons.join('; ') });
      const withList = !toolCalls.length && !ctx.moneyListed;
      const max = 2 - (ctx.moneySentences ?? 0);
      const shown = ctx.moneyGuard.compose(held, { max, withList });
      ctx.moneySentences = (ctx.moneySentences ?? 0) + (shown.replace(/Laut Ledger:[\s\S]*$/, '').match(/[^.!?]+[.!?]*/g)?.length ?? 0);
      if (withList) ctx.moneyListed = true;
      raw = raw.slice(0, raw.length - held.length) + shown;
      if (shown) out(refusal.push(shown));
    }
    out(refusal.flush());
    taxSaid = tax.said;
    const dropAnnouncement = hold && !looped && !toolCalls.length && !filter.dropped && !signal.aborted && isAnnouncement(raw);
    if (dropAnnouncement) { heldOut = ''; hold = false; } else release();
    if (!dropAnnouncement) finalText += text;
    rawText += raw;
    if (looped && !summarized && !signal.aborted) {
      // one more round without tools: a short clean summary of what the tools returned, after what was already shown
      summarized = true;
      forceFinal = true;
      loop = new LoopDetector({ allowed: loop.allowed });
      if (text.trim()) convo.push({ role: 'assistant', content: text });
      convo.push({ role: 'system', content: LOOP_HINT });
      if (text) { finalText += '\n\n'; rawText += '\n\n'; send({ type: 'delta', text: '\n\n' }); }
      continue;
    }
    if (!toolCalls.length) {
      if (filter.dropped && withTools) {
        forceFinal = true;
        continue;
      }
      if (withTools && !nudged && !signal.aborted && isAnnouncement(raw)) {
        nudged = true;
        ctx.audit?.({ action: 'chat.nudge', detail: `round ${round}: ${short(raw, 80)}` });
        convo.push({ role: 'assistant', content: raw });
        convo.push({ role: 'system', content: ACT_NUDGE });
        rawText += '\n\n';
        if (!dropAnnouncement) { finalText += '\n\n'; send({ type: 'delta', text: '\n\n' }); } // an announcement that was dropped (P2-4) leaves no gap
        continue;
      }
      if (!finalText.trim()) {
        send({ type: 'delta', text: NO_ANSWER });
        return { text: NO_ANSWER, raw: NO_ANSWER };
      }
      return { text: finalText, raw: rawText };
    }

    convo.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } })) });
    const status = toolCalls.map((call) => statusText(call.name, parseArgs(call.args) ?? {})).find(Boolean);
    if (status) send({ type: 'status', text: status });
    const results = await Promise.all(toolCalls.map((call) => execute(call, ctx, send, viz)));
    toolCalls.forEach((call, i) => convo.push({ role: 'tool', tool_call_id: call.id, content: results[i].content }));
    loop.allow(results.map((r) => r.content).join('\n')); // quoting a tool result (the same error line for 3 URLs) is no loop
    hadResults ||= results.some((r) => String(r.content ?? '').trim()); // an error line is a result too
    if (text) { finalText += '\n\n'; rawText += '\n\n'; send({ type: 'delta', text: '\n\n' }); } // the text before a tool call and the answer after it are two paragraphs
  }
  return { text: finalText, raw: rawText };
}

async function execute(call, ctx, send, viz) {
  call = { ...call, name: resolveToolName(call.name) };
  const args = parseArgs(call.args);
  const started = Date.now();
  const refused = pseudoPathRefusal(call.name, args); // r6 P2-7: no status line for a call that never reaches the bridge
  if (refused) { ctx.audit?.({ action: 'chat.tool.pseudo-path', detail: call.name }); return refused; }
  const base = { type: 'tool', id: call.id, name: call.name, args: args ?? {} };
  send({ ...base, status: 'start' });
  viz.noteEvent({ ...base, status: 'start' });
  ctx.canvas?.toolStarted(call.name);
  const result = args === null ? { ok: false, summary: 'invalid tool arguments', content: 'ERROR: tool arguments were not valid JSON' } : await runTool(call.name, args, ctx);
  const event = { ...base, status: result.ok ? 'done' : 'error', summary: result.summary, ms: Date.now() - started };
  send(event);
  if (result.event?.type === 'handoff' || result.event?.type === 'claude_proposal') send(result.event); // handoff_propose / claude_task: the browser shows a confirm card; only Florian's click acts
  viz.noteEvent({ ...event, content: result.content }); // the activity canvas reads its facts from the full result
  ctx.canvas?.noteTool({ name: call.name, args: args ?? {}, ok: result.ok, content: result.content });
  if (result.ok) ctx.results?.push(String(result.content ?? ''));
  if (call.name === 'ledger_spend' && result.ok && ctx.moneyQuestion !== false) ctx.moneyGuard = createMoneyGuard(result.content);
  return result;
}
