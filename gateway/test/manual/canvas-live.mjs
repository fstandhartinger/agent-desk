// LIVE proof of the generative canvas against a running gateway (+ bridge) with real vendor keys in the gateway's env.
//   node test/manual/canvas-live.mjs <base-url> <code-file> <out-dir> <spec...>
// spec = voice:<xai|openai|gemini>:text:<question> | voice:<provider>:audio:<pcm-file>:<question label> | chat:<question>
// Records per run: tools called, canvas events with timing (ms after the request; for audio after the end of speech),
// the transcript, whether any refusal to draw appeared; saves the specs. Never prints or stores secrets.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const [, , BASE, CODE_FILE, OUT, ...SPECS] = process.argv;
if (!BASE || !CODE_FILE || !OUT || !SPECS.length) {
  console.error('usage: canvas-live.mjs <base> <code-file> <out-dir> <spec...>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const REFUSAL = /(kann|könnte).{0,30}(keine|nicht).{0,30}(diagramm|zeichn|canvas|grafik)/i;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: readFileSync(CODE_FILE, 'utf8').trim() }) });
const cookie = login.headers.get('set-cookie')?.split(';')[0];
if (!cookie) throw new Error(`login failed (${login.status})`);

// one bus subscriber for the whole run: proves the browser's canvas stream sees what the chat/voice streams carry
const bus = [];
(async () => {
  const res = await fetch(`${BASE}/api/canvas/events`, { headers: { cookie } });
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) bus.push({ at: Date.now(), event: JSON.parse(data) });
    }
  }
})().catch(() => {});

const summary = [];

function finish(run) {
  const canvas = run.events.filter((e) => e.type === 'canvas');
  const ready = canvas.filter((e) => e.phase === 'ready');
  const text = run.transcripts.map((t) => t.text).join('\n');
  const result = {
    name: run.name, provider: run.provider, mode: run.mode, question: run.question,
    drewCanvasTool: run.tools.some((t) => /^canvas_/.test(t.name) && t.status === 'start'),
    tools: run.tools.map((t) => `${t.name}${t.status === 'start' ? '' : `:${t.status}`}`).filter((v, i, a) => a.indexOf(v) === i),
    canvasPhases: canvas.map((e) => `${e.phase}:${e.id}:${e.by}@${e.ms}ms`),
    readyMs: ready[0]?.ms ?? null,
    readyKinds: ready.map((e) => `${e.kind}:${e.id}`),
    onBus: ready.every((e) => bus.some((b) => b.event.id === e.id && b.event.phase === 'ready' && b.event.at === e.at)),
    refusal: REFUSAL.test(text),
    transcript: run.transcripts,
    errors: run.errors,
    audioSeconds: run.audioBytes ? Number((run.audioBytes / 48000).toFixed(1)) : undefined,
  };
  ready.forEach((e, i) => writeFileSync(path.join(OUT, `canvas-${run.name}-${i}-${e.id}.json`), JSON.stringify({ meta: { by: e.by, provider: e.provider, ms: e.ms, at: e.at }, spec: e.spec }, null, 1)));
  writeFileSync(path.join(OUT, `run-${run.name}.json`), JSON.stringify({ ...result, canvasEvents: canvas.map((e) => ({ ...e, spec: e.spec && `<see canvas-${run.name}-*.json>` })) }, null, 1));
  summary.push(result);
  console.log(`${run.name}: tools=[${result.tools.join(', ')}] ready=${result.readyMs}ms kinds=[${result.readyKinds.join(', ')}] refusal=${result.refusal} onBus=${result.onBus} errors=${run.errors.length}`);
}

