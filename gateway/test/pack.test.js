// Slice gw-context: explainer context pack - private fetch, fallback derivation, packing per provider, retrieval, the tool, no leaks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, before, describe, it } from 'node:test';
import { fakeServer, login, setEnv, startGateway } from './helpers/env.js';
import { makeContextJson, makeDeepdive, makePoints, makeTimeline } from './helpers/pack-fixture.js';
import { syn } from './synthetic.js';

const TOKEN = syn('ctx-·toke·n-01·2345·6789·abcd·ef');
const timeline = makeTimeline({ sceneChars: 1200 });
const points = makePoints(timeline);
const deepdive = makeDeepdive();
let upstream;
let gw;
let cookie;
let withPack = true; // false: the upstream answers 404 for the private files (old page)

before(async () => {
  upstream = await fakeServer((req, res) => {
    const file = req.url.split('/').pop();
    const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (file === 'points.json') return json(points);
    if (file === 'timeline.json') return json(timeline);
    if (file === 'context.json' || file === 'deepdive.md') {
      if (!withPack || req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(404).end('nope');
      return file === 'context.json' ? json(makeContextJson(timeline, points)) : res.writeHead(200, { 'content-type': 'text/markdown' }).end(deepdive);
    }
    return res.writeHead(404).end('nope');
  });
  setEnv({ EXPLAINER_ORIGIN: upstream.url, EXPLAINER_CONTEXT_TOKEN: TOKEN });
  gw = await startGateway();
  cookie = (await login(gw.base)).cookie;
});
after(() => { gw.close(); upstream.close(); });

const { deriveFromTimeline, loadPack, pagePackLines, searchPack, splitSections, PAGE_BUDGET, TRUNCATION, orderSections, pageUpdateText } = await import('../src/pack.js');
const { loadPageContext } = await import('../src/page.js');
const { buildInstructions: voice } = await import('../src/voice/instructions.js');
const { buildInstructions: text } = await import('../src/prompt.js');
const { runTool } = await import('../src/tools.js');
const { clearExplainerCacheForTests } = await import('../src/explainer.js');

const pageWith = (pack, pointId = 'el2a', extra = {}) => {
  const e = points.points[pointId];
  const page = { slug: 'demo-slug', title: 'Demo-Erklärer', t: pack.elements[pointId]?.t ?? 0, sceneId: pack.elements[pointId]?.scene, pointId, point: e && { title: e.title, short: e.short, more: e.more }, context: points.page.context, transcriptNear: '', ...extra };
  Object.defineProperty(page, 'pack', { value: pack, enumerable: false });
  return page;
};
const bigPack = () => { const p = deriveFromTimeline(timeline, points, makeDeepdive({ sections: 60, chars: 1800 })); return p; };

describe('fallback derivation (no context.json)', () => {
  const pack = deriveFromTimeline(timeline, points, deepdive);
  it('maps elements to the scene containing their cue; scene ids map to themselves; cue-less points to null', () => {
    assert.equal(pack.elements.el1a.scene, 'scene1');
    assert.equal(pack.elements.el3b.scene, 'scene3');
    assert.equal(pack.elements.scene4.scene, 'scene4');
    assert.equal(pack.elements.orphan.scene, null);
    assert.ok(pack.scenes[2].points.includes('el3a'));
  });
  it('takes scene text from the timeline, or from the words when the scene has none', () => {
    assert.equal(pack.scenes[0].text, timeline.scenes[0].text.trim());
    const bare = deriveFromTimeline({ ...timeline, scenes: timeline.scenes.map(({ text: _t, ...s }) => s) }, points, '');
    assert.ok(bare.scenes[1].text.length > 100);
    assert.equal(bare.deepdive.length, 0);
  });
  it('splits the deep-dive at ## headings', () => {
    const secs = splitSections('Vorwort\n\n## A\nText a\n\n### Unter\nmehr\n\n## B\nText b');
    assert.deepEqual(secs.map((s) => s.heading), ['Einleitung', 'A', 'B']);
    assert.match(secs[1].text, /### Unter/);
  });
});

describe('private fetch', () => {
  it('uses context.json + deepdive.md with the bearer token (cached) and falls back without them', async () => {
    clearExplainerCacheForTests();
    upstream.seen.length = 0;
    const pack = await loadPack('demo-slug', points, timeline);
    assert.equal(pack.origin, 'context.json');
    assert.ok(pack.deepdive.length > 10);
    const priv = upstream.seen.filter((r) => /context\.json|deepdive\.md/.test(r.url));
    assert.equal(priv.length, 2);
    assert.ok(priv.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
    await loadPack('demo-slug', points, timeline);
    assert.equal(upstream.seen.filter((r) => /context\.json|deepdive\.md/.test(r.url)).length, 2, 'second load comes from the cache');

    clearExplainerCacheForTests();
    withPack = false;
    const fallback = await loadPack('demo-slug', points, timeline);
    withPack = true;
    assert.equal(fallback.origin, 'timeline.json');
    assert.equal(fallback.deepdive.length, 0);
    assert.equal(fallback.scenes.length, 6);
    clearExplainerCacheForTests();
  });

  it('without a token nothing private is requested', async () => {
    clearExplainerCacheForTests();
    const saved = process.env.EXPLAINER_CONTEXT_TOKEN;
    delete process.env.EXPLAINER_CONTEXT_TOKEN;
    upstream.seen.length = 0;
    const pack = await loadPack('demo-slug', points, timeline);
    process.env.EXPLAINER_CONTEXT_TOKEN = saved;
    assert.equal(pack.origin, 'timeline.json');
    assert.equal(upstream.seen.filter((r) => /context\.json|deepdive\.md/.test(r.url)).length, 0);
  });

  it('loadPageContext carries the pack non-enumerably (never serialised)', async () => {
    clearExplainerCacheForTests();
    const page = await loadPageContext({ slug: 'demo-slug', t: 30, pointId: 'el2a' });
    assert.ok(page.pack.deepdive.length > 0);
    assert.equal(page.pack.elements.el2a.scene, 'scene2');
    assert.ok(!JSON.stringify(page).includes('Vertiefung'));
    assert.ok(!Object.keys({ ...page }).includes('pack'));
  });
});

describe('packing per provider', () => {
  const pack = bigPack();
  for (const provider of ['xai', 'openai', 'gemini', 'text']) {
    it(`${provider}: priority order and budget`, () => {
      const lines = pagePackLines(pageWith(pack), { provider });
      const out = lines.join('\n');
      assert.ok(out.length <= PAGE_BUDGET[provider], `${out.length} > ${PAGE_BUDGET[provider]}`);
      const at = (s) => out.indexOf(s);
      assert.ok(at('Angeklickt: "el2a"') > 0 && at('Angeklickt: "el2a"') < at('Vollständiger Sprechtext des Videos'));
      assert.ok(at('Vollständiger Sprechtext des Videos') < at('Szenen und Elemente'));
      assert.ok(at('Szenen und Elemente') < at('Hintergrunddokument'));
      assert.match(out, /Florian hat gerade dieses Element angeklickt; seine erste Frage bezieht sich sehr wahrscheinlich darauf/);
      assert.match(out, /\[00:28–00:57\] Zahlungsfluss:/);
      assert.ok(out.includes(TRUNCATION), 'a 100k deep-dive must be cut with the marker');
      assert.match(out, /explainer_context/);
      // the clicked scene's narration is in full in the element block
      assert.ok(out.includes(`Vollständiger Sprechtext dieser Szene: ${timeline.scenes[1].text.trim()}`));
    });
  }
  it('relevant deep-dive sections (keyword overlap with the clicked scene) come first', () => {
    const order = orderSections(pack, 'Zahlungsfluss Detail A Zahlungsfluss');
    assert.match(order[0].heading, /Zahlungsfluss/);
    const out = pagePackLines(pageWith(pack), { provider: 'xai' }).join('\n');
    const first = out.indexOf('## Vertiefung');
    assert.match(out.slice(first, first + 60), /Zahlungsfluss/);
  });
  it('a small page fits whole, without truncation marker', () => {
    const small = deriveFromTimeline(timeline, points, makeDeepdive({ sections: 3, chars: 500 }));
    const out = pagePackLines(pageWith(small), { provider: 'text' }).join('\n');
    assert.ok(!out.includes(TRUNCATION));
    assert.match(out, /Vertiefung 3/);
  });
  it('the final instructions stay within persona + budget for voice and text', () => {
    const page = pageWith(pack);
    for (const provider of ['xai', 'openai', 'gemini']) {
      const full = voice(page, undefined, { provider });
      assert.ok(full.length - full.indexOf('## Aktuelle Erklärseite') <= PAGE_BUDGET[provider], provider);
    }
    const t = text(page);
    assert.ok(t.length - t.indexOf('## Aktuelle Erklärseite') <= PAGE_BUDGET.text);
  });
  it('without a pack the old page lines remain (point, near transcript, facts)', () => {
    const out = voice({ slug: 'x', title: 'Alt', t: 12, pointId: 'p', point: { title: 'Punkt', short: 's' }, transcriptNear: 'gerade gesprochen', context: 'FAKTENTEXT' }, undefined, { provider: 'xai' });
    assert.match(out, /Punkt/);
    assert.match(out, /gerade gesprochen/);
    assert.match(out, /FAKTENTEXT/);
    assert.match(out, /explainer_point/);
  });
  it('page update text names the new element and its scene narration', () => {
    const u = pageUpdateText(pageWith(pack, 'el5b'));
    assert.match(u, /el5b/);
    assert.ok(u.includes(timeline.scenes[4].text.slice(0, 80)));
    assert.equal(pageUpdateText({ pack }), '');
  });
});

describe('retrieval', () => {
  const pack = deriveFromTimeline(timeline, points, deepdive);
  it('ranks the section about the query first, with DE<->EN expansion', () => {
    const r = searchPack(pack, { query: 'Risikoprüfung Quelle' }, 2500);
    assert.match(r.split('\n\n')[0], /Risikoprüfung/);
    const en = searchPack(pack, { query: 'payment flow' }, 2500); // "payment" -> Zahlung
    assert.match(en, /Zahlungsfluss/);
  });
  it('sceneId, section (heading part or number) and outline', () => {
    assert.match(searchPack(pack, { sceneId: 'scene3' }, 2500), /Szene "scene3"/);
    assert.match(searchPack(pack, { section: 'Herkunft' }, 2500), /Board #12345/);
    assert.match(searchPack(pack, { section: '2' }, 2500), /^## /);
    assert.match(searchPack(pack, {}, 2500), /Szenen:/);
    assert.match(searchPack(pack, { sceneId: 'nope' }, 2500), /Unbekannte Szene/);
    assert.match(searchPack(pack, { query: 'qqqqzzzz' }, 2500), /Nichts zu/);
    assert.match(searchPack(null, { query: 'x' }), /kein Hintergrunddokument/);
  });
  it('respects the size limit', () => {
    for (const max of [600, 2500, 4000]) assert.ok(searchPack(bigPack(), { query: 'Zahl Quelle Alphabetrieb' }, max).length <= max, String(max));
  });
});

describe('explainer_context tool', () => {
  const ctx = (slug = 'demo-slug') => ({ hub: {}, page: { slug }, audit: () => {} });
  it('answers from the current page of the conversation', async () => {
    clearExplainerCacheForTests();
    const r = await runTool('explainer_context', { query: 'Datenquellen' }, ctx());
    assert.equal(r.ok, true);
    assert.match(r.content, /Datenquellen/);
    assert.ok(r.content.length <= 6000);
  });
  it('accepts the alias arguments and fails cleanly without a page', async () => {
    assert.equal((await runTool('explainer_context', { scene: 'scene2' }, ctx())).ok, true);
    const none = await runTool('explainer_context', { query: 'x' }, { hub: {}, page: null, audit: () => {} });
    assert.equal(none.ok, false);
    assert.match(none.content, /no explainer page/);
  });
  it('honours maxChars (voice cap)', async () => {
    const r = await runTool('explainer_context', { query: 'Zahl Quelle' }, { ...ctx(), maxChars: 800 });
    assert.ok(r.content.length <= 800);
  });
});

describe('no leaking to the browser', () => {
  it('the explainer proxy refuses the private files and never asks upstream for them', async () => {
    upstream.seen.length = 0;
    for (const f of ['deepdive.md', 'context.json']) {
      const res = await fetch(`${gw.base}/api/explainer/demo-slug/${f}`, { headers: { cookie } });
      assert.ok([400, 404].includes(res.status), f);
      assert.ok(!(await res.text()).includes('Vertiefung'));
    }
    assert.equal(upstream.seen.filter((r) => /deepdive|context\.json/.test(r.url)).length, 0);
  });
  it('only the model-facing modules mention the deep-dive or the context token', () => {
    const src = path.resolve(import.meta.dirname, '../src');
    const allowed = new Set(['pack.js', 'page.js', 'explainer.js', 'config.js', 'tools.js', 'prompt.js', 'vizFacts.js']);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const file of walk(src).filter((f) => f.endsWith('.js'))) {
      const body = fs.readFileSync(file, 'utf8');
      if (!allowed.has(path.basename(file))) assert.ok(!/deepdive|EXPLAINER_CONTEXT_TOKEN|explainerContextToken/i.test(body.replace(/\/\/.*$/gm, '')), path.relative(src, file));
    }
    // routes: http.js/server.js hand the browser nothing from the pack
    for (const f of ['server.js', 'http.js', 'chat.js']) assert.ok(!/\.pack\b|deepdive/i.test(fs.readFileSync(path.join(src, f), 'utf8')), f);
  });
});

describe('voice session', () => {
  async function harness(t, { loadPage } = {}) {
    const { runVoiceSession } = await import('../src/voice/session.js');
    const ws = new EventEmitter();
    ws.OPEN = 1; ws.CONNECTING = 0; ws.readyState = 1; ws.sent = []; ws.send = (d) => ws.sent.push(d); ws.close = () => { ws.readyState = 3; };
    const audits = [];
    const created = [];
    const calls = [];
    const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult() {}, close() {}, updatePage: (txt, o) => { calls.push([txt, o.instructions()]); return 'sent'; } };
    const toolPages = [];
    const canvasPages = [];
    const deps = {
      sid: 's', toolDefs: [], audit: (e) => audits.push(e), makeCtx: (p) => { toolPages.push(p); return { page: p }; }, loadPage,
      createCanvas: () => ({ setPage: (p) => canvasPages.push(p), noteTurn() {}, noteTool() {}, close() {}, cancelAll() {}, idle: async () => {} }),
      limits: { check: () => ({ ok: true }), addCost() {} }, createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
      runTool: async () => ({ summary: 's', content: 'x' }),
    };
    runVoiceSession(ws, deps, { provider: 'xai', apiKey: 'k', create: (o) => { created.push(o); return adapter; } });
    const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
    t.after(() => msg({ type: 'stop' }));
    return { msg, created, audits, calls, toolPages, canvasPages, emit: (e) => ws.emit('x', e) };
  }
  it('builds the instructions from the server-side pack, not from the browser page', async (t) => {
    clearExplainerCacheForTests();
    const h = await harness(t, { loadPage: loadPageContext });
    h.msg({ type: 'start', page: { slug: 'demo-slug', t: 30, pointId: 'el2a', point: { title: 'FORGED' }, transcriptNear: 'FORGED' } });
    await new Promise((r) => setTimeout(r, 150));
    const instr = h.created[0].instructions;
    assert.match(instr, /Angeklickt: "el2a"/);
    assert.match(instr, /Zahlungsfluss Detail A/);
    assert.ok(!instr.includes('FORGED'));
    assert.match(instr, /Hintergrunddokument/);
  });
  it('falls back to the browser page when the loader fails; a second start is ignored', async (t) => {
    const h = await harness(t, { loadPage: async () => { throw new Error('down'); } });
    h.msg({ type: 'start', page: { slug: 'demo-slug', title: 'Roh', t: 1 } });
    h.msg({ type: 'start', page: { slug: 'demo-slug', title: 'Zweit', t: 1 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.created.length, 1);
    assert.match(h.created[0].instructions, /Roh/);
    assert.ok(h.audits.some((a) => a.action === 'voice.page.fallback'));
  });
  it('a page message with another clicked element updates the adapter and the tools\' page', async (t) => {
    clearExplainerCacheForTests();
    const h = await harness(t, { loadPage: loadPageContext });
    h.msg({ type: 'start', page: { slug: 'demo-slug', t: 30, pointId: 'el2a' } });
    await new Promise((r) => setTimeout(r, 150));
    h.msg({ type: 'page', page: { slug: 'demo-slug', t: 90, pointId: 'el4b' } });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0][0], /el4b/);
    assert.match(h.calls[0][1], /Angeklickt: "el4b"/);
    assert.ok(h.audits.some((a) => a.action === 'voice.page.update'));
    assert.equal(h.canvasPages.at(-1)?.pointId, 'el4b'); // critic r2 P1-2: the voice canvases draw from the new click too
    h.msg({ type: 'page', page: { slug: 'other-slug', pointId: 'el1a' } }); // another page: ignored
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.calls.length, 1);
  });
});

describe('adapters: page update channel', () => {
  it('openai appends to the instructions, xai replaces them, gemini holds the update for its next turn', async () => {
    const { WebSocketServer } = await import('ws');
    const { createOpenAI } = await import('../src/voice/openai.js');
    const { createXai } = await import('../src/voice/xai.js');
    const { createGemini } = await import('../src/voice/gemini.js');
    for (const [name, create] of [['openai', createOpenAI], ['xai', createXai], ['gemini', createGemini]]) {
      const wss = new WebSocketServer({ port: 0 });
      const frames = [];
      wss.on('connection', (s) => s.on('message', (d) => frames.push(JSON.parse(d.toString()))));
      const adapter = create({ apiKey: 'k', instructions: 'x', tools: [], url: `ws://127.0.0.1:${wss.address().port}` }, () => {});
      await new Promise((r) => setTimeout(r, 150));
      const how = adapter.updatePage('UPDATE-TEXT', { instructions: () => 'NEUE-INSTRUKTIONEN' });
      adapter.sendText('Frage');
      await new Promise((r) => setTimeout(r, 100));
      if (name === 'openai') { assert.equal(how, 'sent'); assert.ok(frames.some((f) => f.type === 'session.instructions.append' && f.content === 'UPDATE-TEXT')); }
      if (name === 'xai') { assert.equal(how, 'sent'); assert.ok(frames.some((f) => f.type === 'session.update' && f.session.instructions === 'NEUE-INSTRUKTIONEN')); }
      if (name === 'gemini') { assert.equal(how, 'held'); assert.ok(frames.some((f) => f.realtimeInput?.text?.startsWith('UPDATE-TEXT') && f.realtimeInput.text.endsWith('Frage'))); }
      adapter.close();
      wss.close();
    }
  });
});
