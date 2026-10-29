// Round 11 (critic r10 §7 item 1): "zeichne das / dazu" refers to THIS conversation's canvas (the one the browser shows, else
// the conversation's own last one), never to the newest canvas of another conversation. Synthetic data only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_EARLY: '1', DESK_CANVAS_TIMEOUT_MS: '800', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { createCanvasBus } = await import('../src/canvasBus.js');
const { conversationKey, createCanvasRegistry, createCanvasSession, createIllustrator } = await import('../src/illustrator.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const { TOOL_DEFS, runTool } = await import('../src/tools.js');

const VIDEO_Q = 'Wie funktioniert die Video-Sendeblockierung?';
const ENGINES_Q = 'Welche Engines dürfen Agenten nutzen und mit welchen Limits?';
const FOLLOW = 'Kannst du mir dazu ein Diagramm zeichnen?';
const flow = (title) => JSON.stringify({ v: 2, id: 'x', kind: 'flow', title, caption: 'Test.', sources: [], nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'notify --video', shape: 'diamond' }, { id: 'c', label: 'exit 75' }, { id: 'd', label: 'Telegram' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'b', to: 'd' }] });
const table = { v: 2, id: 'engines-tabelle', kind: 'table', title: 'Engines und Limits', caption: 'Test.', sources: [{ label: 'x', ref: 'Board #1' }], columns: ['Engine', 'Limit'], rows: [['Alpha', '10'], ['Beta', '20']] };
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });

let bus; let calls; let registry;
const complete = async (call) => { calls.push({ ...call, messages: structuredClone(call.messages) }); return answer(flow(/Engines/.test(call.messages[1].content) ? 'Engines' : 'Video-Sendeblockierung')); };
const run = async () => ({ ok: true, content: '{"found":true,"topic":"t"}\n---\nnotify --video verlangt einen Seitenlink, sonst exit 75. Agent Telegram.', summary: 's' });
const illustrator = () => createIllustrator({ bus, hub: {}, complete, run, audit: () => {} });
/** One /api/chat request of conversation `conv`: a new canvas session that knows the conversation's own canvases. */
const request = (ill, conv, messages, focusedId) => {
  const key = conversationKey('sid', conv);
  const s = createCanvasSession({ bus, illustrator: ill, by: 'text', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 5000, focusedId, owner: key, owned: registry.ids(key), onOwn: (id) => registry.note(key, id) });
  for (const m of messages) s.noteTurn(m);
  s.startTurn();
  return { s, decision: s.userTurn(messages.at(-1).text) };
};
const specOf = (id) => bus.latest().find((e) => e.id === id)?.spec;
beforeEach(() => { bus = createCanvasBus(); calls = []; registry = createCanvasRegistry(); });

