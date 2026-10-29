// Demo entry (web/viz-demo.html): scripted fake events and specs drive all four viz components.
// `?at=<s>` jumps to a moment of the script (for screenshots), `?loop=0` stops after one run.
// `?lab=1[&rail=<px>]` is a bare test bench for browser checks: LiveCanvas over an ActivityRail like the app's Live tab,
// driven through `window.__lab.set({spec, tools, orb})`; node clicks are recorded in `window.__lab.clicks`.
import { StrictMode, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClaudeEvent, ToolEvent, VizNode, VizSpec } from '../lib/types';
import LiveCanvas from './LiveCanvas';
import VoiceOrb, { type VoiceOrbProps } from './VoiceOrb';
import ActivityRail from './ActivityRail';
import WorkMap from './WorkMap';
import { C } from './theme';

const SPEC_JOB: VizSpec = {
  v: 1, title: 'Job explainer-live-agent-page', caption: 'Zwei Worker sind abgenommen, drei laufen noch – voice testet gerade Gemini Live.', focus: 'voice',
  nodes: [
    { id: 'lead', label: 'Lead (Opus 5.5)', kind: 'agent', tone: 'violet', value: '5 Worker' },
    { id: 'gw', label: 'gateway-core', kind: 'job', tone: 'moss', value: 'abgenommen' },
    { id: 'bridge', label: 'bridge', kind: 'job', tone: 'moss', value: 'abgenommen' },
    { id: 'voice', label: 'voice', kind: 'job', tone: 'papaya', value: 'testet Gemini' },
    { id: 'web', label: 'web', kind: 'job', tone: 'amber', value: 'läuft' },
    { id: 'viz', label: 'viz', kind: 'job', tone: 'amber', value: 'läuft' },
  ],
  edges: [
    { from: 'lead', to: 'gw', style: 'flow' }, { from: 'lead', to: 'bridge', style: 'flow' }, { from: 'lead', to: 'voice', style: 'flow', label: 'Live-Test' },
    { from: 'lead', to: 'web', style: 'pulse' }, { from: 'lead', to: 'viz', style: 'pulse' },
  ],
};

const SPEC_VOICE: VizSpec = {
  v: 1, title: 'voice: xAI blockiert, Gemini springt ein', caption: 'xAI antwortet mit 403 (keine Credits); der Fallback auf Gemini Live funktioniert, OpenAI ist noch offen.', focus: 'gemini',
  nodes: [
    { id: 'lead', label: 'Lead (Opus 5.5)', kind: 'agent', tone: 'violet', value: '5 Worker' },
    { id: 'voice', label: 'voice', kind: 'job', tone: 'papaya', value: 'Fallback aktiv' },
    { id: 'xai', label: 'xAI Grok Voice', kind: 'risk', tone: 'red', value: '403' },
    { id: 'gemini', label: 'Gemini Live', kind: 'tool', tone: 'moss', value: 'funktioniert' },
    { id: 'openai', label: 'OpenAI gpt-live', kind: 'tool', tone: 'amber', value: 'Test offen' },
  ],
  edges: [
    { from: 'lead', to: 'voice', style: 'flow' }, { from: 'voice', to: 'xai', style: 'dashed', label: 'keine Credits' },
    { from: 'voice', to: 'gemini', style: 'flow', label: 'Fallback' }, { from: 'voice', to: 'openai', style: 'pulse' },
  ],
  steps: [{ label: 'xAI testen', state: 'done' }, { label: 'Gemini-Fallback', state: 'done' }, { label: 'OpenAI testen', state: 'active' }],
};

