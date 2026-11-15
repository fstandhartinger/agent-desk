// Live check of the conversation memory against the DEPLOYED Desk (15 Nov 2026): per provider, session 1 hears a planning figure,
// session 2 in the same conversation (the browser's history, as voiceConversation() sends it) must answer a question about it; session 3
// starts a NEW conversation and must find it with conversation_history in the earlier session (registry path).
// Usage: set -a; . ~/.config/agent-desk/secrets.env; set +a; node test/manual/memory-live.mjs [xai,openai,gemini] [https://desk.app.mintapis.com]
// Prints one JSON line per session and a verdict per provider. Typed turns go into the live voice session (deliverText), like the composer.
import WebSocket from 'ws';

const providers = (process.argv[2] ?? 'xai,openai,gemini').split(',');
const origin = process.argv[3] ?? 'https://desk.app.mintapis.com';
const code = process.env.DESK_ACCESS_CODE;
if (!code) throw new Error('DESK_ACCESS_CODE is not set');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  const res = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), redirect: 'manual' });
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('no session cookie');
  return cookie;
}

/** One voice session: start, then each typed question waits for a complete answer (assistant final after a pause). */
function session({ cookie, provider, conversation, questions, label }) {
  return new Promise((resolve) => {
    const q = new URLSearchParams({ provider });
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/voice?${q}`, { headers: { cookie, origin } });
    const out = { label, provider, aid: null, turns: [], errors: [], notices: [], memory: null, started: Date.now() };
    let lastAssistant = 0, answered = 0, idx = -1, done = false;
    const silence = Buffer.alloc(24000 * 2 * 0.04);
    let pump = null;
    const finish = () => { if (done) return; done = true; clearInterval(pump); try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closed */ } setTimeout(() => { ws.close(); resolve(out); }, 1500); };
    const next = () => {
      idx += 1;
      if (idx >= questions.length) return finish();
      const text = questions[idx];
      out.turns.push({ role: 'user', text, ts: Date.now() });
      ws.send(JSON.stringify({ type: 'text', text }));
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', client: { app: 'web', version: 'memory-live', commit: 'test', device: 'desktop' }, entry: { path: 'memory-live' }, conversation })));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (m.type === 'session') out.aid = m.aid;
      if (m.type === 'error') out.errors.push(m.message);
      if (m.type === 'notice') out.notices.push(m.message);
      if (m.type === 'memory') out.memory = m.summary;
      if (m.type === 'tool' && m.status === 'start') { out.turns.push({ role: 'tool', text: `${m.name} ${JSON.stringify(m.args ?? {}).slice(0, 120)}`, ts: Date.now() }); lastAssistant = Date.now(); const mine = ++answered; setTimeout(() => { if (answered === mine && !done) next(); }, 15000); } // a tool runs: the answer follows
      if (m.type === 'ready') { pump = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(silence); }, 40); setTimeout(next, 1500); }
      if (m.type === 'transcript' && m.role === 'assistant' && m.final && m.text?.trim() && idx >= 0) {
        out.turns.push({ role: 'assistant', text: m.text.trim(), ts: Date.now() });
        lastAssistant = Date.now();
        const mine = ++answered;
        setTimeout(() => { if (answered === mine && Date.now() - lastAssistant >= 7000 && !done) next(); }, 7000); // 7 s quiet after the last piece: the answer is complete
      }
      if (m.type === 'closed') finish();
    });
    ws.on('close', () => { if (!done) { done = true; clearInterval(pump); resolve(out); } });
    ws.on('error', (e) => out.errors.push(String(e.message)));
    setTimeout(finish, 150_000);
  });
}

const cookie = await login();
const results = {};
for (const provider of providers) {
  const id = `c_live_${provider}_${Date.now().toString(36)}`;
  const s1 = await session({ cookie, provider, label: 's1', conversation: { id, now: Date.now(), turns: [] }, questions: ['Merke dir bitte für später: Für die 48-Stunden-Bewertungsphase der Runde zwei rechne ich mit höchstens 500 US-Dollar auf vier GPUs. Bestätige nur kurz.'] });
  console.log(JSON.stringify(s1));
  await sleep(4000);
  const history = s1.turns.filter((t) => t.role !== 'tool').map((t) => ({ role: t.role, content: t.text, ts: t.ts }));
  const s2 = await session({ cookie, provider, label: 's2', conversation: { id, now: Date.now(), turns: history, ...(s1.memory ? { memory: { summary: s1.memory, upto: Date.now() } } : {}) }, questions: ['Mit wie viel US-Dollar habe ich für die 48-Stunden-Bewertungsphase gerechnet?'] });
  console.log(JSON.stringify(s2));
  await sleep(4000);
  const s3 = await session({ cookie, provider, label: 's3', conversation: { id: `${id}_new`, now: Date.now(), turns: [] }, questions: [`In der Desk-Sitzung ${s1.aid ?? 'kurz vorhin'} habe ich eine Zahl für die 48-Stunden-Bewertungsphase genannt. Wie viele US-Dollar waren das?`] });
  console.log(JSON.stringify(s3));
  const said = (s) => s.turns.filter((t) => t.role === 'assistant').map((t) => t.text).join(' ');
  results[provider] = { s1: s1.aid, s2: s2.aid, s3: s3.aid, memory: /500/.test(said(s2)), tool: /500/.test(said(s3)), s3tools: s3.turns.filter((t) => t.role === 'tool').map((t) => t.text.split(' ')[0]) };
  console.log('VERDICT', provider, JSON.stringify(results[provider]));
}
console.log('RESULTS', JSON.stringify(results));
process.exit(0);
