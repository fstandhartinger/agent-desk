import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTool } from '../src/tools.js';
import { createToolLedger, guardSpec, toolFacts } from '../src/vizFacts.js';
import { checkSpec, buildInput, createVizGenerator } from '../src/viz.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Real tool output: runTool() formats and truncates exactly as in production; only the bridge is faked.
const ctx = (result, maxChars) => ({ hub: { call: async () => result }, audit: () => {}, maxChars });
const job = (i, finalDone = false) => ({
  name: `job-${String(i).padStart(2, '0')}-20261024`, path: `/home/flori/jobs/job-${i}`, modified: '2026-10-24T09:12:00.000Z',
  finalDone, host: 'lechonk', summary: 'Round 2: four slices, critic pending, gateway and bridge reviewed',
});
const TWENTY = { jobs: Array.from({ length: 20 }, (_, i) => job(i + 1, i >= 17)) };
const DECISIONS = {
  today: '2026-10-24', since: '2026-10-23', note: 'Newest first', entriesToday: 13, shown: 12, omitted: 40,
  entries: [
    { date: '2026-10-24', heading: '## Agent Desk: Canvas darf nie lügen', text: '…' },
    { date: '2026-10-24', heading: '## Opus sparen bis 10. Okt', text: '…' },
  ],
};

test('list_jobs facts count the whole list, also from the 20-job result the critic saw as "1"', async () => {
  const r = await runTool('list_jobs', {}, ctx(TWENTY, 20000));
  assert.deepEqual(toolFacts('list_jobs', r.content), { auswahl: 'neueste Jobs', jobs: 20, offen: 17, fertig: 3, namen: TWENTY.jobs.slice(0, 5).map((j) => j.name) });
  assert.match(toolFacts('list_jobs', r.content, { activeOnly: true }).auswahl, /^nur aktive/); // two lists must not be mixed up (live phone run)
});

test('a cut list only gives lower bounds and says so; the 200-char summary never yields a made-up count', async () => {
  const raw = JSON.stringify(TWENTY, null, 1);
  const r = { content: raw.slice(0, 2300) + '…[abgeschnitten]', summary: raw.slice(0, 200) }; // legacy cut JSON remains a lower bound
  const f = toolFacts('list_jobs', r.content);
  assert.match(String(f.jobs), /^mind\. \d+$/);
  assert.ok(Number(f.jobs.slice(6)) < 20);
  assert.match(f.hinweis, /Untergrenzen/);
  assert.match(String(toolFacts('list_jobs', r.summary).jobs), /^mind\./);
});

test('facts for decisions, files, search, board, Claude and errors', async () => {
  const d = await runTool('decisions_recent', {}, ctx(DECISIONS));
  assert.deepEqual(toolFacts('decisions_recent', d.content), { heute: 13, gezeigt: 12, seit: '2026-10-23', themen: ['Agent Desk: Canvas darf nie lügen', 'Opus sparen bis 10. Okt'] });
  const file = await runTool('read_file', { path: 'jobs/x/STATE.md' }, ctx({ path: '/home/flori/jobs/x/STATE.md', offset: 0, lines: 42, size: 900, truncated: false, totalLines: 42, text: '# STATE\n…' }));
  assert.deepEqual(toolFacts('read_file', file.content), { datei: 'STATE.md', zeilen: 42, gesamtZeilen: 42 });
  const hits = await runTool('search_files', { query: 'lium' }, ctx({ query: 'lium', hits: [{ path: '/home/flori/jobs/jev/STATE.md', line: 3, text: 'Pod lium' }, { path: '/a/b', line: 1, text: 'x' }] }));
  assert.deepEqual(toolFacts('search_files', hits.content), { treffer: 2, ersterTreffer: 'STATE.md' });
  const board = await runTool('board_read', { thread: '15' }, ctx({ text: '#101 [x] a\n#102 [y] b\n#103 [z] c', entries: 3, truncated: false }));
  assert.deepEqual(toolFacts('board_read', board.content), { einträge: 3 });
  const threads = await runTool('board_threads', {}, ctx({ text: '#27 Florian asks\n#22 System1\n#15 Ops', truncated: false }));
  assert.deepEqual(toolFacts('board_threads', threads.content), { threads: 3 });
  const st = await runTool('job_status', { name: 'reax2-next-steps-20261024' }, ctx({ ...job(1), name: 'reax2-next-steps-20261024', state: '# STATE' }));
  assert.deepEqual(toolFacts('job_status', st.content), { job: 'reax2-next-steps-20261024', abgeschlossen: 'nein', host: 'lechonk' });
  const l = createToolLedger();
  l.note({ type: 'tool', id: 'e', name: 'job_status', args: { name: 'Rags to Next Steps' }, status: 'error', summary: 'bad job name' });
  assert.deepEqual(l.entries(), [{ tool: 'job_status', was: 'Jobstatus', status: 'Fehler', ziel: 'Rags to Next Steps', fakten: { fehler: 'bad job name' } }]);
});

