// Round 10 (critic r9 §8): deictic follow-up draws, illustrator facts (hosts, models), per-conversation queues. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '1', DESK_CANVAS_TIMEOUT_MS: '800', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, isDeicticDraw, unknownHostName, unknownModelName } = await import('../src/illustrator.js');

const VIDEO_Q = 'Wie funktioniert die Video-Sendeblockierung?';
const FOLLOW = 'Kannst du mir dazu ein Diagramm zeichnen?';
const flow = (extra = {}) => JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Video-Sendeblockierung', caption: 'Ohne Seitenlink kein Versand.', sources: [], nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'notify: Video-Gate', shape: 'diamond' }, { id: 'c', label: 'exit 75: NOT SENT' }, { id: 'd', label: 'Telegram' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'ohne Link' }, { from: 'b', to: 'd', label: 'mit Link' }], ...extra });
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });

let bus; let calls; let runs; let script;
const complete = async (call) => { calls.push({ ...call, messages: structuredClone(call.messages) }); return script(call, calls.length - 1); };
const run = async (name, args) => { runs.push([name, args]); return { ok: true, content: '{"found":true,"topic":"t","path":"/home/flori/desk-knowledge/topics/t.md"}\n---\nnotify --video verlangt einen Seitenlink, sonst exit 75.', summary: 's' }; };
const illustrator = (extra = {}) => createIllustrator({ bus, hub: {}, complete, run, audit: () => {}, ...extra });
const session = (ill = illustrator(), extra = {}) => createCanvasSession({ bus, illustrator: ill, by: 'voice', provider: 'gemini', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 5000, ...extra });
const ask = (s, text) => { s.startTurn(); s.noteTurn({ role: 'user', text }); return s.userTurn(text); };
beforeEach(() => { bus = createCanvasBus(); calls = []; runs = []; script = () => answer(flow()); });

describe('r10 item 3: deictic follow-up draws refine the previous topic', () => {
  it('isDeicticDraw: "dazu / das" draw requests without a topic of their own', () => {
    for (const t of [FOLLOW, 'zeichne das', 'Zeichne mir das bitte auf.', 'Kannst du das als Diagramm zeigen?', 'Mal mir das mal auf']) assert.equal(isDeicticDraw(t), true, t);
    for (const t of [VIDEO_Q, 'Zeichne ein Diagramm der Ausgaben', 'Kannst du die Ausgaben als Diagramm zeigen?', 'Zeig mir die Architektur vom Gateway']) assert.equal(isDeicticDraw(t), false, t);
  });

  it('Gemini q1 -> q4 "Kannst du mir dazu ein Diagramm zeichnen?": same canvas id, the previous question drives the fast path, the illustrator gets "Bezug" + the previous spec', async () => {
    const s = session();
    assert.equal(ask(s, VIDEO_Q), 'early');
    await s.idle();
    const firstId = bus.latest()[0].id;
    const firstRuns = runs.length;
    assert.equal(ask(s, 'Danke.'), 'not-explanatory'); // a chit-chat turn in between changes nothing
    assert.equal(ask(s, FOLLOW), 'deictic');
    await s.idle();
    const last = calls.at(-1).messages[1].content;
    assert.match(last, /Bezug: Florian meint mit "dazu\/das" das vorherige Thema, seine Frage davor: "Wie funktioniert die Video-Sendeblockierung\?"/);
    assert.match(last, new RegExp(`Vorherige Fassung \\(id ${firstId}\\)`));
    assert.match(last, new RegExp(`id: ${firstId} \\(Update dieser Zeichnung\\)`));
    const search = runs.slice(firstRuns).find(([n]) => n === 'search_files');
    assert.equal(search[1].query, 'video sendeblockierung'); // not "kannst dazu diagramm"
    assert.equal(bus.latest()[0].id, firstId);
    assert.equal(bus.latest().length, 1, 'refined, no second canvas');
  });

  it('the agent\'s own canvas_draw in that turn carries the same context', async () => {
    const s = session();
    ask(s, VIDEO_Q);
    await s.idle();
    ask(s, FOLLOW);
    s.draw({ request: 'Ablauf der Video-Sendeblockierung' }); // deferred behind the early run, then an update of the same id
    await s.idle();
    const agentRun = calls.filter((c) => /Anfrage: Ablauf der Video-Sendeblockierung/.test(c.messages[1].content)).at(-1);
    assert.ok(agentRun, 'the deferred agent drawing ran');
    assert.match(agentRun.messages[1].content, /Bezug: Florian meint/);
  });

  it('without an earlier topic the follow-up is an ordinary request', async () => {
    const s = session();
    assert.notEqual(ask(s, FOLLOW), 'deictic');
  });
});

