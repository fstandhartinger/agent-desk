// a#41d6d2 (14 Nov 2026): a handoff click that fails BEFORE the board is put back and says why; an unclear one stays one-time and says so;
// every click and its outcome is a trace event of the proposing session; the live voice model hears a failure as a passive note.
// All data synthetic.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { setEnv, DESK_ORIGIN } from './helpers/env.js';

setEnv();
const { createHandoffStore, describeFailure, handleHandoff, HANDOFF_LIMITS } = await import('../src/handoff.js');
const { TEXT } = await import('../src/messages.js');
const { timelineLines, localDiagnosis, describeSession } = await import('../src/trace.js');
const { runTool } = await import('../src/tools.js');

/** A fake trace handle: collects events like trace.js's openTrace().event. */
const fakeTrace = () => { const events = []; return { events, event: (type, data) => events.push({ type, data }), recent: () => events.map((e, i) => ({ seq: i + 1, ts: new Date(1_700_000_000_000 + i * 1000).toISOString(), source: 'gateway', type: e.type, data: e.data })), flush: async () => true, aid: 'a#41d6d2' }; };
const req = (id, headers = { origin: DESK_ORIGIN }) => Object.assign(Readable.from([Buffer.from(JSON.stringify({ id }))]), { method: 'POST', headers });
const reply = () => { const r = { status: 0, body: null, headersSent: false, writeHead(s) { r.status = s; }, end(d) { r.body = JSON.parse(d); } }; return r; };
const hubWith = (call, { host = 'sandy' } = {}) => ({ pick: () => host, calls: call.calls, call: async (...a) => { call.calls.push(a); return call(...a); } });
const stub = (fn) => { fn.calls = []; return fn; };

function setup({ contextNote } = {}) {
  const store = createHandoffStore();
  const trace = fakeTrace();
  const notes = [];
  const proposal = store.propose({ sid: 's1', title: 'Regelwerk ändern', task: 'Bitte Regel 2 anpassen (synthetisch).', why: 'Florian hat entschieden', trace, contextNote: contextNote ?? ((t) => notes.push(t)) });
  const audits = [];
  const click = async (hub, id = proposal.id) => { const res = reply(); await handleHandoff(req(id), res, { sid: 's1', ip: '1.2.3.4', hub, store, audit: (e) => audits.push(e) }); return res; };
  return { store, trace, notes, proposal, audits, click };
}
const types = (t) => t.events.map((e) => e.type);