test('ledger: start + done of the same id is ONE entry with the latest status; facts from content', async () => {
  const l = createToolLedger();
  const r = await runTool('list_jobs', { activeOnly: true }, ctx(TWENTY, 20000));
  l.note({ type: 'tool', id: 'c1', name: 'list_jobs', args: { activeOnly: true }, status: 'start' });
  assert.deepEqual(l.entries(), [{ tool: 'list_jobs', was: 'Jobliste', status: 'läuft' }]);
  l.note({ type: 'tool', id: 'c1', name: 'list_jobs', args: { activeOnly: true }, status: 'done', summary: r.summary, content: r.content, ms: 6.4 });
  const e = l.entries();
  assert.equal(e.length, 1);
  assert.equal(e[0].status, 'fertig');
  assert.equal(e[0].ms, 6);
  assert.equal(e[0].fakten.jobs, 20);
  assert.doesNotMatch(JSON.stringify(e), /läuft|"finalDone"|"path"/);
});

const call = (status, name = 'decisions_recent', extra = {}) => ({ id: '1', name, target: '', status, facts: {}, ...extra });

test('a node about a finished tool never says läuft/offen; a failed one says Fehler (critic d23, d27, d41)', () => {
  const spec = {
    v: 1, title: 'Was hat Florian heute entschieden?', caption: 'Die Abfrage der Entscheidungen läuft noch.', focus: 'q',
    nodes: [
      { id: 'agent', label: 'Agent', kind: 'agent', tone: 'violet' },
      { id: 'q', label: 'decisions_recent', kind: 'tool', tone: 'amber', value: 'läuft' },
      { id: 'd', label: 'Heutige Entscheidungen', kind: 'decision', tone: 'amber', value: 'offen' },
    ],
    edges: [{ from: 'agent', to: 'q', style: 'pulse' }, { from: 'q', to: 'd', style: 'flow' }],
  };
  const { spec: s, fixes } = guardSpec(spec, { calls: [call('done')], source: '' });
  assert.deepEqual(s.nodes.map((n) => [n.id, n.value, n.tone]), [['agent', undefined, 'violet'], ['q', 'fertig', 'moss'], ['d', 'fertig', 'moss']]);
  assert.equal(s.caption, undefined);
  assert.ok(fixes.includes('caption'));
  assert.doesNotMatch(JSON.stringify(s), /läuft|offen/);

  const voice = { v: 1, title: 'Job', nodes: [{ id: 'j', label: 'Rags to Next St…', kind: 'job', tone: 'amber', value: 'läuft' }], edges: [] };
  const v = guardSpec(voice, { calls: [call('error', 'job_status', { target: 'Rags to Next Steps' })] }).spec;
  assert.deepEqual([v.nodes[0].value, v.nodes[0].tone], ['Fehler', 'red']);
});

test('while the tool still runs, "läuft" stays; job facts like "offen" are not touched', () => {
  const spec = { v: 1, title: 'Jobs', caption: 'Die Abfrage läuft noch.', nodes: [{ id: 'q', label: 'Jobliste', kind: 'tool', value: 'läuft' }, { id: 'j', label: 'reax2-next-steps', kind: 'job', value: 'offen' }], edges: [] };
  assert.equal(guardSpec(spec, { calls: [call('start', 'list_jobs')] }).spec.nodes[0].value, 'läuft');
  const s = guardSpec(spec, { calls: [call('done', 'job_status', { target: 'reax2-next-steps-20261024' }), call('done', 'list_jobs')] }).spec;
  assert.deepEqual(s.nodes.map((n) => n.value), ['fertig', 'offen']);
});