async function runVoice({ provider, mode, question, pcm }) {
  const name = `${provider}-${mode}-${slug(question)}`;
  const run = { name, provider, mode, question, tools: [], events: [], transcripts: [], errors: [], audioBytes: 0 };
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/voice?provider=${provider}`, { headers: { cookie, origin: BASE } });
  let t0 = 0;
  let readyAt = 0;
  let sending = true;
  let lastCanvasAt = 0;
  const done = new Promise((resolve) => {
    ws.on('close', resolve);
    ws.on('error', (e) => { run.errors.push(`ws: ${e.message}`); resolve(); });
  });
  let lastActivity = Date.now();
  ws.on('message', (data, isBinary) => {
    lastActivity = Date.now();
    if (isBinary) { run.audioBytes += data.length; return; }
    const m = JSON.parse(data.toString());
    const ms = t0 ? Date.now() - t0 : null;
    if (m.type === 'canvas') { run.events.push({ ...m, ms }); lastCanvasAt = Date.now(); }
    else if (m.type === 'tool') run.tools.push({ name: m.name, status: m.status, args: m.args, summary: m.summary, ms });
    else if (m.type === 'transcript' && m.final) run.transcripts.push({ role: m.role, text: m.text, ms });
    else if (m.type === 'error') run.errors.push(m.message);
    else if (m.type === 'ready') readyAt = Date.now();
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'start', lang: 'de', page: { slug: 'demo', title: 'Agent Desk Live-Test', t: 12 } }));
  while (!readyAt && !run.errors.length) await sleep(50);
  if (readyAt) {
    if (mode === 'text') {
      t0 = Date.now();
      ws.send(JSON.stringify({ type: 'text', text: question }));
    } else {
      const chunk = 24000 * 2 * 0.04;
      for (let o = 0; o < pcm.length; o += chunk) { ws.send(pcm.subarray(o, o + chunk)); await sleep(40); }
      t0 = Date.now(); // the request ends where the speech ends
      (async () => { while (sending) { ws.send(Buffer.alloc(chunk)); await sleep(40); } })();
    }
    const deadline = Date.now() + 90_000;
    // finished when a ready canvas is in AND the assistant answered AND nothing (audio, transcript, tool, canvas) happened for 8 s
    while (Date.now() < deadline) {
      await sleep(250);
      const ready = run.events.some((e) => e.phase === 'ready');
      const answered = run.transcripts.some((t) => t.role === 'assistant');
      if (ready && answered && Date.now() - lastActivity > 8000) break;
      if (run.errors.length && !ready) break;
    }
    await sleep(1500);
  }
  sending = false;
  try { ws.send(JSON.stringify({ type: 'stop' })); } catch { /* closed */ }
  await Promise.race([done, sleep(3000)]);
  ws.terminate();
  run.tools = run.tools.map((t) => ({ ...t }));
  finish(run);
}

async function runChat(question) {
  const name = `chat-${slug(question)}`;
  const run = { name, provider: 'text', mode: 'chat', question, tools: [], events: [], transcripts: [], errors: [], audioBytes: 0 };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ conversationId: name, messages: [{ role: 'user', content: question }], page: { slug: 'demo', title: 'Agent Desk Live-Test', t: 12 } }) });
  if (!res.ok) { run.errors.push(`HTTP ${res.status}`); finish(run); return; }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue;
      const m = JSON.parse(data);
      const ms = Date.now() - t0;
      if (m.type === 'delta') text += m.text;
      else if (m.type === 'canvas') run.events.push({ ...m, ms });
      else if (m.type === 'tool') run.tools.push({ name: m.name, status: m.status, args: m.args, summary: m.summary, ms });
      else if (m.type === 'error') run.errors.push(m.message);
    }
  }
  run.transcripts.push({ role: 'assistant', text, ms: Date.now() - t0 });
  finish(run);
}

for (const spec of SPECS) {
  const [kind, a, b, c, d] = spec.split('|');
  if (kind === 'chat') await runChat(a);
  else if (b === 'text') await runVoice({ provider: a, mode: 'text', question: c });
  else await runVoice({ provider: a, mode: 'audio', question: d, pcm: readFileSync(c) });
}
writeFileSync(path.join(OUT, `summary-${Date.now()}.json`), JSON.stringify(summary, null, 1));
await sleep(300);
process.exit(0);