describe('failure before the board: put back, same id, still one-time afterwards', () => {
  it('bridge offline → 502, retry:true, reason names Sandy; the SAME proposal posts on the next click', async () => {
    const s = setup();
    let online = false;
    const hub = hubWith(stub((method) => { if (!online) throw new Error(TEXT.bridgeOffline('sandy')); return { entryId: 777 }; }));
    const first = await s.click(hub);
    assert.equal(first.status, 502);
    assert.equal(first.body.retry, true);
    assert.equal(first.body.error, 'Die Werkstatt auf Sandy ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken.');
    assert.equal(s.store.size(), 1, 'back in the store');
    online = true;
    const second = await s.click(hub);
    assert.deepEqual([second.status, second.body], [200, { ok: true, entryId: 777 }]);
    const third = await s.click(hub);
    assert.equal(third.status, 404, 'one-time once it posted');
    assert.match(third.body.error, /schon angekommen \(Board-Eintrag #777\)/);
    assert.equal(third.body.retry, false);
    assert.equal(hub.calls.length, 2, 'the third click never reaches the bridge');
  });

  it('bridge says not-posted: archived → put back, German reason, retry:true; the daily slot is not used', async () => {
    const s = setup();
    const hub = hubWith(stub(() => { throw new Error('not-posted: board failed: agent-board: Thread #31 is archived; post to an active thread instead.'); }));
    for (let i = 0; i < HANDOFF_LIMITS.perDay + 2; i += 1) {
      const res = await s.click(hub);
      assert.equal(res.status, 502);
      assert.equal(res.body.retry, true);
      assert.match(res.body.error, /^Das Board-Thema für Übergaben war archiviert und ließ sich nicht wieder öffnen – bitte in ein paar Minuten noch einmal klicken\.$/);
    }
    assert.equal(s.store.size(), 1);
  });

  it('an older bridge (no prefix) that only repeats the board refusal is recognised as not-posted too', () => {
    const f = describeFailure(new Error('board failed: agent-board: Thread #31 is archived; post to an active thread instead.'));
    assert.deepEqual([f.kind, f.posted, f.retry], ['archived', false, true]);
    const g = describeFailure(new Error("board failed: agent-board: No thread matches 'Agent Desk handoffs'."));
    assert.deepEqual([g.kind, g.retry], ['no-thread', true]);
  });

  it('bridge limit → retry:true with the limit text; a deterministic validation refusal is not put back', async () => {
    assert.deepEqual(describeFailure(new Error('not-posted: handoff limit reached (10 per day)')).kind, 'limit');
    assert.equal(describeFailure(new Error('not-posted: handoff limit reached (10 per day)')).error, 'Heute wurden schon 10 Aufträge übergeben – bitte morgen wieder');
    const s = setup();
    const res = await s.click(hubWith(stub(() => { throw new Error('not-posted: task required, max 4000 characters'); })));
    assert.equal(res.body.retry, false);
    assert.match(res.body.error, /bitte den Desk um einen neuen Vorschlag bitten/);
    assert.equal(s.store.size(), 0, 'the same task would fail again: not restored');
  });
});

describe('unclear failure: today\'s one-time rule, said plainly', () => {
  for (const [name, message] of [['timeout', TEXT.bridgeSlow], ['connection lost', TEXT.bridgeLost('sandy')], ['posted but no id', 'handoff posted but no entry id returned'], ['plain crash', 'board failed: Traceback (most recent call last): database is locked']]) {
    it(`${name} → retry:false, the proposal is gone, a repeated click gets the unclear text and never reaches the bridge`, async () => {
      const s = setup();
      const hub = hubWith(stub(() => { throw new Error(message); }));
      const first = await s.click(hub);
      assert.equal(first.status, 502);
      assert.equal(first.body.retry, false);
      assert.equal(first.body.error, 'Unklar, ob die Übergabe angekommen ist – bitte nicht noch einmal klicken; ich prüfe das Board.');
      assert.equal(s.store.size(), 0);
      const again = await s.click(hub);
      assert.equal(again.status, 404);
      assert.equal(again.body.retry, false);
      assert.match(again.body.error, /^Unklar, ob die Übergabe angekommen ist/);
      assert.equal(hub.calls.length, 1, 'no second post');
    });
  }

  it('a second click while the first post still runs is told so (no "abgelaufen"), and the first one is not disturbed', async () => {
    const s = setup();
    let release;
    const hub = hubWith(stub(() => new Promise((resolve) => { release = () => resolve({ entryId: 5 }); })));
    const first = s.click(hub);
    await new Promise((r) => setTimeout(r, 10));
    const second = await s.click(hub);
    assert.equal(second.status, 409);
    assert.deepEqual([second.body.retry, second.body.error], [true, 'Die Übergabe läuft gerade – bitte einen Moment warten.']);
    release();
    assert.equal((await first).status, 200);
    assert.equal(hub.calls.length, 1);
  });
});

describe('success shows where it went', () => {
  it('a fallback post carries thread, ids and fallback:true; a reopened thread says so; a normal post stays {ok, entryId}', async () => {
    const s = setup();
    const res = await s.click(hubWith(stub(() => ({ id: 5151, thread: 'Ops & security', threadId: 15, fallback: true, intendedThread: 'Agent Desk handoffs', intendedThreadId: 31 }))));
    assert.deepEqual([res.status, res.body], [200, { ok: true, entryId: 5151, fallback: true, thread: 'Ops & security', threadId: 15, intendedThreadId: 31 }]);
    const t = setup();
    assert.deepEqual((await t.click(hubWith(stub(() => ({ id: 4242, thread: 'Agent Desk handoffs', reopened: true }))))).body, { ok: true, entryId: 4242, reopened: true });
    const u = setup();
    assert.deepEqual((await u.click(hubWith(stub(() => ({ id: 4243, thread: 'Agent Desk handoffs' }))))).body, { ok: true, entryId: 4243 });
  });
});

describe('session trace: every click and outcome', () => {
  it('click → posted (fallback) leaves handoff.click and handoff.posted {entry, thread, fallback} in the proposing trace', async () => {
    const s = setup();
    await s.click(hubWith(stub(() => ({ id: 5151, thread: 'Ops & security', threadId: 15, fallback: true, intendedThreadId: 31 }))));
    assert.deepEqual(types(s.trace), ['handoff.click', 'handoff.posted']);
    assert.equal(s.trace.events[0].data.title, 'Regelwerk ändern');
    const posted = s.trace.events[1].data;
    assert.deepEqual([posted.entry, posted.thread, posted.fallback, posted.threadId, posted.intendedThreadId], [5151, 'Ops & security', true, 15, 31]);
    assert.equal(s.notes.length, 0, 'success needs no alarm note');
  });

  it('a failure leaves handoff.failed {reason, retry} and tells the live model as a passive note', async () => {
    const s = setup();
    await s.click(hubWith(stub(() => { throw new Error(TEXT.bridgeOffline('sandy')); })));
    assert.deepEqual(types(s.trace), ['handoff.click', 'handoff.failed']);
    const failed = s.trace.events[1].data;
    assert.equal(failed.retry, true);
    assert.equal(failed.kind, 'offline');
    assert.match(failed.reason, /^Die Werkstatt auf Sandy ist gerade nicht verbunden/);
    assert.equal(s.notes.length, 1);
    assert.equal(s.notes[0], 'Florians Klick auf die Übergabe-Karte ist fehlgeschlagen: Die Werkstatt auf Sandy ist gerade nicht verbunden – in ein paar Minuten noch einmal klicken.');
    assert.ok(!JSON.stringify(s.trace.events).includes('Traceback'), 'raw error text only as short, redacted detail');
  });

  it('the repeated clicks of the incident (refused after a consumed proposal) are traced as handoff.refused with the reason', async () => {
    const s = setup();
    const hub = hubWith(stub(() => { throw new Error(TEXT.bridgeSlow); }));
    await s.click(hub);
    await s.click(hub);
    await s.click(hub);
    assert.deepEqual(types(s.trace), ['handoff.click', 'handoff.failed', 'handoff.click', 'handoff.refused', 'handoff.click', 'handoff.refused']);
    const refused = s.trace.events[3].data;
    assert.equal(refused.code, 'unclear');
    assert.match(refused.reason, /^Unklar, ob die Übergabe angekommen ist/);
    assert.equal(s.notes.length, 3, 'each failure and refusal reaches the voice model');
  });

  it('refusals before any post (daily limit) are traced and noted; a click of a foreign session is not traced at all', async () => {
    const s = setup();
    for (let i = 0; i < HANDOFF_LIMITS.perDay; i += 1) s.store.take('s1', s.store.propose({ sid: 's1', title: 'x', task: 'y' }).id).commit(i);
    const res = await s.click(hubWith(stub(() => ({ entryId: 1 }))));
    assert.equal(res.status, 429);
    assert.equal(res.body.retry, true);
    assert.deepEqual(types(s.trace), ['handoff.click', 'handoff.refused']);
    const res2 = reply();
    await handleHandoff(req(s.proposal.id), res2, { sid: 'other', ip: 'x', hub: hubWith(stub(() => ({}))), store: s.store, audit: () => {} });
    assert.equal(res2.status, 404);
    assert.equal(s.trace.events.length, 2, 'another session never writes into this trace');
  });

  it('a trace or note that throws never breaks the click', async () => {
    const store = createHandoffStore();
    const bad = { event() { throw new Error('trace down'); } };
    const p = store.propose({ sid: 's1', title: 'T', task: 'X', trace: bad, contextNote: () => { throw new Error('socket gone'); } });
    const res = reply();
    await handleHandoff(req(p.id), res, { sid: 's1', ip: 'x', hub: hubWith(stub(() => { throw new Error(TEXT.bridgeOffline('sandy')); })), store, audit: () => {} });
    assert.equal(res.status, 502);
  });

  it('session_trace shows the click events and the diagnosis names a failed click', async () => {
    const s = setup();
    await s.click(hubWith(stub(() => { throw new Error(TEXT.bridgeOffline('sandy')); })));
    const text = await describeSession({ which: 'current', current: () => s.trace });
    assert.match(text, /handoff\.click "Regelwerk ändern"/);
    assert.match(text, /handoff\.failed .*retry=true Die Werkstatt auf Sandy ist gerade nicht verbunden/);
    assert.match(text, /Diagnose: .*1 fehlgeschlagene\(r\) Klick\(s\) auf die Übergabe-Karte/);
    const ok = setup();
    await ok.click(hubWith(stub(() => ({ id: 5151, thread: 'Ops & security', threadId: 15, fallback: true, intendedThreadId: 31 }))));
    assert.match(timelineLines(ok.trace.recent()).join('\n'), /handoff\.posted Eintrag #5151 FALLBACK in Thema #15 Ops & security/);
    assert.equal(localDiagnosis(ok.trace.recent()), 'Keine Auffälligkeiten im Verlauf.');
  });

  it('the handoff_propose tool stores the session trace and the voice note channel with the proposal (chat and voice ctx shape)', async () => {
    const trace = fakeTrace();
    const noted = [];
    const out = await runTool('handoff_propose', { title: 'Beispiel deployen', task: 'Bitte das Beispiel deployen (synthetisch).' }, { sid: 'sx', hub: { pick: () => 'sandy' }, trace: () => trace, contextNote: (t) => noted.push(t) });
    assert.equal(out.ok, true);
    const { handoffStore } = await import('../src/handoff.js');
    const stored = handoffStore.peek('sx', out.event.id);
    assert.equal(stored.trace, trace);
    stored.contextNote('probe');
    assert.deepEqual(noted, ['probe']);
    assert.ok(!Object.keys(stored).includes('trace') && !Object.keys(stored).includes('contextNote'), 'not enumerable: never serialised with the proposal');
    assert.ok(!JSON.stringify(out.event).includes('probe'));
  });
});
