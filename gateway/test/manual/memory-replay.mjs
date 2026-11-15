// Replays Florian's test of 15 Nov: a new voice session in the conversation of a#a54cbb (30 min, OpenAI) must answer his question
// about the 48-hour figure. History = the words of a trace JSON (desk-trace a#a54cbb --json > file), as the browser would send them.
// Usage: node test/manual/memory-replay.mjs <trace.json> [xai,openai,gemini] [origin]
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import { transcriptOf } from '../../src/history.js';

const [file, list = 'xai,openai,gemini', origin = 'http://127.0.0.1:8899'] = process.argv.slice(2);
const turns = transcriptOf(JSON.parse(readFileSync(file, 'utf8')).events).map((t) => ({ role: t.role, content: t.text, ts: t.at }));
const QUESTION = 'Mit wie viel US-Dollar habe ich als Überschlagswert für die 48-Stunden-Bewertungsphase gerechnet?';
const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: process.env.DESK_ACCESS_CODE }) });
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
for (const provider of list.split(',')) {
  const r = await new Promise((resolve) => {
    const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/voice?provider=${provider}`, { headers: { cookie, origin } });
    const out = { provider, aid: null, said: [], tools: [], memory: null, readyMs: null };
    const t0 = Date.now(); let last = 0, done = false, pump;
    const finish = () => { if (done) return; done = true; clearInterval(pump); try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closed */ } setTimeout(() => { ws.close(); resolve(out); }, 1000); };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', client: { app: 'web', version: 'replay', commit: 'test', device: 'desktop' }, entry: { path: 'memory-replay' }, conversation: { id: `c_replay_${provider}_${Date.now().toString(36)}`, now: Date.now(), turns } })));
    ws.on('message', (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      if (m.type === 'session') out.aid = m.aid;
      if (m.type === 'memory') out.memory = m.summary.slice(0, 600);
      if (m.type === 'tool' && m.status === 'start') out.tools.push(m.name);
      if (m.type === 'ready') { out.readyMs = Date.now() - t0; pump = setInterval(() => ws.readyState === 1 && ws.send(Buffer.alloc(1920)), 40); setTimeout(() => ws.send(JSON.stringify({ type: 'text', text: QUESTION })), 1500); }
      if (m.type === 'transcript' && m.role === 'assistant' && m.final && m.text?.trim()) { out.said.push(m.text.trim()); last = Date.now(); setTimeout(() => Date.now() - last >= 7000 && finish(), 7000); }
      if (m.type === 'error') out.said.push(`ERROR ${m.message}`);
    });
    ws.on('close', () => { if (!done) { done = true; resolve(out); } });
    setTimeout(finish, 90_000);
  });
  console.log(JSON.stringify({ ...r, pass: /500/.test(r.said.join(' ')) }));
}
process.exit(0);
