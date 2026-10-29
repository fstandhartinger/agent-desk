// skills.list / skills.read: the agents' skills (~/.claude/skills/<name>/{SKILL.md,README.md,references/*.md}), read-only.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.js';
import { HOME, NOT_AVAILABLE, isDenied, resolveAllowed } from './paths.js';

const SKILLS_DIR = () => path.join(HOME, '.claude', 'skills');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,79}$/;
const FILE_RE = /^(SKILL\.md|README\.md|references\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md)$/;
const MAX_CHARS = 60_000;

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = /^(name|description):(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trimStart().replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/** The skill folder's real path, only when it ends up inside an allowlisted skills tree. */
function skillDir(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) throw new Error(NOT_AVAILABLE);
  let real;
  try { real = fs.realpathSync(path.join(SKILLS_DIR(), name)); } catch { throw new Error(NOT_AVAILABLE); }
  if (isDenied(real)) throw new Error(NOT_AVAILABLE);
  return real;
}

export async function list({ query } = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const names = (await fs.promises.readdir(SKILLS_DIR()).catch(() => [])).filter((n) => NAME_RE.test(n)).sort();
  const skills = [];
  for (const name of names) {
    let dir;
    try { dir = skillDir(name); resolveAllowed(path.join(dir, 'SKILL.md')); } catch { continue; }
    const head = await fs.promises.readFile(path.join(dir, 'SKILL.md'), 'utf8').then((t) => t.slice(0, 4000)).catch(() => null);
    if (head === null) continue;
    const fm = frontmatter(head);
    const description = redact((fm.description ?? '').slice(0, 300));
    if (q && !`${name} ${description}`.toLowerCase().includes(q)) continue;
    skills.push({ name, description });
    if (skills.length >= 150) break;
  }
  return { skills };
}

export async function read({ name, file = 'SKILL.md' } = {}) {
  const f = String(file || 'SKILL.md');
  if (!FILE_RE.test(f)) throw new Error('file must be SKILL.md, README.md or references/<name>.md');
  const dir = skillDir(String(name ?? ''));
  const real = resolveAllowed(path.join(dir, f));
  if (!real.startsWith(dir + path.sep)) throw new Error(NOT_AVAILABLE);
  const stat = await fs.promises.stat(real);
  if (!stat.isFile()) throw new Error(NOT_AVAILABLE);
  const text = await fs.promises.readFile(real, 'utf8');
  const references = f === 'SKILL.md'
    ? (await fs.promises.readdir(path.join(dir, 'references')).catch(() => [])).filter((n) => FILE_RE.test(`references/${n}`)).sort().slice(0, 50)
    : undefined;
  return { name, file: f, text: redact(text.slice(0, MAX_CHARS)), truncated: text.length > MAX_CHARS, references };
}