const SPEC_CLAUDE = (testState: 'todo' | 'active' | 'done'): VizSpec => ({
  v: 1, title: 'Claude Code testet die Login-Limits', focus: testState === 'done' ? 'result' : testState === 'active' ? 'run' : 'test',
  caption: testState === 'done' ? 'Alle 6 Tests grün: nach 5 Fehlversuchen in 15 Minuten antwortet der Login mit 429.' : 'Claude liest auth.js und schreibt einen Test für das Rate-Limit beim Login.',
  nodes: [
    { id: 'florian', label: 'Florian', kind: 'user', tone: 'neutral' },
    { id: 'session', label: 'Claude-Session', kind: 'claude', tone: 'violet', value: 'Sonnet 5.5' },
    { id: 'auth', label: 'gateway/src/auth.js', kind: 'file', tone: 'moss', value: 'gelesen' },
    { id: 'test', label: 'test/auth.test.js', kind: 'file', tone: testState === 'todo' ? 'papaya' : 'moss', value: testState === 'todo' ? 'wird geschrieben' : 'geschrieben' },
    { id: 'run', label: 'node --test', kind: 'tool', tone: testState === 'done' ? 'moss' : 'amber', value: testState === 'done' ? 'grün' : testState === 'active' ? 'läuft' : 'wartet' },
    ...(testState === 'done' ? [{ id: 'result', label: 'Tests', kind: 'number' as const, tone: 'moss' as const, value: '6/6' }] : []),
  ],
  edges: [
    { from: 'florian', to: 'session', style: 'flow', label: 'Auftrag' }, { from: 'session', to: 'auth', style: 'flow', label: 'Read' },
    { from: 'session', to: 'test', style: 'flow', label: 'Write' }, { from: 'test', to: 'run', style: testState === 'todo' ? 'dashed' : 'flow' },
    ...(testState === 'done' ? [{ from: 'run', to: 'result', style: 'flow' as const }] : []),
  ],
  steps: [
    { label: 'auth.js lesen', state: 'done' },
    { label: 'Test schreiben', state: testState === 'todo' ? 'active' : 'done' },
    { label: 'node --test', state: testState === 'done' ? 'done' : testState === 'active' ? 'active' : 'todo' },
  ],
});

type Orb = VoiceOrbProps['state'];
interface World { spec: VizSpec | null; tools: ToolEvent[]; claude: ClaudeEvent[]; orb: Orb; provider: string; epoch: number }
type Action = (w: World, at: number) => Partial<World>;

let seq = 0;
const ce = (e: Record<string, unknown>) => (w: World, at: number) =>
  ({ claude: [...w.claude, { seq: ++seq, ts: new Date(w.epoch + at * 1000).toISOString(), ...e } as ClaudeEvent] });
const tool = (id: string, name: string, status: ToolEvent['status'], extra: Partial<ToolEvent> = {}) =>
  (w: World) => ({ tools: [...w.tools, { type: 'tool' as const, id, name, status, ...extra }] });

