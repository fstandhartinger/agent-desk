// Round 12 (critic r11 §7 items 1, 2): file names / paths / flags / domains on a drawing come from the facts, a failing
// refinement never replaces a correct drawing, and a canvas id belongs to the conversation that drew it. Synthetic data only.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '1', DESK_CANVAS_TIMEOUT_MS: '800', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, worseThan } = await import('../src/illustrator.js');
const { codeTokens, createCorpus, unknownEntities } = await import('../src/entityGuard.js');
const { detailSpec } = await import('../src/canvas.js');

// a code_outline result of an invented project (file names and line counts are made up)
const OUTLINE = '{"root":"/home/flori/work/demo-desk/gw/src","files":5}\n---\nhub.js (120 Z.) talk.js (80 Z.) paint.js (300 Z.) guard.js (40 Z.) voice/relay.js (90 Z.)\n~/bin/ping --loud verlangt einen Grund. Siehe demo.example.org';
const ARCH_Q = 'Erklär mir die Architektur vom Demo-Gateway.';
const node = (id, label) => ({ id, label });
const arch = (labels, extra = {}) => ({ v: 2, id: 'x', kind: 'flow', title: 'Demo-Gateway', caption: 'Test.', sources: [{ label: 'Code', ref: '/home/flori/work/demo-desk/gw/src' }], nodes: labels.map((l, i) => node(`n${i}`, l)), edges: labels.slice(1).map((_, i) => ({ from: 'n0', to: `n${i + 1}` })), ...extra });
const GOOD = arch(['Browser', 'hub.js', 'talk.js', 'paint.js', 'voice/relay.js']);
const INVENTED = arch(['Browser', 'hub.js', 'voice-bridge.js', 'secrets.js', 'paint.js', 'ping --send']);
const answer = (spec) => ({ message: { content: JSON.stringify(spec), tool_calls: [] }, costUsd: 0.001 });

