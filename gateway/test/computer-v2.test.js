// Computer control v2 (9 Nov 2026): the free tool set of the unrestricted mode. Screenshots with a coordinate frame, clicks by coordinates, keys, drag, wheel,
// shells, Python, files, Chrome over CDP; a picture after every action; several actions per model turn; Chrome failing never ends the run.
// The app, the voice session and the loop model are fakes. The replay test follows trace a#ba7990 (9 Nov, "verwende den Computer, um auf Senden zu klicken").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv } from './helpers/env.js';
import { fakeSession, fakeVision, SCREEN_AGENT, until } from './helpers/computer.js';

setEnv({});
delete process.env.DESK_COMPUTER_GUARDS; // the live default; every other computer test file runs with the older rules
const { FREE_TOOLS, FREE_TOOL_NAMES, FREE_PROMPT, FREE_PROMPT_V1, LOOP_TOOLS, LOOP_TOOL_NAMES, checkArgs, clientHasV2, toWire, waitMsFor, toolsNow } = await import('../src/computer/loop.js');
const { createComputer, validateResult, activityLine, maxJpegChars } = await import('../src/computer/run.js');

const JPEG = (n = 40) => 'A'.repeat(n);
const shot = (text = 'frame: screen 1280x720 (Monitor 0, 2560x1440 @150 %)\ncursor: 640,360\nvorn: chrome "Telegram Web"') => ({ ok: true, code: 'done', result: { text, jpeg: JPEG() } });
const done = (summary = 'fertig') => [{ name: 'done', args: { summary } }];

/** A model that answers each turn with a LIST of tool calls (v2 allows several per answer). */
function setup({ turns, app, clientVersion = '0.1.14', costUsd = 0.01 }) {
  const clock = { t: 1_000_000, now: () => clock.t };
  const vision = fakeVision();
  vision.app = app;
  const calls = [];
  let i = 0;
  const complete = async (o) => {
    calls.push({ ...o, messages: structuredClone(o.messages) });
    const mine = i; i += 1;
    const step = typeof turns[mine] === 'function' ? await turns[mine](o.messages) : turns[mine];
    return { message: { content: '', tool_calls: (step ?? []).map((c, k) => ({ id: `t${i}_${k}`, name: c.name, args: JSON.stringify(c.args ?? {}) })) }, usage: { in: 100, out: 20 }, costUsd, ms: 5 };
  };
  const session = fakeSession({ client: { ...SCREEN_AGENT, version: clientVersion } });
  const computer = createComputer({ vision, hub: { call: async () => ({ text: 'ok' }) }, now: clock.now, complete, tickMs: 1e9, limits: { check: () => ({ ok: true }), addCost() {} }, statePath: '' });
  computer.attach('s1', session);
  return { clock, vision, calls, session, computer, ended: () => computer.runOf('s1') === null, actions: () => vision.ofOp('action') };
}
const pictures = (messages) => messages.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')).length;

test('v2 tool set: general desktop control, shells, files and Chrome are all there; the guarded set is unchanged', () => {
  assert.equal(toolsNow(), FREE_TOOLS);
  for (const name of ['screenshot', 'click', 'move', 'drag', 'wheel', 'type', 'key', 'wait', 'ui_windows', 'window_focus', 'window_state', 'open', 'ui_tree', 'ui_find', 'ui_click', 'ui_type', 'ui_read',
    'clipboard_read', 'clipboard_write', 'run_powershell', 'run_cmd', 'run_wsl', 'run_python', 'file_read', 'file_write',
    'chrome_tabs', 'chrome_open', 'chrome_navigate', 'chrome_activate', 'chrome_close', 'chrome_snapshot', 'chrome_click', 'chrome_fill', 'chrome_key', 'chrome_read', 'chrome_eval', 'chrome_screenshot', 'scroll', 'server_read', 'ask_florian', 'done']) assert.ok(FREE_TOOL_NAMES.includes(name), name);
  assert.equal(new Set(FREE_TOOL_NAMES).size, FREE_TOOL_NAMES.length);
  assert.equal(LOOP_TOOL_NAMES.length, 17, 'guarded set untouched');
  for (const t of FREE_TOOLS) { assert.equal(t.parameters.additionalProperties, false, t.name); for (const r of t.parameters.required) assert.ok(r in t.parameters.properties, `${t.name}.${r}`); }
  assert.match(FREE_PROMPT, /LETZTE Bild/);
  assert.match(FREE_PROMPT, /Desktop-Werkzeugen weiter/);
  assert.match(FREE_PROMPT, /DATEN/);
});

