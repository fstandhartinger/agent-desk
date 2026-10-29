import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from './redact.js';

// Same text as PRE in ~/bin/run-claude.sh: desk sessions run like every other job.
export const PRE = 'NOTE: follow ~/.hermes/model-economy-policy.md for engine choice. New automatic jobs use quota-pace to choose among measured Claude, Codex, and Devin allowance; free OpenCode remains available for mechanical subtasks or when no paid allowance is eligible. Devin work uses the local Devin CLI with no --cloud flag and is admitted only when its quota is measured. Keep judgement, money and security decisions in your own Claude turns. Check the job folder for partial work first and continue from there -- do not redo finished work. IMPORTANT: you run non-interactively (claude -p): never use background tasks or run_in_background and never end your turn to "wait" for something — run every command in the foreground (poll with sleep loops if needed) until the whole job is finished.\n\n';

const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? ''));

function pageSection(page) {
  if (!page || typeof page !== 'object') return '';
  const lines = ['## Page context (what Florian was looking at)'];
  lines.push(`- explainer: ${cut(page.title, 200)} (${cut(page.slug, 80)}) at t=${Number(page.t) || 0}s${page.sceneId ? `, scene ${cut(page.sceneId, 60)}` : ''}`);
  if (page.point) {
    lines.push(`- selected point: ${cut(page.point.title, 200)}`, `  ${cut(page.point.short, 600)}`, `  ${cut(page.point.more, 1200)}`);
  }
  if (page.transcriptNear) lines.push('', 'Narration near the current time:', cut(page.transcriptNear, 1500));
  return `${lines.join('\n')}\n\n`;
}

function chatSection(chat) {
  const msgs = Array.isArray(chat) ? chat.slice(-12) : [];
  const text = typeof chat === 'string' ? cut(chat, 8000) : msgs.map((m) => `${m.role === 'assistant' ? 'Desk agent' : 'Florian'}: ${cut(m.content, 1500)}`).join('\n\n');
  return text ? `## Recent chat on the desk page\n${text}\n\n` : '';
}

// How a desk session draws on Florian's canvas; the bridge cuts the block out of the shown text (src/canvas.js).
export const CANVAS_HELP = [
  '## Canvas: du kannst zeichnen',
  'Florian hat neben dem Gespräch eine Canvas. Zeichne, wenn du eine Struktur, einen Ablauf oder Zahlen erklärst; Florian sieht es live.',
  'Sag nie, dass du nicht zeichnen kannst. Schreibe dazu einen Block mit genau einem JSON-Objekt in deine Antwort:',
  '',
  '```desk-canvas',
  '{"v":2,"id":"video-send-block","kind":"flow","title":"Wie der Video-Versand blockiert wird","direction":"LR",',
  ' "nodes":[{"id":"a","label":"Agent"},{"id":"guard","label":"Link-Prüfung","detail":"exit 75 ohne Link","tone":"papaya"},{"id":"tg","label":"Telegram","tone":"moss"}],',
  ' "edges":[{"from":"a","to":"guard","label":"Video"},{"from":"guard","to":"tg","label":"mit Link"}],',
  ' "sources":[{"label":"notify Quelltext","ref":"/home/flori/bin/notify"}]}',
  '```',
  '',
  'kind: flow | architecture | sequence | pie | bar | line | table | timeline | sankey | custom_svg. Pflichtfelder: v (2), id (slug a-z0-9-, gleiche id = Update derselben Skizze), kind, title (max 70 Zeichen), sources (mindestens eine Quelle: Dateipfad, Board-Eintrag oder "Gespräch").',
  'flow/architecture: nodes (id, label, detail, group, tone, shape), edges (from, to, label, style), groups. sequence: actors, messages. pie/bar: items (label, value, tone) und unit. line: series. table: columns, rows. timeline: events (date, label). sankey: nodes und links (from, to, value). tone: moss | papaya | violet | amber | neutral (red nur für echte Probleme).',
  'Nur Zahlen und Strukturen, die du aus Dateien, Tools oder dem Gespräch kennst; nie schätzen. Der Block erscheint nicht im Chat, dort steht nur "[Skizze auf der Canvas: Titel]". Schreibe zusätzlich ein, zwei Sätze Text dazu.',
  '',
].join('\n');
// --- r5-knowledge block (separate from the canvas lines other slices add to the header) ---
/** Points the Claude session at the desk's private knowledge index before it searches. */
export function knowledgeSection() {
  return [
    '## Florian\'s topics (desk knowledge)',
    '- Overview of all topics with key facts and links: ~/desk-knowledge/INDEX.md. Details per topic: ~/desk-knowledge/topics/<slug>.md.',
    '- Read INDEX.md and the matching topic file FIRST, then follow its links (DECISIONS keys, job folders, skills, board threads) instead of searching blind.',
    '',
  ].join('\n');
}
// --- end r5-knowledge block ---

/** PROMPT.md body: desk header (who/where/rules) + page context + recent chat + the task. */
export function buildPrompt({ sid, title, prompt, page, chatContext, dir }) {
  const header = [
    `# Agent Desk session ${sid}: ${cut(title, 120)}`,
    '',
    `Asked by: Florian, via the Agent Desk page (https://desk.app.mintapis.com/), ${new Date().toISOString()}.`,
    `Session folder (your job folder): ${dir}`,
    '',
    '## Rules for this session',
    '- This is an interactive desk session for Florian: follow /home/flori/AGENTS.md like every job. Use ~/bin/notify and the agent board as usual.',
    '- Keep STATE.md in this session folder current (what is done, what is next); check it first if it exists.',
    '- Florian watches your output live and may send follow-up messages; answer concisely and say what you are doing.',
    '- Never wait idle for an external reply: set a cron/watcher and finish the turn instead.',
    '',
    CANVAS_HELP,
  ].join('\n');
  return redact(`${header}\n${knowledgeSection()}\n${pageSection(page)}${chatSection(chatContext)}## Task\n${cut(prompt, 20000)}\n`);
}

/** Full -p text for the first turn: PRE + shared job preamble + PROMPT.md, as run-claude.sh builds it. */
export function firstTurnPrompt(promptMd) {
  let preamble = '';
  try { preamble = fs.readFileSync(path.join(os.homedir(), 'bin', 'job-preamble.txt'), 'utf8'); } catch { /* optional */ }
  return `${PRE}${preamble}${promptMd}`;
}
