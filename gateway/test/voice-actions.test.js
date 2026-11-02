// voiceActions.js without a session: trigger families, age/window rules, refusals, failure texts, limits, redaction.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv } from './helpers/env.js';

setEnv({});
const { runTool } = await import('../src/tools.js');
const { hasTrigger, MAIN_TRIGGER, JOB_TRIGGER, jaccard, resetActions } = await import('../src/voiceActions.js');
const { Limits } = await import('../src/limits.js');
const { TEXT } = await import('../src/messages.js');
const { syn } = await import('./synthetic.js');

const NOW = 5_000_000;
const clock = { now: () => NOW, sleep: async () => {} };
const entry = (text, age = 1000) => ({ text, at: NOW - age, turn: 1 });
function ctx(spoken, o = {}) {
  const log = { commands: [], hub: [], audit: [], trace: [] };
  const vt = { spoken: () => spoken, fromFragment: false, oldChain: false, speaking: () => false, epoch: () => 1, provider: 'openai', turn: 3, ...o.vt };
  return {
    log, sid: 's', clock, voiceTurn: vt, audit: (e) => log.audit.push(e), limits: o.limits ?? new Limits(),
    trace: () => ({ aid: 'a#abcdef', event: (type, data) => log.trace.push({ type, ...data }) }),
    vision: { command: async (sid, cmd) => { log.commands.push(cmd); return o.vision ?? { id: 'p1', delivered: true, state: 'done', code: 'typed' }; } },
    hub: { call: async (method, params, opts) => { log.hub.push({ method, params, opts }); if (o.hubError) throw new Error(o.hubError); return o.hubResult ?? { name: 'voice-x-20261102', host: 'auto', card: 'queued' }; } },
  };
}
const main = (c, text = 'Prompt') => runTool('output_main_agent_prompt', { text }, c);
const job = (c, a = {}) => runTool('start_agent_job', { title: 'Check disk', prompt: 'Prüfe die Platte', ...a }, c);
beforeEach(() => resetActions());

describe('trigger families (case-insensitive, tolerant to speech recognition)', () => {
  const MAIN = ['Schreib das dem Main Agent', 'dem main-agent', 'MAINAGENT', 'der Men Agent', 'men-agent', 'sag dem Hauptagent', 'Haupt Agent bitte', 'haupt-agent', 'der Stabschef', 'Stabs Chef', 'stabs-chef', 'Chief of Staff', 'chief-of-staff'];
  const NOT_MAIN = ['domain agent', 'der Agent', 'Claude Code', 'Haupt Straße', 'Chief Executive'];
  const JOB = ['mit Claude Code', 'mit Cloud Code', 'mit Clod Code', 'Klaude Code', 'Clode-Code', 'klaud code', 'ClaudeCode', 'starte einen Agent Job', 'einen Agenten-Job', 'agentenjob', 'Job auf Sandy', 'eine Session auf LeChonk', 'Sitzung auf Le Chonk', 'der Agent läuft auf sendy', 'der Job bei Sandi', 'Session le-chong', 'agent auf lechong', 'auf Sandy', 'on LeChonk', 'auf Le-Chonk'];
  const NOT_JOB = ['Hauptagent', 'Code', 'cloud storage', 'der Sandy Beach', 'darauf sandy', 'Job gestern', 'job ' + 'x'.repeat(50) + ' sandy'];
  for (const text of MAIN) it(`MAIN: "${text}"`, () => { assert.ok(MAIN_TRIGGER.test(text)); assert.ok(hasTrigger('output_main_agent_prompt', [entry(text)], NOW)); });
  for (const text of NOT_MAIN) it(`not MAIN: "${text}"`, () => assert.ok(!MAIN_TRIGGER.test(text)));
  for (const text of JOB) it(`JOB: "${text}"`, () => { assert.ok(JOB_TRIGGER.test(text), text); assert.ok(hasTrigger('start_agent_job', [entry(text)], NOW)); });
  for (const text of NOT_JOB) it(`not JOB: "${text}"`, () => assert.ok(!JOB_TRIGGER.test(text), text));

  it('only the last 3 entries, none older than 3 minutes; a trigger split over fragments counts', () => {
    const old = [entry('Hauptagent', 3 * 60_000 + 1)];
    assert.ok(!hasTrigger('output_main_agent_prompt', old, NOW));
    assert.ok(hasTrigger('output_main_agent_prompt', [entry('Hauptagent', 3 * 60_000)], NOW));
    assert.ok(!hasTrigger('output_main_agent_prompt', [entry('Hauptagent'), entry('a'), entry('b'), entry('c')], NOW), 'four entries back is too far');
    assert.ok(hasTrigger('start_agent_job', [entry('mit Claude'), entry('Code bitte')], NOW));
    assert.ok(!hasTrigger('start_agent_job', [entry('Hauptagent')], NOW), 'the two tools have their own words');
    assert.ok(!hasTrigger('output_main_agent_prompt', [entry('mit Claude Code')], NOW));
  });
});

