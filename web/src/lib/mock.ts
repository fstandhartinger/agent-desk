// ?mock=1: simulates the gateway in the browser (chat SSE, Claude sessions, voice WS, transcription, status).
// Explainer assets still come from the network (vite dev proxy → explainers.app.mintapis.com).
import type { ClaudeEvent, PageContext, VizSpec } from './types';
import { FIXTURES } from '../canvas/demo/fixtures';
import type { CanvasSpec } from '../canvas/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const params = new URLSearchParams(location.search);
const AUTH_KEY = 'desk.mock.auth';
if (params.get('auth') === '1') sessionStorage.setItem(AUTH_KEY, '1');

function sse(run: (send: (data: unknown, id?: number) => void, signal: AbortSignal) => Promise<void>, signal?: AbortSignal | null) {
  const ac = new AbortController();
  signal?.addEventListener('abort', () => ac.abort());
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const send = (data: unknown, id?: number) => {
        if (ac.signal.aborted) return;
        ctrl.enqueue(enc.encode(`${id != null ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await run(send, ac.signal);
      } catch {
        /* aborted */
      }
      if (!ac.signal.aborted) ctrl.close();
    },
    cancel: () => ac.abort(),
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

// ── Chat ────────────────────────────────────────────────────────────────────────────
interface Script { tools: { name: string; args: unknown; summary: string; ms: number; host?: string }[]; text: string; viz: VizSpec; handoff?: { id: string; title: string; task: string; why?: string } }

function chatScript(question: string, page?: PageContext): Script {
  const q = question.toLowerCase();
  // Round 12 (28 Oct): read tools with a host chip, and a handoff proposal that waits for Florian's click.
  if (/übergeb|werkzeug|recherch|handoff/.test(q)) {
    return {
      tools: [
        { name: 'web_read', args: { url: 'https://example.org/spec' }, summary: 'Seite „Beispiel-Spezifikation“, 4 200 Zeichen', ms: 640 },
        { name: 'chats_search', args: { query: 'Beispiel-Thema', agent: 'all' }, summary: '3 Treffer in Claude- und Codex-Chats', ms: 410, host: 'sandy' },
        { name: 'chat_read', args: { ref: 'c_demo_1' }, summary: '12 Züge gelesen', ms: 220, host: 'lechonk' },
        { name: 'mail_search', args: { query: 'Beispiel Rechnung' }, summary: '2 Mails', ms: 380, host: 'sandy' },
        { name: 'discord_read', args: { channel: 'beispiel/allgemein' }, summary: '20 Nachrichten', ms: 900, host: 'sandy' },
        { name: 'run_readonly', args: { command: 'quota-pace status' }, summary: 'Claude 41 %, Codex 28 %', ms: 150, host: 'sandy' },
        { name: 'skills_list', args: { query: 'explainer' }, summary: '2 Skills', ms: 90, host: 'lechonk' },
        { name: 'explainer_context', args: { query: 'Krönung' }, summary: 'Abschnitt „Ablauf“ aus dem Hintergrunddokument', ms: 60 },
        { name: 'handoff_propose', args: { title: 'Beispiel-Job prüfen' }, summary: 'Vorschlag erstellt', ms: 30 },
      ],
      text: 'Ich habe nachgesehen – die Quellen stimmen überein. Das Prüfen selbst kann ich nicht anstoßen; dafür habe ich dir einen Auftrag vorbereitet. Er wird erst gepostet, wenn du ihn bestätigst.',
      handoff: { id: 'h_demo_1', title: 'Beispiel-Job prüfen und Ergebnis ins Board schreiben', task: 'Bitte prüfe den Beispiel-Job unter jobs/beispiel-job.\n\n1. Lies STATE.md und RESULT.md.\n2. Vergleiche die genannten Zahlen mit den Rohdaten im Ordner results/.\n3. Wenn etwas abweicht: nenne die Zeile und den Unterschied.\n4. Schreibe ein kurzes Fazit in den passenden Board-Thread.', why: 'Der Desk darf nichts schreiben oder starten, nur lesen.' },
      viz: { v: 1, title: 'Quellen geprüft', nodes: [{ id: 'a', label: 'Desk', kind: 'agent', tone: 'violet' }], edges: [] },
    };
  }
  if (page?.point || /erklär|szene|quelle|bedeutet|fasse/.test(q)) {
    const title = page?.point?.title ?? page?.title ?? 'diese Szene';
    return {
      tools: [{ name: 'explainer_point', args: { pointId: page?.pointId ?? page?.sceneId ?? 'answer' }, summary: `Punkt „${title}“ aus points.json geladen (Kurztext, Quellen).`, ms: 140 }],
      text: `**${title}** heißt im Kern: Es gibt *keinen festen Takt*. Sobald eine neue Version eingereicht wird, läuft die Kette an:\n\n1. **Watcher** – prüft alle 20 Minuten die Chain auf neue Commitments.\n2. **Review** – isoliert, Sicherheit plus Kopien-/Eltern-Check, meist unter einer Stunde.\n3. **Batch** – gemessen auf einer gemieteten RTX PRO 6000, 15–45 Minuten.\n\nWer den Champion um mindestens **3 %** schlägt und das in einer zweiten frischen Sitzung bestätigt, wird *sofort* gekrönt. Die Fakten stammen aus \`engbox/hardening/batches.jsonl\` und der FAQ.\n\nSoll ich nachsehen, ob gerade ein Batch läuft?`,
      viz: {
        v: 1, title: 'Vom Commit zur Krone', caption: 'Ereignisgetrieben statt fester Termine', focus: 'batch',
        nodes: [
          { id: 'commit', label: 'Neues Commitment', kind: 'idea', tone: 'neutral' },
          { id: 'watch', label: 'Watcher · 20 min', kind: 'tool', tone: 'violet' },
          { id: 'review', label: 'Isoliertes Review', kind: 'decision', tone: 'amber', value: '< 1 h' },
          { id: 'batch', label: 'Engine-Batch', kind: 'job', tone: 'papaya', value: 'RTX PRO 6000' },
          { id: 'crown', label: 'Gekrönt', kind: 'number', tone: 'moss', value: '+3 %' },
        ],
        edges: [
          { from: 'commit', to: 'watch', style: 'flow' },
          { from: 'watch', to: 'review', style: 'flow' },
          { from: 'review', to: 'batch', style: 'pulse' },
          { from: 'batch', to: 'crown', label: 'schlägt Champion', style: 'flow' },
        ],
        steps: [{ label: 'Watcher', state: 'done' }, { label: 'Review', state: 'done' }, { label: 'Batch', state: 'active' }, { label: 'Krone', state: 'todo' }],
      },
    };
  }
  if (/job|stand|läuft|board|heute/.test(q)) {
    return {
      tools: [
        { name: 'list_jobs', args: { activeOnly: true, limit: 8 }, summary: '5 aktive Jobs: explainer-live-agent-page, reax2-next-steps, sn92-fast-launch, bh-daily-refresh, mint-cohort-fix', ms: 420 },
        { name: 'job_status', args: { name: 'reax2-next-steps' }, summary: 'STATE.md: Phase 3/4, wartet auf Batch-Ergebnis, letzter Eintrag 08:41', ms: 310 },
      ],
      text: `Gerade laufen **5 Jobs** im Workshop:\n\n| Job | Stand | Seit |\n|---|---|---|\n| explainer-live-agent-page | Fusion-Lead, 5 Worker aktiv | 09:00 |\n| reax2-next-steps | Phase 3/4, wartet auf Batch | 06:12 |\n| sn92-fast-launch | Watcher aktiv, kein neuer Commit | gestern |\n| bh-daily-refresh | Gauntlet-Runde 2 | 07:30 |\n| mint-cohort-fix | Review offen | 08:05 |\n\nAm weitesten ist **reax2-next-steps**: laut \`jobs/reax2-next-steps/STATE.md\` fehlt nur noch das Batch-Ergebnis.`,
      viz: {
        v: 1, title: 'Aktive Jobs', caption: 'Fünf Jobs, einer wartet auf ein Ergebnis', focus: 'reax',
        nodes: [
          { id: 'desk', label: 'Desk', kind: 'agent', tone: 'violet' },
          { id: 'reax', label: 'reax2-next-steps', kind: 'job', tone: 'papaya', value: '3/4' },
          { id: 'expl', label: 'explainer-live-page', kind: 'job', tone: 'moss' },
          { id: 'sn92', label: 'sn92-fast-launch', kind: 'job', tone: 'neutral' },
          { id: 'bh', label: 'bh-daily-refresh', kind: 'job', tone: 'amber' },
        ],
        edges: [
          { from: 'desk', to: 'reax', style: 'pulse' },
          { from: 'desk', to: 'expl', style: 'flow' },
          { from: 'desk', to: 'sn92', style: 'dashed' },
          { from: 'desk', to: 'bh', style: 'flow' },
        ],
      },
    };
  }
  return {
    tools: [
      { name: 'read_core_doc', args: { name: 'DECISIONS' }, summary: 'DECISIONS.md gelesen (412 Zeilen), 3 Einträge seit gestern', ms: 260 },
      { name: 'board_search', args: { query: question.slice(0, 40) }, summary: '2 Treffer in #15 und #22', ms: 380 },
    ],
    text: `Dazu habe ich in \`DECISIONS.md\` und im Board nachgesehen. Die letzte relevante Entscheidung:\n\n> Leads laufen bis 10. Okt auf Codex GPT-6.1 Sol, danach wieder Claude zuerst.\n\nIm Board (#15) gibt es dazu eine offene Rückfrage. Wenn du willst, gebe ich das als Aufgabe an Claude Code:\n\n\`\`\`bash\n~/bin/agent-board read 15 --limit 5\n\`\`\``,
    viz: {
      v: 1, title: 'Woher die Antwort kommt', focus: 'dec',
      nodes: [
        { id: 'q', label: 'Deine Frage', kind: 'user', tone: 'neutral' },
        { id: 'dec', label: 'DECISIONS.md', kind: 'file', tone: 'violet' },
        { id: 'board', label: 'Board #15', kind: 'board', tone: 'amber' },
        { id: 'a', label: 'Antwort', kind: 'agent', tone: 'moss' },
      ],
      edges: [
        { from: 'q', to: 'dec', style: 'flow' },
        { from: 'q', to: 'board', style: 'flow' },
        { from: 'dec', to: 'a', style: 'pulse' },
        { from: 'board', to: 'a', style: 'pulse' },
      ],
    },
  };
}

function mockChat(body: { messages: { role: string; content: string }[]; page?: PageContext }, signal?: AbortSignal | null) {
  const last = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const s = chatScript(last, body.page);
  return sse(async (send, sig) => {
    await sleep(250);
    if (s.tools.some((t) => t.name !== 'explainer_point')) {
      send({ type: 'status', text: 'Ich schaue kurz in die Jobs und ins Board …' });
      await sleep(700);
    }
    const spec = canvasFor(last);
    publishCanvas({ phase: 'pending', id: spec.id, kind: spec.kind, title: spec.title, by: 'text' });
    window.setTimeout(() => publishCanvas({ phase: 'ready', id: spec.id, spec, by: 'text' }), 2600);
    for (const [i, t] of s.tools.entries()) {
      const id = `tc_${Date.now()}_${i}`;
      send({ type: 'tool', id, name: t.name, args: t.args, status: 'start' });
      await sleep(t.ms + 300);
      send({ type: 'tool', id, name: t.name, status: 'done', summary: t.summary, ms: t.ms, host: t.host });
    }
    if (s.handoff) send({ type: 'handoff', ...s.handoff });
    const words = s.text.split(/(?<=\s)/);
    let n = 0;
    for (const w of words) {
      if (sig.aborted) return;
      send({ type: 'delta', text: w });
      if (++n === 18) send({ type: 'viz', spec: s.viz });
      await sleep(22 + Math.random() * 30);
    }
    send({ type: 'done', usage: { in: 2140, out: 380 }, costUsd: 0.0009, model: 'deepseek/deepseek-v4.1-flash-20261017:nitro' });
  }, signal);
}

// ── Canvas bus ──────────────────────────────────────────────────────────────────────
// History = three fixtures; a chat question publishes pending → ready of the fixture that fits it (like canvas_draw).
const canvasSubs = new Set<(ev: unknown, id: number) => void>();
let canvasSeq = 0;
// A screenshot run can seed its own history (localStorage `desk.mock.canvases`, a JSON array of {spec, by, provider}),
// so layouts of drawings that must not be committed are checked in the real UI without a gateway.
function seededHistory(): { spec: CanvasSpec; by: string; provider?: string; at: string }[] | null {
  try {
    const raw = JSON.parse(localStorage.getItem('desk.mock.canvases') ?? 'null');
    if (!Array.isArray(raw)) return null;
    return raw.map((c, i) => ({ spec: c.spec, by: c.by ?? 'text', provider: c.provider, at: new Date(Date.now() - (raw.length - i) * 60_000).toISOString() }));
  } catch { return null; }
}
const canvasHistory: { spec: CanvasSpec; by: string; provider?: string; at: string }[] = seededHistory() ?? [
  { spec: FIXTURES.timeline, by: 'text', at: new Date(Date.now() - 600_000).toISOString() },
  { spec: FIXTURES.architecture, by: 'claude', at: new Date(Date.now() - 300_000).toISOString() },
  { spec: FIXTURES.flow, by: 'voice', provider: 'gemini', at: new Date(Date.now() - 60_000).toISOString() },
];
function publishCanvas(ev: Record<string, unknown>) {
  const full = { type: 'canvas', at: new Date().toISOString(), ...ev };
  canvasSeq++;
  canvasSubs.forEach((fn) => fn(full, canvasSeq));
}
function canvasFor(text: string): CanvasSpec {
  if (/geld|ausgab|kosten|wofür/i.test(text)) return FIXTURES.pie;
  if (/architektur|aufbau|gateway/i.test(text)) return FIXTURES.architecture;
  if (/video|send|block/i.test(text)) return FIXTURES.flow;
  if (/tabelle|jobs/i.test(text)) return FIXTURES.table;
  return FIXTURES.sequence;
}
function mockCanvasEvents(signal?: AbortSignal | null) {
  return sse(async (send, sig) => {
    const fn = (ev: unknown, id: number) => send(ev, id);
    canvasSubs.add(fn);
    await new Promise<void>((r) => sig.addEventListener('abort', () => r()));
    canvasSubs.delete(fn);
  }, signal);
}

// ── Claude sessions ─────────────────────────────────────────────────────────────────
type Ev = ClaudeEvent;
interface Session { sid: string; title: string; model: string; createdAt: number; events: Ev[]; subs: Set<(e: Ev) => void>; timer: number | null; seq: number }
const sessions = new Map<string, Session>();

function emit(s: Session, e: Record<string, unknown>) {
  const ev = { seq: ++s.seq, ts: new Date().toISOString(), ...e } as Ev;
  s.events.push(ev);
  s.subs.forEach((fn) => fn(ev));
}

const RUN: Record<string, unknown>[][] = [
  [{ kind: 'status', state: 'running', model: 'opus', account: 'A' }],
  [{ kind: 'text_delta', text: 'Ich schaue mir zuerst ' }, { kind: 'text_delta', text: 'den aktuellen Stand der Erklärseite an ' }, { kind: 'text_delta', text: 'und prüfe, wo der Desk-Link fehlt.' }],
  [{ kind: 'text', text: 'Ich schaue mir zuerst den aktuellen Stand der Erklärseite an und prüfe, wo der Desk-Link fehlt.' }],
  [{ kind: 'todo', items: [{ content: 'Player-Template lesen', status: 'in_progress' }, { content: 'Desk-Link in index.html einbauen', status: 'pending' }, { content: 'Telegram-Caption ergänzen', status: 'pending' }, { content: 'Tests laufen lassen', status: 'pending' }] }],
  [{ kind: 'tool_use', id: 't1', name: 'Read', path: '~/.agents/skills/explainer-video-webpage/templates/index.html', input: 'index.html' }],
  [{ kind: 'tool_result', id: 't1', ok: true, preview: '<!doctype html>\n<html lang="de">\n<head>\n<meta charset="utf-8">\n<title>Erklärvideo — interaktiv</title>\n…' }],
  [{ kind: 'tool_use', id: 't2', name: 'Grep', input: 'pattern: "subtitle" in templates/', path: '~/.agents/skills/explainer-video-webpage/templates' }],
  [{ kind: 'tool_result', id: 't2', ok: true, preview: 'templates/index.html:57:  <p id="subtitle">Interaktive Fassung — …' }],
  [{ kind: 'todo', items: [{ content: 'Player-Template lesen', status: 'completed' }, { content: 'Desk-Link in index.html einbauen', status: 'in_progress' }, { content: 'Telegram-Caption ergänzen', status: 'pending' }, { content: 'Tests laufen lassen', status: 'pending' }] }],
  [{ kind: 'tool_use', id: 't3', name: 'Edit', path: '~/.agents/skills/explainer-video-webpage/templates/index.html', input: '+ <a class="desk" href="https://desk.app.mintapis.com/?x={slug}">Im Desk öffnen</a>' }],
  [{ kind: 'tool_result', id: 't3', ok: true, preview: 'The file has been updated.' }],
  [{ kind: 'tool_use', id: 't4', name: 'Edit', path: '~/.agents/skills/explainer-video-webpage/scripts/publish.py', input: 'caption += f"\\nInteraktiv: {page_url}"' }],
  [{ kind: 'tool_result', id: 't4', ok: true, preview: 'The file has been updated.' }],
  [{ kind: 'todo', items: [{ content: 'Player-Template lesen', status: 'completed' }, { content: 'Desk-Link in index.html einbauen', status: 'completed' }, { content: 'Telegram-Caption ergänzen', status: 'completed' }, { content: 'Tests laufen lassen', status: 'in_progress' }] }],
  [{ kind: 'tool_use', id: 't5', name: 'Bash', command: 'cd ~/.agents/skills/explainer-video-webpage && node --test', input: 'node --test' }],
  [{ kind: 'tool_result', id: 't5', ok: true, preview: '✔ publish adds page link to caption (3.1ms)\n✔ index template contains desk link (1.2ms)\nℹ tests 14\nℹ pass 14\nℹ fail 0' }],
  [{ kind: 'todo', items: [{ content: 'Player-Template lesen', status: 'completed' }, { content: 'Desk-Link in index.html einbauen', status: 'completed' }, { content: 'Telegram-Caption ergänzen', status: 'completed' }, { content: 'Tests laufen lassen', status: 'completed' }] }],
  [{ kind: 'text_delta', text: 'Erledigt: Die Erklärseite verlinkt jetzt auf den Desk ' }, { kind: 'text_delta', text: '(`?x=<slug>`), und die Telegram-Caption trägt den Seitenlink. **14/14 Tests grün.**' }],
  [{ kind: 'text', text: 'Erledigt: Die Erklärseite verlinkt jetzt auf den Desk (`?x=<slug>`), und die Telegram-Caption trägt den Seitenlink. **14/14 Tests grün.**' }],
  [{ kind: 'result', durationMs: 48200, turns: 1, costUsd: 0.44, subscription: true }, { kind: 'status', state: 'idle', model: 'opus', account: 'A' }],
];

function runScript(s: Session, steps: Record<string, unknown>[][], from = 0) {
  let i = from;
  const step = () => {
    if (i >= steps.length) return void (s.timer = null);
    steps[i++].forEach((e) => emit(s, e));
    s.timer = window.setTimeout(step, 500 + Math.random() * 900);
  };
  s.timer = window.setTimeout(step, 400);
}

function createSession(title: string, prompt: string, model = 'opus', opts: { preplay?: number } = {}) {
  const sid = `d20261024-${Math.random().toString(16).slice(2, 8)}`;
  const s: Session = { sid, title, model, createdAt: Date.now() - (opts.preplay ? 90_000 : 0), events: [], subs: new Set(), timer: null, seq: 0 };
  sessions.set(sid, s);
  emit(s, { kind: 'status', state: 'starting', model, account: 'A' });
  emit(s, { kind: 'user', text: prompt });
  if (opts.preplay) RUN.slice(0, opts.preplay).forEach((step) => step.forEach((e) => emit(s, e)));
  runScript(s, RUN, opts.preplay ?? 0);
  return s;
}

const stateOf = (s: Session) => {
  const st = [...s.events].reverse().find((e) => e.kind === 'status') as Extract<Ev, { kind: 'status' }> | undefined;
  return st?.state ?? 'starting';
};

function seedSessions() {
  const done = createSession('Board-Zusammenfassung #15', 'Fasse die offenen Fragen in Board #15 zusammen.', 'sonnet', { preplay: RUN.length });
  done.createdAt = Date.now() - 3600_000 * 3;
  createSession('Desk-Link in Erklärseiten', 'Kontext: Erklärseite „How the REAX Engine track crowns champions“\n\nAufgabe: Verlinke jede Erklärseite mit dem Desk und ergänze die Telegram-Caption.', 'opus', { preplay: 11 });
}

function mockClaude(path: string, method: string, body: any, headers: Headers, signal?: AbortSignal | null): Response {
  if (path === '/api/claude/sessions' && method === 'GET') {
    return json({ sessions: [...sessions.values()].map((s) => ({ sid: s.sid, title: s.title, model: s.model, state: stateOf(s), createdAt: s.createdAt, updatedAt: Date.parse(s.events[s.events.length - 1].ts) })) });
  }
  if (path === '/api/claude/sessions' && method === 'POST') return json({ sid: createSession(body.title, body.prompt, body.model).sid });
  const m = path.match(/^\/api\/claude\/sessions\/([^/]+)\/(events|messages|stop)/);
  const s = m && sessions.get(m[1]);
  if (!m || !s) return json({ error: 'Sitzung nicht gefunden' }, 404);
  if (m[2] === 'messages') {
    emit(s, { kind: 'user', text: body.text });
    if (!s.timer) runScript(s, [RUN[0], ...RUN.slice(16)]);
    return json({ ok: true });
  }
  if (m[2] === 'stop') {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    emit(s, { kind: 'status', state: 'stopped' });
    return json({ ok: true });
  }
  const since = Number(headers.get('Last-Event-ID') ?? new URL(path, location.origin).searchParams.get('since') ?? -1);
  return sse(async (send, sig) => {
    s.events.filter((e) => e.seq > since).forEach((e) => send(e, e.seq));
    const fn = (e: Ev) => send(e, e.seq);
    s.subs.add(fn);
    await new Promise<void>((r) => sig.addEventListener('abort', () => r()));
    s.subs.delete(fn);
  }, signal);
}

// ── Voice ───────────────────────────────────────────────────────────────────────────
/** Vowel-ish synthetic speech: harmonics with a syllable envelope, PCM16 24 kHz. */
function speechChunk(t0: number, n: number): ArrayBuffer {
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / 24000;
    const f0 = 165 + 25 * Math.sin(t * 2.1);
    const env = Math.max(0, Math.sin(t * Math.PI * 4.2)) ** 0.6 * (0.6 + 0.4 * Math.sin(t * 1.3));
    const v = (Math.sin(2 * Math.PI * f0 * t) * 0.6 + Math.sin(4 * Math.PI * f0 * t) * 0.25 + Math.sin(6 * Math.PI * f0 * t) * 0.12) * env * 0.12;
    pcm[i] = v * 0x7fff;
  }
  return pcm.buffer;
}

class MockVoiceSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  private timers: number[] = [];
  private audio: number | null = null;
  private provider: string;

  constructor(url: string) {
    super();
    this.provider = new URL(url, location.origin).searchParams.get('provider') ?? 'xai';
    this.later(120, () => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }
  private later(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, ms));
  }
  private out(m: unknown) {
    if (this.readyState === 1) this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(m) }));
  }
  private speak(text: string, then?: () => void) {
    const words = text.split(' ');
    let t = 0, w = 0;
    this.audio = window.setInterval(() => {
      if (this.readyState !== 1) return;
      this.onmessage?.(new MessageEvent('message', { data: speechChunk(t, 960) }));
      t += 0.04;
      if (w < words.length && t > w * 0.28) this.out({ type: 'transcript', role: 'assistant', delta: (w ? ' ' : '') + words[w++], final: false });
      if (t > words.length * 0.28 + 0.3) {
        clearInterval(this.audio!);
        this.audio = null;
        this.out({ type: 'transcript', role: 'assistant', text, final: true });
        then?.();
      }
    }, 40);
  }
  private userSays(text: string, after: () => void) {
    const words = text.split(' ');
    words.forEach((w, i) => this.later(i * 260, () => this.out({ type: 'transcript', role: 'user', delta: (i ? ' ' : '') + w, final: false })));
    this.later(words.length * 260 + 200, () => {
      this.out({ type: 'transcript', role: 'user', text, final: true });
      after();
    });
  }
  private reply(answer: string, tool?: { name: string; args: unknown; summary: string }) {
    if (tool) {
      const id = `vt_${Date.now()}`;
      this.later(300, () => this.out({ type: 'tool', id, name: tool.name, args: tool.args, status: 'start' }));
      this.later(1300, () => this.out({ type: 'tool', id, name: tool.name, status: 'done', summary: tool.summary, ms: 820 }));
    }
    this.later(tool ? 1500 : 600, () => this.speak(answer));
  }
  send(data: string | ArrayBuffer) {
    if (typeof data !== 'string') return;
    const m = JSON.parse(data);
    if (m.type === 'start') {
      if (this.provider === 'xai' && params.get('fallback') === '1') {
        this.later(400, () => this.out({ type: 'error', message: 'xAI: 403 – Team ohne Guthaben', fallback: 'gemini' }));
        return;
      }
      const model = { xai: 'grok-voice-3.0', openai: 'gpt-live-1', gemini: m.variant === 'fast' ? 'gemini-3.8-live' : 'gemini-3.8-live-extended-thinking' }[this.provider];
      this.later(500, () => this.out({ type: 'ready', provider: this.provider, model }));
      this.later(1600, () =>
        this.userSays('Wie ist der Stand vom Job reax2-next-steps?', () =>
          this.reply('Ich habe kurz nachgesehen. Der Job steht in Phase drei von vier und wartet nur noch auf das Batch-Ergebnis. Soll ich dir Bescheid geben, sobald es da ist?', {
            name: 'job_status', args: { name: 'reax2-next-steps' }, summary: 'Phase 3/4, wartet auf Batch-Ergebnis',
          }),
        ),
      );
    } else if (m.type === 'text') {
      this.reply('Gute Frage. Kurz gesagt: Es gibt keinen festen Termin, die Krönung passiert direkt im nächsten Batch.');
    } else if (m.type === 'interrupt') {
      if (this.audio) clearInterval(this.audio);
      this.audio = null;
    } else if (m.type === 'stop') this.close();
  }
  close() {
    this.timers.forEach(clearTimeout);
    if (this.audio) clearInterval(this.audio);
    this.readyState = 3;
  }
}