describe('r12 item 1: code tokens on a drawing come from the facts', () => {
  const corpus = () => createCorpus({ rich: OUTLINE });

  it('codeTokens finds files, paths, flags and domains; word compounds and product names are none', () => {
    assert.deepEqual(codeTokens('server.js / voice/relay.js, ping --send, demo.example.org, Browser/Telegram, Node.js').map((c) => `${c.type}:${c.token}`), ['path:voice/relay.js', 'file:server.js', 'flag:--send', 'domain:demo.example.org']);
  });

  it('critic repro (Grok architecture): invented lower-case files and the invented flag are unknown, the real files pass', () => {
    assert.deepEqual(unknownEntities(INVENTED, corpus()), ['voice-bridge.js', 'secrets.js', '--send']);
    assert.deepEqual(unknownEntities(GOOD, corpus()), []);
    assert.deepEqual(unknownEntities(arch(['A', 'B', 'Quelle: /home/florian/x.md', 'benchmarkmind.io']), corpus()), ['/home/florian/x.md', 'benchmarkmind.io']);
    assert.deepEqual(unknownEntities(arch(['A', '~/bin/ping --loud', 'gw/src/hub.js', 'Siehe https://demo.example.org/p/x']), corpus()), []);
  });

  it('live r12 false positives: "/p/-Link" is no path, an emphasised long ALL-CAPS word ("GESENDET") is no name', () => {
    assert.deepEqual(codeTokens('Caption mit /p/-Link'), []);
    assert.deepEqual(unknownEntities(arch(['Agent', 'Caption mit /p/-Link?', 'GESENDET', 'ABGELEHNT: exit 75']), corpus()), []);
    assert.deepEqual(unknownEntities(arch(['Agent', 'ZQXW', 'B']), corpus()), ['ZQXW']); // a short invented code still counts
  });

  it('a lookup that missed (unknown topic, no search hit) is not handed to the voice model as facts', async () => {
    const bus = createCanvasBus();
    const handed = [];
    const run = async (name) => (name === 'knowledge_read' ? { ok: true, content: '{"found":false,"topic":"x","note":"Kein passendes Thema"}' } : { ok: true, content: '{"query":"x","files":0,"hits":[]}' });
    const ill = createIllustrator({ bus, hub: {}, complete: async () => answer(GOOD), run, audit: () => {} });
    await ill.draw({ id: 'q', request: 'Wie funktioniert die Quarkbremse?', question: 'Wie funktioniert die Quarkbremse?', early: true, by: 'auto', publish: (p) => bus.publish(p), onFacts: (f) => handed.push(f) });
    assert.deepEqual(handed, []);
    const run2 = async () => ({ ok: true, content: '{"found":true,"topic":"q"}\n---\nDie Quarkbremse hält bei 3 an.' });
    const ill2 = createIllustrator({ bus, hub: {}, complete: async () => answer(GOOD), run: run2, audit: () => {} });
    await ill2.draw({ id: 'q2', request: 'Wie funktioniert die Quarkbremse?', question: 'Wie funktioniert die Quarkbremse?', early: true, by: 'auto', publish: (p) => bus.publish(p), onFacts: (f) => handed.push(f) });
    assert.equal(handed.length, 1);
    assert.match(handed[0], /hält bei 3 an/);
  });

  it('facts are exact only for the knowledge topic asked for by its own slug (a fuzzy match is not)', async () => {
    const bus = createCanvasBus();
    const handed = [];
    const run = (topic) => async (name, args) => (name === 'knowledge_read' ? { ok: true, content: `{"found":true,"topic":"${topic}"}\n---\nText.` } : { ok: true, content: '{"files":0}' });
    for (const topic of ['quark-bremse', 'demo-desk']) {
      const ill = createIllustrator({ bus, hub: {}, complete: async () => answer(GOOD), run: run(topic), audit: () => {} });
      // fastPath asks for the words of the question ("quark bremse") or, with a clear index winner, the slug itself
      await ill.draw({ id: `e-${topic}`, request: 'Wie funktioniert die Quark-Bremse?', question: 'Wie funktioniert die Quark-Bremse?', early: true, by: 'auto', publish: (p) => bus.publish(p), onFacts: (f, meta) => handed.push(meta) });
    }
    assert.deepEqual(handed.map((m) => m.exact), [false, false]); // neither "quark bremse" nor a fuzzy topic is the slug asked for
    const money = createIllustrator({ bus, hub: {}, complete: async () => answer(GOOD), run: async () => ({ ok: true, content: '{"count":1,"totalsEurApprox":[{"key":"GPU","sumEur":7}]}' }), audit: () => {} });
    await money.draw({ id: 'm', request: 'Wofür geben wir das Geld aus?', question: 'Wofür geben wir das Geld aus?', early: true, by: 'auto', publish: (p) => bus.publish(p), onFacts: (f, meta) => handed.push(meta) });
    assert.equal(handed.at(-1).exact, true); // the ledger answers a money question exactly
  });

  it('facts from search hits only are weak; what the early run reads afterwards is handed over again as strong (final)', async () => {
    const bus = createCanvasBus();
    const handed = [];
    const run = async (name) => (name === 'search_files' ? { ok: true, content: '{"query":"q","files":1}\n---\nnotes/a.md: Quarkbremse' } : name === 'read_file' ? { ok: true, content: 'Die Quarkbremse hält bei 3 an.' } : { ok: true, content: '{"found":false}' });
    const script = [{ message: { content: null, tool_calls: [{ id: 'r1', name: 'read_file', args: '{"path":"/home/flori/notes/a.md"}' }] }, costUsd: 0 }, answer(GOOD)];
    const ill = createIllustrator({ bus, hub: {}, complete: async () => script.shift(), run, audit: () => {} });
    await ill.draw({ id: 'q3', request: 'Wie funktioniert die Quarkbremse?', question: 'Wie funktioniert die Quarkbremse?', early: true, by: 'auto', publish: (p) => bus.publish(p), onFacts: (f, meta) => handed.push({ f, ...meta }) });
    assert.deepEqual(handed.map((h) => [h.strong, h.exact, h.final]), [[false, false, false], [true, false, true]]);
    assert.match(handed[1].f, /^Frage: Wie funktioniert die Quarkbremse\?\n\n### read_file[\s\S]*hält bei 3 an[\s\S]*### search_files/); // the question, then the strong facts first
  });

  it('worseThan: a refinement whose names were dropped never beats a correct drawing; equal unknowns -> more clean entries win', () => {
    const facts = corpus();
    assert.equal(worseThan(GOOD, arch(['Browser', 'hub.js', 'paint.js']), { facts, raw: ['secrets.js'] }), true);
    assert.equal(worseThan(GOOD, arch(['Browser', 'hub.js', 'paint.js']), { facts, raw: [] }), false); // a clean refinement may differ
    const oldBad = arch(['Browser', 'hub.js', 'keys.js']);
    assert.equal(worseThan(oldBad, GOOD, { facts, raw: [] }), false);
    assert.equal(worseThan(oldBad, arch(['Browser', 'a.js', 'b.js']), { facts, raw: ['a.js', 'b.js'] }), true);
  });
});

describe('r12 item 1: a failing refinement keeps the correct drawing', () => {
  let bus;
  let audits;
  beforeEach(() => { bus = createCanvasBus(); audits = []; });
  const run = async () => ({ ok: true, content: OUTLINE, summary: 's' });

  it('illustrator: the refinement invents files twice (answer and repair) -> the correct early drawing stays on its id', async () => {
    const script = [GOOD, INVENTED, INVENTED];
    const complete = async () => answer(script.shift());
    const ill = createIllustrator({ bus, hub: {}, complete, run: async () => ({ ok: true, content: OUTLINE }), audit: (a) => audits.push(a) });
    const memory = { noteTool() {}, toolsUsed: () => [{ name: 'code_outline', args: {}, ok: true, content: OUTLINE }], snapshot: () => ({ turns: [], facts: OUTLINE }), turnTexts: () => [ARCH_Q], lastUser: () => ARCH_Q, userTurns: () => [ARCH_Q] };
    await ill.draw({ id: 'demo-arch', request: ARCH_Q, by: 'auto', publish: (p) => bus.publish(p), memory });
    assert.deepEqual(bus.latest()[0].spec.nodes.map((n) => n.label), GOOD.nodes.map((n) => n.label));
    const r = await ill.draw({ id: 'demo-arch', request: 'Architektur mit voice-bridge.js und secrets.js', by: 'voice', publish: (p) => bus.publish(p), memory });
    assert.equal(r.kept, true);
    const spec = bus.latest()[0].spec;
    assert.deepEqual(spec.nodes.map((n) => n.label), GOOD.nodes.map((n) => n.label));
    assert.equal(bus.latest()[0].by, 'auto', 'the kept drawing keeps its author');
    assert.ok(audits.some((a) => a.action === 'canvas.refine.rejected' && /invented voice-bridge\.js/.test(a.detail)));
  });

  it('illustrator: a repair that drops the invented names is published (the guard does not freeze a canvas)', async () => {
    const better = arch(['Browser', 'hub.js', 'talk.js', 'paint.js', 'guard.js', 'voice/relay.js']);
    const script = [GOOD, INVENTED, better];
    const ill = createIllustrator({ bus, hub: {}, complete: async () => answer(script.shift()), run, audit: (a) => audits.push(a) });
    const memory = { noteTool() {}, toolsUsed: () => [{ name: 'code_outline', args: {}, ok: true, content: OUTLINE }], snapshot: () => ({ turns: [], facts: OUTLINE }), turnTexts: () => [], lastUser: () => '', userTurns: () => [] };
    await ill.draw({ id: 'demo-arch', request: ARCH_Q, by: 'auto', publish: (p) => bus.publish(p), memory });
    await ill.draw({ id: 'demo-arch', request: 'genauer', by: 'voice', publish: (p) => bus.publish(p), memory });
    // upgrades 28 Oct (§5): six boxes are shown simple (<= 5), the full repair is the detail
    assert.deepEqual(detailSpec(bus.latest()[0].spec).nodes.map((n) => n.label), better.nodes.map((n) => n.label));
    assert.ok(bus.latest()[0].spec.nodes.length <= 5);
  });

  it('canvas_render: the agent invents files twice on the early drawing\'s canvas -> the early drawing stays, the tool says kept', async () => {
    const ill = createIllustrator({ bus, hub: {}, complete: async () => answer(GOOD), run, audit: () => {} });
    const s = createCanvasSession({ bus, illustrator: ill, by: 'voice', provider: 'xai', emit: () => {}, ctx: {}, audit: (a) => audits.push(a), debounceMs: () => 30, researchMs: () => 5000 });
    s.startTurn();
    const q = 'Wie funktioniert der Ablauf im Demo-Gateway?'; // a process question: the flow is the answer's kind
    s.noteTurn({ role: 'user', text: q });
    s.noteTool({ name: 'code_outline', args: { path: '/home/flori/work/demo-desk/gw/src' }, ok: true, content: OUTLINE });
    assert.equal(s.userTurn(q), 'early');
    await s.idle();
    const id = bus.latest()[0].id;
    const { v, id: _drop, ...body } = INVENTED;
    assert.throws(() => s.render(body), /voice-bridge\.js/); // first strike: the agent gets the list
    const r = s.render(body);
    assert.equal(r.kept, true);
    assert.equal(r.id, id);
    assert.deepEqual(bus.latest()[0].spec.nodes.map((n) => n.label), GOOD.nodes.map((n) => n.label));
  });
});

describe('r12 item 2: canvas ids belong to the conversation that drew them', () => {
  let bus;
  beforeEach(() => { bus = createCanvasBus(); });
  const ill = () => createIllustrator({ bus, hub: {}, complete: async (call) => answer({ ...GOOD, id: /"?id: ([a-z0-9-]+)/.exec(call.messages[1].content)?.[1] ?? 'x' }), run: async () => ({ ok: true, content: OUTLINE }), audit: () => {} });
  const session = (illustrator, by, owner) => {
    const s = createCanvasSession({ bus, illustrator, by, provider: by === 'voice' ? 'xai' : undefined, owner, emit: () => {}, ctx: {}, audit: () => {}, debounceMs: () => 30, researchMs: () => 5000 });
    s.noteTool({ name: 'code_outline', args: {}, ok: true, content: OUTLINE });
    return s;
  };
  const body = (labels) => { const { v, id, ...rest } = arch(labels); return rest; };

  it('critic repro: a voice session renders under the text conversation\'s agent-chosen id -> it gets "-2", the text canvas stays', () => {
    const i = ill();
    const text = session(i, 'text', 'sid\u0000conv-r');
    text.startTurn();
    assert.equal(text.render({ ...body(['Browser', 'hub.js', 'talk.js']), id: 'gateway-architektur' }).id, 'gateway-architektur');
    const voice = session(i, 'voice');
    voice.startTurn();
    const r = voice.render({ ...body(['Browser', 'hub.js', 'paint.js', 'guard.js']), id: 'gateway-architektur' });
    assert.equal(r.id, 'gateway-architektur-2');
    assert.deepEqual(bus.latest().find((e) => e.id === 'gateway-architektur').spec.nodes.map((n) => n.label), ['Browser', 'hub.js', 'talk.js']);
    assert.equal(bus.latest().find((e) => e.id === 'gateway-architektur').by, 'text');
    // the voice session keeps refining its own copy under the same name
    assert.equal(voice.render({ ...body(['Browser', 'hub.js', 'paint.js', 'guard.js', 'talk.js']), id: 'gateway-architektur' }).id, 'gateway-architektur-2');
    assert.equal(bus.ownerOf('gateway-architektur'), 'sid\u0000conv-r');
  });

  it('the same question in text and voice: the voice early drawing does not overwrite the text one (same slug -> "-2")', async () => {
    const i = ill();
    const text = session(i, 'text', 'sid\u0000conv-q');
    text.startTurn(); text.noteTurn({ role: 'user', text: ARCH_Q });
    assert.equal(text.userTurn(ARCH_Q), 'early');
    await text.idle();
    const voice = session(i, 'voice');
    voice.startTurn(); voice.noteTurn({ role: 'user', text: ARCH_Q });
    voice.userTurn(ARCH_Q);
    await voice.idle();
    const ids = bus.latest().map((e) => `${e.id}:${e.by}`).sort();
    assert.equal(ids.length, 2);
    assert.match(ids[0], /^erklaer-mir-die-architektur-vom-demo-gate-2:auto$/);
    assert.match(ids[1], /^erklaer-mir-die-architektur-vom-demo-gate:auto$/);
  });

  it('canvas_draw with a foreign id -> drawn under the own id; the next request of the same conversation refines its own id', async () => {
    const i = ill();
    const text = session(i, 'text', 'sid\u0000conv-a');
    text.startTurn();
    text.render({ ...body(['Browser', 'hub.js', 'talk.js']), id: 'demo-arch' });
    const voice = session(i, 'voice');
    voice.startTurn();
    assert.equal(voice.draw({ request: 'Architektur', kind: 'flow', id: 'demo-arch' }).id, 'demo-arch-2');
    await voice.idle();
    const later = session(i, 'text', 'sid\u0000conv-a'); // the same text conversation, next /api/chat request
    later.startTurn();
    assert.equal(later.render({ ...body(['Browser', 'hub.js', 'talk.js', 'paint.js']), id: 'demo-arch' }).id, 'demo-arch');
    assert.deepEqual(bus.latest().find((e) => e.id === 'demo-arch').spec.nodes.map((n) => n.label), ['Browser', 'hub.js', 'talk.js', 'paint.js']);
  });

  it('Florian names the foreign canvas -> that canvas is updated (the one exception)', () => {
    const i = ill();
    const text = session(i, 'text', 'sid\u0000conv-n');
    text.startTurn();
    text.render({ ...body(['Browser', 'hub.js', 'talk.js']), id: 'demo-arch-plan' });
    const voice = session(i, 'voice');
    voice.startTurn();
    voice.noteTurn({ role: 'user', text: 'Ergänze in demo-arch-plan noch paint.js.' });
    voice.userTurn('Ergänze in demo-arch-plan noch paint.js.');
    assert.equal(voice.render({ ...body(['Browser', 'hub.js', 'talk.js', 'paint.js']), id: 'demo-arch-plan' }).id, 'demo-arch-plan');
  });

  it('a Claude session owns what it drew: a text conversation that reuses the id gets its own', () => {
    bus.publish({ phase: 'ready', id: 'claude-plan', kind: 'flow', title: 'Plan', spec: { ...GOOD, id: 'claude-plan' }, by: 'claude' }, { owner: 'claude:s1' });
    const text = session(ill(), 'text', 'sid\u0000conv-c');
    text.startTurn();
    assert.equal(text.render({ ...body(['Browser', 'hub.js', 'talk.js']), id: 'claude-plan' }).id, 'claude-plan-2');
    assert.equal(bus.latest().find((e) => e.id === 'claude-plan').by, 'claude');
  });
});
