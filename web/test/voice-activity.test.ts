// v0.1.7: the gateway's live activity events reach the native host unchanged in shape and drive the dock line.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityMessage, forwardActivity } from '../src/canvas/nativeNotify.ts';
import { isActivity, nextActivity } from '../src/lib/liveActivity.ts';
import type { ActivityEvent } from '../src/lib/types.ts';

const ev = (extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ type: 'activity', id: 'c1', phase: 'start', label: 'Lese Karte a#dbc8f1', tool: 'artifact_resolve', at: 1_000, ...extra });

describe('native host message', () => {
  it('is exactly {type,id,phase,label,tool,ms,reason} and carries no extra fields', () => {
    assert.deepEqual(activityMessage(ev({ phase: 'fail', ms: 123.4, reason: 'Zugriff verweigert' })), { type: 'activity', id: 'c1', phase: 'fail', label: 'Lese Karte a#dbc8f1', tool: 'artifact_resolve', ms: 123, reason: 'Zugriff verweigert' });
    assert.deepEqual(activityMessage(ev({ phase: 'thinking', id: 'think-1', label: 'Verstanden, denke nach …', tool: undefined })), { type: 'activity', id: 'think-1', phase: 'thinking', label: 'Verstanden, denke nach …' });
  });
  it('is posted to the host when there is one and silently dropped in a normal browser', () => {
    const posted: unknown[] = [];
    forwardActivity(() => ({ postMessage: (m) => posted.push(m) }), ev());
    forwardActivity(() => undefined, ev());
    assert.equal(posted.length, 1);
    assert.equal((posted[0] as { type: string }).type, 'activity');
  });
  it('labels are flattened and capped', () => {
    assert.equal(activityMessage(ev({ label: `a\n${'b'.repeat(300)}` })).label.length, 120);
  });
});

describe('dock line', () => {
  it('validates gateway messages', () => {
    assert.equal(isActivity(ev()), true);
    for (const bad of [null, {}, { type: 'activity' }, { type: 'activity', id: 'x', phase: 'nope', label: 'l' }, { type: 'activity', id: '', phase: 'done', label: 'l' }]) assert.equal(isActivity(bad), false);
  });
  it('the newest event wins; the end of an older tool never replaces a newer running one', () => {
    let line = nextActivity(null, ev({ id: 'c1' }), 1);
    assert.deepEqual([line?.id, line?.phase], ['c1', 'start']);
    line = nextActivity(line, ev({ id: 'c2', label: 'Suche in Dateien: x' }), 2);
    line = nextActivity(line, ev({ id: 'c1', phase: 'done', ms: 40 }), 3);
    assert.deepEqual([line?.id, line?.phase], ['c2', 'start']);
    line = nextActivity(line, ev({ id: 'c2', phase: 'done', ms: 90 }), 4);
    assert.deepEqual([line?.id, line?.phase, line?.ms], ['c2', 'done', 90]);
    line = nextActivity(line, ev({ id: 'c3', phase: 'start' }), 5);
    line = nextActivity(line, ev({ id: 'c3', phase: 'fail', reason: 'boom' }), 6);
    assert.deepEqual([line?.phase, line?.reason], ['fail', 'boom']);
  });
  it('a new thinking or heard line replaces a finished tool', () => {
    const done = nextActivity(null, ev({ phase: 'done' }), 1);
    assert.equal(nextActivity(done, ev({ id: 'think-2', phase: 'thinking', label: 'Verstanden, denke nach …' }), 2)?.phase, 'thinking');
  });
});

describe('voice session', () => {
  it('an activity message goes to the native host once and into the dock store', async () => {
    const { VoiceSession, VOICE_OPTIONS, voiceStore } = await import('../src/lib/voice.ts');
    const posted: unknown[] = [];
    (globalThis as unknown as { chrome?: unknown }).chrome = { webview: { postMessage: (m: unknown) => posted.push(m) } };
    const s = new VoiceSession(VOICE_OPTIONS[0], undefined, {} as never) as unknown as { handle(m: unknown): void };
    s.handle(ev({ id: 'c9', phase: 'start' }));
    s.handle({ type: 'activity', id: 'bad' }); // malformed: ignored
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { type: 'activity', id: 'c9', phase: 'start', label: 'Lese Karte a#dbc8f1', tool: 'artifact_resolve' });
    assert.equal(voiceStore.get().activity?.id, 'c9');
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });
});
