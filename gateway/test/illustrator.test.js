import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { setEnv } from './helpers/env.js';

setEnv({ DESK_CANVAS_TIMEOUT_MS: '400', DESK_CANVAS_DEBOUNCE_MS: '30' });
// Critic r6 P2-7: the illustrator's timers are unref'd; on Node 20 the test runner then saw an empty event loop and cancelled
// the suites ("Promise resolution is still pending"). One ref'd timer keeps the loop alive until the file is done.
const keepAlive = setInterval(() => {}, 1_000);
after(() => clearInterval(keepAlive));
const { createCanvasBus: createBus } = await import('../src/canvasBus.js');
// what live listeners saw (round 10: failed / dropped placeholders leave the replay ring, so the ring alone no longer tells)
const createCanvasBus = () => { const b = createBus(); b.seen = []; b.subscribe((e) => b.seen.push(e)); return b; };
const { createCanvasSession, createIllustrator, createMemory, deriveSources, groundNumbers, ILLUSTRATOR_TOOLS, SYSTEM_PROMPT } = await import('../src/illustrator.js');

const LEDGER = `${JSON.stringify({ totalsEurApprox: [{ key: 'LLM-APIs', sumEur: 165, count: 33 }, { key: 'GPU', sumEur: 99.5, count: 4 }], source: { kind: 'board', ref: 'Board #22 · Eintrag 25697', asOf: '2026-10-24' } })}\n---\n2026-10-01 | 5 USD | OpenAI | API | LLM-APIs`;
const pie = (extra = {}) => JSON.stringify({ v: 2, id: 'geld', kind: 'pie', title: 'Wohin das Geld geht', caption: 'Meist LLM-APIs.', unit: 'EUR', items: [{ label: 'LLM-APIs', value: 165 }, { label: 'GPU', value: 99.5 }], sources: [{ label: 'Ledger', ref: 'Board #22 · Eintrag 25697' }], ...extra });
const toolCall = (name, args, id = 'c1') => ({ message: { content: '', tool_calls: [{ id, name, args: JSON.stringify(args) }] }, costUsd: 0.001 });
const answer = (content, costUsd = 0.002) => ({ message: { content, tool_calls: [] }, costUsd });

let bus;
let audits;
let calls; // every complete() call
let script; // (call, index) -> result | Promise
let runs; // run() invocations
const complete = async (call) => {
  calls.push({ ...call, messages: structuredClone(call.messages) });
  return script(call, calls.length - 1);
};
const run = async (name, args) => {
  runs.push([name, args]);
  if (name === 'ledger_spend') return { ok: true, content: LEDGER, summary: 's' };
  return { ok: true, content: `{"ok":true}`, summary: 's' };
};
const make = (extra = {}) => createIllustrator({ bus, hub: {}, complete, run, audit: (a) => audits.push(a), ...extra });
const events = () => bus.seen;
const ring = () => bus.replay(0).map((e) => e.event);
const publishTo = (partial) => bus.publish(partial);
const withFacts = () => {
  const m = createMemory();
  m.noteTurn({ role: 'user', text: 'Es sind 165 und 99,50 Euro.' });
  return m;
};
const job = (extra = {}) => ({ request: 'Wofür geben wir das Geld aus?', by: 'voice', provider: 'gemini', publish: publishTo, memory: withFacts(), ...extra });

beforeEach(() => {
  bus = createCanvasBus();
  audits = [];
  calls = [];
  runs = [];
  script = () => answer(pie());
});