describe('refusals', () => {
  it('no trigger: {ok:false}, German hint, nothing done, action.refused audited', async () => {
    const c = ctx([entry('Mach mal was mit dem Bildschirm')]);
    const r = await main(c);
    assert.equal(r.ok, false);
    assert.match(r.content, /^Nichts passiert: Florian hat dafür kein Auslösewort gesagt\. Frage ihn in einem kurzen Satz.*"Main Agent", "Hauptagent" oder "Stabschef"/);
    assert.equal(c.log.commands.length, 0);
    assert.ok(c.log.audit.some((a) => a.action === 'action.refused' && /no-trigger/.test(a.detail)));
    const j = await job(c);
    assert.match(j.content, /"Claude Code" oder "Agent Job auf Sandy\/LeChonk"/);
    assert.equal(c.log.hub.length, 0);
  });
  it('fragment / old chain: refused with the call-again hint', async () => {
    for (const vt of [{ fromFragment: true }, { oldChain: true }]) {
      const c = ctx([entry('Hauptagent Claude Code')], { vt });
      assert.match((await main(c)).content, /Satzfetzen oder einer früheren Frage.*erneut/);
      assert.match((await job(c)).content, /Satzfetzen/);
      assert.equal(c.log.commands.length + c.log.hub.length, 0);
    }
  });
  it('outside a voice session (no voiceTurn)', async () => {
    const c = ctx([entry('Hauptagent')]);
    delete c.voiceTurn;
    const r = await main(c);
    assert.equal(r.ok, false);
    assert.match(r.content, /nur in einem Sprachgespräch/);
  });
  it('a still-speaking session that never settles within 8 s is refused', async () => {
    let t = NOW;
    const slow = { now: () => t, sleep: async (ms) => { t += ms; } };
    const c = ctx([entry('Hauptagent')], { vt: { speaking: () => true } });
    c.clock = slow;
    assert.match((await main(c)).content, /Florian spricht noch/);
    assert.ok(t - NOW >= 8000 && t - NOW < 8300);
  });
});

