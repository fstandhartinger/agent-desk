import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasBus } from '../src/canvasBus.js';

test('card maps go only to their paired device on history, replay and live events', () => {
  const bus = createCanvasBus();
  const published = [];
  bus.subscribe(event => published.push(event));
  const map = bus.publish({ phase: 'ready', id: 'private', spec: { title: 'Private card' } }, { owner: 'private', audience: 'device-one' });
  const shared = bus.publish({ phase: 'ready', id: 'shared', spec: { title: 'Shared chart' } });
  assert.deepEqual(bus.latest(), [shared]);
  assert.deepEqual(bus.latest('device-two'), [shared]);
  assert.deepEqual(bus.latest('device-one'), [shared, map]);
  for (const events of [published, bus.replay().map(({ event }) => event)]) {
    assert.deepEqual(events.filter(event => bus.visible(event, 'device-two')), [shared]);
    assert.deepEqual(events.filter(event => bus.visible(event, 'device-one')), [map, shared]);
  }
  assert.equal(JSON.stringify(map).includes('device-one'), false);
});