describe('r11 item 1: the deictic referent is conversation-scoped', () => {
  it('critic repro: B\'s "dazu Diagramm" refines B\'s own video canvas although A\'s table is the newest on the desk', async () => {
    const ill = illustrator();
    const b1 = request(ill, 'conv-b', [{ role: 'user', text: VIDEO_Q }]);
    assert.equal(b1.decision, 'early');
    await b1.s.idle();
    const videoId = registry.ids(conversationKey('sid', 'conv-b'))[0];
    assert.ok(videoId);
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'text' }); // conversation A, later
    assert.equal(bus.latest()[0].id, table.id);
    const b2 = request(ill, 'conv-b', [{ role: 'user', text: VIDEO_Q }, { role: 'assistant', text: 'Ohne Seitenlink kein Versand.' }, { role: 'user', text: FOLLOW }]); // an old client: no focus info
    assert.equal(b2.decision, 'deictic');
    await b2.s.idle();
    assert.deepEqual(specOf(table.id), table, 'A\'s table is untouched');
    assert.equal(bus.latest()[0].id, videoId, 'B\'s drawing refined B\'s own canvas');
    assert.match(calls.at(-1).messages[1].content, new RegExp(`id: ${videoId} \\(Update dieser Zeichnung\\)`));
  });

  it('no own canvas and no focus: a NEW id from the earlier question, never the newest canvas of the desk', async () => {
    const ill = illustrator();
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'voice' });
    const r = request(ill, 'conv-c', [{ role: 'user', text: VIDEO_Q }, { role: 'assistant', text: 'Ohne Seitenlink kein Versand.' }, { role: 'user', text: FOLLOW }]);
    assert.equal(r.decision, 'deictic');
    await r.s.idle();
    assert.deepEqual(specOf(table.id), table);
    assert.equal(bus.latest()[0].id, 'wie-funktioniert-die-video-sendeblockier');
    assert.doesNotMatch(calls.at(-1).messages[1].content, /engines-tabelle/);
  });

  it('the browser\'s focused canvas wins when this conversation drew it (an older own canvas Florian clicked)', async () => {
    const ill = illustrator();
    const a1 = request(ill, 'conv-a', [{ role: 'user', text: ENGINES_Q }]);
    await a1.s.idle();
    const enginesId = bus.latest()[0].id;
    const a2 = request(ill, 'conv-a', [{ role: 'user', text: ENGINES_Q }, { role: 'assistant', text: 'x' }, { role: 'user', text: VIDEO_Q }]);
    await a2.s.idle();
    const videoId = bus.latest()[0].id;
    assert.notEqual(videoId, enginesId);
    const a3 = request(ill, 'conv-a', [{ role: 'user', text: ENGINES_Q }, { role: 'assistant', text: 'x' }, { role: 'user', text: VIDEO_Q }, { role: 'assistant', text: 'y' }, { role: 'user', text: 'zeichne das' }], enginesId);
    assert.equal(a3.decision, 'deictic');
    await a3.s.idle();
    assert.match(calls.at(-1).messages[1].content, new RegExp(`id: ${enginesId} \\(Update dieser Zeichnung\\)`));
  });

  it('a focused canvas of ANOTHER conversation is never overwritten: with an own topic the own one is refined, without one its topic gets a new id', async () => {
    const ill = illustrator();
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'claude' });
    // own earlier question -> own topic, new id (the foreign table is not touched)
    const r1 = request(ill, 'conv-d', [{ role: 'user', text: VIDEO_Q }, { role: 'assistant', text: 'x' }, { role: 'user', text: FOLLOW }], table.id);
    assert.equal(r1.decision, 'deictic');
    await r1.s.idle();
    assert.deepEqual(specOf(table.id), table);
    // a fresh conversation whose first words are "zeichne das genauer" while Florian looks at the foreign table
    const r2 = request(ill, 'conv-e', [{ role: 'user', text: 'Zeichne mir das bitte auf.' }], table.id);
    assert.equal(r2.decision, 'deictic');
    await r2.s.idle();
    assert.deepEqual(specOf(table.id), table, 'still untouched');
    const last = calls.at(-1).messages[1].content;
    assert.match(last, /die Zeichnung, die er gerade sieht: "Engines und Limits"/);
    assert.equal(bus.latest()[0].id, 'engines-und-limits');
    assert.ok(registry.ids(conversationKey('sid', 'conv-e')).includes('engines-und-limits'));
  });

  it('the automatic illustration after the answer offers only this conversation\'s canvas as "aktuelle Zeichnung"', async () => {
    const ill = illustrator();
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'voice' });
    const s = createCanvasSession({ bus, illustrator: ill, by: 'text', emit: () => {}, ctx: {}, debounceMs: () => 10, focusedId: null });
    s.noteTurn({ role: 'user', text: 'Erzähl mir, warum der Versand blockiert wird' });
    s.startTurn();
    s.autoTurn({ userText: 'Erzähl mir, warum der Versand blockiert wird', answerText: 'Weil notify --video ohne Seitenlink mit exit 75 abbricht, damit jedes Video seine Seite hat.' });
    await s.idle();
    assert.ok(calls.length);
    assert.doesNotMatch(calls[0].messages[1].content, /engines-tabelle/);
  });

  it('"ändere die Zeichnung" means the focused canvas; with focus null and nothing own it names no canvas', () => {
    const ill = illustrator();
    bus.publish({ phase: 'ready', id: 'gezeigt-wird-das', kind: 'table', title: 't', spec: { ...table, id: 'gezeigt-wird-das' }, by: 'text' });
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'voice' });
    const pendingIds = () => bus.replay().map((e) => e.event).filter((e) => e.phase === 'pending').map((e) => e.id);
    const r = request(ill, 'conv-f', [{ role: 'user', text: 'Ändere die Zeichnung bitte so, dass Telegram dabei ist' }], 'gezeigt-wird-das');
    assert.equal(r.decision, 'early');
    assert.ok(pendingIds().includes('gezeigt-wird-das'));
    r.s.cancelAll();
    const none = request(ill, 'conv-g', [{ role: 'user', text: 'Ändere die Zeichnung bitte so, dass Telegram dabei ist' }], null);
    assert.ok(!pendingIds().includes(table.id), 'the newest foreign canvas is not claimed');
    none.s.cancelAll();
  });

  it('registry: per conversation, newest last, bounded; conversationKey rejects odd ids', () => {
    const reg = createCanvasRegistry({ maxConversations: 2, maxIds: 2 });
    reg.note('a', 'x'); reg.note('a', 'y'); reg.note('a', 'z'); reg.note('a', 'y');
    assert.deepEqual(reg.ids('a'), ['z', 'y']);
    reg.note('b', 'q'); reg.note('c', 'r');
    assert.deepEqual(reg.ids('a'), [], 'the least recently used conversation left');
    assert.equal(conversationKey('s', 'c_abc123'), 's\u0000c_abc123');
    for (const bad of [undefined, '', 'a b', 'x'.repeat(81), 42]) assert.equal(conversationKey('s', bad), null);
  });
});

