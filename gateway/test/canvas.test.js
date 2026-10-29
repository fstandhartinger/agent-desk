import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CANVAS_KINDS, LIMITS, RefusalFilter, isExplanatory, normalizeCanvas, parseNumber, refusesToDraw, slugify } from '../src/canvas.js';

const src = [{ label: 'STATE.md', ref: '/home/flori/jobs/x/STATE.md' }];
const ok = (spec) => {
  const r = normalizeCanvas(spec);
  assert.equal(r.ok, true, r.error);
  return r.spec;
};
const err = (spec) => {
  const r = normalizeCanvas(spec);
  assert.equal(r.ok, false, 'expected an error');
  return r.error;
};
const flow = { kind: 'flow', title: 'Video-Versand', sources: src, nodes: [{ id: 'agent', label: 'Agent' }, { id: 'guard', label: 'Link-Prüfung', shape: 'diamond', tone: 'papaya' }], edges: [{ from: 'agent', to: 'guard', label: 'Video' }] };

describe('parseNumber', () => {
  it('reads German and English money strings', () => {
    assert.equal(parseNumber('165,00 €'), 165);
    assert.equal(parseNumber('1.234,56'), 1234.56);
    assert.equal(parseNumber('$1,234.50'), 1234.5);
    assert.equal(parseNumber('12 %'), 12);
    assert.equal(parseNumber('164.62'), 164.62);
    assert.equal(parseNumber('1.234'), 1234); // lone separator + three digits = thousands
    assert.equal(parseNumber('0.123'), 0.123);
    assert.equal(parseNumber('1.234.567'), 1234567);
    assert.equal(parseNumber(7), 7);
    assert.equal(parseNumber('-3'), -3);
  });
  it('returns NaN for anything not numeric', () => {
    for (const v of ['abc', '', '€', null, undefined, {}, NaN, Infinity, '--']) assert.ok(Number.isNaN(parseNumber(v)), String(v));
  });
});

describe('normalizeCanvas: envelope', () => {
  it('accepts a flow, adds v:2 and keeps declared sources', () => {
    const s = ok(flow);
    assert.deepEqual([s.v, s.kind, s.direction, s.unsourced], [2, 'flow', 'LR', undefined]);
    assert.deepEqual(s.sources, src);
    assert.deepEqual(s.nodes[1], { id: 'guard', label: 'Link-Prüfung', shape: 'diamond', tone: 'papaya' });
    assert.deepEqual(s.edges[0], { from: 'agent', to: 'guard', label: 'Video', style: 'solid' });
  });
  it('refuses non-objects and bad JSON, parses a JSON string', () => {
    assert.match(err(null), /object/);
    assert.match(err([1]), /object/);
    assert.match(err('{nope'), /not valid JSON/);
    assert.equal(ok(JSON.stringify(flow)).id, 'video-versand');
  });
  it('unknown or missing kind lists the valid kinds', () => {
    assert.match(err({ ...flow, kind: 'radar' }), /unknown kind "radar".*flow, architecture, sequence, pie, bar, line, table, timeline, sankey, custom_svg/);
    assert.match(err({ ...flow, kind: undefined }), /kind is required/);
    assert.equal(CANVAS_KINDS.length, 10);
  });
  it('requires a title and clamps it to 70 characters', () => {
    assert.match(err({ ...flow, title: '  ' }), /title is required/);
    const s = ok({ ...flow, title: 'x'.repeat(200) });
    assert.ok(s.title.length <= 70);
  });
  it('missing sources -> "Gespräch" + unsourced:true; empty/garbage sources too', () => {
    for (const sources of [undefined, [], [{}], 'x', [{ label: '', ref: '' }]]) {
      const s = ok({ ...flow, sources });
      assert.deepEqual(s.sources, [{ label: 'Gespräch', ref: 'Gespräch' }]);
      assert.equal(s.unsourced, true);
    }
  });
  it('a source with only a ref or only a label is completed; more than 6 are cut', () => {
    const s = ok({ ...flow, sources: [{ ref: '/a/b.md' }, { label: 'Board #22' }, ...Array.from({ length: 10 }, (_, i) => ({ label: `s${i}`, ref: `r${i}` }))] });
    assert.deepEqual(s.sources.slice(0, 2), [{ label: '/a/b.md', ref: '/a/b.md' }, { label: 'Board #22', ref: 'Board #22' }]);
    assert.equal(s.sources.length, 6);
  });
  it('id: valid slug kept, invalid derived from the title (umlauts transliterated), same title -> same id', () => {
    assert.equal(ok({ ...flow, id: 'video-send-block' }).id, 'video-send-block');
    assert.equal(ok({ ...flow, id: 'Video Send!', title: 'Wie läuft das?' }).id, 'video-send');
    assert.equal(ok({ ...flow, id: undefined, title: 'Wie läuft das?' }).id, 'wie-laeuft-das');
    assert.equal(ok({ ...flow, id: undefined, title: '!' }).id, 'flow-skizze');
    assert.ok(/^[a-z0-9-]{2,48}$/.test(ok({ ...flow, id: undefined, title: 'ü'.repeat(100) }).id));
  });
  it('caption and highlight are clamped, unknown fields dropped, control characters removed', () => {
    const s = ok({ ...flow, caption: 'Satz. '.repeat(100), highlight: 'guard', evil: 'x', onload: 'y', title: 'A\u0000B\n\tC' });
    assert.ok(s.caption.length <= 160 && s.caption.endsWith('…'));
    assert.equal(s.highlight, 'guard');
    assert.equal(s.title, 'A B C');
    assert.ok(!('evil' in s) && !('onload' in s));
  });
  it('fields of other kinds are dropped', () => {
    const s = ok({ ...flow, items: [{ label: 'a', value: 1 }], svg: '<svg/>', rows: [['x']] });
    assert.ok(!('items' in s) && !('svg' in s) && !('rows' in s));
  });
});