test('v2 arguments: coordinates, regions, multi-line text, chords and code pass; wrong shapes are refused before anything leaves the gateway', () => {
  const good = (name, args) => assert.equal(checkArgs(name, args).ok, true, `${name} ${JSON.stringify(args)} ${checkArgs(name, args).error}`);
  const bad = (name, args) => assert.equal(checkArgs(name, args).ok, false, `${name} ${JSON.stringify(args)}`);
  good('click', { x: 640.5, y: 360, button: 'right', count: 2, mods: 'ctrl+shift', step: 'öffne das Kontextmenü' });
  good('drag', { x: 10, y: 10, x2: 300, y2: 200, ms: 800 });
  good('wheel', { dy: -3 });
  good('type', { text: 'Zeile eins\nZeile zwei mit Umlauten äöü und 😀', enter: true });
  good('key', { key: 'ctrl+shift+t' });
  good('key', { key: 'ctrl+a delete', times: 2 });
  good('key', { key: 'strg+umschalt+entf' });
  good('screenshot', { region: [100, 100, 400, 300], grid: true, max: 1600 });
  good('screenshot', {});
  good('run_powershell', { command: 'Get-ChildItem $env:USERPROFILE\\Desktop |\n  Select-Object -First 5', timeout_s: 120 });
  good('run_wsl', { command: 'ls -la ~ && uname -a' });
  good('run_python', { code: 'import os\nprint(os.getcwd())', where: 'wsl' });
  good('file_write', { path: '~/Desktop/notiz.txt', content: 'a\nb', append: true });
  good('chrome_open', { url: 'chrome://inspect/#remote-debugging' });
  good('chrome_eval', { tab: 't3', js: 'return document.title' });
  good('ui_find', { name: 'Senden', window: 'all' });
  good('window_state', { window: 'w3', state: 'maximize' });
  bad('click', { x: '640', y: 360 });
  bad('click', { x: 640 });
  bad('click', { x: 1, y: 2, count: 9 });
  bad('click', { x: Infinity, y: 2 });
  bad('screenshot', { region: [1, 2, 3] });
  bad('screenshot', { region: [1, 2, 3, 2] });
  bad('key', { key: 'ctrl+a; rm -rf' });
  bad('run_powershell', { command: 'x', timeout_s: 100000 });
  bad('wheel', { dy: 500 });
  bad('window_state', { window: 'w3', state: 'explode' });
  bad('ui_click', { ref: 'has spaces' });
  bad('launch_missiles', {});
  bad('click', { x: 1, y: 2, extra: true });
  // `step` is for the activity line only and never reaches the app
  assert.deepEqual(toWire('click', { x: 1, y: 2, step: 'klicke auf Senden' }), { x: 1, y: 2 });
  assert.deepEqual(toWire('scroll', { direction: 'up', amount: 2, tab: 't1', step: 'x' }), { tab: 't1', dy: -240 });
  // long commands get the app's own time limit plus a margin; everything else the default
  assert.equal(waitMsFor('run_powershell', { timeout_s: 300 }), 315_000);
  assert.equal(waitMsFor('run_python', {}), 75_000);
  assert.equal(waitMsFor('click', {}), 30_000);
});