describe('r11 item 1 (live Gemini): in a "zeichne das" turn a late drawing about the previous topic does not take the referent\'s id', () => {
  it('canvas_render about another topic gets its own id (history only); one about the referent refines it', async () => {
    const { sharesTopic } = await import('../src/illustrator.js');
    assert.equal(sharesTopic('Ablauf der Emissionen und Steuerabdeckung', 'Wie funktioniert die Video-Sendeblockierung? Video-Sendeblockierung: notify ohne Link'), false);
    assert.equal(sharesTopic('notify --video prüft den Seitenlink', 'Wie funktioniert die Video-Sendeblockierung? Video-Sendeblockierung: notify ohne Link'), true);
    const ill = illustrator();
    const s = createCanvasSession({ bus, illustrator: ill, by: 'voice', provider: 'gemini', emit: () => {}, ctx: {}, audit: () => {}, debounceMs: () => 30, researchMs: () => 5000 });
    s.startTurn(); s.noteTurn({ role: 'user', text: VIDEO_Q }); s.userTurn(VIDEO_Q);
    await s.idle();
    const videoId = bus.latest()[0].id;
    s.startTurn(); s.noteTurn({ role: 'user', text: FOLLOW });
    assert.equal(s.userTurn(FOLLOW), 'deictic');
    await s.idle();
    const nodes = [{ id: 'a', label: 'Emission' }, { id: 'b', label: 'Tranche' }, { id: 'c', label: 'Steuer' }];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }];
    const late = s.render({ kind: 'flow', title: 'Ablauf der Emissionen und Steuerabdeckung', nodes, edges });
    assert.notEqual(late.id, videoId);
    assert.equal(bus.replay().map((e) => e.event).filter((e) => e.id === late.id && e.phase === 'ready').at(-1).focus, false, 'history only');
    assert.equal(specOf(videoId).title, 'Video-Sendeblockierung', 'the referent canvas is untouched');
    const own = s.render({ kind: 'flow', title: 'Video-Sendeblockierung im Detail', nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'notify --video' }, { id: 'c', label: 'exit 75' }], edges });
    assert.equal(own.id, videoId);
  });
});

