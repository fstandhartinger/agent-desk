import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDate, fmtNumber, fmtPercent, fmtValue, niceTicks } from '../src/canvas/format.ts';
import { byLabel, footnote, shortRef } from '../src/canvas/sources.ts';
import { pathLerp, lerpPrim, enterFrom, diffKeys } from '../src/canvas/tween.ts';
import { exportSvg } from '../src/canvas/export.ts';
import { renderPie } from '../src/canvas/render/charts.ts';
import type { CanvasSpec } from '../src/canvas/types.ts';

const nb = ' ';
test('de-DE numbers: thousands dot, decimal comma, no noise', () => {
  assert.equal(fmtNumber(1234.5), '1.235', '≥ 1000 → whole numbers');
  assert.equal(fmtNumber(12.25), '12,25');
  assert.equal(fmtNumber(41.5), '41,5');
  assert.equal(fmtNumber(3), '3');
  assert.equal(fmtNumber(1234567), '1.234.567');
  assert.equal(fmtNumber(NaN), '–');
});

test('units: money with cents unless whole, symbols after the number, % and hours', () => {
  assert.equal(fmtValue(165, 'USD'), `165${nb}$`);
  assert.equal(fmtValue(58.9, 'USD'), `58,90${nb}$`);
  assert.equal(fmtValue(3.5, 'EUR'), `3,50${nb}€`);
  assert.equal(fmtValue(1234.5, '€'), `1.234,50${nb}€`);
  assert.equal(fmtValue(12.5, '%'), `12,5${nb}%`);
  assert.equal(fmtValue(41.5, 'Std'), `41,5${nb}Std`);
  assert.equal(fmtValue(7), '7');
  assert.match(fmtValue(1_250_000, 'EUR', { compact: true }), /^1,3\sMio\.\s€$/);
});

test('percent: one decimal below 10 %, whole above', () => {
  assert.equal(fmtPercent(0.4335), `43${nb}%`);
  assert.equal(fmtPercent(0.0206), `2,1${nb}%`);
  assert.equal(fmtPercent(0), `0${nb}%`);
});

test('dates: German short month, optional time', () => {
  assert.equal(fmtDate('2026-10-24'), '24. Okt');
  assert.equal(fmtDate('2026-03-01 09:20'), '1. Mär, 09:20');
  assert.equal(fmtDate('gestern'), 'gestern');
});

test('nice ticks cover the range in 1-2-2.5-5 steps', () => {
  assert.deepEqual(niceTicks(0, 41.5, 4), [0, 20, 40, 60]);
  assert.deepEqual(niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
});

test('source footnotes: file + job for paths, board refs as "#22 · Eintrag n", URLs by host', () => {
  assert.equal(shortRef('/home/flori/jobs/explainer-live-agent-page-20261024/STATE.md'), 'STATE.md · explainer-live-agent-page-20261024');
  assert.equal(shortRef('board #22 entry 25697'), '#22 · Eintrag 25697');
  assert.equal(shortRef('#22/25697'), '#22 · Eintrag 25697');
  assert.equal(shortRef('board #22'), 'Board #22');
  assert.equal(shortRef('https://explainers.app.mintapis.com/p/live-desk-intro/'), 'explainers.app.mintapis.com · live-desk-intro');
  assert.equal(shortRef('Gespräch'), 'Gespräch');
  assert.deepEqual(footnote({ label: 'STATE.md', ref: '/home/flori/jobs/x-job/STATE.md' }), { text: 'STATE.md · x-job', title: '/home/flori/jobs/x-job/STATE.md' });
});

test('by-badge names the drawer: Text / Grok / GPT-Live / Gemini / Claude / Auto', () => {
  assert.deepEqual([byLabel('text'), byLabel('voice', 'xai'), byLabel('voice', 'openai'), byLabel('voice', 'gemini'), byLabel('claude'), byLabel('auto')],
    ['Text', 'Grok', 'GPT-Live', 'Gemini', 'Claude', 'Auto']);
});

test('tween: paths with the same structure interpolate, others snap; numbers count; bars grow from the baseline', () => {
  const f = pathLerp('M0 0 L10 10', 'M10 0 L20 30')!;
  assert.equal(f(0.5), 'M5 0 L15 20');
  assert.equal(pathLerp('M0 0 L1 1', 'M0 0 Q1 1 2 2'), null);
  const t = lerpPrim({ t: 'text', key: 'v', x: 0, y: 0, text: '0', size: 10, fill: '#fff', num: { value: 0, format: (v) => v.toFixed(0) } },
    { t: 'text', key: 'v', x: 10, y: 0, text: '100', size: 10, fill: '#fff', num: { value: 100, format: (v) => v.toFixed(0) } }, 0.5);
  assert.equal((t as { text: string }).text, '50');
  assert.deepEqual(enterFrom({ t: 'rect', key: 'b', x: 0, y: 50, w: 10, h: 40, fill: '#fff', grow: 'h' }), { t: 'rect', key: 'b', x: 0, y: 90, w: 10, h: 0, fill: '#fff', grow: 'h' });
  assert.deepEqual(diffKeys([{ t: 'circle', key: 'a', cx: 0, cy: 0, r: 1, fill: '' }], [{ t: 'circle', key: 'b', cx: 0, cy: 0, r: 1, fill: '' }]), { enter: ['b'], exit: ['a'], update: [] });
});

test('PNG export composition: title, caption, visual and numbered footnotes, wider than 1000 px', () => {
  const spec: CanvasSpec = { v: 2, id: 'money', kind: 'pie', title: 'Wofür <das> Geld', caption: 'Eine Zeile.', unit: 'USD', items: [{ label: 'A', value: 2 }, { label: 'B', value: 1 }],
    sources: [{ label: 'ledger_spend', ref: 'board #22' }], unsourced: true };
  const scene = renderPie(spec, { width: 900, height: 500 });
  const { svg, w, h } = exportSvg(spec, scene, { by: 'Grok', at: Date.UTC(2026, 9, 24, 12) });
  assert.ok(w >= 1000 && h > 500);
  assert.match(svg, /Wofür &lt;das&gt; Geld/);
  assert.match(svg, /Eine Zeile\./);
  assert.match(svg, /QUELLEN/);
  assert.match(svg, /1 ledger_spend — Board #22/);
  assert.match(svg, /ohne Quelle/);
  assert.match(svg, /Agent Desk · Grok/);
  assert.doesNotMatch(svg, /<script/);
});
