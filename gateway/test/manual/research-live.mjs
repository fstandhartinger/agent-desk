// Live check of the research path on the deployed desk: a GPT-Live voice session, one typed question, everything the
// desk says for up to 150 s with timestamps. Usage (LeChonk): set -a; . ~/.config/agent-desk/secrets.env; set +a;
// node test/manual/research-live.mjs "question" [openai] [https://desk.app.mintapis.com]
import WebSocket from 'ws';
const question = process.argv[2];
const provider = process.argv[3] || 'openai';
const origin = process.argv[4] || 'https://desk.app.mintapis.com';
const code = process.env.DESK_ACCESS_CODE;
if (!code || !question) throw new Error('DESK_ACCESS_CODE and a question are required');
const res = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code }), redirect: 'manual' });
const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
if (!cookie) throw new Error(`login failed HTTP ${res.status}`);
const ws = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/voice?provider=${provider}`, { headers: { cookie, origin } });
const t0 = Date.now(); let asked = 0; let pump;
const log = (...a) => console.log(`${((Date.now() - (asked || t0)) / 1000).toFixed(1).padStart(6)}s`, ...a);
const silence = Buffer.alloc(24000 * 2 * 0.04);
ws.on('open', () => ws.send(JSON.stringify({ type: 'start', lang: 'de', client: { app: 'web', version: 'research-live', commit: 'test', device: 'desktop' }, entry: { path: 'research-live' }, conversation: { id: `c_rl_${Date.now().toString(36)}`, now: Date.now(), turns: [] } })));
ws.on('message', (data, bin) => {
  if (bin) return;
  const m = JSON.parse(data.toString());
  if (m.type === 'session') log('session', m.aid);
  if (m.type === 'ready') { pump = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(silence), 40); setTimeout(() => { asked = Date.now(); log('ASK', question); ws.send(JSON.stringify({ type: 'text', text: question })); }, 1500); }
  if (m.type === 'tool') log('tool', m.status, m.name);
  if (m.type === 'activity' && /Recherche/.test(m.label ?? '')) log('activity', m.phase, m.label);
  if (m.type === 'transcript' && m.role === 'assistant' && m.final && m.text?.trim()) log('DESK:', m.text.trim());
  if (m.type === 'error') log('error', m.message);
});
setTimeout(() => { clearInterval(pump); try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closed */ } setTimeout(() => process.exit(0), 1500); }, 150_000);
