// Source normalisation (docs/CANVAS.md "Quellen", round 7): a source ref on the canvas is a path, a URL, a board ref
// ("Board #n · Eintrag m"), a DECISIONS key with its file, or "Gespräch" - nothing else. Models write "Ledger-Aggregation",
// "AGENTS", "Thread #11", "Board #41234" (an entry id): those are repaired from the turn's tool results or dropped.
import { slugify } from './canvas.js';

const HOME = '/home/flori';
const CORE_DOCS = { AGENTS: `${HOME}/AGENTS.md`, DECISIONS: `${HOME}/DECISIONS.md`, STATE: `${HOME}/STATE.md`, CLAUDE: `${HOME}/CLAUDE.md`, MODEL_POLICY: `${HOME}/.hermes/model-economy-policy.md` };
const REPO = `${HOME}/work/agent-desk`;
const ENTRY_MIN = 1000; // thread ids are small; board entry ids are not

/** The thread whose board_read result contains entry `n` ("#41234 [" starts an entry), from the turn's tools. */
function threadOfEntry(n, tools) {
  for (const t of [...tools].reverse()) {
    if (t.name !== 'board_read' || t.ok === false) continue;
    const thread = String(t.args?.thread ?? '').replace(/^#/, '');
    if (/^\d{1,4}$/.test(thread) && new RegExp(`(^|\\n)#${n} \\[`).test(String(t.content ?? ''))) return thread;
  }
  return null;
}

function boardRef(match, tools) {
  const n = Number(match[1]);
  const entry = match[2] ? Number(match[2]) : null;
  if (n >= ENTRY_MIN) {
    const thread = threadOfEntry(n, tools);
    return thread ? `Board #${thread} · Eintrag ${n}` : `Board · Eintrag ${n}`;
  }
  return `Board #${n}${entry ? ` · Eintrag ${entry}` : ''}`; // "Board #22 (TAX-Zeilen)" -> "Board #22": the parenthesis is a model's comment, not part of the ref
}

/** The repaired ref, or null when it is not a real source. */
export function normalizeRef(ref, tools = []) {
  const text = String(ref ?? '').trim();
  if (!text) return null;
  if (/^gespräch$/i.test(text)) return 'Gespräch';
  if (/^https?:\/\/\S+$/i.test(text)) return text;
  if (/^(?:\/|~\/)\S/.test(text) && !/\s{2,}/.test(text)) return text.replace(/^~(?=\/)/, '~');
  const board = /^(?:board|thread|faden)\s*#\s*(\d{1,9})(?:\s*·\s*eintrag\s*(\d{1,9}))?(\s*(?:\([^)]{1,60}\)|\/\s*ledger-export))?/i.exec(text);
  if (board) return boardRef(board, tools).replace(/(?<!\s)\s*\/\s*ledger-export$/i, '');
  if (/^board:\s*\S/i.test(text)) return text;
  if (/^(?:board\s*)?(?:eintrag|entry)\s*(?:#\s*)?(\d{3,9})$/i.test(text)) {
    const n = Number(/(\d{3,9})/.exec(text)[1]);
    const thread = threadOfEntry(n, tools);
    return thread ? `Board #${thread} · Eintrag ${n}` : `Board · Eintrag ${n}`;
  }
  const decisions = /^decisions(?:\.md)?\s*(?:[:·#-](.+))?$/i.exec(text); // no \s* before (.+): they overlapped (critic r7)
  if (decisions) return decisions[1] ? `${CORE_DOCS.DECISIONS} · ${decisions[1].trim()}` : CORE_DOCS.DECISIONS;
  const core = /^(agents|state|claude|model_policy)(?:\.md)?(?:\s+\S.*)?$/i.exec(text);
  if (core) return CORE_DOCS[core[1].toUpperCase()];
  if (/DECISIONS\.md/.test(text)) return CORE_DOCS.DECISIONS;
  const relative = /^((?:gateway|bridge|web|docs)\/[\w./@-]+)$/.exec(text);
  if (relative) return `${REPO}/${relative[1]}`;
  // a job name that a tool of this turn actually looked at
  const slug = slugify(text, '');
  if (slug && tools.some((t) => t.name === 'job_status' && t.ok !== false && String(t.args?.name ?? '') === text)) return `${HOME}/jobs/${text}`;
  return null;
}

const inRepo = (ref) => canonRef(ref) === REPO || canonRef(ref).startsWith(`${REPO}/`);
const NOTIFY_TOPIC = /notify|telegram|erklärvideo|explainer|video[- ]?(?:versand|send)|build_video|login[- ]?link/i;
const DESK_TOPIC = /\b(?:desk|gateway|bridge|canvas|voice|illustrator|frontend|web[- ]?client|slices?)\b/i;

/**
 * Round 8 (critic r7 C3): a source must match the topic. A drawing about the notify / video-send flow does not cite the Agent
 * Desk's own code (`bridge/src`), even when the model looked there; its sources are the rules, scripts and knowledge it read.
 * `spec` = the validated CanvasSpec (title, caption, labels).
 */
export function dropOffTopicSources(list, spec) {
  const text = [spec?.title, spec?.caption, ...(spec?.nodes ?? []).flatMap((n) => [n.label, n.detail]), ...(spec?.actors ?? []).map((a) => a.label), ...(spec?.messages ?? []).map((m) => m.label)].filter(Boolean).join(' ');
  if (!NOTIFY_TOPIC.test(text) || DESK_TOPIC.test(text)) return list;
  return list.filter((s) => !inRepo(s.ref));
}

/** `~/x` and `/home/flori/x` are the same file. */
export const canonRef = (ref) => String(ref ?? '').replace(/^~(?=\/)/, HOME);

/** [{label, ref}] with every ref repaired; sources that are not real are dropped, duplicates merged. */
export function normalizeSources(list, tools = []) {
  const out = [];
  for (const s of list ?? []) {
    if (s?.label === 'Wechselkurs (ca.)') { out.push(s); continue; } // the desk's own FX note
    const ref = normalizeRef(s?.ref, tools);
    if (!ref || out.some((o) => canonRef(o.ref) === canonRef(ref))) continue;
    out.push({ label: s.label && s.label !== s.ref ? s.label : ref.startsWith('/') ? ref.split('/').filter(Boolean).at(-1) : ref, ref });
  }
  return out;
}
