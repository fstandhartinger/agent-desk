// v0.1.7 gw-voice: announcements are no answer, prompt rules, session finder + stamp, live activity events, illustrator value check.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '600', DESK_CANVAS_DEBOUNCE_MS: '30', DESK_CANVAS_RESEARCH_MS: '60' });
const { isPromiseOnly } = await import('../src/voice/noAnswer.js');
const { screenLines, canvasLines } = await import('../src/prompt.js');
const { buildInstructions } = await import('../src/voice/instructions.js');
const { parseWhich, describeSession } = await import('../src/trace.js');
const { deskStamp, resetActions } = await import('../src/voiceActions.js');
const { activityLabel, TOOL_DEFS } = await import('../src/tools.js');
const { runVoiceSession } = await import('../src/voice/session.js');
const { createCanvasBus } = await import('../src/canvasBus.js');
const { createCanvasSession, createIllustrator, SYSTEM_PROMPT } = await import('../src/illustrator.js');

describe('announcements are no answer (a#624670)', () => {
  it('the exact sentences of the incident are promise-only, real answers are not', () => {
    assert.equal(isPromiseOnly('Ich schaue nach. Die Suche lieferte nichts.'), true, 'a failed step next to an announcement');
    for (const t of ['Ich zeichne dir das auf.', 'Ich lese den Volltext.', 'Ich hole die Karte.', 'Ich male dir das gleich.', 'Das kommt gleich.', 'Ich zeichne dir das auf. Ich lese den Volltext.', 'Ich zeichne dir das'])
      assert.equal(isPromiseOnly(t), true, t);
    for (const t of ['Ich zeichne dir das auf. Die Karte beschreibt die Freigabe von Reax 1.3.', 'Der Job läuft noch.', 'Die Suche lieferte nichts.', 'Ich lese 5 Karten vor.', 'Die Karte sagt, dass die Engine gesperrt wird und dass Florian entscheiden soll.'])
      assert.equal(isPromiseOnly(t), false, t);
  });
});

describe('prompt rules', () => {
  it('named card -> hintergrund first, silent, mishearing by sense, failed steps never spoken', () => {
    const text = screenLines(true).join('\n');
    assert.match(text, /schau zuerst in "hintergrund" der sichtbaren IDs, ohne Suche und ohne es anzukündigen/);
    assert.match(text, /genau DIESE eine/);
    assert.match(text, /verhört Namen/);
    assert.match(text, /direkt an artifact_resolve/);
    assert.match(text, /"Die Suche lieferte nichts" ist verboten/);
  });
  it('only say you draw when canvas_draw runs in the same step', () => {
    assert.match(canvasLines({ spoken: true }).join('\n'), /Rufe canvas_draw .* im selben Schritt auf und kündige es nicht an/);
    assert.match(buildInstructions(null, undefined, { provider: 'xai', screen: true }), /Ankündigung wie "Ich zeichne dir das auf"/);
  });
  it('action tool descriptions: no repo paths from memory, IDs stay IDs', () => {
    for (const name of ['output_main_agent_prompt', 'start_agent_job']) {
      const d = TOOL_DEFS.find((t) => t.name === name).description;
      assert.match(d, /keine Repo- oder Ordnerpfade aus dem Gedächtnis/); assert.match(d, /"IDs" als "IDs"/);
    }
  });
});

