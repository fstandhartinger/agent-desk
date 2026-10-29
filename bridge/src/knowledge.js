// ctx.knowledge: the desk's private knowledge index in ~/desk-knowledge (built by scripts/knowledge, never in the repo).
// INDEX.md is the short overview of all of Florian's topics; topics/<slug>.md holds the details of one topic.
// Each topic file names its keywords in a `<!-- keywords: a, b, c -->` line, which the fuzzy topic match uses.
import fs from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_DIR, resolveAllowed } from './paths.js';
import { redact } from './redact.js';
import { score } from './fuzzy.js';
import { expandQuery, groupsIn } from './searchTerms.js';

const MAX_CHARS = 12_000;
// The content stops at the next --> or <!-- (critic r7: a lazy (.*?)\s*--> was rescanned per char), trimmed in code.
const KEYWORDS = /<!--\s{0,8}keywords:((?:(?!-->|<!--).)*)\s{0,8}-->/i;

const topicsDir = () => path.join(KNOWLEDGE_DIR, 'topics');

// Keyword lists and curated/auto markers are for the generator and the topic match, not for the reader; dropping them
// leaves more room for facts under the voice agents' 2,500-character tool cap.
const stripMarkers = (text) => text.replace(/^<!--.*-->[ \t]*\n?/gm, '');

async function readCapped(file) {
  const real = resolveAllowed(file);
  const [raw, stat] = await Promise.all([fs.promises.readFile(real, 'utf8'), fs.promises.stat(real)]);
  const text = stripMarkers(raw);
  return { text: redact(text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n…[gekürzt]` : text), updated: stat.mtime.toISOString() };
}

/** [{slug, title, keywords}] of every topic file. */
export async function listTopics() {
  let names = [];
  try { names = (await fs.promises.readdir(topicsDir())).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  return Promise.all(names.map(async (name) => {
    const head = (await fs.promises.readFile(path.join(topicsDir(), name), 'utf8').catch(() => '')).slice(0, 1500);
    return {
      slug: name.slice(0, -3),
      title: /^#\s+(.+)$/m.exec(head)?.[1]?.trim() ?? name.slice(0, -3),
      keywords: KEYWORDS.exec(head)?.[1]?.trim() ?? '',
    };
  }));
}

/** Best topic for a free-text name ("Steuer", "sn92", "Server"): fuzzy on slug/title plus DE<->EN keyword groups. */
export function matchTopic(query, topics) {
  const groups = expandQuery(query);
  const ranked = topics.map((t) => {
    const hay = `${t.slug.replace(/-/g, ' ')} ${t.title} ${t.keywords}`;
    const fuzzy = Math.max(score(query, t.slug), score(query, t.title));
    const terms = groups.length ? groupsIn(hay, groups).length / groups.length : 0;
    return { topic: t, score: Math.max(fuzzy, terms) + (t.slug === String(query).trim().toLowerCase() ? 1 : 0) };
  }).filter((r) => r.score >= 0.5).sort((a, b) => b.score - a.score);
  return ranked;
}

/** Without topic: INDEX.md. With topic: that topic file (fuzzy match), or the list of topics when nothing fits. */
export async function knowledge({ topic } = {}) {
  if (!fs.existsSync(path.join(KNOWLEDGE_DIR, 'INDEX.md'))) {
    return { found: false, note: 'Das Wissensverzeichnis (~/desk-knowledge) ist auf diesem Rechner noch nicht angelegt.' };
  }
  const wanted = String(topic ?? '').trim();
  if (!wanted || /^index$/i.test(wanted)) {
    return { found: true, topic: 'INDEX', path: path.join(KNOWLEDGE_DIR, 'INDEX.md'), ...await readCapped(path.join(KNOWLEDGE_DIR, 'INDEX.md')) };
  }
  const topics = await listTopics();
  const [best, second] = matchTopic(wanted, topics);
  if (!best) return { found: false, topic: wanted, note: 'Kein passendes Thema; wähle eines aus topics.', topics: topics.map((t) => `${t.slug}: ${t.title}`) };
  const file = path.join(topicsDir(), `${best.topic.slug}.md`);
  return {
    found: true,
    topic: best.topic.slug,
    path: file,
    ...(second && second.score >= best.score - 0.1 ? { alsoRelevant: second.topic.slug } : {}),
    ...await readCapped(file),
  };
}