describe('output_main_agent_prompt results', () => {
  const say = [entry('Schreib dem Hauptagent')];
  it('typed / typed-unverified', async () => {
    assert.match((await main(ctx(say))).content, /^Der Prompt steht im Eingabefeld, nicht abgeschickt\./);
    resetActions();
    const r = await main(ctx(say, { vision: { delivered: true, state: 'done', code: 'typed-unverified' } }));
    assert.equal(r.ok, true);
    assert.match(r.content, /nicht zurücklesen.*Nicht abgeschickt/);
  });
  it('app failures: plain German reason, the app shows the text, no browser event', async () => {
    const cases = { 'no-window': /kein VS-Code-Fenster/, 'no-foreground': /Vordergrund/, 'no-field': /Eingabefeld.*nicht gefunden/, 'wrong-focus': /Fokus/, interrupted: /dazwischen/, busy: /beschäftigt/, 'no-session': /keine aktive Sitzung/ };
    for (const [code, re] of Object.entries(cases)) {
      resetActions();
      const r = await main(ctx(say, { vision: { delivered: true, state: 'failed', code } }));
      assert.equal(r.ok, false, code);
      assert.match(r.content, re, code);
      assert.match(r.content, /^Nicht eingetippt \(.*\)\. Der Screen Agent zeigt den Text selbst mit Kopieren-Knopf\. Sag das Florian in einem Satz\.$/, code);
      assert.equal(r.event, undefined, code);
    }
  });
  it('no-device / no-app: the event carries the text so the desk can show a copy button', async () => {
    for (const code of ['no-device', 'no-app']) {
      resetActions();
      const r = await main(ctx(say, { vision: { delivered: false, code } }), 'Der Text');
      assert.equal(r.ok, false);
      assert.deepEqual(r.event, { type: 'main_agent_prompt', text: 'Der Text' });
      assert.match(r.content, /Nicht eingetippt/);
    }
  });
  it('timeout says it is unclear; a failed attempt may be repeated (not deduped)', async () => {
    const c = ctx(say, { vision: { delivered: true, code: 'timeout' } });
    assert.match((await main(c)).content, /unklar ob etwas getippt wurde/);
    assert.match((await main(c)).content, /unklar/, 'second try goes out again');
    assert.equal(c.log.commands.length, 2);
  });
  it('length 1..8000; the text passes redact before it leaves; trace and audit carry no text', async () => {
    assert.equal((await main(ctx(say), '   ')).ok, false);
    assert.equal((await main(ctx(say), 'x'.repeat(8001))).ok, false);
    const c = ctx(say);
    await main(c, `Nimm ${syn('password: "correct·horse·battery·staple"')} bitte`);
    assert.ok(!JSON.stringify(c.log.commands).includes('horse'));
    assert.ok(!JSON.stringify([c.log.trace, c.log.audit]).includes('Nimm'));
    const t = c.log.trace.find((e) => e.type === 'action.main_prompt');
    assert.deepEqual([t.turn, t.id, t.code, t.delivered], [3, 'p1', 'typed', true]);
    assert.ok(c.log.audit.some((a) => a.action === 'action.main_prompt' && a.detail.includes('a#abcdef')));
  });
});