test('v2 results: a picture of up to 1.4 M characters and a 2 MB result pass in the unrestricted mode', () => {
  assert.equal(maxJpegChars(), 1_400_000);
  assert.equal(validateResult({ ok: true, code: 'done', result: { text: 'geklickt', jpeg: 'A'.repeat(1_200_000) } }).ok, true);
  assert.throws(() => validateResult({ ok: true, code: 'done', result: { jpeg: 'A'.repeat(1_400_001) } }));
  assert.throws(() => validateResult({ ok: true, code: 'done', result: { jpeg: 'not base64 !!' } }));
  assert.equal(validateResult({ ok: false, code: 'refused', rule: 'debugging-off', result: { text: 'Chrome ist gerade nicht steuerbar; nimm die Desktop-Werkzeuge.' } }).rule, 'debugging-off');
});

test('the run starts with eyes open: one screenshot before the first model call, the picture and the frame line are in the first request', async () => {
  const h = setup({ turns: [done('nichts zu tun')], app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }) });
  const r = await h.computer.begin('s1', { text: 'Klick auf Senden bei Opnar AI', goalArg: 'x' });
  assert.equal(r.ok, true);
  await until(h.ended);
  assert.deepEqual(h.actions().map((w) => [w.tool, w.args]), [['screenshot', {}]]);
  const first = h.calls[0];
  assert.equal(first.tools, FREE_TOOLS);
  assert.equal(first.parallel, true);
  assert.deepEqual(first.messages[0].content, [{ type: 'text', text: FREE_PROMPT, cache_control: { type: 'ephemeral' } }], 'tools + system prompt are marked cacheable');
  assert.ok(first.messages[1].content.includes('Klick auf Senden bei Opnar AI'));
  assert.equal(pictures(first.messages), 1);
  const boot = first.messages[2].content;
  assert.match(boot[0].text, /frame: screen 1280x720/);
  assert.match(boot[0].text, /<computer_data>/);
  assert.match(boot[1].image_url.url, /^data:image\/jpeg;base64,A+$/);
});

test('several actions in one answer run in order, each with its own activity line; only the last picture goes back; a failing step skips the rest', async () => {
  const seen = [];
  const app = (w) => {
    if (w.op !== 'action') return { ok: true, code: 'done' };
    seen.push(w.tool);
    if (w.tool === 'key' && w.args.key === 'f13') return { ok: false, code: 'refused', rule: 'bad-args', result: { text: 'Taste unbekannt' } };
    return { ok: true, code: 'done', result: { text: `${w.tool} ok`, jpeg: JPEG(10 + seen.length) } };
  };
  const h = setup({
    app,
    turns: [
      [{ name: 'click', args: { x: 400, y: 300, step: 'klicke ins Suchfeld' } }, { name: 'type', args: { text: 'Opnar AI', step: 'tippe den Namen' } }, { name: 'key', args: { key: 'enter' } }],
      [{ name: 'key', args: { key: 'f13' } }, { name: 'click', args: { x: 1, y: 1 } }],
      done('gesucht'),
    ],
  });
  await h.computer.begin('s1', { text: 'Suche nach Opnar AI', goalArg: 'x' });
  await until(h.ended);
  assert.deepEqual(seen, ['screenshot', 'click', 'type', 'key', 'key'], 'the click after the failed key never ran');
  assert.deepEqual(h.actions()[1].args, { x: 400, y: 300 }, 'step stays in the gateway');
  // second request: assistant with 3 calls, 3 tool results, then ONE picture (the last one) besides the first screenshot
  const second = h.calls[1].messages;
  const asst = second.find((m) => m.role === 'assistant');
  assert.equal(asst.tool_calls.length, 3);
  assert.equal(second.filter((m) => m.role === 'tool').length, 3);
  assert.equal(pictures(second), 2);
  assert.ok(second.at(-1).content[1].image_url.url.endsWith('A'.repeat(14)) && !second.at(-1).content[1].image_url.url.endsWith('A'.repeat(15)), 'the picture after the last step');
  // third request: the skipped call is answered as data, so the tool_call ids are all answered
  const third = h.calls[2].messages;
  const tools = third.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 5);
  assert.match(tools[3].content, /bad-args/);
  assert.match(tools[4].content, /"rule":"skipped"/);
  // what he reads while it happens
  const labels = h.session.activities.filter((a) => a.phase === 'start').map((a) => a.label);
  assert.deepEqual(labels.slice(1, 4), ['Computer: klicke ins Suchfeld', 'Computer: tippe den Namen', 'Computer: drücke eine Taste']);
  assert.equal(activityLine('click', null, 'klicke <b>auf</b> Senden'), 'Computer: klicke baufb Senden'); // markup characters never reach the overlay
});