/** Synthetic microphone: modulated noise + tone, so meters and the orb move without a real mic. */
async function fakeMic(): Promise<MediaStream> {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 190;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 3.2;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.08;
  lfo.connect(lfoGain).connect(gain.gain);
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dest);
  osc.start();
  lfo.start();
  await ctx.resume();
  return dest.stream;
}

// ── Install ─────────────────────────────────────────────────────────────────────────
export function installMock() {
  const realFetch = window.fetch.bind(window);
  seedSessions();
  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    const path = url.pathname + url.search;
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/explainer/')) return realFetch(input, init);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    await sleep(80);
    if (url.pathname === '/api/auth/me') return sessionStorage.getItem(AUTH_KEY) ? json({ ok: true }) : json({ error: 'Nicht angemeldet' }, 401);
    if (url.pathname === '/api/auth/login') {
      await sleep(400);
      if (body?.code === 'gesperrt') return new Response(JSON.stringify({ error: 'too many attempts' }), { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after': '900' } });
      if (!body?.code || body.code === 'falsch') return json({ error: 'invalid code' }, 401);
      sessionStorage.setItem(AUTH_KEY, '1');
      return json({ ok: true });
    }
    if (url.pathname === '/api/auth/logout') {
      sessionStorage.removeItem(AUTH_KEY);
      return json({ ok: true });
    }
    if (url.pathname === '/api/status') {
      const running = [...sessions.values()].filter((s) => ['running', 'starting'].includes(stateOf(s))).length;
      return json({ bridges: [{ host: 'lechonk', connected: true, claude: { running, max: 3 } }], providers: {
        xai: { configured: true, ok: false, reason: 'xAI-Guthaben aufgebraucht (403)', checkedAt: new Date().toISOString() },
        openai: { configured: true, ok: null },
        gemini: { configured: true, ok: true, checkedAt: new Date().toISOString() },
        openrouter: { configured: true, ok: true },
        elevenlabs: { configured: true, ok: null },
      }, spendToday: 2.37, capUsd: 15 });
    }
    if (url.pathname === '/api/chat') return mockChat(body, init.signal);
    if (url.pathname === '/api/handoff') {
      await sleep(500);
      return body?.id === 'h_demo_fail' ? json({ error: 'Tageslimit für Übergaben erreicht (10 pro Tag).' }, 429) : json({ ok: true, entryId: 31337 });
    }
    if (url.pathname === '/api/canvas') return json({ canvases: [...canvasHistory].reverse() });
    if (url.pathname === '/api/canvas/events') return mockCanvasEvents(init.signal);
    if (url.pathname === '/api/auth/request-link') {
      await sleep(500);
      if (params.get('linkLimit') === '1') return new Response(JSON.stringify({ error: 'Gerade erst einen Link geschickt.' }), { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after': '540' } });
      return json({ ok: true });
    }
    if (url.pathname === '/api/transcribe') {
      await sleep(900);
      return json({ text: 'Was passiert eigentlich, wenn zwei Engines gleichzeitig den Champion schlagen?' });
    }
    if (url.pathname.startsWith('/api/claude/')) return mockClaude(path, method, body, headers, init.signal);
    return json({ error: 'mock: unbekannte Route' }, 404);
  };

  const RealWS = window.WebSocket;
  window.WebSocket = new Proxy(RealWS, {
    construct(target, args: [string, (string | string[])?]) {
      return String(args[0]).includes('/api/voice') ? new MockVoiceSocket(args[0]) : new target(...args);
    },
  });
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => fakeMic();
  document.documentElement.dataset.mock = '1';
  // Screenshot/measurement scripts: show any spec on the real desk canvas (as if an agent had drawn it).
  (window as unknown as { __mockCanvas: (spec: CanvasSpec, by?: string) => void }).__mockCanvas = (spec, by = 'text') => {
    canvasHistory.push({ spec, by, at: new Date().toISOString() });
    publishCanvas({ phase: 'ready', id: spec.id, spec, by });
  };
}
