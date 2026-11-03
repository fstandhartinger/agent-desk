// Item F, the wire between the Desk gateway and the Screen Agent app: the exact messages in test/fixtures/computer-contract.json, the same file the app's Core tests parse
// (screen-agent testdata/computer-contract.json). What the gateway SENDS is produced by the real run code and compared; what the app SENDS is validated by the real route code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setEnv } from './helpers/env.js';
import { setup, until } from './helpers/computer.js';

setEnv({});
const { checkArgs, toWire } = await import('../src/computer/loop.js');
const { validateResult, BEAT_MS } = await import('../src/computer/run.js');
const FX = JSON.parse(fs.readFileSync(new URL('./fixtures/computer-contract.json', import.meta.url), 'utf8'));
const GOAL = 'Übernimm den Computer und öffne mail.google.com.';
const ok = (extra = {}) => ({ ok: true, code: 'done', class: 'R1', rule: 'in-scope', ...extra });
const bare = (w) => { const { id, run, seq, ...rest } = w; assert.match(id, new RegExp(FX.ids.command)); assert.match(run, new RegExp(FX.ids.run)); assert.ok(Number.isInteger(seq) && seq >= 0); return rest; };
const fx = (name) => bare(FX.commands.find((c) => c.name === name).wire);
const say = (h, text, extra = {}) => h.computer.userFinal('s1', { text, at: h.clock.now(), turn: 9, started: h.clock.now(), ...extra });
const ended = (h) => h.computer.runOf('s1') === null;

test('contract: start, extend, stop, beat and confirm are sent exactly as the fixture says', async () => {
  const h = setup({ script: [{ name: 'ui_windows', args: {} }, { name: 'ui_windows', args: {} }], app: (w) => (w.op === 'action' ? new Promise((r) => { h.release = () => r(ok()); }) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  assert.deepEqual(bare(h.vision.ofOp('start')[0]), fx('start'));
  await until(() => h.vision.ofOp('action').length === 1);
  say(h, 'Und öffne auch github.com.', { turn: 11 });
  await until(() => h.vision.ofOp('start').length === 2);
  assert.deepEqual(bare(h.vision.ofOp('start')[1]), fx('extend'));
  h.clock.t += BEAT_MS; h.computer.tick();
  assert.deepEqual(bare(h.vision.ofOp('beat')[0]), fx('beat'));
  assert.equal(FX.timing.beatMs, BEAT_MS, 'the beat is 5 s both ways');
  h.computer.userPartial('s1', 'Stopp bitte');
  assert.deepEqual(bare(h.vision.ofOp('stop')[0]), fx('stop'));
  h.release();
});

test('contract: confirm carries the hash and the digits and nothing else', async () => {
  const spoken = FX.results.find((r) => r.name === 'needs-confirm').body.needs_confirm;
  const h = setup({ script: [{ name: 'chrome_click', args: { ref: 'e5' } }, { name: 'done', args: { summary: 'x' } }], app: (w) => (w.op === 'action' ? FX.results.find((r) => r.name === 'needs-confirm').body : w.op === 'confirm' ? ok({ rule: 'confirmed' }) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.session.said.some((t) => /WÖRTLICH/.test(t)));
  h.computer.assistantFinal('s1', spoken.spoken);
  say(h, 'Ja, vier sieben.');
  await until(() => ended(h));
  assert.deepEqual(bare(h.vision.ofOp('confirm')[0]), fx('confirm'));
});

test('contract: every tool of the loop arrives at the app with the arguments the fixture lists', async () => {
  const calls = FX.actions.map((a) => ({ name: a.wire.tool, args: a.loop }));
  const h = setup({ script: [...calls, { name: 'done', args: { summary: 'x' } }], app: (w) => (w.op === 'action' ? ok() : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => ended(h));
  const sent = h.vision.ofOp('action');
  assert.equal(sent.length, FX.actions.length);
  FX.actions.forEach((a, i) => {
    assert.equal(checkArgs(a.wire.tool, a.loop).ok, true, a.name);
    assert.deepEqual(toWire(a.wire.tool, a.loop), a.wire.args, a.name);
    assert.deepEqual(bare(sent[i]), bare(a.wire), a.name);
  });
});

test('contract: the app results of the fixture pass validateResult unchanged; the bad ones are refused', () => {
  for (const r of FX.results) assert.deepEqual(validateResult(r.body), r.body, r.name);
  for (const r of FX.badResults) assert.throws(() => validateResult(r.body), undefined, r.name);
  assert.equal(FX.results.find((r) => r.name === 'screenshot').body.result.jpeg.length > 0, true);
});

test('contract: the beats of the fixture are accepted (ended and killed end the run), the bad ones are refused', async () => {
  for (const b of FX.beats) {
    const h = setup({ script: [{ name: 'ui_windows', args: {} }], app: (w) => (w.op === 'action' ? new Promise(() => {}) : { ok: true, code: 'done' }) });
    await h.computer.begin('s1', { text: GOAL, goalArg: '' });
    const run = h.computer.runOf('s1').run;
    assert.deepEqual(h.computer.beat('s1', { deviceId: 'dev1' }, { ...b.body, run }), { ok: true }, JSON.stringify(b.body));
    assert.equal(ended(h), ['ended', 'killed'].includes(b.body.state), b.body.state);
    h.detach();
  }
  const h = setup({ script: [{ name: 'ui_windows', args: {} }], app: (w) => (w.op === 'action' ? new Promise(() => {}) : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  const run = h.computer.runOf('s1').run;
  for (const b of FX.badBeats) assert.throws(() => h.computer.beat('s1', { deviceId: 'dev1' }, { ...b.body, run }), undefined, JSON.stringify(b.body));
  h.detach();
});

test('contract: the hotkey confirm is a second result for the original action id, taken once', async () => {
  const nc = FX.results.find((r) => r.name === 'needs-confirm').body, second = FX.results.find((r) => r.name === 'hotkey second result').body;
  const h = setup({ script: [{ name: 'chrome_click', args: { ref: 'e5' } }, { name: 'done', args: { summary: 'x' } }], app: (w) => (w.op === 'action' ? nc : { ok: true, code: 'done' }) });
  await h.computer.begin('s1', { text: GOAL, goalArg: '' });
  await until(() => h.session.said.some((t) => /WÖRTLICH/.test(t)));
  const id = h.vision.ofOp('action')[0].id, cmd = h.vision.computerCommand('s1', id);
  assert.equal(typeof cmd.late, 'function', 'the gateway waits for a second result on the same command id');
  cmd.late(validateResult(second));
  await until(() => ended(h));
  assert.equal(h.vision.ofOp('confirm').length, 0, 'no digits needed');
  assert.ok(h.session.events.some((e) => e.type === 'computer.confirm.ok' && e.via === 'hotkey'));
});