test('done together with actions whose result the model has not seen is refused once; done alone ends the run', async () => {
  const h = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [[{ name: 'click', args: { x: 5, y: 5 } }, { name: 'done', args: { summary: 'geklickt' } }], done('geklickt und geprüft')] });
  await h.computer.begin('s1', { text: 'Klick', goalArg: 'x' });
  await until(h.ended);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].messages.filter((m) => m.role === 'tool').at(-1).content, /done-unverified/);
  assert.equal(h.session.events.find((e) => e.type === 'computer.run.stop').why, 'done');
  assert.match(h.session.said.at(-1), /geklickt und geprüft/);
});

test('replay of 9 Nov (a#ba7990): Chrome cannot be attached, the run goes on with the desktop tools and clicks Senden', async () => {
  const outline = 'r7 Text "Opnar AI (Lund) ein Angebot schicken?" [640,410]\nr8 Button "Senden (empfohlen)" [520,470]\nr9 Button "Ändern" [640,470]';
  const app = (w) => {
    if (w.op !== 'action') return { ok: true, code: 'done' };
    if (w.tool.startsWith('chrome_')) return { ok: false, code: 'refused', rule: 'no-answer', result: { text: 'Chrome ist gerade nicht über CDP steuerbar (keine Antwort auf die Freigabe). Nimm die Desktop-Werkzeuge: screenshot, click, type, key, ui_find, ui_tree.' } };
    if (w.tool === 'ui_find') return { ok: true, code: 'done', result: { text: outline } };
    if (w.tool === 'ui_click') return { ok: true, code: 'done', result: { text: 'ausgelöst', target: 'Senden (empfohlen)', jpeg: JPEG(64) } };
    return shot();
  };
  const h = setup({
    app,
    turns: [
      [{ name: 'chrome_tabs', args: { step: 'lese die Tabs' } }],
      (messages) => { assert.match(messages.filter((m) => m.role === 'tool').at(-1).content, /Desktop-Werkzeuge/); return [{ name: 'ui_find', args: { name: 'Senden', step: 'suche den Senden-Knopf' } }]; },
      [{ name: 'ui_click', args: { ref: 'r8', step: 'klicke Senden bei Opnar AI' } }],
      done('Senden bei der Opnar-AI-Karte geklickt; die Karte zeigt jetzt die Bestätigung.'),
    ],
  });
  const r = await h.computer.begin('s1', { text: 'Im Telegram-Chat bei der Karte zu Opnar AI auf Senden klicken (Florians Worte: Ja, okay, verwende den Computer, um auf Senden zu klicken.)', goalArg: 'x' });
  assert.equal(r.ok, true);
  await until(h.ended);
  assert.deepEqual(h.actions().map((w) => w.tool), ['screenshot', 'chrome_tabs', 'ui_find', 'ui_click']);
  const stop = h.session.events.find((e) => e.type === 'computer.run.stop');
  assert.equal(stop.why, 'done');
  assert.equal(stop.actions, 4);
  const refused = h.session.events.filter((e) => e.type === 'computer.refused');
  assert.deepEqual(refused.map((e) => e.rule), ['no-answer'], 'one refusal, traced with its machine reason');
  assert.match(h.session.said.at(-1), /Senden bei der Opnar-AI-Karte geklickt/);
  // nothing page-shaped in the trace: no outline text, no picture
  const trace = JSON.stringify(h.session.events);
  assert.ok(!trace.includes('Angebot') && !trace.includes('AAAA'));
  assert.ok(h.session.events.some((e) => e.type === 'computer.action' && e.tool === 'ui_click' && e.image === true && e.target === 'Senden empfohlen'));
});