const NOW = Date.parse('2026-11-03T11:00:00Z'); // 12:00 in Berlin
describe('session finder', () => {
  it('parseWhich understands last/previous, clock times and time words (Berlin time)', () => {
    for (const w of ['last', 'previous', 'vorherige', 'Davor', 'die letzte', 'die Sitzung davor', 'vorherige Sitzung']) assert.equal(parseWhich(w, NOW).kind, 'last', w);
    for (const w of ['a#3f9c20', '3f9c20', 'some-slug']) assert.equal(parseWhich(w, NOW).kind, 'lookup', w);
    assert.equal(new Date(parseWhich('10:29', NOW).at).toISOString(), '2026-11-03T09:29:00.000Z');
    assert.equal(new Date(parseWhich('um 10 Uhr', NOW).at).toISOString(), '2026-11-03T09:00:00.000Z');
    assert.equal(new Date(parseWhich('13:00', NOW).at).toISOString(), '2026-11-02T12:00:00.000Z', 'later today cannot be meant: yesterday');
    const morning = parseWhich('heute morgen', NOW);
    assert.deepEqual([morning.kind, new Date(morning.from).toISOString(), new Date(morning.to).toISOString()], ['range', '2026-11-03T03:00:00.000Z', '2026-11-03T11:00:00.000Z']);
    assert.equal(parseWhich('vorhin', NOW).from, NOW - 3 * 3_600_000);
    const yesterday = parseWhich('gestern', NOW);
    assert.equal(new Date(yesterday.from).toISOString(), '2026-11-01T23:00:00.000Z');
  });
  const session = (id, start, extra = {}) => ({ id, title: `Sitzung ${id}`, kind: 'voice', provider: 'xai', started_at: start, ...extra });
  const fake = ({ recent, lookup } = {}) => {
    const calls = [];
    return { calls, configured: () => true,
      lookup: async (q, extra = '') => { calls.push(['lookup', q, extra]); return lookup ? lookup(q, extra) : { id: '111111' }; },
      recent: async (query) => { calls.push(['recent', query]); if (recent === 404) throw Object.assign(new Error('registry 404'), { status: 404 }); return recent ?? []; },
      remote: async (id) => { calls.push(['remote', id]); return { events: [], diagnosis: 'Alles gut.' }; } };
  };
  it('"last" asks the registry to exclude the running session and never returns it', async () => {
    const svc = fake({ lookup: (q, extra) => (extra ? { id: '222222' } : { id: '999999' }) });
    const text = await describeSession({ which: 'last', service: svc, current: () => ({ aid: 'a#999999' }), now: NOW });
    assert.deepEqual(svc.calls[0], ['lookup', 'last', '&exclude=999999']);
    assert.match(text, /^Sitzung a#222222/);
  });
  it('an old registry that ignores exclude: the newest other session of the list is taken', async () => {
    const svc = fake({ lookup: () => ({ id: '999999' }), recent: [session('999999', '2026-11-03T10:50:00Z'), session('abcdef', '2026-11-03T09:00:00Z')] });
    assert.match(await describeSession({ which: 'previous', service: svc, current: () => ({ aid: 'a#999999' }), now: NOW }), /^Sitzung a#abcdef/);
    const only = fake({ lookup: () => ({ id: '999999' }), recent: 404 });
    assert.match(await describeSession({ which: 'davor', service: only, current: () => ({ aid: 'a#999999' }), now: NOW }), /keine frühere Sitzung/);
  });
  it('a clock time: the closest session first, up to 3 more candidates with start times', async () => {
    const svc = fake({ recent: [session('aaaaa1', '2026-11-03T08:00:00Z'), session('bbbbb2', '2026-11-03T09:25:00Z', { ended_at: '2026-11-03T09:40:00Z' }), session('ccccc3', '2026-11-03T10:30:00Z'), session('999999', '2026-11-03T09:30:00Z'), session('ddddd4', '2026-11-02T09:30:00Z'), session('eeeee5', '2026-11-01T09:30:00Z')] });
    const text = await describeSession({ which: '10:29', service: svc, current: () => ({ aid: 'a#999999' }), now: NOW });
    assert.match(text, /^Sitzung a#bbbbb2 \(beste Übereinstimmung: a#bbbbb2 03\.11\. 10:25 voice\/xai/);
    assert.match(text, /weitere: a#ccccc3 03\.11\. 11:30[^;]*; a#aaaaa1 03\.11\. 09:00/);
    assert.ok(!text.includes('999999'), 'the running session is no candidate');
    assert.equal(text.match(/a#[0-9a-f]{6} \d\d\.\d\d\./g).length, 4);
    assert.match(svc.calls[0][1], /^\?limit=12&around=2026-11-03T09%3A29%3A00\.000Z$/);
  });
  it('"heute morgen" lists the sessions of that range newest first; nothing inside says so; an old registry gets a hint', async () => {
    const svc = fake({ recent: [session('aaaaa1', '2026-11-03T05:00:00Z'), session('bbbbb2', '2026-11-03T08:30:00Z'), session('ccccc3', '2026-11-02T20:00:00Z')] });
    const text = await describeSession({ which: 'heute morgen', service: svc, now: NOW });
    assert.match(text, /^Sitzung a#bbbbb2 \(beste Übereinstimmung: a#bbbbb2/); assert.match(text, /weitere: a#aaaaa1/); assert.ok(!/ccccc3/.test(text), 'yesterday evening is outside');
    const empty = await describeSession({ which: 'heute morgen', service: fake({ recent: [] }), now: NOW });
    assert.match(empty, /Keine Sitzung zu "heute morgen"/);
    assert.match(await describeSession({ which: 'vorhin', service: fake({ recent: 404 }), now: NOW }), /noch nicht/);
  });
  it('an a#id and a slug still go through the plain lookup', async () => {
    const svc = fake({ lookup: () => ({ id: '3f9c20' }) });
    await describeSession({ which: 'a#3f9c20', service: svc, now: NOW });
    assert.deepEqual(svc.calls[0], ['lookup', 'a#3f9c20', '']);
  });
});

describe('session stamp', () => {
  beforeEach(() => resetActions());
  it('names this and the previous session and the desk-trace command; one lookup per session', async () => {
    let lookups = 0;
    const ctx = { trace: () => ({ aid: 'a#624670' }), traces: { configured: () => true, lookup: async (q, extra) => { lookups += 1; assert.equal(extra, '&exclude=624670'); return { id: '9e36c8' }; } } };
    const stamp = '[Desk: diese Sitzung a#624670, vorherige a#9e36c8; Protokoll: desk-trace a#624670]';
    assert.equal(await deskStamp(ctx), stamp); assert.equal(await deskStamp(ctx), stamp); assert.equal(lookups, 1);
  });
  it('without a previous session, without registry, without id: shorter or empty, never an error', async () => {
    assert.equal(await deskStamp({ trace: () => ({ aid: 'a#abcdef' }) }), '[Desk: diese Sitzung a#abcdef; Protokoll: desk-trace a#abcdef]');
    assert.equal(await deskStamp({ trace: () => ({ aid: null }) }), '');
    assert.equal(await deskStamp({}), '');
    resetActions();
    const failing = { trace: () => ({ aid: 'a#abcdef' }), traces: { configured: () => true, lookup: async () => { throw new Error('down'); } } };
    assert.equal(await deskStamp(failing), '[Desk: diese Sitzung a#abcdef; Protokoll: desk-trace a#abcdef]');
  });
});

describe('activity labels', () => {
  it('every tool has a German label; arguments are redacted and capped; unknown tools show their name', () => {
    for (const t of TOOL_DEFS) assert.ok(activityLabel(t.name, {}) && activityLabel(t.name, {}) !== t.name, t.name);
    assert.equal(activityLabel('output_main_agent_prompt', { text: 'geheim' }), 'Schreibe den Prompt für den Main Agent');
    assert.equal(activityLabel('start_agent_job', { title: 'Check disk' }), 'Starte Agent-Job: Check disk');
    assert.equal(activityLabel('artifact_resolve', { ids: ['a#DBC8F1'] }), 'Lese Karte a#dbc8f1');
    assert.equal(activityLabel('look_at_screen', {}), 'Schaue auf den Bildschirm');
    assert.ok(!/sk-abcdefghijklmnopqrstuvwxyz/.test(activityLabel('search_files', { query: 'sk-abcdefghijklmnopqrstuvwxyz123456' })));
    assert.ok(activityLabel('canvas_draw', { request: 'x'.repeat(500) }).length <= 70);
    assert.equal(activityLabel('totally_unknown', {}), 'totally_unknown');
  });
});

function harness(t, { runTool, provider = 'xai' } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1; ws.readyState = 1; ws.sent = [];
  ws.send = (d) => ws.sent.push(typeof d === 'string' ? JSON.parse(d) : d);
  ws.close = () => { ws.readyState = 3; };
  let emit;
  const adapter = { sendAudio() {}, sendText() {}, interrupt() {}, sendToolResult() {}, close() {}, newTurn() {} };
  const deps = { sid: 's1', toolDefs: [], audit() {}, makeCtx: (p) => ({ page: p }), limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }), runTool: runTool ?? (async () => ({ ok: true, summary: 'fertig', content: 'x' })) };
  runVoiceSession(ws, deps, { provider, apiKey: 'k', create: (_o, e) => ((emit = e), adapter) });
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'start' })), false);
  t.after(() => ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false));
  return { ws, emit: (e) => emit(e), activities: () => ws.sent.filter((m) => m.type === 'activity') };
}
const tick = () => new Promise((r) => setImmediate(r));