describe('r10 item 2: illustrator hosts and versioned model names', () => {
  it('unknownHostName: "Bridge (Leontin)" is unknown, Sandy / LeChonk / the connected bridge / a sourced host are fine', () => {
    const spec = { kind: 'architecture', title: 'Desk', groups: [{ id: 'g', label: 'Bridge (Leontin)' }], nodes: [{ id: 'a', label: 'Gateway (Sandy)' }] };
    assert.equal(unknownHostName(spec, 'nothing', ['lechonk']), 'Leontin');
    assert.equal(unknownHostName({ ...spec, groups: [{ id: 'g', label: 'Bridge (LeChonk)' }] }, '', ['lechonk']), null);
    assert.equal(unknownHostName(spec, 'Leontin ist der neue Host', []), null);
  });

  it('unknownModelName: a family word does not whitelist an invented version ("deepseek" vs "deepseek-v4-flash")', () => {
    const facts = 'Text: deepseek/deepseek-v4.1-flash-20261017:nitro; Voice: gpt-live-1';
    assert.equal(unknownModelName({ kind: 'flow', title: 'x', nodes: [{ id: 'a', label: 'deepseek-v4-flash' }] }, facts), 'deepseek-v4-flash');
    assert.equal(unknownModelName({ kind: 'flow', title: 'x', nodes: [{ id: 'a', label: 'DeepSeek V4.1 Flash' }, { id: 'b', label: 'deepseek-v4.1-flash' }] }, facts), null);
    assert.equal(unknownModelName({ kind: 'flow', title: 'x', nodes: [{ id: 'a', label: 'gpt-4o-realtime-preview' }] }, facts), 'gpt-4o-realtime-preview');
  });

  it('a drawing with an unknown bridge host is repaired once with the real host list', async () => {
    const bad = JSON.parse(flow());
    bad.nodes[3].label = 'Bridge (Leontin)';
    script = (_c, i) => answer(i === 0 ? JSON.stringify(bad) : flow());
    const hub = { status: () => [{ host: 'lechonk', connected: true }] };
    const r = await illustrator({ hub }).draw({ id: 'arch', request: 'Architektur', by: 'voice', publish: (p) => bus.publish(p) });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].messages.at(-1).content, /names a host that no source carries \("Leontin"\).*lechonk/s);
  });
});

describe('r10 item 8: content', () => {
  it('"Login-Link" questions read the desk\'s own auth.js first, not a word search across other projects', async () => {
    const { fastCalls } = await import('../src/fastPath.js');
    assert.deepEqual(fastCalls('Zeig mir, wie der Login-Link-Ablauf funktioniert.'), [{ name: 'read_file', args: { path: '/home/flori/work/agent-desk/gateway/src/auth.js' } }]);
    assert.notEqual(fastCalls('Wie funktioniert der Magic-Link-Login bei System1?')[0]?.args?.path, '/home/flori/work/agent-desk/gateway/src/auth.js');
  });

  it('a timeline whose caption says "R1 bis R9" must have an event for R9 (repair round), else it passes', async () => {
    const { timelineRangeGap } = await import('../src/illustrator.js');
    const tl = (events) => ({ kind: 'timeline', title: 'Job heute', caption: 'Runden R1 bis R9 mit Deploys.', events });
    assert.equal(timelineRangeGap(tl([{ label: 'R1 Deploy' }, { label: 'critic r7 FAIL' }])), 'R9');
    assert.equal(timelineRangeGap(tl([{ label: 'R1 Deploy' }, { label: 'R9 Deploy' }])), null);
    assert.equal(timelineRangeGap(tl([{ label: 'R1' }, { label: 'critic-r9 FAIL' }])), null);
    const short = JSON.stringify({ v: 2, id: 't', kind: 'timeline', title: 'Job heute', caption: 'Runden R1 bis R9.', sources: [], events: [{ date: '2026-10-24', label: 'R1 Deploy' }, { date: '2026-10-24', label: 'R7 Deploy' }] });
    const full = JSON.stringify({ v: 2, id: 't', kind: 'timeline', title: 'Job heute', caption: 'Runden R1 bis R7.', sources: [], events: [{ date: '2026-10-24', label: 'R1 Deploy' }, { date: '2026-10-24', label: 'R7 Deploy' }] });
    script = (_c, i) => answer(i === 0 ? short : full);
    const r = await illustrator().draw({ id: 't', request: 'Zeitleiste', by: 'text', publish: (p) => bus.publish(p) });
    assert.equal(r.ok, true);
    assert.match(calls[1].messages.at(-1).content, /range up to R9, but no event covers R9/);
  });
});

describe('r10 item 6: early runs with fast-path facts are short', () => {
  it('an early run whose fast path read the facts gets ONE more tool round (not three), then must answer', async () => {
    let n = 0;
    script = (c) => (c.tools ? { message: { content: null, tool_calls: [{ id: `r${(n += 1)}`, name: 'read_file', args: JSON.stringify({ path: `/home/flori/x${n}.md` }) }] }, costUsd: 0 } : answer(flow()));
    const r = await illustrator().draw({ id: 'v', request: VIDEO_Q, question: VIDEO_Q, early: true, by: 'auto', publish: (p) => bus.publish(p) });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2, 'one round with tools, one forced answer');
    assert.equal(calls.filter((c) => c.tools).length, 1);
    assert.deepEqual(runs.map(([name]) => name), ['knowledge_read', 'search_files', 'read_file']);
  });

  it('a non-early run keeps its three tool rounds', async () => {
    let n = 0;
    script = (c) => (c.tools ? { message: { content: null, tool_calls: [{ id: `r${(n += 1)}`, name: 'read_file', args: JSON.stringify({ path: `/home/flori/x${n}.md` }) }] }, costUsd: 0 } : answer(flow()));
    await illustrator().draw({ id: 'v', request: 'Zeichne den Ablauf', by: 'voice', publish: (p) => bus.publish(p) });
    assert.equal(calls.filter((c) => c.tools).length, 3);
  });
});

describe('r10 live: an invented model name never costs the whole drawing', () => {
  it('unknown model -> repair round; the repair answer is invalid too -> the first drawing with the name left out is published', async () => {
    const bad = JSON.parse(flow());
    bad.nodes[0].label = 'Grok (grok-5-1)';
    script = (_c, i) => answer(i === 0 ? JSON.stringify(bad) : '{"kind":"flow","title":"x"}');
    const audits = [];
    const r = await illustrator({ audit: (a) => audits.push(a) }).draw({ id: 'arch', request: 'Architektur', by: 'auto', publish: (p) => bus.publish(p) });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 2);
    const spec = bus.latest()[0].spec;
    assert.equal(spec.nodes[0].label, 'Grok');
    assert.ok(audits.some((a) => a.action === 'canvas.repair.fallback'));
  });
});