describe('normalizeCanvas: flow / architecture', () => {
  it('needs nodes; edges to unknown nodes are an error naming the node', () => {
    assert.match(err({ ...flow, nodes: [] }), /needs "nodes"/);
    assert.match(err({ ...flow, edges: [{ from: 'agent', to: 'ghost' }] }), /edges\[0\]\.to: unknown node "ghost"/);
  });
  it('node ids are slugged, deduplicated, edges may use the raw id', () => {
    const s = ok({ ...flow, nodes: [{ id: 'Link Check', label: 'A' }, { id: 'Link Check', label: 'B' }, { label: 'Ohne Id' }], edges: [{ from: 'Link Check', to: 'ohne-id' }] });
    assert.deepEqual(s.nodes.map((n) => n.id), ['link-check', 'link-check-2', 'ohne-id']);
    assert.deepEqual([s.edges[0].from, s.edges[0].to], ['link-check', 'ohne-id']);
  });
  it('one-character ids work', () => {
    const s = ok({ ...flow, nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] });
    assert.deepEqual(s.nodes.map((n) => n.id), ['a', 'b']);
    assert.equal(s.edges.length, 1);
  });
  it('unknown shape/tone/style fall back; label is required (id is the fallback)', () => {
    const s = ok({ ...flow, nodes: [{ id: 'a', label: 'A', shape: 'star', tone: 'pink' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', style: 'wavy' }] });
    assert.deepEqual(s.nodes[0], { id: 'a', label: 'A', shape: 'box' });
    assert.equal(s.nodes[1].label, 'b');
    assert.equal(s.edges[0].style, 'solid');
    assert.match(err({ ...flow, nodes: [{ id: '', label: '' }] }), /nodes\[0\] needs a label/);
  });
  it('clamps: 24 nodes, 40 edges, labels 40, detail 90; edges to clamped-away nodes are dropped, not errors', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: 'L'.repeat(80), detail: 'D'.repeat(200) }));
    const edges = Array.from({ length: 60 }, (_, i) => ({ from: `n${i % 24}`, to: `n${(i + 1) % 24}` }));
    edges.push({ from: 'n0', to: 'n39' });
    const s = ok({ ...flow, nodes, edges });
    assert.equal(s.nodes.length, LIMITS.nodes);
    assert.equal(s.edges.length, LIMITS.edges);
    assert.ok(s.nodes.every((n) => n.label.length <= 40 && n.detail.length <= 90));
    assert.ok(s.edges.every((e) => !(e.from === 'n0' && e.to === 'n39')));
  });
  it('architecture: groups (max 8), node.group must exist, direction defaults to TB', () => {
    const groups = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, label: `G${i}`, tone: i === 0 ? 'violet' : 'bogus' }));
    const s = ok({ ...flow, kind: 'architecture', groups, nodes: [{ id: 'a', label: 'A', group: 'g1' }, { id: 'b', label: 'B', group: 'nope' }], edges: [] });
    assert.equal(s.direction, 'TB');
    assert.equal(s.groups.length, 8);
    assert.equal(s.groups[0].tone, 'violet');
    assert.ok(!('tone' in s.groups[1]));
    assert.equal(s.nodes[0].group, 'g1');
    assert.ok(!('group' in s.nodes[1]));
  });
  it('flow ignores groups; explicit direction wins', () => {
    const s = ok({ ...flow, direction: 'TB', groups: [{ id: 'g', label: 'G' }] });
    assert.equal(s.direction, 'TB');
    assert.ok(!('groups' in s));
  });
  it('type errors name the field', () => {
    assert.match(err({ ...flow, nodes: 'x' }), /nodes must be an array/);
    assert.match(err({ ...flow, nodes: [5] }), /nodes\[0\] must be an object/);
  });
});