describe('live activity events', () => {
  it('heard (80 chars) and thinking for a spoken question; start before the tool runs, done after', async (t) => {
    let seenAtRun;
    const h = harness(t, { runTool: async (name) => { seenAtRun = h.activities().map((a) => a.phase); return { ok: true, summary: 'ok', content: 'x' }; } });
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'speech_started' });
    h.emit({ t: 'transcript', role: 'user', text: `Was steht auf der Karte? ${'sehr lang '.repeat(20)}`, final: true });
    h.emit({ t: 'response_started', id: 'r1' });
    h.emit({ t: 'tool_call', id: 'c1', name: 'artifact_resolve', args: { ids: ['dbc8f1'] }, responseId: 'r1' });
    await tick(); await tick();
    const a = h.activities();
    assert.deepEqual(a.map((x) => x.phase), ['heard', 'thinking', 'start', 'done']);
    assert.ok(a[0].label.length <= 80 && a[0].label.startsWith('Was steht auf der Karte?'));
    assert.equal(a[1].label, 'Verstanden, denke nach …');
    assert.deepEqual([a[2].id, a[2].tool, a[2].label], ['c1', 'artifact_resolve', 'Lese Karte a#dbc8f1']);
    assert.ok(a[3].ms >= 0 && a[3].tool === 'artifact_resolve');
    assert.ok(a.every((x) => typeof x.at === 'number'));
    assert.deepEqual(seenAtRun, ['heard', 'thinking', 'start'], 'start is out before the tool runs');
  });
  it('thinking comes once per question, and not for the greeting', async (t) => {
    const h = harness(t);
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'response_started', id: 'g' });
    h.emit({ t: 'turn_done', id: 'g' });
    h.emit({ t: 'transcript', role: 'user', text: 'Wie geht es dir heute?', final: true });
    h.emit({ t: 'response_started', id: 'r1' });
    h.emit({ t: 'response_started', id: 'r2' });
    await tick();
    assert.deepEqual(h.activities().map((x) => x.phase), ['heard', 'thinking']);
  });
  it('a failing tool (ok:false and thrown) reports fail with a short reason, and no secret leaks into the reason', async (t) => {
    let n = 0;
    const h = harness(t, { runTool: async () => { n += 1; if (n === 1) return { ok: false, summary: 'ERROR: Zugriff verweigert sk-abcdefghijklmnopqrstuvwxyz123456', content: 'ERROR' }; throw new Error('boom'); } });
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'tool_call', id: 'c1', name: 'read_file', args: { path: '/home/flori/a/b.md' } });
    h.emit({ t: 'tool_call', id: 'c2', name: 'search_files', args: { query: 'x' } });
    await tick(); await tick(); await tick();
    const fails = h.activities().filter((x) => x.phase === 'fail');
    assert.equal(fails.length, 2);
    assert.match(fails[0].reason, /Zugriff verweigert/); assert.ok(!fails[0].reason.includes('sk-abcdef'));
    assert.equal(fails[1].reason, 'boom');
    assert.equal(h.activities().find((x) => x.id === 'c1' && x.phase === 'start').label, 'Lese Datei b.md');
  });
  it('without response events (Gemini-like) thinking follows the completed question', async (t) => {
    const h = harness(t, { provider: 'gemini' });
    h.emit({ t: 'ready', model: 'm' });
    h.emit({ t: 'transcript', role: 'user', text: 'Wie viel kostet das? Bitte genau.', final: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(h.activities().map((x) => x.phase), ['heard', 'thinking']);
  });
});

