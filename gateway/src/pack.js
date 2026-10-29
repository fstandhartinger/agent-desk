// Explainer context pack (docs/UPGRADES-1028.md §1, §3): the whole explainer - narration per scene, element -> scene map and
// the long deep-dive - in a form the voice/text agent can carry from its first turn, packed into a per-provider character
// budget, plus ranked keyword retrieval for the rest (tool explainer_context). Server-side only: nothing here reaches the browser
// except as a model answer.
import { fetchExplainerJson, fetchExplainerPrivate } from './explainer.js';

/**
 * Characters of the PAGE part of the instructions per provider (the persona/tool/grounding lines come on top, ~8k).
 * Sources of the vendor limits (researched 28 Oct 2026):
 *  - openai (gpt-live-1): the Live session guide caps `instructions` at 16,384 tokens (developers.openai.com/api/docs/guides/live-conversations);
 *    German text is ~3.2 chars/token, so 24k page chars + 8k persona ≈ 10k tokens = 60 % of the cap. No total context figure is published.
 *  - xai (grok-voice-3.0): xAI publishes no instruction or context limit for the voice model (docs.x.ai voice agent; aggregators list none).
 *    Conservative: same as OpenAI, well below any plausible limit.
 *  - gemini (gemini-3.8-live*): Live models have a 128k-token session context window (ai.google.dev / Firebase Live API session docs), shared with
 *    audio (~25 tokens/s) and the tools; no separate system-instruction cap is documented. 24k chars ≈ 8k tokens is 6 % of it.
 *  - text (OpenRouter deepseek-v4.1-flash, 128k+ context): text turns are not latency-critical at session setup, 40k chars ≈ 13k tokens.
 * Latency: a longer prompt slows the FIRST answer (prefill); the budgets stay at the lead's suggested starting point until a live
 * measurement (scripts/dump-instructions.mjs prints the sizes) says otherwise.
 */
export const PAGE_BUDGET = { xai: 24_000, openai: 24_000, gemini: 24_000, text: 40_000 };
export const budgetFor = (provider) => PAGE_BUDGET[provider] ?? PAGE_BUDGET.text;

const MAX_CONTEXT_JSON = 3_000_000;
const MAX_DEEPDIVE = 60_000;
const CONTEXT_FACTS_MAX = 3_000; // points.page.context (older fact source, <= 12k): capped when a deep-dive competes for the budget
const TOOL = 'explainer_context';
const CLOSING_RESERVE = 300;
export const TRUNCATION = `[… gekürzt; mehr per ${TOOL}(query | section | sceneId)]`;

const clean = (v, max) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
export const mmss = (s) => { const n = Math.max(0, Math.floor(Number(s) || 0)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; };

/** Splits a Markdown deep-dive into sections at `## ` headings (text before the first one is the section "Einleitung"). */
export function splitSections(md) {
  const text = String(md ?? '').replace(/\r/g, '').slice(0, MAX_DEEPDIVE);
  const sections = [];
  let cur = { heading: 'Einleitung', body: [] };
  for (const line of text.split('\n')) {
    // "## <heading>" by index, not /^##\s+(.*\S)\s*$/ (its \s+ and .* overlapped: quadratic on a line of blanks, critic r7)
    const heading = /^##\s/.test(line) ? line.slice(2).trim() : '';
    if (heading && !/[\n\r\u2028\u2029]/.test(heading) && !line.startsWith('###')) {
      sections.push(cur);
      cur = { heading, body: [] };
    } else cur.body.push(line);
  }
  sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, text: s.body.join('\n').trim() })).filter((s) => s.text || s.heading !== 'Einleitung');
}

const sceneIndex = (scenes, t) => scenes.findIndex((s) => t >= s.start && t < s.end);

