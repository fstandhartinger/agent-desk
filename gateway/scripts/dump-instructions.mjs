#!/usr/bin/env node
// Prints the final instructions of the voice/text agent for a synthetic explainer, so the packing can be eyeballed.
// Usage: node scripts/dump-instructions.mjs <slug> <pointId> <provider: xai|openai|gemini|text> [--full-deepdive]
// The fixture is synthetic (test/helpers/pack-fixture.js); <slug> only labels the page. Point ids: el1a ... el6b, or a scene id.
import { makeDeepdive, makePoints, makeTimeline } from '../test/helpers/pack-fixture.js';
import { deriveFromTimeline, PAGE_BUDGET, transcriptOf } from '../src/pack.js';
import { buildInstructions as voice } from '../src/voice/instructions.js';
import { buildInstructions as text } from '../src/prompt.js';

const [slug = 'demo-slug', pointId = 'el2a', provider = 'xai', flag] = process.argv.slice(2);
if (!(provider in PAGE_BUDGET)) { console.error(`provider must be one of ${Object.keys(PAGE_BUDGET).join(', ')}`); process.exit(2); }
const timeline = makeTimeline({ sceneChars: 1200 });
const points = makePoints(timeline);
const deep = makeDeepdive(flag === '--full-deepdive' ? { sections: 40, chars: 1800 } : {});
const pack = deriveFromTimeline(timeline, points, deep);
pack.transcriptFull = transcriptOf(pack);
const entry = points.points[pointId];
const t = pack.elements[pointId]?.t ?? 0;
const page = { slug, title: points.page.title, t, sceneId: pack.elements[pointId]?.scene, pointId: entry ? pointId : undefined, point: entry && { title: entry.title, short: entry.short, more: entry.more }, context: points.page.context, transcriptNear: '' };
Object.defineProperty(page, 'pack', { value: pack, enumerable: false });
const instructions = provider === 'text' ? text(page) : voice(page, undefined, { provider });
const pageStart = instructions.indexOf('## Aktuelle Erklärseite');
console.log(`# provider=${provider} total=${instructions.length} chars, page part=${instructions.length - pageStart} chars (budget ${PAGE_BUDGET[provider]}), deepdive=${deep.length} chars\n`);
console.log(instructions);