describe('illustrator run', () => {
  it('reads a tool, answers with a pie, publishes ready with derived sources and records cost + audit', async () => {
    script = (c, i) => (i === 0 ? toolCall('ledger_spend', { groupBy: 'category' }) : answer(pie({ sources: [] })));
    const result = await make().draw(job({ id: 'geld' }));
    assert.deepEqual([result.ok, result.id, result.kind], [true, 'geld', 'pie']);
    const ready = events().find((e) => e.phase === 'ready');
    assert.deepEqual([ready.by, ready.provider, ready.id, ready.kind], ['voice', 'gemini', 'geld', 'pie']);
    assert.deepEqual(ready.spec.items.map((i) => i.value), [165, 99.5]);
    assert.deepEqual(ready.spec.sources, [{ label: 'Ledger (Board #22)', ref: 'Board #22 · Eintrag 25697' }]);
    assert.equal(ready.spec.unsourced, undefined);
    assert.deepEqual(runs, [['ledger_spend', { groupBy: 'category' }]]);
    // the first call offers only read tools, the second sees the tool result
    assert.deepEqual(calls[0].tools.map((t) => t.name).sort(), [...ILLUSTRATOR_TOOLS].sort());
    assert.ok(calls[0].tools.every((t) => !/^canvas_|^claude_/.test(t.name)));
    assert.equal(calls[1].messages.at(-1).role, 'tool');
    assert.match(calls[1].messages.at(-1).content, /165/);
    const line = audits.find((a) => a.action === 'canvas.draw');
    assert.match(line.detail, /geld pie by=voice .*rounds=2 \([\d+]+ms\) tools=ledger_spend/);
    assert.ok(Math.abs(line.cost_usd - 0.003) < 1e-9);
  });

  it('user message carries request, id, last 8 turns (cut to 700 chars), the facts and the previous spec of the same id', async () => {
    bus.publish({ phase: 'ready', id: 'geld', kind: 'pie', title: 'alt', spec: { id: 'geld', title: 'alt' }, by: 'text' });
    const memory = createMemory();
    for (let i = 0; i < 12; i += 1) memory.noteTurn({ role: i % 2 ? 'assistant' : 'user', text: `turn${i} ${'x'.repeat(900)}` });
    memory.noteTool({ name: 'ledger_spend', args: { groupBy: 'category' }, ok: true, content: 'FAKTEN-ZAHL 165' });
    memory.noteTool({ name: 'canvas_draw', args: {}, ok: true, content: 'NICHT-DABEI' });
    await make().draw(job({ id: 'geld', memory, kind: 'pie' }));
    const user = calls[0].messages[1].content;
    assert.match(user, /Anfrage: Wofür geben wir das Geld aus\?/);
    assert.match(user, /Gewünschte Art: pie/);
    assert.match(user, /id: geld \(Update dieser Zeichnung\)/);
    assert.match(user, /FAKTEN-ZAHL 165/);
    assert.ok(!user.includes('NICHT-DABEI'));
    assert.match(user, /Vorherige Fassung \(id geld\)/);
    assert.ok(!user.includes('turn3 ') && user.includes('turn4 ') && user.includes('turn11 '));
    assert.ok(!user.includes('x'.repeat(701)));
    assert.match(calls[0].messages[0].content, /Heute ist .*Europe\/Berlin/);
  });

  it('repairs once: the validator error goes back to the model in a json round', async () => {
    script = (c, i) => (i === 0 ? answer('{"kind":"radar","title":"x"}') : answer(pie()));
    const result = await make().draw(job({ id: 'geld' }));
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].json, true);
    assert.equal(calls[1].tools, undefined);
    assert.match(calls[1].messages.at(-1).content, /rejected: unknown kind "radar"/);
  });

  it('a second invalid answer ends in an error event "Zeichnung fehlgeschlagen: …" and no ready', async () => {
    script = () => answer('{"kind":"radar","title":"x"}');
    const result = await make().draw(job({ id: 'geld' }));
    assert.equal(result.ok, false);
    assert.equal(calls.length, 2);
    const ev = events();
    assert.deepEqual(ev.map((e) => e.phase), ['error']);
    assert.match(ev[0].message, /^Zeichnung fehlgeschlagen: unknown kind "radar"/);
    assert.equal(ev[0].id, 'geld');
    assert.deepEqual(ring(), [], 'live only: /api/canvas/events replay never brings the failed placeholder back');
  });

  it('prose or fenced JSON is understood; garbage is a repairable error', async () => {
    script = () => answer(`Hier:\n\`\`\`json\n${pie()}\n\`\`\``);
    assert.equal((await make().draw(job({ id: 'geld' }))).ok, true);
    script = () => answer('Ich kann das nicht.');
    const r = await make().draw(job({ id: 'x1' }));
    assert.equal(r.ok, false);
    assert.match(r.error, /not a JSON object/);
  });

  it('numbers that are in no tool result nor in the conversation are dropped (no ledger ran: groundNumbers)', async () => {
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: 'Zeichne 165 und 99,50' });
    script = () => answer(pie({ items: [{ label: 'A', value: 165 }, { label: 'B', value: 99.5 }, { label: 'Erfunden', value: 4711 }], sources: [] }));
    await make().draw(job({ id: 'geld', memory }));
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.items.map((i) => i.label), ['A', 'B']);

    bus = createCanvasBus();
    script = () => answer(pie({ items: [{ label: 'Erfunden', value: 4711 }, { label: 'Auch', value: 4712 }], sources: [] }));
    const r = await make().draw(job({ id: 'geld', memory }));
    assert.equal(r.ok, false);
    assert.match(r.error, /none of the numbers occur/);
  });

  it('numbers from the conversation count as known (the user said "70 zu 30")', async () => {
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: 'Zeichne 70 zu 30' });
    script = () => answer(pie({ items: [{ label: 'A', value: 70 }, { label: 'B', value: 30 }], sources: [] }));
    await make().draw(job({ id: 'split', memory }));
    const ready = events().find((e) => e.phase === 'ready');
    assert.deepEqual(ready.spec.items.map((i) => i.value), [70, 30]);
    assert.equal(ready.spec.unsourced, true); // no tool used, no source claimed
  });

  it('a source the model made up is dropped, "Gespräch" and a really used path stay', async () => {
    const memory = createMemory();
    memory.noteTurn({ role: 'user', text: 'Zeige 70 zu 30' });
    script = () => answer(pie({ items: [{ label: 'A', value: 70 }, { label: 'B', value: 30 }], sources: [{ label: 'Fake', ref: '/etc/passwd' }, { label: 'Gespräch', ref: 'Gespräch' }] }));
    await make().draw(job({ id: 'x2', memory }));
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.sources, [{ label: 'Gespräch', ref: 'Gespräch' }]);
  });

  it('at most 3 tool rounds, then a final json round without tools', async () => {
    let n = 0;
    script = (c) => (c.tools ? toolCall('read_file', { path: `/home/flori/a${(n += 1)}.md` }, `c${n}`) : answer(pie({ items: [{ label: 'A', value: 1 }, { label: 'B', value: 1 }], sources: [] })));
    await make().draw(job({ id: 'tool-loop' }));
    assert.equal(calls.length, 4);
    assert.equal(calls[3].tools, undefined);
    assert.equal(calls[3].json, true);
    assert.equal(runs.length, 3);
    assert.equal(calls[3].messages.at(-1).role, 'user');
    assert.deepEqual(events().find((e) => e.phase === 'ready').spec.sources.map((s) => s.ref), ['/home/flori/a1.md', '/home/flori/a2.md', '/home/flori/a3.md']);
  });

  it('refuses tools outside its read list (claude_task, canvas_draw) and bad tool arguments', async () => {
    script = (c, i) => (i === 0
      ? { message: { content: '', tool_calls: [{ id: 'a', name: 'claude_task', args: '{}' }, { id: 'b', name: 'canvas_draw', args: '{}' }, { id: 'c', name: 'read_file', args: '{broken' }] }, costUsd: 0 }
      : answer(pie({ items: [{ label: 'A', value: 1 }, { label: 'B', value: 1 }] })));
    await make().draw(job({ id: 'guard' }));
    assert.equal(runs.length, 0);
    const tools = calls[1].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.match(tools[0], /not available/);
    assert.match(tools[1], /not available/);
    assert.match(tools[2], /not valid JSON/);
  });

  it('times out after DESK_CANVAS_TIMEOUT_MS with an error event', async () => {
    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const t0 = Date.now();
    const r = await make().draw(job({ id: 'slow' }));
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(r.ok, false);
    assert.deepEqual(events().map((e) => [e.phase, e.message]), [['error', 'Zeichnung fehlgeschlagen: Zeitüberschreitung']]);
  });

  it('a model/network failure becomes the error event', async () => {
    script = () => { throw new Error('Beim Textmodell-Anbieter ist kein Guthaben mehr da'); };
    await make().draw(job({ id: 'oops' }));
    assert.match(events()[0].message, /kein Guthaben/);
  });
});

