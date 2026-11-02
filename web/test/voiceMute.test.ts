import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MuteGate } from '../src/lib/muteGate.ts';
import { buildEntry, clientInfo } from '../src/lib/clientInfo.ts';

const pcm = () => new ArrayBuffer(960);
function rig() {
  const tracks = [{ enabled: true }];
  const wire: unknown[] = [];
  let sockets = 1; // one WebSocket for the whole session; a reconnect would bump this
  const changes: [boolean, string][] = [];
  const gate = new MuteGate(() => tracks, (m, s) => { changes.push([m, s]); wire.push({ type: 'mute', muted: m, source: s }); });
  const feed = (n: number) => { let sent = 0; for (let i = 0; i < n; i++) if (gate.frame(pcm(), true, (p) => { wire.push(p); sent++; })) sent; return sent; };
  return { tracks, wire, gate, changes, feed, sockets: () => sockets };
}

test('while muted no frame reaches the socket and the track is disabled', () => {
  const r = rig();
  assert.equal(r.feed(5), 5);
  r.gate.set(true, 'dock');
  assert.equal(r.tracks[0].enabled, false);
  const before = r.wire.length;
  assert.equal(r.feed(50), 0);
  assert.equal(r.wire.length, before);
  assert.equal(r.gate.dropped, 50);
});

test('unmute resumes on the same socket with only a control message and no reconnect', () => {
  const r = rig();
  r.gate.set(true, 'hotkey');
  r.gate.set(false, 'hotkey');
  assert.equal(r.tracks[0].enabled, true);
  assert.equal(r.sockets(), 1);
  assert.deepEqual(r.wire, [{ type: 'mute', muted: true, source: 'hotkey' }, { type: 'mute', muted: false, source: 'hotkey' }]);
  assert.equal(r.feed(3), 3);
  assert.equal(r.gate.set(false), false, 'idempotent, no duplicate message');
});

test('no barge-in while muted; assistant audio is not the gate\'s business', () => {
  const r = rig();
  assert.equal(r.gate.allowBargeIn(), true);
  r.gate.set(true);
  assert.equal(r.gate.allowBargeIn(), false);
});

test('a device or permission change while muted keeps the (new) track disabled; session end resets', () => {
  const r = rig();
  r.gate.set(true);
  r.tracks.splice(0, 1, { enabled: true }); // device switched: fresh live track
  r.gate.applyTracks();
  assert.equal(r.tracks[0].enabled, false);
  r.gate.reset();
  assert.equal(r.gate.muted, false);
});

test('entry fields come from the URL: card, interactive page, page id, Screen Agent', () => {
  const x = { pathname: '/', search: '?x=inbound-people-20261102-n5bj31qg3v&from=card:19124&a=A%23b8c3ff' };
  assert.deepEqual(buildEntry(x, 'p3'), { path: 'card>interactive>desk', card: '19124', page_aid: 'b8c3ff', element: 'p3' });
  assert.deepEqual(buildEntry({ pathname: '/', search: '?x=foo' }), { path: 'interactive>desk' });
  assert.deepEqual(buildEntry({ pathname: '/', search: '' }), { path: 'desk' });
  assert.equal(buildEntry({ pathname: '/', search: '?companion=1' }).path, 'screen-agent');
  assert.equal(buildEntry({ pathname: '/', search: '?from=card:x1' }).card, undefined);
  assert.deepEqual(clientInfo(false), { app: 'web', version: 'dev', commit: 'dev', device: 'phone' });
  assert.equal(clientInfo(true).device, 'desktop');
});
