import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeToolStates, reconcileSpec } from '../reconcile.ts';
import { canvasFrame, PILL_STRIP } from '../frame.ts';
import { activityDetail, activityRow } from '../describe.ts';

const spec = {
  v: 1, title: 'Entscheidungen', focus: 'q',
  nodes: [
    { id: 'agent', label: 'Agent', kind: 'agent', tone: 'violet' },
    { id: 'q', label: 'decisions_recent', kind: 'tool', tone: 'amber', value: 'läuft' },
    { id: 'j', label: 'reax2-next-steps', kind: 'job', tone: 'amber', value: 'läuft' },
  ],
  edges: [{ from: 'agent', to: 'q' }],
};

test('a node whose tool finished flips to "fertig" in place, the moment the event arrives (critic d23)', () => {
  assert.equal(reconcileSpec(spec, [{ name: 'decisions_recent', status: 'start' }]), spec); // unchanged while running
  const s = reconcileSpec(spec, [{ name: 'decisions_recent', status: 'start' }, { name: 'decisions_recent', status: 'done' }]);
  assert.deepEqual([s.nodes[1].value, s.nodes[1].tone], ['fertig', 'moss']);
  assert.equal(s.nodes[2].value, 'läuft'); // a job may really run
  assert.deepEqual([...nodeToolStates(s, [{ name: 'decisions_recent', status: 'done' }])], [['q', 'done']]);
  const e = reconcileSpec(spec, [{ name: 'decisions_recent', status: 'error' }]);
  assert.deepEqual([e.nodes[1].value, e.nodes[1].tone], ['Fehler', 'red']);
});

test('German tool labels count as a reference ("Jobliste läuft" after list_jobs finished)', () => {
  const s = reconcileSpec({ ...spec, nodes: [{ id: 'l', label: 'Jobliste', kind: 'tool', value: 'lädt' }] }, [{ name: 'list_jobs', status: 'done' }]);
  assert.equal(s.nodes[0].value, 'fertig');
  const marks = nodeToolStates({ ...spec, nodes: [{ id: 'q', label: 'Entscheidungen', kind: 'tool' }, { id: 'd', label: 'Entscheidungen heute', kind: 'decision', value: '15' }] }, [{ name: 'decisions_recent', status: 'done' }]);
  assert.deepEqual([...marks], [['q', 'done']]); // the tick sits on the call, not on its result
});

test('"mehr ↓" strip and footer never overlap the diagram area (critic D-new-5, d22/m22)', () => {
  for (const [height, compact] of [[900 - 260, false], [520, true], [844 - 330, true]]) {
    for (const footerH of [0, 72, 150]) {
      for (const scroll of [false, true]) {
        const f = canvasFrame({ height, compact, footerH, scroll });
        const diagramBottom = height - f.bottom;
        assert.ok(diagramBottom <= f.footerTop, `diagram ${diagramBottom} into footer ${f.footerTop}`);
        if (scroll) {
          assert.ok(f.pill.top >= diagramBottom, 'pill starts below the diagram');
          assert.ok(f.pill.bottom <= f.footerTop, 'pill ends above the caption');
          assert.equal(f.pill.bottom - f.pill.top, PILL_STRIP);
        } else assert.equal(f.pill, null);
      }
    }
  }
});

test('Activity tab never shows raw JSON (critic d24: { "jobs": [ { "name": …)', () => {
  const LIST = '{ "jobs": [ { "name": "mail-domains-gmail-20261002", "path": "/home/flori/jobs/mail-domains-gmail-20261002", "finalDone": true…';
  assert.equal(activityDetail(LIST, 'list_jobs', 'done'), 'mail-domains-gmail-20261002 …');
  assert.equal(activityDetail('{ "total": 20, "open": 17, "jobs": [ { "name": "a"…', 'list_jobs', 'done'), '20 Jobs · 17 offen');
  assert.equal(activityDetail('{ "today": "2026-10-24", "entriesToday": 13, "shown": 12…', 'decisions_recent', 'done'), '13 heute');
  assert.equal(activityDetail('bad job name', 'job_status', 'error'), 'bad job name');
  assert.equal(activityDetail('{ "weird": [1, 2] }'), '');
  assert.equal(activityDetail('jobs/x/STATE.md'), 'jobs/x/STATE.md');
  for (const d of [LIST, '{ "sid": "d1" }', '[1,2]']) assert.doesNotMatch(activityDetail(d, 'claude_task', 'done') + activityDetail(d), /[{}[\]"]/);
});

test('a failed call keeps its red mark when a retry of the same tool succeeds (live "Rags to Next Steps" run)', () => {
  const s = { v: 1, title: 'x', nodes: [{ id: 'js', label: 'Jobstatus-Abfrage', kind: 'tool', tone: 'red', value: 'Fehler' }, { id: 'j2', label: 'job_status', kind: 'tool', value: 'läuft' }], edges: [] };
  const act = [{ name: 'job_status', status: 'error' }, { name: 'job_status', status: 'done' }];
  assert.deepEqual([...nodeToolStates(reconcileSpec(s, act), act)], [['js', 'error'], ['j2', 'done']]);
});

test('a two-line title moves the diagram down instead of being cut', () => {
  const one = canvasFrame({ height: 640, compact: false, headerH: 66, footerH: 80, scroll: false });
  const two = canvasFrame({ height: 640, compact: false, headerH: 100, footerH: 80, scroll: false });
  assert.equal(two.top - one.top, 34);
  assert.ok(one.top >= 24 + 66);
});

test('Activity rows: German names for tools the log does not know, summaries instead of JSON, other rows untouched', () => {
  const logLabel = (n) => ({ list_jobs: 'Jobs auflisten' })[n] ?? n.replace(/_/g, ' ');
  assert.deepEqual(activityRow({ source: 'chat', label: 'decisions recent fertig', detail: '{ "today": "2026-10-24", "entriesToday": 15' }, logLabel), { label: 'Entscheidungen fertig', detail: '15 heute' });
  assert.deepEqual(activityRow({ source: 'voice', label: 'Jobs auflisten fertig', detail: '{ "total": 20, "open": 10, "jobs": [' }, logLabel), { label: 'Jobs auflisten fertig', detail: '20 Jobs · 10 offen' });
  assert.deepEqual(activityRow({ source: 'chat', label: 'decisions recent' }, logLabel), { label: 'Entscheidungen', detail: '' });
  assert.deepEqual(activityRow({ source: 'chat', label: 'Antwort fertig', detail: '2.0 s · $0.00' }, logLabel), { label: 'Antwort fertig', detail: '2.0 s · $0.00' });
});