describe('illustrator concurrency', () => {
  it('a new request for the same id cancels the older run quietly; only the newer publishes', async () => {
    const gates = [];
    script = (c, i) => new Promise((resolve, reject) => {
      c.signal.addEventListener('abort', () => reject(c.signal.reason));
      gates[i] = () => resolve(answer(pie({ title: `Fassung ${i}` })));
    });
    const ill = make();
    const first = ill.draw(job({ id: 'geld' }));
    const second = ill.draw(job({ id: 'geld' }));
    assert.equal(ill.inflight(), 1);
    gates[1]();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.cancelled, true);
    assert.equal(b.ok, true);
    const ev = events();
    assert.deepEqual(ev.map((e) => e.phase), ['ready']);
    assert.equal(ev[0].title, 'Fassung 1');
  });

  it('at most 2 in flight per conversation: the third evicts the oldest, which leaves no failed placeholder (r10)', async () => {
    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const ill = make();
    const a = ill.draw(job({ id: 'eins' }));
    const b = ill.draw(job({ id: 'zwei' }));
    const c = ill.draw(job({ id: 'drei' }));
    assert.equal(ill.inflight(), 2);
    assert.equal((await a).cancelled, true);
    assert.deepEqual(events().map((e) => [e.phase, e.id]), [['dropped', 'eins']]);
    assert.deepEqual(ring(), []);
    ill.cancel('zwei');
    ill.cancel('drei');
    await Promise.all([b, c]);
  });

  it('r10 (critic r9 F6): three conversations in parallel do not cancel each other; an evicted EXISTING id shows its last spec again', async () => {
    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const ill = make();
    const runs3 = ['chat-1', 'voice-2', 'claude-3'].map((lane, i) => ill.draw(job({ id: `frage-${i}`, lane })));
    assert.equal(ill.inflight(), 3);
    assert.deepEqual(events(), [], 'nobody was evicted');
    const old = JSON.parse(pie({ id: 'alt' }));
    bus.publish({ phase: 'ready', id: 'alt', kind: 'pie', title: old.title, spec: old, by: 'text' });
    const x = ill.draw(job({ id: 'alt', lane: 'chat-1' }));
    const y = ill.draw(job({ id: 'neu', lane: 'chat-1' })); // chat-1 now has 3 -> its oldest (frage-0) goes
    assert.equal((await runs3[0]).cancelled, true);
    assert.equal(ill.inflight(), 4);
    ill.draw(job({ id: 'neu2', lane: 'chat-1' })); // evicts 'alt' -> its old spec is shown again
    assert.deepEqual(events().filter((e) => e.id === 'alt').map((e) => e.phase), ['ready', 'ready']);
    for (const id of ['frage-1', 'frage-2', 'neu', 'neu2']) ill.cancel(id);
    await Promise.all([...runs3, x, y]);
  });

  it('quiet (automatic) runs publish nothing on failure and are cancelled by an explicit draw of the current id', async () => {
    script = () => answer('nope');
    const ill = make();
    await ill.draw(job({ quiet: true, by: 'auto' }));
    assert.deepEqual(events(), []);

    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const auto = ill.draw(job({ quiet: true, by: 'auto', currentId: 'geld' }));
    const explicit = ill.draw(job({ id: 'geld' }));
    assert.equal((await auto).cancelled, true);
    assert.equal(ill.inflight(), 1);
    ill.cancel('geld');
    await explicit;
    assert.deepEqual(events(), []);
  });
});