/** Pack from the server-built context.json (v1). Returns null for anything that is not that shape. */
function fromContext(ctx, deepdiveMd) {
  if (!ctx || ctx.v !== 1 || !Array.isArray(ctx.scenes)) return null;
  const scenes = ctx.scenes.map((s) => ({ id: String(s.id), start: Number(s.start) || 0, end: Number(s.end) || 0, title: clean(s.title, 160) || String(s.id), text: clean(s.text, 8000), points: Array.isArray(s.points) ? s.points.map(String) : [] }));
  const elements = {};
  for (const [id, e] of Object.entries(ctx.elements ?? {})) elements[id] = { scene: e?.scene ?? null, t: Number(e?.t) || 0, title: clean(e?.title, 160), short: clean(e?.short, 400) };
  return { scenes, elements, deepdive: splitSections(deepdiveMd), sources: Array.isArray(ctx.sources) ? ctx.sources.slice(0, 20) : [], origin: 'context.json' };
}

/** Fallback when the server has no context.json: the same shapes derived from timeline.json + points.json. */
export function deriveFromTimeline(timeline, points, deepdiveMd) {
  const words = Array.isArray(timeline?.words) ? timeline.words : [];
  const scenes = (Array.isArray(timeline?.scenes) ? timeline.scenes : []).map((s) => {
    const text = clean(s.text, 8000) || words.filter((w) => w.s >= s.start && w.s < s.end).map((w) => w.w).join(' ');
    return { id: String(s.id), start: Number(s.start) || 0, end: Number(s.end) || 0, title: clean(points?.points?.[s.id]?.title, 160) || String(s.id), text, points: [] };
  });
  const elements = {};
  const cues = timeline?.cues && typeof timeline.cues === 'object' ? timeline.cues : {};
  for (const [id, p] of Object.entries(points?.points ?? {})) {
    let scene = null;
    let t = Number.isFinite(cues[id]) ? cues[id] : 0;
    if (scenes.some((s) => s.id === id)) scene = id; // a point id equal to a scene id maps to itself
    else if (Number.isFinite(cues[id])) scene = scenes[sceneIndex(scenes, cues[id])]?.id ?? null;
    if (scene) t = Number.isFinite(cues[id]) ? cues[id] : scenes.find((s) => s.id === scene).start;
    elements[id] = { scene, t, title: clean(p?.title, 160), short: clean(p?.short, 400) };
    const owner = scenes.find((s) => s.id === scene);
    if (owner && !owner.points.includes(id)) owner.points.push(id);
  }
  return { scenes, elements, deepdive: splitSections(deepdiveMd), sources: [], origin: 'timeline.json' };
}

/** Loads the pack of one page: context.json + deepdive.md (private, bearer) when available, else derived. null when nothing is known. */
export async function loadPack(slug, points, timeline) {
  const [ctxBody, deepBody] = await Promise.all([fetchExplainerPrivate(slug, 'context.json'), fetchExplainerPrivate(slug, 'deepdive.md')]);
  const deepdiveMd = deepBody ? deepBody.toString('utf8') : '';
  let ctx = null;
  if (ctxBody && ctxBody.length <= MAX_CONTEXT_JSON) {
    try { ctx = fromContext(JSON.parse(ctxBody.toString('utf8')), deepdiveMd); } catch { ctx = null; }
  }
  const pack = ctx ?? (timeline || points ? deriveFromTimeline(timeline, points, deepdiveMd) : null);
  if (!pack || (!pack.scenes.length && !pack.deepdive.length)) return null;
  pack.transcriptFull = transcriptOf(pack);
  return pack;
}

/** Pack of a slug from the (cached) public files + the private ones; used by the explainer_context tool. */
export async function loadPackForSlug(slug) {
  const [points, timeline] = await Promise.all([fetchExplainerJson(slug, 'points.json'), fetchExplainerJson(slug, 'timeline.json')]);
  return loadPack(slug, points, timeline);
}

/** `[mm:ss–mm:ss] Szenentitel: Text` per scene. */
export function transcriptOf(pack) {
  return pack.scenes.map((s) => `[${mmss(s.start)}–${mmss(s.end)}] ${s.title}: ${s.text}`).join('\n');
}

export const sceneOfElement = (pack, id) => (pack?.elements?.[id]?.scene ? pack.scenes.find((s) => s.id === pack.elements[id].scene) ?? null : null);

