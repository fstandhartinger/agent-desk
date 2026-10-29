// Upgrades 28 Oct (§5) readability check: three synthetic examples (desk architecture, payout flow, deployment
// pipeline), each drawn as the full version and passed through the gateway's real simple path (ensureSimple), shown in the
// dev demo (/canvas-demo.html, side-column frame at 1440×900, full width at 390×844): simple, then "Details", then
// "Einfach" again. Measures the rendered label font size and counts crossing arrows of the simple view.
// Usage: NODE_PATH=<playwright node_modules> node scripts/screens-detail.mjs <devServerUrl> <outDir>
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ensureSimple, normalizeCanvas } from '../../gateway/src/canvas.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const [base, out] = process.argv.slice(2);
if (!base || !out) throw new Error('usage: screens-detail.mjs <baseUrl> <outDir>');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (id, label, extra = {}) => ({ id, label, ...extra });
const src = [{ label: 'Beispiel (synthetisch)', ref: 'Gespräch' }];

const EXAMPLES = {
  architecture: {
    kind: 'architecture', id: 'desk-aufbau', title: 'Wie der Agent Desk aufgebaut ist', caption: 'Browser, Gateway, Bridge und Anbieter.', highlight: 'gateway', sources: src,
    groups: [{ id: 'browser', label: 'Browser' }, { id: 'server', label: 'Gateway-Server' }, { id: 'werkstatt', label: 'Werkstatt' }, { id: 'anbieter', label: 'Anbieter' }],
    nodes: [n('web', 'Web-App', { group: 'browser' }), n('canvas', 'Canvas', { group: 'browser' }), n('gateway', 'Gateway', { group: 'server', tone: 'papaya', detail: 'Login, Tools, Kostenlimit' }), n('zeichner', 'Zeichnerin', { group: 'server', tone: 'violet' }), n('relay', 'Voice-Relay', { group: 'server' }), n('bridge', 'Bridge', { group: 'werkstatt' }), n('sessions', 'Code-Sessions', { group: 'werkstatt' }), n('ledger', 'Ledger', { group: 'werkstatt', shape: 'cylinder' }), n('voice', 'Voice-Anbieter', { group: 'anbieter' }), n('llm', 'Sprachmodell', { group: 'anbieter' })],
    edges: [{ from: 'web', to: 'gateway', label: 'HTTPS und WebSocket' }, { from: 'canvas', to: 'gateway' }, { from: 'gateway', to: 'zeichner' }, { from: 'gateway', to: 'relay' }, { from: 'gateway', to: 'bridge', label: 'WS' }, { from: 'bridge', to: 'sessions' }, { from: 'bridge', to: 'ledger' }, { from: 'relay', to: 'voice' }, { from: 'zeichner', to: 'llm' }],
  },
  payout: {
    kind: 'flow', id: 'auszahlung', title: 'Wie eine Auszahlung läuft', caption: 'Erst Belege, dann Freigabe, dann Überweisung.', highlight: 'check', sources: src,
    nodes: [n('antrag', 'Antrag'), n('pruefung', 'Belege prüfen', { detail: 'Rechnung und Betrag' }), n('check', 'Freigabe?', { shape: 'diamond', tone: 'papaya' }), n('rueckfrage', 'Rückfrage an Antragsteller', { tone: 'amber' }), n('bank', 'Überweisung'), n('buchung', 'Buchung'), n('beleg', 'Beleg ablegen', { shape: 'cylinder' }), n('fertig', 'Erledigt', { tone: 'moss' })],
    edges: [{ from: 'antrag', to: 'pruefung' }, { from: 'pruefung', to: 'check' }, { from: 'check', to: 'bank', label: 'ja' }, { from: 'check', to: 'rueckfrage', label: 'nein, Beleg fehlt', style: 'dashed' }, { from: 'rueckfrage', to: 'pruefung' }, { from: 'bank', to: 'buchung' }, { from: 'buchung', to: 'beleg' }, { from: 'beleg', to: 'fertig' }],
  },
  deploy: {
    kind: 'flow', id: 'deployment', title: 'Vom Commit bis in Produktion', caption: 'Tests und Build entscheiden, ob ausgerollt wird.', highlight: 'tests', direction: 'LR', sources: src,
    nodes: [n('commit', 'Commit'), n('ci', 'CI startet'), n('lint', 'Lint'), n('tests', 'Tests', { tone: 'papaya' }), n('build', 'Docker-Build'), n('scan', 'Abhängigkeiten prüfen'), n('staging', 'Staging'), n('smoke', 'Smoke-Test'), n('prod', 'Produktion', { tone: 'moss' }), n('rollback', 'Rollback', { tone: 'red' })],
    edges: [{ from: 'commit', to: 'ci' }, { from: 'ci', to: 'lint' }, { from: 'ci', to: 'tests' }, { from: 'lint', to: 'build' }, { from: 'tests', to: 'build', label: 'grün' }, { from: 'build', to: 'scan' }, { from: 'scan', to: 'staging' }, { from: 'staging', to: 'smoke' }, { from: 'smoke', to: 'prod', label: 'ok' }, { from: 'smoke', to: 'rollback', label: 'Fehler', style: 'dashed' }],
  },
};