describe('helpers', () => {
  it('deriveSources names what was actually read', () => {
    const used = [
      { name: 'ledger_spend', args: {}, ok: true, content: LEDGER },
      { name: 'code_outline', args: { path: '/home/flori/work/agent-desk/gateway/src' }, ok: true, content: '' },
      { name: 'read_file', args: { path: '/home/flori/AGENTS.md' }, ok: true, content: '' },
      { name: 'read_file', args: { path: '/nope' }, ok: false, content: 'ERROR' },
      { name: 'board_read', args: { thread: '22' }, ok: true, content: '' },
      { name: 'job_status', args: { name: 'job-x' }, ok: true, content: '' },
    ];
    assert.deepEqual(deriveSources(used).map((s) => s.ref), ['Board #22 · Eintrag 25697', '/home/flori/work/agent-desk/gateway/src', '/home/flori/AGENTS.md', 'Board #22', '/home/flori/jobs/job-x']);
  });

  it('groundNumbers tolerates rounding to a whole number but not invention; text kinds are untouched', () => {
    const spec = { kind: 'pie', items: [{ label: 'a', value: 165 }, { label: 'b', value: 99.5 }, { label: 'c', value: 12 }, { label: 'z', value: 0 }] };
    const r = groundNumbers(spec, 'sum 164.62 und 99,50 €');
    assert.deepEqual(r.spec.items.map((i) => i.label), ['a', 'b', 'z']);
    assert.equal(r.dropped, 1);
    assert.equal(groundNumbers({ kind: 'flow', nodes: [] }, '').dropped, 0);
    const line = groundNumbers({ kind: 'line', series: [{ name: 's', points: [{ x: '1', y: 3 }, { x: '2', y: 4 }] }] }, '3');
    assert.deepEqual(line.spec.series[0].points.map((p) => p.y), [3]);
  });

  it('the system prompt carries the numbers rule and the agent desk code location', () => {
    assert.match(SYSTEM_PROMPT, /NUMBERS: use only numbers that literally appear/);
    assert.match(SYSTEM_PROMPT, /\/home\/flori\/work\/agent-desk/);
  });

  it('memory keeps the newest facts within 6000 characters and only real turns', () => {
    const m = createMemory();
    for (let i = 0; i < 10; i += 1) m.noteTool({ name: 'read_file', args: { path: `/f${i}` }, ok: true, content: `F${i} ${'y'.repeat(2000)}` });
    m.noteTurn({ role: 'system', text: 'x' });
    m.noteTurn({ role: 'user', text: '   ' });
    const snap = m.snapshot();
    assert.ok(snap.facts.length <= 6000);
    assert.ok(snap.facts.includes('F9 ') && !snap.facts.includes('F0 '));
    assert.deepEqual(snap.turns, []);
  });
});