const SCRIPT: [number, Action][] = [
  [0.0, () => ({ orb: 'connecting' })],
  [1.4, () => ({ orb: 'listening' })],
  [3.4, () => ({ orb: 'thinking' })],
  [3.6, tool('t1', 'job_status', 'start', { args: { name: 'explainer-live-agent-page-20261024' } })],
  [4.4, tool('t1', 'job_status', 'done', { summary: 'STATE.md: 5 Worker, 2 abgenommen, 3 laufen', ms: 812 })],
  [4.6, tool('t2', 'board_read', 'start', { args: { thread: 'explainer-live-agent-page' } })],
  [5.3, tool('t2', 'board_read', 'done', { summary: '4 neue Einträge, letzter von voice', ms: 640 })],
  [5.6, () => ({ spec: SPEC_JOB, orb: 'speaking' })],
  [9.6, () => ({ orb: 'listening' })],
  [11.0, () => ({ orb: 'thinking' })],
  [11.2, tool('t3', 'read_file', 'start', { args: { path: 'jobs/explainer-live-agent-page-20261024/workers/voice/OUTPUT.md' } })],
  [12.0, tool('t3', 'read_file', 'done', { summary: 'xAI 403 (keine Credits), Gemini-Fallback ok, OpenAI offen', ms: 420 })],
  [12.6, () => ({ spec: SPEC_VOICE, orb: 'speaking' })],
  [16.0, () => ({ orb: 'listening' })],
  [17.0, tool('t4', 'claude_task', 'start', { args: { prompt: 'Login-Rate-Limits im agent-desk testen', model: 'sonnet' } })],
  [17.2, ce({ kind: 'status', state: 'starting', model: 'sonnet', account: 'A' })],
  [17.8, tool('t4', 'claude_task', 'done', { summary: 'Session d20261024-a3f9c1 gestartet', ms: 640 })],
  [18.0, ce({ kind: 'status', state: 'running' })],
  [18.1, ce({ kind: 'user', text: 'Teste die Login-Rate-Limits im agent-desk Repo.' })],
  [18.6, ce({ kind: 'thinking', text: 'Erst auth.js lesen, um zu sehen, wie die Fehlversuche gezählt werden …' })],
  [19.0, () => ({ spec: SPEC_CLAUDE('todo'), orb: 'speaking' })],
  [19.2, ce({ kind: 'todo', items: [{ content: 'auth.js lesen', status: 'in_progress' }, { content: 'Test schreiben', status: 'pending' }, { content: 'node --test ausführen', status: 'pending' }] })],
  [19.4, ce({ kind: 'tool_use', id: 'c1', name: 'Read', path: 'gateway/src/auth.js' })],
  [19.9, ce({ kind: 'tool_use', id: 'c2', name: 'Read', path: 'gateway/src/limits.js' })],
  [20.4, ce({ kind: 'tool_use', id: 'c3', name: 'Read', path: 'gateway/src/server.js' })],
  [20.9, ce({ kind: 'tool_use', id: 'c4', name: 'Read', path: 'docs/SPEC.md' })],
  [21.4, ce({ kind: 'todo', items: [{ content: 'auth.js lesen', status: 'completed' }, { content: 'Test schreiben', status: 'in_progress' }, { content: 'node --test ausführen', status: 'pending' }] })],
  [21.5, ce({ kind: 'text', text: 'Das Limit sitzt in limits.js: 5 Fehlversuche pro 15 Minuten und IP. Ich schreibe jetzt einen Test, der sechs falsche Codes schickt.' })],
  [22.2, ce({ kind: 'tool_use', id: 'c5', name: 'Write', path: 'gateway/test/auth.test.js' })],
  [22.8, ce({ kind: 'tool_use', id: 'c6', name: 'Read', path: 'gateway/src/auth.js' })],
  [23.2, ce({ kind: 'tool_use', id: 'c7', name: 'Edit', path: 'gateway/src/limits.js' })],
  [23.4, () => ({ orb: 'listening' })],
  [23.6, ce({ kind: 'todo', items: [{ content: 'auth.js lesen', status: 'completed' }, { content: 'Test schreiben', status: 'completed' }, { content: 'node --test ausführen', status: 'in_progress' }] })],
  [23.7, ce({ kind: 'tool_use', id: 'c8', name: 'Bash', command: 'cd gateway && node --test test/auth.test.js' })],
  [23.8, () => ({ spec: SPEC_CLAUDE('active') })],
  [24.0, tool('t5', 'search_chats', 'start', { args: { query: 'Login Rate Limit' } })],
  [24.9, tool('t5', 'search_chats', 'error', { summary: 'Bridge nicht verbunden (Timeout 30 s)', ms: 900 })],
  [26.6, ce({ kind: 'tool_result', id: 'c8', ok: false, preview: '1 failing' })],
  [26.8, ce({ kind: 'tool_use', id: 'c9', name: 'Edit', path: 'gateway/test/auth.test.js' })],
  [27.2, ce({ kind: 'tool_use', id: 'c10', name: 'Bash', command: 'cd gateway && node --test test/auth.test.js' })],
  [28.8, ce({ kind: 'tool_result', id: 'c10', ok: true, preview: '# pass 6' })],
  [29.0, ce({ kind: 'todo', items: [{ content: 'auth.js lesen', status: 'completed' }, { content: 'Test schreiben', status: 'completed' }, { content: 'node --test ausführen', status: 'completed' }] })],
  [29.1, ce({ kind: 'text', text: 'Alle 6 Tests sind grün. Nach dem fünften Fehlversuch antwortet /api/auth/login mit 429.' })],
  [29.3, ce({ kind: 'result', durationMs: 11300, costUsd: 0.18, turns: 9 })],
  [29.4, ce({ kind: 'status', state: 'idle' })],
  [29.5, () => ({ spec: SPEC_CLAUDE('done'), orb: 'speaking' })],
  [33.0, () => ({ orb: 'idle' })],
  [34.5, () => ({ orb: 'error' })],
];
const LOOP_S = 38;