const specs = Object.fromEntries(Object.entries(EXAMPLES).map(([k, raw]) => {
  const r = normalizeCanvas(raw, { gate: true });
  if (!r.ok) throw new Error(`${k}: ${r.error}`);
  return [k, ensureSimple(r.spec).spec];
}));
writeFileSync(`${out}/canvas-specs.json`, JSON.stringify(specs, null, 2));

// rendered font size (px on screen) of every node label, and the number of crossing edge segments
const measure = () => {
  const svg = document.querySelector('.cv-svg');
  const texts = [...svg.querySelectorAll('text')];
  const px = (t) => Number(t.getAttribute('font-size')) * (t.getScreenCTM()?.a ?? 1);
  const sizes = texts.map(px).filter((x) => x > 0);
  // node labels = the biggest type of the scene (edge pills and group legends are set smaller on purpose)
  const base = Math.max(...texts.map((t) => Number(t.getAttribute('font-size'))));
  const nodeLabel = Math.round(Math.min(...texts.filter((t) => Number(t.getAttribute('font-size')) === base).map(px)) * 10) / 10;
  const segs = [];
  for (const p of svg.querySelectorAll('path')) {
    if (p.getAttribute('fill') && p.getAttribute('fill') !== 'none') continue;
    const d = p.getAttribute('d') ?? '';
    if (!/^M/.test(d) || /[AQC]/.test(d)) continue;
    const pts = [...d.matchAll(/(-?\d+(?:\.\d+)?)[ ,](-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1], b: pts[i], path: p });
  }
  const cross = (s, t) => {
    const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    return o(s.a, s.b, t.a) * o(s.a, s.b, t.b) < 0 && o(t.a, t.b, s.a) * o(t.a, t.b, s.b) < 0;
  };
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i].path !== segs[j].path && cross(segs[i], segs[j])) crossings++;
  return { nodeLabel, minFont: Math.round(Math.min(...sizes) * 10) / 10, maxFont: Math.round(Math.max(...sizes) * 10) / 10, crossings, toggle: document.querySelector('.cv-detail')?.textContent ?? null, pressed: document.querySelector('.cv-detail')?.getAttribute('aria-pressed') ?? null };
};

const VIEW = { desktop: { viewport: { width: 1440, height: 900 }, query: 'w=829&h=719' }, phone: { viewport: { width: 390, height: 844 }, query: '' } };
const browser = await chromium.launch();
const report = {};
const errors = [];
for (const [kind, v] of Object.entries(VIEW)) {
  for (const [name, spec] of Object.entries(specs)) {
    const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: 1, isMobile: kind === 'phone', hasTouch: kind === 'phone', locale: 'de-DE' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`${kind} ${name}: ${e.message}`));
    await p.goto(`${base}/canvas-demo.html?empty=1&${v.query}`, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => window.__ready);
    await p.evaluate((s) => window.__show(s), spec);
    await wait(3200);
    report[`${kind}-${name}-simple`] = await p.evaluate(measure);
    await p.screenshot({ path: `${out}/canvas-${name}-simple-${kind}.png` });
    await p.click('.cv-detail');
    await wait(450);
    await p.screenshot({ path: `${out}/canvas-${name}-switching-${kind}.png` });
    await wait(2600);
    report[`${kind}-${name}-detail`] = await p.evaluate(measure);
    await p.screenshot({ path: `${out}/canvas-${name}-detail-${kind}.png` });
    await p.click('.cv-detail');
    await wait(2600);
    report[`${kind}-${name}-back`] = await p.evaluate(measure);
    console.log('saved', kind, name);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(`${out}/canvas-report.json`, JSON.stringify({ report, errors }, null, 2));
console.log(JSON.stringify(report, null, 1));
if (errors.length) { console.error('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