describe('r11 (live Gemini): a late drawing that arrives while Florian speaks the next question', () => {
  it('goes to the history and does not suppress the new question\'s early drawing', async () => {
    const s = createCanvasSession({ bus, illustrator: illustrator(), by: 'voice', provider: 'gemini', emit: () => {}, ctx: {}, audit: () => {}, debounceMs: () => 30, researchMs: () => 5000 });
    s.startTurn(); s.noteTurn({ role: 'user', text: VIDEO_Q }); s.userTurn(VIDEO_Q);
    await s.idle();
    s.startTurn(); // Florian starts speaking q2; the transcript is not committed yet
    const late = s.render({ kind: 'flow', title: 'Emissionen und Steuer', nodes: [{ id: 'a', label: 'Emission' }, { id: 'b', label: 'Tranche' }, { id: 'c', label: 'Steuer' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.equal(bus.replay().map((e) => e.event).filter((e) => e.id === late.id && e.phase === 'ready').at(-1).focus, false);
    s.noteTurn({ role: 'user', text: ENGINES_Q });
    assert.equal(s.userTurn(ENGINES_Q), 'early', 'the new question still gets its early drawing');
    await s.idle();
  });
});

describe('r11 item 1: voice sessions learn the focused canvas from start / text / focus messages', () => {
  it('start carries focusedCanvasId into the canvas session; {type:"focus"} and typed text update it', async () => {
    const focus = [];
    const ws = new EventEmitter();
    Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
    const deps = {
      sid: 's', toolDefs: TOOL_DEFS, audit: () => {}, runTool, makeCtx: (page) => ({ page, hub: {}, audit: () => {} }),
      limits: { check: () => ({ ok: true }), addCost() {} },
      createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
      createCanvas: (opts) => { focus.push(['create', opts.focusedId]); return { setFocus: (id) => focus.push(['set', id]), noteTurn() {}, userTurn() {}, startTurn() {}, close() {}, autoTurn() {}, turnDone() {}, toolStarted() {}, noteTool() {} }; },
    };
    runVoiceSession(ws, deps, { provider: 'gemini', apiKey: 'k', create: () => ({ sendAudio() {}, sendText() {}, interrupt() {}, close() {}, sendToolResult() {} }) });
    const msg = (o) => ws.emit('message', Buffer.from(JSON.stringify(o)), false);
    msg({ type: 'start', focusedCanvasId: 'video-ablauf' });
    msg({ type: 'focus', focusedCanvasId: 'engines-tabelle' });
    msg({ type: 'focus', focusedCanvasId: null });
    msg({ type: 'text', text: 'zeichne das', focusedCanvasId: 'video-ablauf' });
    msg({ type: 'stop' });
    assert.deepEqual(focus, [['create', 'video-ablauf'], ['set', 'engines-tabelle'], ['set', null], ['set', 'video-ablauf']]);
  });

  it('a voice session refines the canvas the browser focuses when it is its own, never a foreign newest one', async () => {
    const ill = illustrator();
    const s = createCanvasSession({ bus, illustrator: ill, by: 'voice', provider: 'xai', emit: () => {}, ctx: {}, debounceMs: () => 30, researchMs: () => 5000, focusedId: null });
    s.startTurn(); s.noteTurn({ role: 'user', text: VIDEO_Q }); s.userTurn(VIDEO_Q);
    await s.idle();
    const own = bus.latest()[0].id;
    bus.publish({ phase: 'ready', id: table.id, kind: 'table', title: table.title, spec: table, by: 'claude' });
    s.setFocus(table.id); // the stage followed the Claude drawing
    s.startTurn(); s.noteTurn({ role: 'user', text: FOLLOW });
    assert.equal(s.userTurn(FOLLOW), 'deictic');
    await s.idle();
    assert.deepEqual(specOf(table.id), table);
    assert.equal(bus.latest()[0].id, own);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 11 (critic r10 §7 item 2): names / IDs on drawn specs must come from the facts. Every name below is invented test data.
const { createCorpus, dropEntities, unknownEntities } = await import('../src/entityGuard.js');
const { fastCalls, knowledgeTopicOf } = await import('../src/fastPath.js');

const FACTS = 'Offizieller Owner ist Nordwind Labs (Testland); Florian ist Operator. Der Coldkey "kappa" verkauft Tranchen zu 111 α an Wallet Pelikan, dann Börse Merlin, dann EUR. QX7-Owner-Emission. Steuerrücklage ~41 %. Auszahlungen werden geprüft. notify --video NOT SENT exit 75. Kunden: BlauWerk, Sternhaus.';
const INVENTED = { v: 2, id: 'emission-ablauf', kind: 'flow', title: 'Coldkey Kapa und Steuer', caption: 'Ablauf der Auszahlung', sources: [{ label: 'x', ref: 'Gespräch' }],
  nodes: [{ id: 'a', label: 'Nordwind SE: Champion/Stake-Operator', detail: 'Nordwind hält den Champion-Slot' }, { id: 'b', label: 'Wallet „Kapa“', detail: 'KAPA emittiert ZQX-QX7-Owner-Emission' }, { id: 'c', label: 'Pelikan → Merlin' }, { id: 'd', label: 'Steuerrücklage 41 %', detail: 'Prüfung der Auszahlungen' }, { id: 'e', label: 'QX3-Kette' }, { id: 'f', label: 'BlauWerg' }, { id: 'g', label: 'NOT SENT exit 75' }],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd', label: 'via ZQX' }, { from: 'd', to: 'g' }] };
const CLEAN = { ...INVENTED, title: 'Coldkey kappa und Steuer', nodes: [{ id: 'a', label: 'Nordwind Labs', detail: 'offizieller Owner' }, { id: 'b', label: 'Coldkey kappa' }, { id: 'c', label: 'Pelikan → Merlin' }, { id: 'd', label: 'Steuerrücklage 41 %' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] };
const KNOWLEDGE_RESULT = `{"found":true,"topic":"emission-steuer","path":"/home/flori/desk-knowledge/topics/emission-steuer.md"}\n---\n${FACTS}`;

describe('r11 item 2: entity guard on drawn specs', () => {
  it('unknownEntities: invented acronyms, IDs, quoted names and near misses of sourced names; not sourced words, units, inflections, German nouns', () => {
    const corpus = createCorpus({ rich: FACTS, strict: 'Sandy LeChonk' });
    assert.deepEqual(unknownEntities(INVENTED, corpus), ['Kapa', 'SE', 'KAPA', 'ZQX', 'QX3', 'BlauWerg']);
    const fine = { kind: 'flow', title: 'Steuerrücklagen der KG (R7, T6, v3.4)', caption: 'Auszahlung in 3x 111 α, 24h, 10k Requests, API/GPU/EUR.', nodes: [{ id: 'a', label: 'Prüfung', detail: 'Wallet Pelikan auf Sandy' }, { id: 'b', label: 'QX7 Owner-Emission' }, { id: 'c', label: 'BlauWerk und Sternhaus' }] };
    assert.deepEqual(unknownEntities(fine, corpus), []);
    // live r11 false alarms: a quoted placeholder word, an English status word, a German plural next to a caps word
    const live = { kind: 'flow', title: 'Texte und Status', nodes: [{ id: 'a', label: '--no-page-link "Grund"' }, { id: 'b', label: 'GOOD' }, { id: 'c', label: 'Texte' }] };
    assert.deepEqual(unknownEntities(live, createCorpus({ rich: 'TEXT: deepseek; notify --video --no-page-link', strict: '' })), []);
    // JSON / code string literals are no names ("state" is not a source for flagging "Stand"); German spelling of an English word
    const code = { kind: 'table', title: 'Stand', columns: ['Transkript', 'Ost'], rows: [['a', 'b'], ['c', 'd']] };
    assert.deepEqual(unknownEntities(code, createCorpus({ rich: '{"state":"ok","host":"x","type":"transcript","post":1}', strict: '' })), []);
    // a CamelCase part of a sourced identifier, a generic protocol word
    assert.deepEqual(unknownEntities({ kind: 'flow', title: 'CanvasSession über WebSockets', nodes: [] }, createCorpus({ rich: 'export function createCanvasSession()', strict: '' })), []);
  });

  it('dropEntities: nodes naming them go (with their edges), details / edge labels lose them, the title loses the word', () => {
    const out = dropEntities(INVENTED, ['Kapa', 'SE', 'KAPA', 'ZQX', 'QX3', 'BlauWerg']);
    assert.deepEqual(out.nodes.map((n) => n.id), ['c', 'd', 'g']);
    assert.deepEqual(out.edges, [{ from: 'c', to: 'd' }, { from: 'd', to: 'g' }]);
    assert.equal(out.title, 'Coldkey und Steuer');
    const seq = dropEntities({ kind: 'sequence', title: 't', actors: [{ id: 'x', label: 'ZQX-Dienst' }, { id: 'y', label: 'Gateway' }, { id: 'z', label: 'Bridge' }], messages: [{ from: 'x', to: 'y', label: 'a' }, { from: 'y', to: 'z', label: 'ruft ZQX', note: 'n' }, { from: 'y', to: 'z', label: 'b', note: 'über ZQX' }] }, ['ZQX']);
    assert.deepEqual(seq.actors.map((a) => a.id), ['y', 'z']);
    assert.deepEqual(seq.messages, [{ from: 'y', to: 'z', label: 'b' }]);
    const tab = dropEntities({ kind: 'table', title: 't', columns: ['A', 'B'], rows: [['BlauWerg', '1'], ['BlauWerk', '2']] }, ['BlauWerg']);
    assert.deepEqual(tab.rows, [['BlauWerk', '2']]);
  });

  it('critic repro (Gemini t2 early flow): the repair round gets the list; a clean repair is published', async () => {
    const seen = [];
    const ill = createIllustrator({ bus, hub: {}, run: async (name) => (name === 'knowledge_read' ? { ok: true, content: KNOWLEDGE_RESULT } : { ok: true, content: '{"hits":[]}' }), audit: () => {}, complete: async (c) => { seen.push(structuredClone(c.messages)); return answer(JSON.stringify(seen.length === 1 ? INVENTED : CLEAN)); } });
    const r = await ill.draw({ id: 'emission-ablauf', request: 'Es geht um die Emission und die Steuer', question: 'Es geht um die Emission und die Steuer', early: true, by: 'auto', publish: (p) => bus.publish(p) });
    assert.equal(r.ok, true);
    assert.match(seen[1].at(-1).content, /entities that no tool result, knowledge read, page or conversation carries: "Kapa", "SE", "KAPA", "ZQX", "QX3", "BlauWerg"/);
    assert.equal(specOf('emission-ablauf').title, 'Coldkey kappa und Steuer');
  });

  it('a repair that still invents: those nodes / details are dropped, no invented name is published', async () => {
    const ill = createIllustrator({ bus, hub: {}, run: async () => ({ ok: true, content: KNOWLEDGE_RESULT }), audit: () => {}, complete: async () => answer(JSON.stringify(INVENTED)) });
    const r = await ill.draw({ id: 'emission-ablauf', request: 'Zeichne die Kette', by: 'voice', publish: (p) => bus.publish(p), memory: { snapshot: () => ({ turns: [], facts: '' }), toolsUsed: () => [{ name: 'knowledge_read', content: KNOWLEDGE_RESULT }], turnTexts: () => [] } });
    assert.equal(r.ok, true);
    const text = JSON.stringify(specOf('emission-ablauf'));
    for (const bad of ['Kapa', 'KAPA', 'ZQX', 'QX3', 'BlauWerg', 'Nordwind SE']) assert.ok(!text.includes(bad), bad);
    assert.match(text, /Pelikan → Merlin/);
  });

  it('the agent\'s canvas_draw request does not whitelist names (the r10 request itself carried the invented IDs)', async () => {
    const seen = [];
    const ill = createIllustrator({ bus, hub: {}, run: async () => ({ ok: true, content: KNOWLEDGE_RESULT }), audit: () => {}, complete: async (c) => { seen.push(c.messages.at(-1).content); return answer(JSON.stringify({ ...CLEAN, nodes: [...CLEAN.nodes, { id: 'z', label: 'ZQX-QX3-Kette' }], edges: [...CLEAN.edges, { from: 'd', to: 'z' }] })); } });
    await ill.draw({ id: 'kette', request: 'Flussdiagramm der QX3-Kette: (1) ZQX-QX7-Emission an Kapa', by: 'text', publish: (p) => bus.publish(p), memory: { snapshot: () => ({ turns: [], facts: '' }), toolsUsed: () => [{ name: 'knowledge_read', content: KNOWLEDGE_RESULT }], turnTexts: () => [] } });
    assert.match(seen[1], /"ZQX", "QX3"/);
    assert.ok(!JSON.stringify(specOf('kette')).includes('ZQX'));
  });

  it('canvas_render by the agent: the first invented answer goes back with the list, the second is published without those parts', () => {
    const s = createCanvasSession({ bus, illustrator: illustrator(), by: 'text', emit: () => {}, ctx: {}, audit: () => {} });
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Wie läuft die Emission?' });
    s.noteTool({ name: 'knowledge_read', args: {}, ok: true, content: KNOWLEDGE_RESULT });
    const { v, ...args } = INVENTED;
    assert.throws(() => s.render(args), /"Kapa", "SE", "KAPA", "ZQX", "QX3", "BlauWerg"/);
    const r = s.render(args);
    assert.equal(r.shown, true);
    const text = JSON.stringify(specOf(r.id));
    for (const bad of ['Kapa', 'KAPA', 'ZQX', 'QX3', 'BlauWerg']) assert.ok(!text.includes(bad), bad);
    s.startTurn(); // a new turn gets its own repair chance again
    assert.throws(() => s.render(args), /Kapa/);
  });

  it('the conversation counts: a name Florian said may be drawn', () => {
    const s = createCanvasSession({ bus, illustrator: illustrator(), by: 'text', emit: () => {}, ctx: {}, audit: () => {} });
    s.startTurn();
    s.noteTurn({ role: 'user', text: 'Zeichne, wie ZQX an Kapa zahlt (QX3).' });
    const r = s.render({ kind: 'flow', title: 'ZQX an Kapa', nodes: [{ id: 'a', label: 'ZQX' }, { id: 'b', label: 'Kapa' }, { id: 'c', label: 'QX3' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.equal(r.shown, true);
  });

  it('early fast path: a question about a knowledge-index topic reads that topic instead of searching its filler words', () => {
    const index = '# Index\n## emission-steuer — Owner-Emissionen, Steuerrücklage, EUR\nDie Owner-Emission geht an den Coldkey; Tranchen werden für Steuer verkauft.\n\n## server-flotte — Server, Hosts\nDrei Server.\n';
    const q = 'Es geht darum, dass unser Subnetz Honoraremissionen emittiert und ich davon regelmäßig in Euro umwandeln muss, wegen der Steuerlast.';
    assert.equal(knowledgeTopicOf(q, index), 'emission-steuer');
    assert.deepEqual(fastCalls(q, { index })[0], { name: 'knowledge_read', args: { topic: 'emission-steuer' } });
    assert.equal(knowledgeTopicOf('Welche Server haben wir?', index), 'server-flotte');
    assert.equal(knowledgeTopicOf('Wie spät ist es?', index), null);
  });
});