test('a long run stays small: the two newest pictures are kept, older tool results shrink to their head', async () => {
  const big = 'x'.repeat(20_000);
  const turns = Array.from({ length: 8 }, (_, k) => [{ name: 'ui_tree', args: { filter: `f${k}` } }]);
  turns.push(done());
  const h = setup({ turns, app: (w) => (w.op === 'action' ? { ok: true, code: 'done', result: { text: big, jpeg: JPEG() } } : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: 'Lies viel', goalArg: 'x' });
  await until(h.ended);
  const last = h.calls.at(-1).messages;
  assert.equal(pictures(last), 2);
  const tools = last.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 8);
  assert.ok(tools[0].content.length < 1700 && tools[0].content.endsWith('[älteres Ergebnis gekürzt]'));
  assert.ok(tools.at(-1).content.length > 20_000, 'the newest result is whole');
  assert.ok(JSON.stringify(last).length < 120_000);
});

test('he steers by voice while the run works: every spoken sentence reaches the loop in his words, also a negation, a correction and a sentence that grows', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = setup({
    app: async (w) => { if (w.op === 'action' && w.tool === 'wait') await gate; return w.op === 'action' ? shot() : { ok: true, code: 'done' }; },
    turns: [[{ name: 'wait', args: { ms: 100 } }], [{ name: 'screenshot', args: {} }], done('Entwurf geöffnet, nicht gesendet.')],
  });
  await h.computer.begin('s1', { text: 'Gmail öffnen und die Mail senden (Florians Worte: Öffne Gmail und sende die Mail.)', goalArg: 'x', turn: 4, said: 'Öffne Gmail und sende die Mail.' });
  await until(() => h.actions().some((w) => w.tool === 'wait'));
  h.computer.userFinal('s1', { text: 'Öffne Gmail und sende die Mail.', turn: 4, at: 1 }); // the opening final again: nothing new
  h.computer.userFinal('s1', { text: 'Öffne Gmail und sende die Mail, aber sende sie nicht sofort.', turn: 4, at: 2 }); // his sentence went on after the run began
  h.computer.userFinal('s1', { text: 'Nein, nimm', turn: 5, at: 3 });
  h.computer.userFinal('s1', { text: 'Nein, nimm den Entwurf von gestern.', turn: 5, at: 4 }); // a sentence that grows replaces its shorter self
  h.computer.userFinal('s1', { text: 'Das hast du doch gerade gesagt', turn: 6, at: 5, echo: true }); // the Desk's own voice is not him
  release();
  await until(h.ended);
  const second = h.calls[1].messages;
  assert.match(second[1].content, /Seit dem Start hat Florian gesagt/);
  assert.ok(second[1].content.includes('aber sende sie nicht sofort') && second[1].content.includes('Nein, nimm den Entwurf von gestern.'));
  assert.ok(!second[1].content.includes('"Nein, nimm"') && !second[1].content.includes('gerade gesagt'));
  assert.ok(second.at(-1).content.includes('Florian hat gerade gesprochen, während du arbeitest.') && second.at(-1).content.includes('der neueste: "Nein, nimm den Entwurf von gestern."'));
  assert.match(second.at(-1).content, /geht dem bisherigen Auftrag vor/);
  const steer = h.session.events.filter((e) => e.type === 'computer.steer');
  assert.deepEqual(steer.map((e) => e.opener), [true, false, false]);
  assert.ok(!JSON.stringify(steer).includes('Entwurf'), 'the trace has lengths, not his words');
  assert.ok(h.calls[2].messages[1].content.includes('Nein, nimm den Entwurf von gestern.'), 'it stays in the task for every later turn');
});