describe('start_agent_job', () => {
  const say = [entry('Starte mit Claude Code einen Job')];
  it('sends the strict job.start request to the sandy bridge only; short result without paths', async () => {
    const c = ctx([entry('ältere Worte'), ...say]);
    const r = await job(c, { host: 'lechonk' });
    assert.equal(r.ok, true);
    assert.equal(r.content, 'Job voice-x-20261102 läuft. Karte: unterwegs. Sag nur einen kurzen Satz.');
    const [call] = c.log.hub;
    assert.equal(call.method, 'job.start');
    assert.deepEqual(call.opts, { host: 'sandy' });
    assert.deepEqual(Object.keys(call.params).sort(), ['aid', 'host', 'prompt', 'provider', 'requestId', 'spoken', 'title']);
    assert.deepEqual([call.params.host, call.params.aid, call.params.provider], ['lechonk', 'a#abcdef', 'openai']);
    assert.deepEqual(call.params.spoken, ['ältere Worte', 'Starte mit Claude Code einen Job']);
    const a = c.log.audit.find((x) => x.action === 'action.agent_job');
    assert.match(a.detail, /a#abcdef voice-x-20261102 title=Check disk/);
  });
  it('last 6 spoken texts at most; title trimmed to 60; host defaults to auto', async () => {
    const many = Array.from({ length: 9 }, (_, i) => entry(i === 8 ? 'mit Claude Code' : `satz ${i}`, 9000 - i));
    const c = ctx(many);
    await job(c, { title: `T ${'x'.repeat(100)}` });
    assert.equal(c.log.hub[0].params.spoken.length, 6);
    assert.equal(c.log.hub[0].params.title.length, 60);
    assert.equal(c.log.hub[0].params.host, 'auto');
  });
  it('card words', async () => {
    for (const [card, word] of [['sent', 'gesendet'], ['queued', 'unterwegs'], ['pending', 'unterwegs'], ['not-sent', 'nicht gesendet']]) {
      resetActions();
      const r = await job(ctx(say, { hubResult: { name: 'voice-card-20261102', host: 'auto', card } }), { prompt: `eigener Auftrag ${card}`, title: `Title ${card}` });
      assert.match(r.content, new RegExp(`Karte: ${word}\\.`));
    }
  });
  it('dedupe: identical title, or word-set Jaccard >= 0.6, within 3 minutes -> the earlier job name, nothing started', async () => {
    assert.ok(jaccard('a b c d e', 'a b c d f') >= 0.6 && jaccard('a b c', 'x y z') === 0);
    const c = ctx(say);
    await job(c, { title: 'Disk check', prompt: 'Prüfe den Plattenplatz auf Sandy und berichte kurz' });
    const same = await job(c, { title: 'disk  CHECK', prompt: 'ganz anderer Text hier' });
    assert.match(same.content, /läuft schon \(voice-x-20261102\).*Telegram-Karte/);
    const close = await job(c, { title: 'Something else', prompt: 'Prüfe den Plattenplatz auf Sandy und berichte kurz bitte' });
    assert.match(close.content, /läuft schon/);
    const other = await job(c, { title: 'Totally different', prompt: 'Schreibe einen Bericht über die Mails von heute' });
    assert.ok(!/läuft schon/.test(other.content));
    assert.equal(c.log.hub.length, 2);
    assert.equal(c.log.trace.filter((e) => e.type === 'action.agent_job' && e.duplicate).length, 2);
  });
  it('dedupe window is 3 minutes', async () => {
    const c = ctx(say);
    await job(c, { title: 'Disk check', prompt: 'gleicher Auftrag' });
    c.clock = { now: () => NOW + 3 * 60_000 + 1, sleep: async () => {} };
    c.voiceTurn.spoken = () => [{ text: 'Claude Code', at: NOW + 3 * 60_000, turn: 1 }];
    await job(c, { title: 'Disk check', prompt: 'gleicher Auftrag' });
    assert.equal(c.log.hub.length, 2);
  });
  it('limits.check(sid, "agentJob"): 20 per day, then refused without a bridge call', async () => {
    const limits = new Limits();
    const c = ctx(say, { limits });
    for (let i = 0; i < 20; i += 1) assert.ok(limits.check('s', 'agentJob').ok);
    const r = await job(c);
    assert.equal(r.ok, false);
    assert.match(r.content, /Tageslimit für Agent-Jobs/);
    assert.equal(c.log.hub.length, 0);
  });
  it('bridge offline: German failure, no retry, and the same task may be tried again later', async () => {
    const c = ctx(say, { hubError: TEXT.bridgeOffline('sandy') });
    const r = await job(c);
    assert.equal(r.ok, false);
    assert.match(r.content, /nicht gestartet \(die Werkstatt auf Sandy ist offline\)\. Sag das Florian in einem Satz\./);
    assert.equal(c.log.hub.length, 1);
    await job(c);
    assert.equal(c.log.hub.length, 2, 'a failure is not a duplicate');
  });
  it('bridge too slow: unclear whether it started -> told not to start again, and the twin is deduped', async () => {
    const c = ctx(say, { hubError: TEXT.bridgeSlow });
    assert.match((await job(c)).content, /Unklar, ob der Job gestartet wurde.*nicht nochmal/);
    assert.match((await job(c)).content, /läuft schon/);
    assert.equal(c.log.hub.length, 1);
  });
  it('a bridge answer without a valid job name is not a success; the text never carries paths or the prompt', async () => {
    const r = await job(ctx(say, { hubResult: { name: '/etc/passwd', card: 'sent' } }));
    assert.equal(r.ok, false);
    const ok = await job(ctx(say), { title: 'Other', prompt: 'Völlig anderer Auftrag mit ganz anderen Wörtern hier' });
    assert.ok(!/\/home|Prüfe die Platte/.test(ok.content));
  });
  it('a secret in the task never comes back in the result text', async () => {
    const r = await job(ctx(say, { hubError: syn('password: "correct·horse·battery·staple"') }), { prompt: 'Ein völlig neuer Auftrag zum Testen der Schwärzung' });
    assert.ok(!r.content.includes('horse'));
  });
});