// ---- illustrator value check ----
const flow = JSON.stringify({ v: 2, id: 'x', kind: 'flow', title: 'Ablauf des Links', caption: 'Drei Schritte.', sources: [], nodes: [{ id: 'a', label: 'Agent' }, { id: 'b', label: 'Guard', shape: 'diamond' }, { id: 'c', label: 'Telegram' }], edges: [{ from: 'a', to: 'b', label: 'Video' }, { from: 'b', to: 'c', label: 'ok' }] });
const answer = (content) => ({ message: { content, tool_calls: [] }, costUsd: 0.001 });
const SKIP = JSON.stringify({ skip: true, reason: 'simple fact' });
describe('illustrator value check', () => {
  let bus, audits, calls, script, skipped;
  const seen = () => bus.seen.map((e) => `${e.phase}:${e.id}`);
  const session = () => {
    const illustrator = createIllustrator({ bus, hub: {}, complete: async (c) => { calls.push(structuredClone(c.messages)); return script(calls.length - 1); }, run: async () => ({ ok: true, content: '{}', summary: 's' }), audit: (a) => audits.push(a) });
    return createCanvasSession({ bus, illustrator, by: 'voice', provider: 'xai', emit() {}, ctx: {}, debounceMs: () => 30, researchMs: () => 60, onSkip: (i) => skipped.push(i) });
  };
  const ask = (s, text) => { s.startTurn(); s.noteTurn({ role: 'user', text }); return s.userTurn(text); };
  beforeEach(() => { bus = createCanvasBus(); bus.seen = []; bus.subscribe((e) => bus.seen.push(e)); audits = []; calls = []; skipped = []; script = () => answer(flow); });

  it('the system prompt asks for the decision in the same call', () => {
    assert.match(SYSTEM_PROMPT, /FIRST decide whether a drawing adds real information value/);
    assert.match(SYSTEM_PROMPT, /\{"skip":true,"reason"/);
  });
  it('an early drawing the model skips: the placeholder goes away, nothing is drawn, canvas.skipped is audited and reported', async () => {
    script = () => answer(SKIP);
    const s = session();
    assert.equal(ask(s, 'Wie funktioniert die Video-Sendeblockierung eigentlich genau?'), 'early');
    await s.idle();
    assert.deepEqual(seen().map((x) => x.split(':')[0]), ['pending', 'dropped']);
    assert.equal(calls.length, 1, 'one model call, no extra one for the decision');
    assert.match(audits.find((a) => a.action === 'canvas.skipped').detail, /simple fact/);
    assert.equal(skipped.length, 1); assert.equal(skipped[0].reason, 'simple fact'); assert.equal(skipped[0].by, 'auto');
  });
  it('an explicit "zeichne das" always draws, even if the model first says skip', async () => {
    let n = 0;
    script = () => answer(n++ === 0 ? SKIP : flow);
    const s = session();
    ask(s, 'Erkläre mir den Ablauf des Versands und zeichne das bitte auf.');
    await s.idle();
    assert.ok(seen().some((x) => x.startsWith('ready:')));
    assert.equal(skipped.length, 0); assert.equal(calls.length, 2);
    assert.match(calls[1].at(-1).content, /ausdrücklich verlangt/);
  });
  it('fix-desk S10a: a second skip after the explicit-draw retry is sent back for the CanvasSpec once more, then drawn', async () => {
    let n = 0;
    script = () => answer(n++ < 2 ? SKIP : flow);
    const s = session();
    ask(s, 'Erkläre mir den Ablauf des Versands und zeichne das bitte auf.');
    await s.idle();
    assert.ok(seen().some((x) => x.startsWith('ready:')), 'drawn, not ended as an error');
    assert.equal(calls.length, 3); assert.equal(skipped.length, 0);
    assert.match(calls[2].at(-1).content, /no skip/);
  });
  it('canvas_draw on a yes/no turn or small talk answers "keine Zeichnung nötig" without a model call', async () => {
    const s = session();
    ask(s, 'Läuft der Job gerade noch?');
    const r = s.draw({ request: 'Status des Jobs als Diagramm' });
    assert.deepEqual([r.ok, r.skipped, r.status], [true, true, 'keine Zeichnung nötig']);
    assert.match(r.hinweis, /Keine Zeichnung nötig/);
    assert.equal(calls.length, 0); assert.equal(seen().length, 0);
    assert.equal(skipped[0].reason, 'yes-no');
    ask(s, 'Danke dir!');
    assert.equal(s.draw({ request: 'irgendwas' }).skipped, true); assert.equal(skipped[1].reason, 'small-talk');
  });
  it('an explicit drawing wish is never skipped by the pre-check; the normal result tells the agent the illustrator decides', async () => {
    const s = session();
    ask(s, 'Läuft der Job noch? Zeichne mir das bitte auf.');
    const r = s.draw({ request: 'Jobstatus' });
    assert.equal(r.status, 'zeichne'); assert.match(r.hinweis, /entscheidet die Zeichnerin selbst/);
    await s.idle();
    assert.ok(seen().some((x) => x.startsWith('ready:')));
  });
  it('a model skip of the agent\'s own canvas_draw keeps the existing drawing on the canvas', async () => {
    const s = session();
    ask(s, 'Wie läuft der Versand?'); await s.idle();
    const first = seen().find((x) => x.startsWith('ready:')).split(':')[1];
    script = () => answer(SKIP);
    s.startTurn(); s.noteTurn({ role: 'user', text: 'Und wer prüft das genau, Florian?' });
    s.draw({ request: 'Prüfer', id: first });
    await s.idle();
    assert.equal(bus.latest().find((e) => e.id === first)?.phase, 'ready');
    assert.equal(skipped.length, 1);
  });
});

describe('fix-desk M2: only a bare announcement is promise-only', () => {
  it('the critic\'s five complete answers need no recovery', () => {
    for (const t of ['Ich zeichne kein Diagramm, weil die Antwort eine Zahl ist.', 'Ich öffne die Karte nicht.', 'Ich lade die Karte gerade nicht, weil sie privat ist.', 'Die Suche ergab keine Treffer.', 'Die Karte kommt gleich, sie heißt Lock the Engine.'])
      assert.equal(isPromiseOnly(t), false, t);
  });
  it('bare announcements stay promise-only', () => {
    for (const t of ['Ich zeichne dir das auf.', 'Okay, ich schaue kurz nach.', 'Ich öffne die Karte.']) assert.equal(isPromiseOnly(t), true, t);
  });
});

describe('fix-desk M3: prompt lines agree, a started drawing answers a draw request', () => {
  it('no line tells the model to announce the drawing', () => {
    const all = [...canvasLines({ spoken: true }), ...buildInstructions(null, undefined, { provider: 'xai', screen: true }).split('\n')].join('\n');
    assert.doesNotMatch(all, /sag kurz 'Ich zeichne dir das auf'/);
    assert.match(all, /kündige die Zeichnung nicht an/);
    assert.match(all, /nicht bei Karten auf dem Bildschirm und nicht bei Zeichnungen/);
  });
});