const params = new URLSearchParams(location.search);
const startAt = Number(params.get('at') ?? 0);
const loop = params.get('loop') !== '0';
const showStates = params.get('orbs') === '1';
const empty: Omit<World, 'epoch'> = { spec: null, tools: [], claude: [], orb: 'idle', provider: 'Gemini Live' };

function useScript(): World & { t: number } {
  const [world, setWorld] = useState<World & { t: number }>({ ...empty, epoch: Date.now(), t: 0 });
  useEffect(() => {
    let w: World = { ...empty, epoch: Date.now() - startAt * 1000 };
    let i = 0;
    let base = performance.now() - startAt * 1000;
    const step = () => {
      const t = (performance.now() - base) / 1000;
      let changed = false;
      while (i < SCRIPT.length && SCRIPT[i][0] <= t) { w = { ...w, ...SCRIPT[i][1](w, SCRIPT[i][0]) }; i++; changed = true; }
      if (t >= LOOP_S && loop) { base = performance.now(); w = { ...empty, epoch: Date.now() }; i = 0; changed = true; }
      if (changed) setWorld({ ...w, t });
    };
    step();
    const id = setInterval(step, 50);
    return () => clearInterval(id);
  }, []);
  return world;
}

const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

/**
 * Speech-like RMS (0..1) at time t: phrases of 1.4–3 s with 0.25–0.8 s pauses, syllables at 4–6 per second with
 * uneven peaks and a fast attack/slow decay, plus a low room-noise floor — what a real mic/speaker meter shows.
 */
function speechLevel(t: number, seed = 0): number {
  let start = 0, k = seed * 17;
  for (;;) { // walk phrase boundaries deterministically
    const len = 1.4 + hash(k) * 1.6, pause = 0.25 + hash(k + 0.5) * 0.55;
    if (t < start + len + pause) {
      const floor = 0.015 + 0.01 * hash(Math.floor(t * 30) + k);
      const u = t - start;
      if (u > len) return floor;
      const rate = 4 + hash(k + 0.25) * 2;
      const syl = Math.floor(u * rate);
      const ph = u * rate - syl;
      const peak = 0.35 + 0.6 * hash(syl + k * 3.7);
      const env = ph < 0.18 ? ph / 0.18 : Math.exp(-(ph - 0.18) * 4.2);
      const phrase = Math.min(1, u / 0.15, (len - u) / 0.3);
      return floor + peak * env * phrase * 0.8;
    }
    start += len + pause;
    k += 1;
  }
}

/** Fake RMS levels for whoever is talking (speechLevel curves at ~30 Hz, like LiveOrb feeds the real orb). */
function useLevels(orb: Orb) {
  const [lv, setLv] = useState({ mic: 0, spk: 0 });
  const orbRef = useRef(orb);
  orbRef.current = orb;
  useEffect(() => {
    const id = setInterval(() => {
      const t = performance.now() / 1000;
      const o = orbRef.current;
      setLv({ mic: o === 'listening' ? speechLevel(t, 1) : o === 'idle' || o === 'error' ? 0 : 0.02, spk: o === 'speaking' ? speechLevel(t, 2) : 0 });
    }, 33);
    return () => clearInterval(id);
  }, []);
  return lv;
}

function DemoOrb({ state, provider, size = 150 }: { state: Orb; provider: string; size?: number }) {
  const lv = useLevels(state);
  return <VoiceOrb state={state} micLevel={lv.mic} speakerLevel={lv.spk} provider={provider} size={size} />;
}