describe('normalizeCanvas: sequence', () => {
  const seq = { kind: 'sequence', title: 'Ablauf', sources: src, actors: [{ id: 'agent', label: 'Agent' }, { id: 'notify', label: 'notify' }], messages: [{ from: 'agent', to: 'notify', label: '--video x.mp4' }, { from: 'notify', to: 'agent', label: 'exit 75', style: 'reply', note: 'NOT SENT' }] };
  it('accepts actors and messages, defaults the style to sync', () => {
    const s = ok(seq);
    assert.equal(s.messages[0].style, 'sync');
    assert.equal(s.messages[1].note, 'NOT SENT');
  });
  it('needs 2 actors and 1 message; unknown actor is an error', () => {
    assert.match(err({ ...seq, actors: [seq.actors[0]] }), /at least 2/);
    assert.match(err({ ...seq, messages: [] }), /needs "messages"/);
    assert.match(err({ ...seq, messages: [{ from: 'agent', to: 'x' }] }), /messages\[0\]\.to: unknown node "x"/);
  });
  it('clamps to 8 actors and 24 messages', () => {
    const actors = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }));
    const messages = Array.from({ length: 40 }, (_, i) => ({ from: 'a0', to: `a${1 + (i % 7)}`, label: `m${i}` }));
    const s = ok({ ...seq, actors, messages });
    assert.equal(s.actors.length, 8);
    assert.equal(s.messages.length, 24);
  });
});

describe('normalizeCanvas: pie / bar', () => {
  const pie = { kind: 'pie', title: 'Ausgaben', unit: 'EUR', sources: src, items: [{ label: 'LLM-APIs', value: 165, tone: 'papaya' }, { label: 'GPU', value: '99,50 €', detail: '3 Pods' }] };
  it('parses numbers incl. "165,00 €", keeps unit/tone/detail', () => {
    const s = ok({ ...pie, items: [{ label: 'a', value: '165,00 €' }, ...pie.items.slice(1)] });
    assert.deepEqual(s.items.map((i) => i.value), [165, 99.5]);
    assert.equal(s.unit, 'EUR');
    assert.equal(s.items[1].detail, '3 Pods');
  });
  it('non-numbers and negatives are errors that name the item', () => {
    assert.match(err({ ...pie, items: [{ label: 'x', value: 'viel' }] }), /items\[0\] "x": value must be a number/);
    assert.match(err({ ...pie, items: [{ label: 'x', value: -3 }] }), />= 0/);
    assert.match(err({ ...pie, items: [{ label: 'x', value: null }] }), /must be a number/);
    assert.match(err({ ...pie, items: [{ label: 'x', value: Infinity }] }), /must be a number/);
  });
  it('needs items with labels; a pie of zeros is refused, a bar of zeros is fine', () => {
    assert.match(err({ ...pie, items: [] }), /needs "items"/);
    assert.match(err({ ...pie, items: [{ value: 3 }] }), /needs a label/);
    assert.match(err({ ...pie, items: [{ label: 'a', value: 0 }, { label: 'b', value: '0' }] }), /all values are 0/);
    assert.equal(ok({ ...pie, kind: 'bar', items: [{ label: 'a', value: 0 }] }).items[0].value, 0);
  });
  it('clamps to 12 items', () => {
    assert.equal(ok({ ...pie, items: Array.from({ length: 30 }, (_, i) => ({ label: `i${i}`, value: i + 1 })) }).items.length, 12);
  });
});