describe('canvas session', () => {
  const events2 = [];
  const session = (extra = {}) => {
    events2.length = 0;
    return createCanvasSession({ bus, illustrator: make(), by: 'text', emit: (e) => events2.push(e), ctx: {}, debounceMs: () => 30, ...extra });
  };

  it('render validates, publishes ready on the bus AND the session stream, returns the shown result', () => {
    const s = session();
    const r = s.render({ kind: 'flow', title: 'Ablauf', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.deepEqual(r, { ok: true, id: 'ablauf', kind: 'flow', title: 'Ablauf', shown: true });
    assert.equal(events().length, 1);
    assert.deepEqual(events2, events());
    assert.deepEqual([events2[0].type, events2[0].phase, events2[0].by], ['canvas', 'ready', 'text']);
    assert.throws(() => s.render({ kind: 'radar', title: 'x' }), /unknown kind/);
    assert.equal(events().length, 1);
  });

  it('draw returns at once with status zeichne and a pending event; ready follows from the illustrator', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 70 }, { label: 'B', value: 70 }], sources: [] }));
    const s = session();
    s.noteTurn({ role: 'user', text: 'Zeige 70' });
    const t0 = Date.now();
    const r = s.draw({ request: 'Torte mit 70', kind: 'pie', id: 'mein-geld' });
    assert.ok(Date.now() - t0 < 50);
    assert.deepEqual(r, { ok: true, id: 'mein-geld', status: 'zeichne' });
    assert.deepEqual(events().map((e) => [e.phase, e.id, e.kind]), [['pending', 'mein-geld', 'pie']]);
    await s.idle();
    assert.deepEqual(events().map((e) => e.phase), ['pending', 'ready']);
    assert.equal(events()[1].id, 'mein-geld');
    assert.deepEqual(events2.map((e) => e.phase), ['pending', 'ready']);
    assert.throws(() => s.draw({ request: '   ' }), /what to draw/);
  });

  it('critic r3 P1-2: a refused write is never auto-drawn (early, auto, proposal)', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 3 }, { label: 'B', value: 3 }], sources: [] }));
    const asks = [
      'Schick bitte eine Mail an test@example.org und sag, dass es klappt.',
      'Starte bitte eine neue Claude-Code-Sitzung auf der Bridge.',
      'Poste bitte im Chutes-Discord im Kanal general eine Nachricht.',
      'Deploy bitte den Agent Desk jetzt neu auf Coolify.',
      'Überweise bitte 5 Euro an DE00000000000000000000.',
    ];
    for (const ask of asks) {
      const s = session({ by: 'voice', provider: 'xai' });
      s.startTurn();
      assert.equal(s.userTurn(ask), 'write-intent', ask);
      assert.equal(s.autoTurn({ userText: ask, answerText: 'Das kann der Desk selbst nicht. Die Karte für Florian steht bereit; erst sein Klick gibt den Auftrag weiter.' }), 'write-intent', ask);
      await s.idle();
      s.close();
    }
    assert.equal(calls.length, 0);
    assert.equal(events().length, 0, 'no canvas event at all');
  });

  it('critic r3 P1-2: a turn that produced a handoff / claude proposal is not auto-drawn, a plain explanation still is', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 3 }, { label: 'B', value: 3 }], sources: [] }));
    const s = session({ by: 'voice', provider: 'xai' });
    s.startTurn();
    s.noteTool({ name: 'handoff_propose', args: {}, ok: true, content: '{"proposed":true}' });
    assert.equal(s.autoTurn({ userText: 'Wie läuft das ab, wenn der Agent das macht?', answerText: 'Der Agent bekommt den Auftrag erst nach Florians Klick. Dann arbeitet er ihn ab und meldet sich.' }), 'write-intent');
    await s.idle();
    assert.equal(calls.length, 0);
    s.startTurn(); // next turn: the flag is reset
    assert.equal(s.userTurn('Wie funktioniert der Mailversand im Desk?'), 'early');
    await s.idle();
    s.close();
  });

  it('auto: an explanatory turn without a canvas tool is illustrated once, after the debounce', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 3 }, { label: 'B', value: 3 }], sources: [] }));
    const s = session({ by: 'voice', provider: 'xai' });
    s.noteTurn({ role: 'user', text: 'Wie funktioniert das mit 3 Schritten?' });
    s.noteTurn({ role: 'assistant', text: 'Der Agent ruft notify auf und notify prüft den Link.' });
    assert.equal(s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link.' }), 'scheduled');
    assert.equal(calls.length, 0, 'debounced');
    await s.idle();
    assert.equal(calls.length, 1);
    assert.match(calls[0].messages[1].content, /Anfrage: Illustriere die letzte Antwort/);
    assert.deepEqual(events().map((e) => [e.phase, e.by, e.provider]), [['ready', 'auto', 'xai']]);
    assert.equal(s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link.' }), 'skipped', 'never more than one auto run per turn');
    s.startTurn();
    assert.equal(s.autoTurn({ userText: 'Wie geht das?', answerText: 'Der Agent ruft notify auf und notify prüft den Link.' }), 'scheduled');
    s.close();
  });

  it('auto: skipped when a canvas tool ran, when a tool starts during the debounce, or when the turn is not explanatory', async () => {
    let s = session();
    s.noteTurn({ role: 'user', text: 'Wie funktioniert das?' });
    s.render({ kind: 'flow', title: 'Schon da', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.equal(s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link.' }), 'skipped');

    s = session();
    s.noteTurn({ role: 'user', text: 'Wie funktioniert das?' });
    assert.equal(s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link.' }), 'scheduled');
    s.toolStarted();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, 0);

    s = session();
    s.noteTurn({ role: 'user', text: 'Läuft der Job?' });
    assert.equal(s.autoTurn({ answerText: 'Ja, er läuft seit gestern.' }), 'not-explanatory');
    assert.equal(s.autoTurn({ userText: 'Wie geht das?', answerText: 'ok' }), 'not-explanatory', 'answer too short');
  });

  it('an explicit canvas_draw without an id updates the canvas the automatic run of this turn made; a pending auto run is superseded', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 3 }, { label: 'B', value: 3 }], sources: [] }));
    const s = session();
    s.noteTurn({ role: 'user', text: 'Wie funktioniert das mit 3 Schritten?' });
    s.autoTurn({ answerText: 'Der Agent ruft notify auf und notify prüft den Link.' });
    await s.idle();
    const autoCanvas = events().find((e) => e.phase === 'ready');
    assert.equal(autoCanvas.by, 'auto');
    const r = s.draw({ request: 'Detaillierter: 3 Schritte', id: 'vom-agenten-gewaehlt', kind: 'pie' });
    assert.equal(r.id, autoCanvas.id, 'same turn, same kind -> the same canvas, the browser animates the difference');
    assert.notEqual(s.draw({ request: 'Eine Zeitleiste dazu', kind: 'timeline', id: 'zeit' }).id, autoCanvas.id, 'another kind is another drawing');
    await s.idle();
    s.startTurn();
    assert.notEqual(s.draw({ request: 'Etwas ganz anderes mit 3' }).id, autoCanvas.id, 'a new turn starts fresh');
    s.cancelAll();
  });

  it('an explicit draw cancels an automatic run that is still thinking', async () => {
    script = (c) => new Promise((resolve, reject) => c.signal.addEventListener('abort', () => reject(c.signal.reason)));
    const ill = make();
    const auto = ill.draw(job({ quiet: true, by: 'auto' }));
    const explicit = ill.draw(job({ id: 'direkt' }));
    assert.equal((await auto).cancelled, true);
    ill.cancel('direkt');
    await explicit;
  });

  it('refusal: the illustrator is started at once for the user request, with a pending event, by auto', async () => {
    script = () => answer(pie({ items: [{ label: 'A', value: 5 }, { label: 'B', value: 5 }], sources: [] }));
    const s = session({ by: 'voice', provider: 'gemini' });
    s.noteTurn({ role: 'user', text: 'Zeig mir 5 Dinge' });
    assert.equal(s.autoTurn({ answerText: 'Ich kann leider keine Diagramme direkt auf der Canvas für dich erstellen.' }), 'refusal');
    assert.equal(events()[0].phase, 'pending');
    assert.equal(events()[0].by, 'auto');
    await s.idle();
    assert.equal(events().at(-1).phase, 'ready');
    assert.match(calls[0].messages[1].content, /Anfrage: Zeig mir 5 Dinge/);
    s.startTurn();
    s.render({ kind: 'flow', title: 'Doch gezeichnet', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
    assert.equal(s.autoTurn({ userText: 'x', answerText: 'Ich kann keine Diagramme zeichnen' }), 'refusal-ignored');
  });
});