// ---------------------------------------------------------------- relevance + retrieval

// DE<->EN helpers in the spirit of bridge/src/searchTerms.js (kept small: the explainers are mostly German, the questions too)
const SYNONYMS = [
  ['steuer', 'tax', 'finanzamt'], ['rücklage', 'reserve', 'rückstellung'], ['emission', 'emissions', 'emit'], ['geld', 'money', 'spend', 'budget', 'kosten', 'cost'],
  ['euro', 'eur'], ['server', 'host'], ['kunde', 'customer', 'client'], ['rechnung', 'invoice'], ['zahlung', 'payment', 'bezahl'], ['vertrag', 'contract'],
  ['entscheid', 'decision', 'decided'], ['benchmark', 'bench'], ['grenze', 'limit', 'quota'], ['konto', 'account'], ['regel', 'rule'], ['wissen', 'knowledge'],
  ['quelle', 'source'], ['schritt', 'step'], ['ablauf', 'flow', 'process', 'prozess'], ['zahl', 'number', 'wert', 'value'], ['risiko', 'risk'], ['preis', 'price'],
  ['modell', 'model'], ['daten', 'data'], ['fehler', 'error', 'bug'], ['ergebnis', 'result'], ['agent', 'agenten'],
];
const STOP = new Set('der die das den dem des ein eine einen einem einer und oder aber auch nur noch schon mal mir mich ich du er sie es wir ihr was wie wo wer wann warum ist sind war bin hat haben wird werden kann mit von vom zu zum zur auf aus bei nach in im an am als dass da dann denn doch so the a an and or of to in on at for with from by is are was were be it this that what how which who about'.split(' '));