test('a stop word still ends the run at once, and a cap reached inside one answer stops before the next action', async () => {
  const h = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [Array.from({ length: 6 }, () => ({ name: 'click', args: { x: 1, y: 1 } })), done()] });
  await h.computer.begin('s1', { text: 'Klick sechsmal', goalArg: 'x' });
  const R = h.computer.runOf('s1');
  R.actions = 996; // bootstrap screenshot + 3 clicks reach the cap of 1000
  await until(h.ended);
  const stop = h.session.events.find((e) => e.type === 'computer.run.stop');
  assert.equal(stop.why, 'actions');
  assert.ok(stop.actions <= 1000, `ran ${stop.actions} actions`);
  const h2 = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [() => { h2.computer.userPartial('s1', 'stopp, hör auf'); return [{ name: 'click', args: { x: 1, y: 1 } }]; }] });
  await h2.computer.begin('s1', { text: 'Klick', goalArg: 'x' });
  await until(h2.ended);
  assert.equal(h2.session.events.find((e) => e.type === 'computer.run.stop').why, 'voice-stop');
});

test('an app older than 0.1.14 keeps the run it had: the earlier tool set, prompt and one call per answer, no screenshot before the first turn', async () => {
  for (const [v, want] of [['0.1.14', true], ['0.1.15+abc', true], ['0.2.0', true], ['1.0.0', true], ['0.1.13', false], ['0.1.9', false], ['0.0.99', false], ['', false], [undefined, false], ['e2e', false]]) assert.equal(clientHasV2(v), want, String(v));
  const h = setup({ clientVersion: '0.1.13', app: (w) => (w.op === 'action' ? { ok: true, code: 'done', result: { text: 'w1 chrome' } } : { ok: true, code: 'done' }), turns: [[{ name: 'ui_windows', args: {} }, { name: 'ui_tree', args: {} }], done()] });
  await h.computer.begin('s1', { text: 'Lies die Fenster', goalArg: 'x' });
  await until(h.ended);
  assert.deepEqual(h.actions().map((w) => w.tool), ['ui_windows'], 'no bootstrap screenshot, the second call of the answer is dropped');
  assert.equal(h.calls[0].tools, LOOP_TOOLS);
  assert.equal(h.calls[0].parallel, false);
  assert.equal(h.calls[0].messages[0].content, FREE_PROMPT_V1);
  assert.equal(h.session.events.find((e) => e.type === 'computer.run.start').v2, false);
});

// ---- second review round (9 Nov): steering in every state, for every unrestricted app, and nothing unread is dropped ----
const blockFirstModelCall = () => { let release; const gate = new Promise((r) => { release = r; }); return { release, first: async () => { await gate; return [{ name: 'ui_windows', args: {} }]; } }; };
const goalMessage = (call) => call.messages[1].content;

test('steering: an older app in the unrestricted mode keeps his correction in EVERY later request, not only in one note', async () => {
  const b = blockFirstModelCall();
  const h = setup({ clientVersion: '0.1.13', app: (w) => (w.op === 'action' ? { ok: true, code: 'done', result: { text: 'w1' } } : { ok: true, code: 'done' }), turns: [b.first, [{ name: 'ui_windows', args: {} }], done()] });
  await h.computer.begin('s1', { text: 'Sende die Mail.', goalArg: 'x', turn: 1, said: 'Sende die Mail.' });
  await until(() => h.calls.length === 1);
  h.computer.userFinal('s1', { text: 'Aber noch nicht senden.', turn: 2, at: 1 });
  b.release();
  await until(h.ended);
  assert.equal(h.calls.length, 3);
  for (const k of [1, 2]) assert.ok(goalMessage(h.calls[k]).includes('Aber noch nicht senden.'), `request ${k + 1}`);
});