test('numbers only from facts or turn text: "Aktive Jobs 1" with 20 listed is dropped, "20" is kept (critic m22)', async () => {
  const l = createToolLedger();
  const r = await runTool('list_jobs', {}, ctx(TWENTY, 20000));
  l.note({ type: 'tool', id: 'c', name: 'list_jobs', args: {}, status: 'done', summary: r.summary, content: r.content, ms: 5 });
  const input = buildInput({ turns: [{ role: 'user', text: 'Welche Jobs laufen gerade?' }], tools: l.entries() });
  const raw = {
    title: 'Jobs am 24.', caption: 'Es laufen 4 Jobs, 20 sind gelistet.', focus: 'a',
    nodes: [
      { id: 'a', label: 'Aktive Jobs', kind: 'number', tone: 'papaya', value: '1' },
      { id: 'b', label: 'Gelistet', kind: 'number', tone: 'moss', value: '20' },
      { id: 'c', label: 'Offen', kind: 'job', tone: 'amber', value: '17 offen' },
      { id: 'd', label: '4 Worker', kind: 'idea' },
    ],
    edges: [{ from: 'b', to: 'c', label: '3 fertig' }, { from: 'b', to: 'a', label: '9 neu' }],
  };
  const { spec, fixes } = checkSpec(raw, { prev: null, calls: l.calls(), input });
  assert.deepEqual(spec.nodes.map((n) => [n.id, n.value]), [['b', '20'], ['c', '17 offen']]);
  assert.deepEqual(spec.edges, [{ from: 'b', to: 'c', style: 'flow', label: '3 fertig' }]);
  assert.equal(spec.caption, undefined); // "4" is not in the input
  assert.equal(spec.title, 'Gelistet'); // "24" is not in the input either
  assert.ok(fixes.includes('number-value:a') && fixes.includes('number-label:d'));
});

test('numbers from the turn text and decimal commas count as known', () => {
  const s = guardSpec({ v: 1, title: 'Latenz', caption: 'DeepSeek antwortet in 0,6 s.', nodes: [{ id: 'a', label: 'DeepSeek', kind: 'idea', value: '0.6 s' }], edges: [] }, { source: 'etwa 0,6 s und kostet' }).spec;
  assert.equal(s.nodes[0].value, '0.6 s');
  assert.equal(s.caption, 'DeepSeek antwortet in 0,6 s.');
});

test('a node the model merely typed "tool" ("LeChonk läuft") is not touched; only named tool nodes are', () => {
  const spec = { v: 1, title: 'Job', nodes: [{ id: 'h', label: 'LeChonk', kind: 'tool', tone: 'moss', value: 'läuft' }], edges: [] };
  const { spec: s, fixes } = guardSpec(spec, { calls: [call('done', 'list_jobs'), call('error', 'job_status', { target: 'Rags to Next Steps' })] });
  assert.equal(s.nodes[0].value, 'läuft');
  assert.deepEqual(fixes, []);
});

test('a cut list with an exact count header gives exact counts', async () => {
  const r = await runTool('list_jobs', {}, ctx({ total: 20, open: 17, ...TWENTY }, 2500));
  const f = toolFacts('list_jobs', r.content);
  assert.equal(f.jobs, 20);
  assert.equal(f.offen, 17);
  assert.equal(f.namen.length, 5);
});

