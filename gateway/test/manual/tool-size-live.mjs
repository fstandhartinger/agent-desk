// Part 6 (15 Nov 2026): what a big tool result does per provider. Real vendors, the real voice instructions, one typed question that
// makes the model call conversation_history; the result has N characters with the answer at the very end. Measures the time from
// handing the result over to the first audio, and the tokens the vendor reports.
// Usage (LeChonk, keys in the env): node test/manual/tool-size-live.mjs [xai,openai,gemini] [2500,10000,30000]
import { createXai } from '../../src/voice/xai.js';
import { createOpenAI } from '../../src/voice/openai.js';
import { createGemini } from '../../src/voice/gemini.js';
import { TOOL_DEFS } from '../../src/tools.js';
import { buildInstructions } from '../../src/voice/instructions.js';

const providers = (process.argv[2] ?? 'xai,openai,gemini').split(',');
const sizes = (process.argv[3] ?? '2500,10000,30000').split(',').map(Number);
const CREATE = { xai: [createXai, 'XAI_API_KEY'], openai: [createOpenAI, 'OPENAI_API_KEY'], gemini: [createGemini, 'GOOGLE_API_KEY'] };
const tools = TOOL_DEFS.filter((t) => t.name === 'conversation_history');
const filler = (n) => {
  const line = '[18:47] Florian: Wir besprechen den Ablauf der Runde, die Prüfung, die Vorschau und die Wertung, ohne neue Zahlen. ';
  let s = '';
  while (s.length < n - 80) s += line;
  return `${s.slice(0, n - 80)}\n[19:10] Florian: Die geheime Testzahl ist 4711.`;
};

function run(provider, size) {
  return new Promise((resolve) => {
    const [create, keyName] = CREATE[provider];
    const out = { provider, size, toolMs: null, firstAudioMs: null, firstTextMs: null, said: '', usage: [], error: null };
    let sentAt = 0, adapter = null, done = false, callId = null;
    const finish = () => { if (done) return; done = true; try { adapter.close(); } catch { /* closed */ } resolve(out); };
    const t0 = Date.now();
    adapter = create({ apiKey: process.env[keyName], instructions: buildInstructions(null, undefined, { provider }), tools, lang: 'de' }, (e) => {
      if (e.t === 'ready') setTimeout(() => adapter.sendText('Ruf jetzt conversation_history mit query "Testzahl" auf und nenne mir danach nur die Testzahl aus dem Ergebnis.'), 500);
      if (e.t === 'tool_call' && !callId) { callId = e.id; out.toolMs = Date.now() - t0; sentAt = Date.now(); adapter.sendToolResult(e.id, e.name, filler(size)); }
      if (e.t === 'audio' && sentAt && out.firstAudioMs === null) { for (let i = 0; i + 1 < e.pcm.length; i += 32) if (Math.abs(e.pcm.readInt16LE(i)) > 300) { out.firstAudioMs = Date.now() - sentAt; break; } }
      if (e.t === 'transcript' && e.role === 'assistant' && sentAt) { if (out.firstTextMs === null) out.firstTextMs = Date.now() - sentAt; out.said += e.delta ?? e.text ?? ''; }
      if (e.t === 'usage') out.usage.push(e.usage);
      if (e.t === 'error' && !e.soft) { out.error = e.message; finish(); }
      if (e.t === 'turn_done' && sentAt && out.firstAudioMs !== null) setTimeout(finish, 2500);
    });
    setTimeout(finish, 45_000);
  });
}

for (const p of providers) for (const n of sizes) {
  const r = await run(p, n);
  console.log(JSON.stringify({ ...r, said: r.said.replace(/\s+/g, ' ').slice(0, 120), found: /4711|siebenundvierzig/i.test(r.said) }));
}
process.exit(0);