test('steering: a correction during a hands-on pause or while a question to him is open reaches the loop; the pause is not resumed by it', async () => {
  const b = blockFirstModelCall();
  const h = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [b.first, done()] });
  await h.computer.begin('s1', { text: 'Mail senden', goalArg: 'x', turn: 1, said: 'Mail senden' });
  await until(() => h.calls.length === 1);
  const R = h.computer.runOf('s1');
  h.computer.beat('s1', { deviceId: 'dev1' }, { run: R.run, state: 'handson' });
  assert.equal(R.paused, true);
  h.computer.userFinal('s1', { text: 'Aber noch nicht senden.', turn: 2, at: 1 });
  assert.equal(R.paused, true, 'a correction is no go word');
  assert.deepEqual(R.spokenSince(), ['Aber noch nicht senden.']);
  h.computer.userFinal('s1', { text: 'mach weiter', turn: 3, at: 2 });
  await until(() => !R.paused);
  assert.match(R.note, /Hands-on-Pause ist vorbei/);
  for (let k = 1; k <= 30; k += 1) h.computer.userFinal('s1', { text: `Nimm den Entwurf von gestern. ${'Noch ein Zusatz. '.repeat(k)}`.trim(), turn: 3, at: 2 + k });
  const pending = [R.note, R.steerNote].join('\n');
  assert.ok(pending.length < 3500 && (pending.match(/Florian hat gerade gesprochen/g) ?? []).length === 1, 'a growing sentence replaces its alert, the pause note stays');
  h.computer.userFinal('s1', { text: 'mach weiter', turn: 3, at: 99 });
  // a question to him is open: his sentence is no clear yes/no, the loop still gets his words
  const answer = R.ask({ form: 'yesno', topic: 'die Mail senden' });
  h.computer.userFinal('s1', { text: 'Nimm den Entwurf von gestern.', turn: 4, at: 3 });
  assert.equal((await answer).code, 'unclear');
  assert.ok(R.spokenSince().includes('Nimm den Entwurf von gestern.'));
  b.release();
  await until(h.ended);
  assert.ok(goalMessage(h.calls[1]).includes('Aber noch nicht senden.') && goalMessage(h.calls[1]).includes('Nimm den Entwurf von gestern.'));
});

test('steering: sentences the loop has not read are never dropped, a long sentence keeps its end, and an overflow ends the run instead of forgetting', async () => {
  const b = blockFirstModelCall();
  const h = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [b.first, done()] });
  await h.computer.begin('s1', { text: 'Sende die Mail.', goalArg: 'x', turn: 1, said: 'Sende die Mail.' });
  await until(() => h.calls.length === 1);
  h.computer.userFinal('s1', { text: 'Aber noch nicht senden.', turn: 2, at: 1 });
  for (let k = 3; k <= 8; k += 1) h.computer.userFinal('s1', { text: `Das ist Nebensatz Nummer ${k}.`, turn: k, at: k });
  h.computer.userFinal('s1', { text: `${'Und dann noch etwas ganz Langes. '.repeat(80)}Am Ende aber: nichts abschicken.`, turn: 9, at: 9 });
  b.release();
  await until(h.ended);
  const goal = goalMessage(h.calls[1]);
  assert.ok(goal.includes('Aber noch nicht senden.'), 'the restriction of turn 2 is still there after six more sentences');
  assert.ok(goal.includes('Am Ende aber: nichts abschicken.'), 'the end of a long sentence survives the cut');
  assert.ok(goal.length < 12_000);
  // 41 unread sentences: the run ends with a reason instead of dropping one
  const b2 = blockFirstModelCall();
  const h2 = setup({ app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [b2.first, done()] });
  await h2.computer.begin('s1', { text: 'x', goalArg: 'x', turn: 1, said: 'x' });
  await until(() => h2.calls.length === 1);
  for (let k = 2; k <= 42 && h2.computer.runOf('s1'); k += 1) h2.computer.userFinal('s1', { text: `Satz ${k}.`, turn: k, at: k });
  assert.equal(h2.session.events.find((e) => e.type === 'computer.run.stop').why, 'voice-overflow');
  b2.release();
});

test('a cost cap reached by the model answer itself ends the run before its first action', async () => {
  const h = setup({ costUsd: 2, app: (w) => (w.op === 'action' ? shot() : { ok: true, code: 'done' }), turns: [[{ name: 'click', args: { x: 1, y: 1 } }, { name: 'click', args: { x: 2, y: 2 } }], done()] });
  await h.computer.begin('s1', { text: 'Klick', goalArg: 'x' });
  await until(h.ended);
  assert.deepEqual(h.actions().map((w) => w.tool), ['screenshot'], 'no click after the cap of USD 1.50');
  assert.equal(h.session.events.find((e) => e.type === 'computer.run.stop').why, 'cost');
});