test('after the answer nothing is "in progress": "prüft jetzt" caption, active step and busy agent are settled (live board run)', () => {
  const spec = {
    v: 1, title: 'Dringendes auf dem Board?', caption: 'Der Agent hat #25 und #27 gelesen und prüft jetzt, ob etwas Dringendes dabei ist.',
    nodes: [{ id: 'agent', label: 'Desk-Agent', kind: 'agent', value: 'sucht' }, { id: 't', label: 'Board-Threads', kind: 'board', value: '14' }],
    edges: [], steps: [{ label: 'Threads auflisten', state: 'done' }, { label: 'Dringendes melden', state: 'active' }],
  };
  const calls = [call('done', 'board_threads')];
  const before = guardSpec(spec, { calls, source: '14 25 27' }).spec; // answer not in yet: honest progress stays
  assert.equal(before.caption, spec.caption);
  assert.equal(before.steps[1].state, 'active');
  const { spec: s, fixes } = guardSpec(spec, { calls, source: '14 25 27', answered: true });
  assert.equal(s.caption, undefined);
  assert.equal(s.nodes[0].value, undefined);
  assert.deepEqual(s.steps.map((x) => x.state), ['done', 'done']);
  assert.ok(fixes.includes('steps') && fixes.includes('progress:agent'));
});

test('German dates are day and month, not decimals; they pass when the ISO date is in the facts (live phone run)', () => {
  const s = guardSpec({ v: 1, title: 'Seit 23.10.', caption: 'Entscheidungen seit 23.10.2026.', nodes: [{ id: 's', label: 'Seit', kind: 'idea', value: '23.10.' }], edges: [] }, { source: '"seit":"2026-10-23"' }).spec;
  assert.equal(s.nodes[0].value, '23.10.');
  assert.equal(s.caption, 'Entscheidungen seit 23.10.2026.');
  assert.equal(guardSpec({ v: 1, title: 'x', nodes: [{ id: 's', label: 'Seit', kind: 'idea', value: '24.10.' }], edges: [] }, { source: '"seit":"2026-10-23"' }).spec.nodes[0].value, undefined);
});

test('after the answer, present-tense work narration is gone too (live: "liest #27 …, um zu prüfen", "STATE.md wird gelesen")', () => {
  const calls = [call('done', 'board_read')];
  const cases = ['Der Agent hat 14 Threads gefunden und liest #27, #4 und #25, um Dringendes zu prüfen.', 'Alle Threads sind gelesen; jetzt fehlt nur noch die Antwort an Florian.'];
  for (const caption of cases) assert.equal(guardSpec({ v: 1, title: 'x', caption, nodes: [{ id: 'a', label: 'A' }], edges: [] }, { calls, source: '14 27 4 25', answered: true }).spec.caption, undefined, caption);
  const st = guardSpec({ v: 1, title: 'x', nodes: [{ id: 'f', label: 'STATE.md', kind: 'file', value: 'wird gelesen' }, { id: 'j', label: 'explainer-live', kind: 'job', value: 'läuft' }], edges: [] }, { calls: [call('done', 'job_status')], answered: true }).spec;
  assert.deepEqual(st.nodes.map((n) => n.value), [undefined, 'läuft']);
  const done = 'Der Agent hat 14 Threads gelesen; dringend ist der Pod in #15.';
  assert.equal(guardSpec({ v: 1, title: 'x', caption: done, nodes: [{ id: 'a', label: 'A' }], edges: [] }, { calls, source: '14 15', answered: true }).spec.caption, done);
});

test('a long answer is cut at a word boundary, so a cut number never becomes a "known" number (live: "#25700" → "#2570")', async () => {
  const seen = [];
  const g = createVizGenerator({ emit: () => {}, debounceMs: 5, complete: async (req) => { seen.push(req); return { json: null }; } });
  g.noteTurn({ role: 'user', text: 'Board?' });
  g.noteTurn({ role: 'assistant', text: `${'x '.repeat(343)}Fund #25700 im Thread` });
  await sleep(30);
  const said = JSON.parse(seen.at(-1).messages[1].content).conversation[1];
  assert.doesNotMatch(said, /#2570(?!0)/);
  assert.ok(said.endsWith('…') && said.length <= 707);
  g.close();
});

test('decision facts omit today as since but keep a genuinely wider scope', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(toolFacts('decisions_recent', JSON.stringify({ since: today, entriesToday: 15 })).seit, undefined);
  assert.equal(toolFacts('decisions_recent', JSON.stringify({ since: '2020-01-01', entriesToday: 15 })).seit, '2020-01-01');
});