describe('normalizeCanvas: line / table / timeline / sankey', () => {
  it('line: series with parsed y, x kept as text, clamps 4 series x 60 points', () => {
    const series = Array.from({ length: 6 }, (_, i) => ({ name: `S${i}`, points: Array.from({ length: 90 }, (_, j) => ({ x: `2026-10-${j}`, y: j === 0 ? '12,5' : j })) }));
    const s = ok({ kind: 'line', title: 'Verlauf', series });
    assert.equal(s.series.length, 4);
    assert.equal(s.series[0].points.length, 60);
    assert.equal(s.series[0].points[0].y, 12.5);
    assert.match(err({ kind: 'line', title: 'x', series: [{ name: 'a', points: [{ x: '1', y: 'n/a' }] }] }), /series "a" point 0.*must be a number/);
    assert.match(err({ kind: 'line', title: 'x', series: [{ name: 'a', points: [{ y: 1 }] }] }), /x is required/);
    assert.match(err({ kind: 'line', title: 'x', series: [] }), /needs "series"/);
  });
  it('table: pads/cuts rows to the columns, stringifies cells, clamps 8 x 24', () => {
    const columns = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const rows = Array.from({ length: 40 }, (_, i) => [i, 'x'.repeat(200)]);
    const s = ok({ kind: 'table', title: 'T', columns, rows });
    assert.equal(s.columns.length, 8);
    assert.equal(s.rows.length, 24);
    assert.ok(s.rows.every((r) => r.length === 8));
    assert.equal(s.rows[3][0], '3');
    assert.ok(s.rows[0][1].length <= 90);
    assert.match(err({ kind: 'table', title: 'T', columns: [], rows: [['a']] }), /needs "columns"/);
    assert.match(err({ kind: 'table', title: 'T', columns: ['a'], rows: [] }), /needs "rows"/);
    assert.match(err({ kind: 'table', title: 'T', columns: ['a'], rows: ['x'] }), /rows\[0\] must be an array/);
  });
  it('timeline: needs labelled events, clamps 16', () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${i + 1}`, label: `E${i}` }));
    assert.equal(ok({ kind: 'timeline', title: 'T', events }).events.length, 16);
    assert.match(err({ kind: 'timeline', title: 'T', events: [{ date: 'x' }] }), /events\[0\] needs a label/);
    assert.match(err({ kind: 'timeline', title: 'T', events: [] }), /needs "events"/);
  });
  it('sankey: nodes + links, numbers parsed, unknown node an error, 40 links max', () => {
    const base = { kind: 'sankey', title: 'Geld', sources: src, nodes: [{ id: 'konto', label: 'Konto' }, { id: 'llm', label: 'LLM' }, { id: 'gpu', label: 'GPU' }] };
    const s = ok({ ...base, links: [{ from: 'konto', to: 'llm', value: '165,00' }, { from: 'konto', to: 'gpu', value: 10 }] });
    assert.deepEqual(s.links.map((l) => l.value), [165, 10]);
    assert.match(err({ ...base, links: [{ from: 'konto', to: 'x', value: 1 }] }), /links\[0\]\.to: unknown node/);
    assert.match(err({ ...base, links: [{ from: 'konto', to: 'gpu', value: 'x' }] }), /must be a number/);
    assert.match(err({ ...base, nodes: [base.nodes[0]], links: [] }), /at least 2/);
    assert.equal(ok({ ...base, links: Array.from({ length: 80 }, () => ({ from: 'konto', to: 'llm', value: 1 })) }).links.length, 40);
  });
});

describe('normalizeCanvas: custom_svg', () => {
  const svg = '<svg viewBox="0 0 100 50"><rect width="10" height="10" fill="#63D297"/><text x="5" y="5">Hi</text></svg>';
  it('accepts a complete svg with viewBox', () => assert.equal(ok({ kind: 'custom_svg', title: 'S', svg }).svg, svg));
  it('size: exactly 20000 characters passes, one more is refused with a hint', () => {
    const fill = (total) => `<svg viewBox="0 0 1 1">${' '.repeat(total - '<svg viewBox="0 0 1 1"></svg>'.length)}</svg>`;
    assert.equal(ok({ kind: 'custom_svg', title: 'S', svg: fill(20000) }).svg.length, 20000);
    assert.match(err({ kind: 'custom_svg', title: 'S', svg: fill(20001) }), /limit is 20000/);
  });
  it('refuses missing/incomplete svg, missing viewBox and active content', () => {
    assert.match(err({ kind: 'custom_svg', title: 'S' }), /needs "svg"/);
    assert.match(err({ kind: 'custom_svg', title: 'S', svg: '<div/>' }), /complete <svg>/);
    assert.match(err({ kind: 'custom_svg', title: 'S', svg: '<svg><rect/></svg>' }), /viewBox/);
    for (const evil of ['<script>alert(1)</script>', '<foreignObject/>', '<rect onclick="x()"/>', '<a href="javascript:x"/>', '<image href="http://x/y.png"/>', '<use href="http://x/y.svg#a"/>', '<iframe/>']) {
      assert.match(err({ kind: 'custom_svg', title: 'S', svg: `<svg viewBox="0 0 1 1">${evil}</svg>` }), /forbidden content/, evil);
    }
    assert.equal(ok({ kind: 'custom_svg', title: 'S', svg: '<svg viewBox="0 0 1 1"><use href="#a"/></svg>' }).kind, 'custom_svg');
  });
});

describe('slugify', () => {
  it('transliterates umlauts and falls back', () => {
    assert.equal(slugify('Größe & Übersicht'), 'groesse-uebersicht');
    assert.equal(slugify('?', 'fb'), 'fb');
    assert.equal(slugify(undefined), 'skizze');
  });
});

describe('auto-illustration heuristic', () => {
  it('questions that ask for structure, flow or money trigger', () => {
    for (const q of ['Wie funktioniert das?', 'Wofür geben wir das Geld aus?', 'Erklär mir die Architektur', 'Zeig es mir', 'Was kostet das, Kosten?', 'Gib mir eine Übersicht']) assert.equal(isExplanatory(q, 'kurz'), true, q);
  });
  it('a plain question with a short answer does not', () => {
    assert.equal(isExplanatory('Läuft der Job?', 'Ja.'), false);
    assert.equal(isExplanatory('Läuft der Job?', 'Ja, er läuft seit gestern. Fertig ist er nicht.'), false);
  });
  it('a long or numeric answer does', () => {
    assert.equal(isExplanatory('Läuft der Job?', 'Eins. Zwei. Drei.'), true);
    assert.equal(isExplanatory('Läuft der Job?', 'Es sind 3 Jobs, 12 Threads und 4 Pods.'), true);
  });
});

describe('refusal to draw', () => {
  it('detects the sentence Florian saw from Gemini and variants', () => {
    for (const t of ['Ich kann leider keine Diagramme direkt auf der Canvas für dich erstellen', 'Ich kann dir das nicht zeichnen', 'Ich könnte keine Grafik anzeigen', 'Leider kann ich keine Canvas benutzen']) assert.equal(refusesToDraw(t), true, t);
    for (const t of ['Ich zeichne dir das auf.', 'Das Diagramm zeigt die Ausgaben.', 'Ich kann das erklären.']) assert.equal(refusesToDraw(t), false, t);
  });
  it('RefusalFilter swaps only the refusing sentence, also across stream pieces', () => {
    const f = new RefusalFilter();
    let out = '';
    for (const piece of ['Gern. Ich kann lei', 'der keine Diagramme erstellen. ', 'Das Geld geht an die APIs.']) out += f.push(piece);
    out += f.flush();
    assert.equal(f.refused, true);
    assert.ok(out.includes('Ich zeichne es dir auf.'));
    assert.ok(!/keine Diagramme/.test(out));
    assert.ok(out.includes('Gern.') && out.includes('Das Geld geht an die APIs.'));
  });
  it('RefusalFilter passes normal text through unchanged and never loses characters', () => {
    const f = new RefusalFilter();
    const text = `${'Das ist ein langer Satz ohne Punkt '.repeat(12)}Ende. Noch ein Satz!`;
    let out = '';
    for (let i = 0; i < text.length; i += 7) out += f.push(text.slice(i, i + 7));
    out += f.flush();
    assert.equal(f.refused, false);
    assert.equal(out.replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  });
});