const stem = (w) => {
  for (const suffix of ['ungen', 'en', 'er', 'es', 'e', 's', 'n']) if (w.length - suffix.length >= 4 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  return w;
};
const words = (text) => String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

/** Query -> groups of word stems (each group = one meaning with its DE/EN variants). */
export function termGroups(query) {
  const groups = [];
  for (const w of new Set(words(query))) {
    const group = new Set([stem(w)]);
    for (const row of SYNONYMS) if (row.some((r) => r === w || (r.length >= 4 && w.includes(r)) || (w.length >= 4 && r.startsWith(w)))) row.forEach((r) => group.add(stem(r)));
    groups.push([...group]);
  }
  return groups.slice(0, 10);
}

const countIn = (hay, needle) => { let n = 0; for (let i = hay.indexOf(needle); i !== -1 && n < 20; i = hay.indexOf(needle, i + needle.length)) n += 1; return n; };

/** Score of one document (heading counts triple): each matched group adds 1 + log(count). */
function score(groups, heading, text) {
  const h = heading.toLowerCase();
  const t = text.toLowerCase();
  let total = 0;
  for (const group of groups) {
    const inText = Math.max(...group.map((g) => countIn(t, g)));
    const inHead = Math.max(...group.map((g) => countIn(h, g)));
    if (inText || inHead) total += 1 + Math.log(1 + inText) + 3 * inHead;
  }
  return total;
}

/** Excerpt of at most `max` chars, centred on the first query-term hit. */
function excerpt(text, groups, max) {
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const g of groups.flat()) { const i = lower.indexOf(g); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const start = Math.max(0, Math.min(at === -1 ? 0 : at - Math.floor(max / 4), text.length - max));
  return `${start > 0 ? '… ' : ''}${text.slice(start, start + max).trim()}${start + max < text.length ? ' …' : ''}`;
}

function sceneBlock(pack, scene) {
  const els = scene.points.map((id) => pack.elements[id]).filter(Boolean);
  const list = scene.points.length ? `\nElemente: ${scene.points.map((id) => `${id} (${pack.elements[id]?.title || id})`).join(', ')}` : '';
  return `[${mmss(scene.start)}–${mmss(scene.end)}] Szene "${scene.id}" – ${scene.title}\n${scene.text}${els.length ? list : ''}`;
}

/**
 * The explainer_context tool: with sceneId the narration + elements of that scene, with section the deep-dive section whose heading contains it
 * (or its 1-based number), with query the ranked best deep-dive sections and scenes; without arguments the outline. At most `max` characters.
 */
export function searchPack(pack, { query, section, sceneId } = {}, max = 2500) {
  if (!pack) return 'Zu dieser Seite liegt kein Hintergrunddokument und keine Szenenübersicht vor.';
  const out = [];
  const room = () => max - out.join('\n\n').length - 2;
  const add = (text) => { const left = room(); if (left > 80) out.push(text.length > left ? `${text.slice(0, left - 40).trim()} …[gekürzt]` : text); };
  if (sceneId) {
    const scene = pack.scenes.find((s) => s.id === sceneId);
    if (!scene) return `Unbekannte Szene "${sceneId}". Szenen: ${pack.scenes.map((s) => s.id).join(', ')}.`;
    add(sceneBlock(pack, scene));
  }
  if (section) {
    const n = Number(section);
    const hit = Number.isInteger(n) && n >= 1 ? pack.deepdive[n - 1] : pack.deepdive.find((s) => s.heading.toLowerCase().includes(String(section).toLowerCase()));
    if (!hit) return `Kein Abschnitt "${section}". Abschnitte: ${pack.deepdive.map((s, i) => `${i + 1}. ${s.heading}`).join(' | ') || '(kein Hintergrunddokument)'}.`;
    add(`## ${hit.heading}\n${hit.text}`);
  }
  if (query) {
    const groups = termGroups(query);
    const ranked = [
      ...pack.deepdive.map((s) => ({ kind: 'section', s: score(groups, s.heading, s.text), text: `## ${s.heading}\n`, body: s.text })),
      ...pack.scenes.map((sc) => ({ kind: 'scene', s: score(groups, sc.title, sc.text) * 1.2, text: `Szene "${sc.id}" [${mmss(sc.start)}–${mmss(sc.end)}] ${sc.title}\n`, body: sc.text })),
    ].filter((r) => r.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
    if (!ranked.length && !out.length) return `Nichts zu "${query}" gefunden. Abschnitte: ${pack.deepdive.map((s) => s.heading).join(' | ') || '(keine)'}; Szenen: ${pack.scenes.map((s) => s.id).join(', ')}.`;
    const per = Math.max(500, Math.floor(max / Math.min(3, ranked.length || 1)));
    for (const r of ranked) add(`${r.text}${excerpt(r.body, groups, per)}`);
  }
  if (!out.length) {
    add(`Szenen:\n${pack.scenes.map((s) => `- ${s.id} [${mmss(s.start)}–${mmss(s.end)}] ${s.title}`).join('\n')}`);
    add(`Hintergrunddokument${pack.deepdive.length ? '' : ' (nicht vorhanden)'}:\n${pack.deepdive.map((s, i) => `${i + 1}. ${s.heading}`).join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------------------------------------------------------------- packing into the instructions

/** Distinct word stems of a text, for the keyword overlap between a scene and a deep-dive section. */
const stems = (text) => new Set(words(text).filter((w) => w.length > 3).map(stem));

/** Deep-dive sections ordered: relevant to the clicked scene first (keyword overlap), then the rest in document order. */
export function orderSections(pack, focusText) {
  const secs = pack.deepdive.map((s, i) => ({ ...s, i }));
  if (!focusText) return secs;
  const focus = stems(focusText);
  const rel = (s) => { const own = stems(`${s.heading} ${s.text}`); let hit = 0; for (const w of focus) if (own.has(w)) hit += 1; const head = stems(s.heading); for (const w of focus) if (head.has(w)) hit += 2; return hit / Math.sqrt(1 + own.size / 20); };
  const scored = secs.map((s) => ({ s, r: rel(s) }));
  const top = scored.filter((x) => x.r >= 1.5).sort((a, b) => b.r - a.r).slice(0, 3).map((x) => x.s);
  return [...top, ...secs.filter((s) => !top.includes(s))];
}

/**
 * The page part of the instructions as lines, at most `budget` characters. Priority (contract §3): (1) the clicked element with its scene and
 * the full narration of that scene, flagged as the likely topic of the first question; (2) the full transcript with scene timestamps;
 * (3) the scene list with element ids; (4) the older fact text of the page, (5) the deep-dive, relevant sections first, with a truncation marker.
 * `page` is the server-loaded page context (loadPageContext): title, t, sceneId, pointId, point, transcriptNear, context, pack.
 */
export function pagePackLines(page, { provider = 'text', budget = budgetFor(provider) } = {}) {
  if (!page) return [];
  const pack = page.pack ?? null;
  const parts = [];
  let used = 0;
  const room = budget - CLOSING_RESERVE; // the closing tool hint is appended after the greedy blocks
  const push = (text, { flexible = true } = {}) => {
    const left = room - used - 1;
    if (left < 120) return false;
    const piece = text.length <= left ? text : flexible ? `${text.slice(0, left - TRUNCATION.length - 2).trimEnd()}\n${TRUNCATION}` : null;
    if (piece === null) return false;
    parts.push(piece);
    used += piece.length + 1;
    return text.length <= left;
  };

  const head = [`## Aktuelle Erklärseite`, `Titel: ${page.title}`, `Position: ${Number.isFinite(page.t) ? Math.round(page.t) : 0} s${page.sceneId ? `, Szene "${page.sceneId}"` : ''}`];
  const scene = (page.pointId && sceneOfElement(pack, page.pointId)) || pack?.scenes.find((s) => s.id === page.sceneId) || null;
  push(head.join('\n'));

  // (1) the clicked element
  if (page.point) {
    const lines = [`### Angeklickt: "${page.pointId}" – ${page.point.title}`, 'Florian hat gerade dieses Element angeklickt; seine erste Frage bezieht sich sehr wahrscheinlich darauf. Beantworte sie direkt aus den Angaben hier, ohne Werkzeug.', `${page.point.short ?? ''} ${page.point.more ?? ''}`.trim()];
    if (scene) lines.push(`Gehört zur Szene "${scene.id}" – ${scene.title} [${mmss(scene.start)}–${mmss(scene.end)}]. Vollständiger Sprechtext dieser Szene: ${scene.text}`);
    push(lines.filter(Boolean).join('\n'));
  } else if (scene) {
    push(`### Aktuelle Szene "${scene.id}" – ${scene.title} [${mmss(scene.start)}–${mmss(scene.end)}]\nSprechtext: ${scene.text}`);
  }
  if (page.transcriptNear && !pack) push(`Gerade gesprochen (±20 s): ${String(page.transcriptNear).slice(0, 1500)}`);

  if (pack) {
    // (2) full transcript, scene by scene (whole scenes only; the cut names the tool)
    if (pack.scenes.length) {
      const lines = ['### Vollständiger Sprechtext des Videos'];
      let fits = true;
      const reserve = Math.min(2500, Math.floor(budget * 0.1)); // the scene list and facts still get room
      for (const s of pack.scenes) {
        const line = `[${mmss(s.start)}–${mmss(s.end)}] ${s.title}: ${s.text}`;
        if (used + lines.join('\n').length + line.length + reserve > room) { fits = false; break; }
        lines.push(line);
      }
      if (!fits) lines.push(TRUNCATION);
      push(lines.join('\n'));
      // (3) scenes with their element ids
      const els = pack.scenes.map((s) => `- ${s.id} (${s.title}): ${s.points.length ? s.points.map((id) => `${id}${pack.elements[id]?.title ? ` "${pack.elements[id].title}"` : ''}`).join(', ') : 'keine Elemente'}`);
      push(['### Szenen und Elemente', ...els].join('\n'));
    }
  }
  // (4) older fact text of the page
  if (page.context) push(`### Fakten zur Seite (Quelle für Fragen dazu)\n${page.context.slice(0, pack?.deepdive.length ? CONTEXT_FACTS_MAX : page.context.length)}`);
  // (5) deep-dive, relevant first
  if (pack?.deepdive.length) {
    const focus = [page.point && `${page.point.title} ${page.point.short ?? ''} ${page.point.more ?? ''}`, scene && `${scene.title} ${scene.text}`].filter(Boolean).join(' ');
    const lines = ['### Hintergrunddokument (Vertiefung zum Video)'];
    let cut = false;
    for (const s of orderSections(pack, focus)) {
      const block = `## ${s.heading}\n${s.text}`;
      const left = room - used - lines.join('\n').length - 2;
      if (block.length <= left) lines.push(block);
      else { if (left > 400) lines.push(`${block.slice(0, left - TRUNCATION.length - 2).trimEnd()}\n`); cut = true; break; }
    }
    if (cut) lines.push(TRUNCATION);
    if (lines.length > 1) push(lines.join('\n'));
  }
  if (pack) parts.push(`Für mehr aus dem Hintergrunddokument oder zu einer Szene: ${TOOL} (query, section oder sceneId). Weitere Punkte holst du mit explainer_point.`);
  else parts.push('Bei Fragen zur Seite antworte aus diesen Fakten; weitere Punkte holst du mit explainer_point.');
  return parts;
}

/** Short page-context update when Florian clicks another element during a running voice session. */
export function pageUpdateText(page, max = 3500) {
  if (!page?.point) return '';
  const pack = page.pack;
  const scene = (page.pointId && sceneOfElement(pack, page.pointId)) || pack?.scenes.find((s) => s.id === page.sceneId) || null;
  const text = [
    `(Hinweis vom Desk, nicht von Florian: Florian hat gerade das Element "${page.pointId}" – ${page.point.title} angeklickt. Seine nächste Frage bezieht sich sehr wahrscheinlich darauf. Antworte daraus, ohne Werkzeug.)`,
    `${page.point.short ?? ''} ${page.point.more ?? ''}`.trim(),
    scene && `Szene "${scene.id}" – ${scene.title} [${mmss(scene.start)}–${mmss(scene.end)}]: ${scene.text}`,
  ].filter(Boolean).join('\n');
  return text.length > max ? `${text.slice(0, max - TRUNCATION.length - 1)}\n${TRUNCATION}` : text;
}

// Critic r2 P1-2: the page facts of the clicked element (title / short / more, the full narration of its scene, the most relevant
// deep-dive section) for the illustrator, which draws an answer about the page from them FIRST. Model-only like pagePackLines.
const PAGE_FACTS_CHARS = 5000;
/** The page block for the illustrator / the voice model: '' without a page. */
export function pageFacts(page) {
  if (!page || typeof page !== 'object') return '';
  const pack = page.pack ?? null;
  const scene = (page.pointId && sceneOfElement(pack, page.pointId)) || pack?.scenes?.find((x) => x.id === page.sceneId) || null;
  const lines = [];
  if (page.point) {
    lines.push(`Angeklickt: "${page.pointId}" – ${page.point.title}`, `${page.point.short ?? ''} ${page.point.more ?? ''}`.trim());
  }
  if (scene) lines.push(`Szene "${scene.id}" – ${scene.title} [${mmss(scene.start)}–${mmss(scene.end)}], Sprechtext: ${scene.text}`);
  else if (page.transcriptNear) lines.push(`Gerade gesprochen (±20 s): ${String(page.transcriptNear).slice(0, 1500)}`);
  if (pack?.deepdive?.length && (page.point || scene)) {
    const focus = [page.point && `${page.point.title} ${page.point.short ?? ''} ${page.point.more ?? ''}`, scene && `${scene.title} ${scene.text}`].filter(Boolean).join(' ');
    const [top] = orderSections(pack, focus);
    if (top) lines.push(`Hintergrunddokument, Abschnitt "${top.heading}": ${top.text.slice(0, 2000)}`);
  }
  const text = lines.filter(Boolean).join('\n');
  return text.length > PAGE_FACTS_CHARS ? `${text.slice(0, PAGE_FACTS_CHARS - 1)}…` : text;
}