function Panel({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ background: '#121218', border: `1px solid ${C.line}`, borderRadius: 20, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <h2 style={{ margin: 0, padding: '12px 18px', fontSize: 12, letterSpacing: 2.5, textTransform: 'uppercase', color: C.dim, fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{title}</h2>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </section>
  );
}

function Demo() {
  const w = useScript();
  (window as unknown as { __vizDemo: unknown }).__vizDemo = { t: w.t, spec: w.spec?.title ?? null };
  const activity = [...new Map(w.tools.map((e) => [e.id, { name: e.name, status: e.status }])).values()].slice(-4);
  return (
    <div style={{ minHeight: '100vh', background: C.bg, color: C.fg, fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', padding: 24, boxSizing: 'border-box' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700, letterSpacing: -0.5 }}>Agent Desk · Live-Visualisierung</h1>
        <span style={{ color: C.dim, fontSize: 14 }}>Demo mit Skript-Ereignissen · t = {w.t.toFixed(1)} s</span>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.75fr) minmax(0, 1fr)', gap: 18 }}>
        <Panel title="Live Canvas" style={{ height: 560 }}>
          <LiveCanvas spec={w.spec} activity={activity} className="demo-fill" />
        </Panel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Panel title="Sprachmodus">
            <div style={{ display: 'grid', placeItems: 'center', padding: '26px 0 18px' }}>
              <DemoOrb state={w.orb} provider={w.provider} />
            </div>
          </Panel>
          <Panel title="Werkzeuge" style={{ flex: 1 }}>
            <ActivityRail events={w.tools} />
          </Panel>
        </div>
        <Panel title="Claude Code · Arbeitskarte" style={{ minHeight: 380 }}>
          <WorkMap events={w.claude} />
        </Panel>
        <Panel title="Live Canvas · Handy-Breite" style={{ height: 560, width: 390, justifySelf: 'center' }}>
          <LiveCanvas spec={w.spec} className="demo-fill" />
        </Panel>
      </div>
      {showStates && (
        <Panel title="Sprachmodus · alle Zustände" style={{ marginTop: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-around', padding: '28px 0 20px' }}>
            {(['idle', 'connecting', 'listening', 'thinking', 'speaking', 'error'] as const).map((s) => <DemoOrb key={s} state={s} provider="xAI" size={96} />)}
          </div>
        </Panel>
      )}
    </div>
  );
}

interface LabState { spec: VizSpec | null; tools: ToolEvent[]; orb: Orb }
interface LabApi { set: (p: Partial<LabState>) => void; clicks: string[] }

/** Bench page for browser checks: the app's Live tab without the app (see header comment). */
function Lab() {
  const [st, setSt] = useState<LabState>({ spec: null, tools: [], orb: 'idle' });
  const rail = Number(params.get('rail') ?? 92);
  useEffect(() => {
    const api: LabApi = { set: (p) => setSt((s) => ({ ...s, ...p })), clicks: [] };
    (window as unknown as { __lab: LabApi }).__lab = api;
  }, []);
  const onNodeClick = (n: VizNode) => (window as unknown as { __lab: LabApi }).__lab.clicks.push(n.id);
  const activity = [...new Map(st.tools.map((e) => [e.id, { name: e.name, status: e.status }])).values()].slice(-4);
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', gap: 12, padding: 12, boxSizing: 'border-box', background: C.bg, color: C.fg }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 240, borderRadius: 16, overflow: 'hidden', border: `1px solid ${C.line}` }}>
        <LiveCanvas spec={st.spec} activity={activity} onNodeClick={onNodeClick} className="lab-abs" />
      </div>
      <div style={{ height: rail, flex: 'none', borderRadius: 16, overflow: 'hidden', border: `1px solid ${C.line}` }}>
        <ActivityRail events={st.tools} className="lab-full" />
      </div>
      {params.get('orb') && (
        <div style={{ position: 'absolute', right: 24, top: 24 }}><DemoOrb state={st.orb} provider="Gemini Live" size={110} /></div>
      )}
    </div>
  );
}

const style = document.createElement('style');
// Same web font as the app (index.css), so screenshots show the real text metrics.
style.textContent = '@font-face{font-family:"Inter";src:url("/fonts/InterVariable-latin.woff2") format("woff2");font-weight:100 900;font-display:swap}'
  + 'body{margin:0;background:#0e0e12} .demo-fill{flex:1;min-height:0} .lab-abs{position:absolute;inset:0} .lab-full{height:100%}';
document.head.appendChild(style);
createRoot(document.getElementById('root')!).render(<StrictMode>{params.get('lab') ? <Lab /> : <Demo />}</StrictMode>);
