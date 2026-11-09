#!/usr/bin/env node
// End-to-end check of computer control v2 against a REAL Windows desktop: the gateway's own run + loop code (createComputer, runLoop, checkArgs, the v2 prompt and
// tool set) drives a Screen Agent that runs in its debug mode `ScreenAgent.exe --computer-serve <port>` (same ComputerAgent, same tools, no voice session).
// Every step's picture is saved, every action is timed, and each task is verified afterwards with an independent command on the machine.
//
//   SA_SERVE_TOKEN=... E2E_API_KEY=... node scripts/computer-e2e.mjs --serve https://host:port --out ./e2e-out [--model <id>] [--base <openai-compatible url>] [--only a,b]
//
// The loop model here is whatever --model names on an OpenAI-compatible endpoint (vision + tool calls). Production uses cfg.computerModel(); agents must not call
// Claude through a paid API, so the agents' runs of this script use an open-weights vision model: a task that passes with it is a lower bound for production.
import fs from 'node:fs';
import path from 'node:path';

delete process.env.DESK_COMPUTER_GUARDS;
process.env.DESK_COMPUTER_RUN_USD ??= '5';
process.env.DESK_COMPUTER_DAY_USD ??= '50';
const { createComputer } = await import('../src/computer/run.js');

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const SERVE = String(arg('serve', 'http://127.0.0.1:8765')).replace(/\/$/, ''), OUT = arg('out', './e2e-out'), MODEL = arg('model', ''), BASE = String(arg('base', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const ONLY = arg('only', '') ? arg('only').split(',') : null, TOKEN = process.env.SA_SERVE_TOKEN ?? '', KEY = process.env.E2E_API_KEY ?? '';
if (!MODEL || !KEY) { console.error('need --model and E2E_API_KEY'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

async function serve(pathname, body, timeoutMs = 620_000) {
  const res = await fetch(`${SERVE}${pathname}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`serve ${pathname}: HTTP ${res.status} ${text.slice(0, 200)}`); }
}
const act = (tool, args = {}) => serve('/act', { tool, args });
const textOf = (r) => String(r?.result?.text ?? '');

/** One model call on an OpenAI-compatible endpoint; the request is the gateway's (tools, parallel calls), minus the provider pin. */
async function complete({ messages, signal, tools, parallel, maxTokens }) {
  const t0 = Date.now();
  const plain = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.map(({ cache_control: _c, ...part }) => part) } : m)); // the cache mark is Anthropic's
  const body = { model: MODEL, messages: plain, max_tokens: maxTokens, usage: { include: true }, parallel_tool_calls: parallel, tool_choice: 'auto', tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) };
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      if (!res.ok) throw Object.assign(new Error(`provider answered ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
      const data = await res.json();
      if (data.error) throw Object.assign(new Error(String(data.error.message).slice(0, 200)), { status: 502 });
      const m = data.choices?.[0]?.message ?? {};
      const usage = { in: Number(data.usage?.prompt_tokens) || 0, out: Number(data.usage?.completion_tokens) || 0 };
      return { message: { content: typeof m.content === 'string' ? m.content : '', tool_calls: (m.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function?.name ?? '', args: c.function?.arguments ?? '' })).filter((c) => c.name) }, usage, costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : 0, ms: Date.now() - t0 };
    } catch (err) { lastErr = err; if (signal?.aborted || (err.status && err.status < 429)) break; await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); }
  }
  throw Object.assign(lastErr, { ms: Date.now() - t0 });
}

// ---- tasks: what he would say, and how the result is checked without trusting the model ----
const ps = async (command) => textOf(await act('run_powershell', { command, timeout_s: 30 }));
const TASKS = [
  { id: 'notepad', goal: 'Öffne den Windows-Editor (Notepad), schreibe dort den Satz "Hallo aus dem Screen Agent, äöü!" und speichere die Datei als e2e-notiz.txt in meinem Benutzerordner.',
    check: async () => /Hallo aus dem Screen Agent, äöü!/.test(textOf(await act('file_read', { path: '~/e2e-notiz.txt' }))) },
  { id: 'shell', goal: 'Finde mit einem Kommandozeilenbefehl heraus, wie viele Dateien im Ordner C:\\Windows\\System32\\drivers\\etc liegen, und schreibe nur diese Zahl in die Datei e2e-count.txt in meinem Benutzerordner.',
    check: async () => { const want = (await ps('(Get-ChildItem C:\\Windows\\System32\\drivers\\etc -File).Count')).match(/--- stdout ---\s*(\d+)/)?.[1]; const got = textOf(await act('file_read', { path: '~/e2e-count.txt' })).match(/\b\d+\b/g) ?? []; return Boolean(want) && got.includes(want); } },
  { id: 'python', goal: 'Berechne mit Python die SHA-256-Prüfsumme des Textes "screen agent" (UTF-8, ohne Zeilenumbruch) und schreibe sie in die Datei e2e-sha.txt in meinem Benutzerordner.',
    check: async () => { const { createHash } = await import('node:crypto'); return textOf(await act('file_read', { path: '~/e2e-sha.txt' })).toLowerCase().includes(createHash('sha256').update('screen agent').digest('hex')); } },
  { id: 'right-click', goal: 'Lege auf dem Desktop über das Rechtsklick-Menü einen neuen Ordner an und nenne ihn E2E-Ordner. Benutze dafür die Maus, keinen Kommandozeilenbefehl.',
    prepare: async () => { await ps('Remove-Item "$env:USERPROFILE\\Desktop\\E2E-Ordner" -Recurse -ErrorAction SilentlyContinue; (New-Object -ComObject Shell.Application).MinimizeAll()'); },
    check: async () => /True/.test(await ps('Test-Path "$([Environment]::GetFolderPath(\'Desktop\'))\\E2E-Ordner"')) },
  { id: 'drag-window', goal: 'Öffne den Rechner (calc). Ziehe sein Fenster mit der Maus an der Titelleiste so, dass es ganz links oben auf dem Bildschirm liegt.',
    check: async () => { const line = textOf(await act('ui_windows', {})).split('\n').find((l) => /calc|rechner/i.test(l)) ?? ''; const m = line.match(/(-?\d+),\s*(-?\d+),\s*\d+,\s*\d+|\[(-?\d+),(-?\d+)/); const x = Number(m?.[1] ?? m?.[3]), y = Number(m?.[2] ?? m?.[4]); return Number.isFinite(x) && x <= 60 && y <= 60; } },
  { id: 'chrome-cards', goal: 'Im Chrome ist eine Seite mit drei Karten offen (Nordgatan, Opnar AI, Outwing). Klicke bei der Karte zu Opnar AI auf den Knopf "Senden (empfohlen)". Nur diesen einen Knopf.',
    needs: 'cards', check: async () => /clicked=opnar:senden(?![,\w])/i.test(textOf(await act("ui_windows", {}))) },
  { id: 'chrome-fill', goal: 'Öffne im Chrome in einem eigenen Tab diese Adresse: data:text/html,<title>Formular</title><h1>Testformular</h1><input id=q placeholder=Name><button onclick="document.title=\'sent=\'+document.getElementById(\'q\').value">Absenden</button> . Trage dort in das Feld den Namen Hallo Welt ein und klicke auf Absenden.',
    check: async () => /sent=Hallo Welt/.test(textOf(await act('ui_windows', {}))) },
  { id: 'wheel-keys', goal: 'Öffne im Windows-Explorer den Ordner C:\\Windows\\System32, scrolle mit dem Mausrad ein Stück nach unten und sage mir in der Zusammenfassung, wie die erste jetzt sichtbare Datei oder der erste sichtbare Ordner heißt.',
    check: async (summary) => summary.length > 10 },
  { id: 'wsl', goal: 'Führe in WSL den Bash-Befehl "uname -a" aus und schreibe die Ausgabe in die Datei e2e-uname.txt in meinem Windows-Benutzerordner.',
    skipIf: async () => (/no-wsl/.test(JSON.stringify(await act('run_wsl', { command: 'true', timeout_s: 20 }))) ? 'kein WSL auf diesem Rechner' : null),
    check: async () => /Linux/.test(textOf(await act('file_read', { path: '~/e2e-uname.txt' }))) },
];

async function runTask(task) {
  const dir = path.join(OUT, task.id); fs.mkdirSync(dir, { recursive: true });
  const steps = [], said = [], events = [];
  let n = 0;
  const vision = {
    computerReady: () => true, computerDevice: () => 'e2e', computerCommand: () => null,
    computerSend: async (_sid, wire, opts = {}) => {
      if (wire.op === 'beat' || wire.op === 'stop') return { ok: true, code: 'sent' };
      if (wire.op === 'start') { const r = await serve('/start', { goal: wire.goal }); return opts.validate ? opts.validate(r.result) : r.result; }
      if (wire.op !== 'action') return { ok: true, code: 'done' };
      const t0 = Date.now();
      let r; try { r = await act(wire.tool, wire.args); } catch (err) { return { ok: false, code: 'unclear', note: String(err.message).slice(0, 120) }; }
      const ms = Date.now() - t0; n += 1;
      const jpeg = r?.result?.jpeg;
      if (typeof jpeg === 'string' && jpeg) fs.writeFileSync(path.join(dir, `${String(n).padStart(3, '0')}-${wire.tool}.jpg`), Buffer.from(jpeg, 'base64'));
      steps.push({ n, tool: wire.tool, args: JSON.stringify(wire.args).slice(0, 160), ok: r.ok, code: r.code, rule: r.rule, ms, image: Boolean(jpeg), text: textOf(r).slice(0, 200) });
      try { return opts.validate ? opts.validate(r) : r; } catch (err) { steps.at(-1).invalid = String(err.message); return { ok: false, code: 'unclear', note: 'invalid result' }; }
    },
  };
  const session = { client: { app: 'screen-agent', version: '0.1.14', device: 'windows' }, say: (t) => { said.push(t); return true; }, trace: (type, data) => events.push({ type, ...data }), activity: () => {} };
  const computer = createComputer({ vision, hub: {}, complete, tickMs: 1000, statePath: '', limits: { check: () => ({ ok: true }), addCost() {} } });
  computer.attach('e2e', session);
  const t0 = Date.now();
  if (task.prepare) await task.prepare();
  const begun = await computer.begin('e2e', { text: task.goal, goalArg: task.goal });
  if (!begun.ok) return { id: task.id, ok: false, why: `start: ${begun.text}`, steps };
  const R = computer.runOf('e2e');
  // the real app posts a heartbeat every few seconds; without it the gateway ends the run (no-beat)
  const beats = setInterval(() => { try { computer.beat('e2e', { deviceId: 'e2e' }, { run: R.run, state: 'running' }); } catch { /* run over */ } }, 2000);
  const deadline = Date.now() + 6 * 60_000;
  while (computer.isOpen('e2e') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  clearInterval(beats);
  if (computer.isOpen('e2e')) computer.runOf('e2e')?.end('time');
  const stop = events.find((e) => e.type === 'computer.run.stop') ?? {};
  const summary = String(R?.summary ?? '');
  const models = events.filter((e) => e.type === 'computer.model');
  let verified = false, checkError = null;
  try { verified = Boolean(await task.check(summary)); } catch (err) { checkError = String(err.message).slice(0, 200); }
  const result = { id: task.id, ok: verified && stop.why === 'done', verified, why: stop.why, summary, actions: stop.actions ?? steps.length, ms: Date.now() - t0, modelTurns: models.length, modelMs: models.reduce((a, e) => a + (e.ms ?? 0), 0), actionMs: steps.reduce((a, s) => a + s.ms, 0), costUsd: Number((stop.costUsd ?? 0).toFixed(4)), refusals: steps.filter((s) => !s.ok).map((s) => `${s.tool}:${s.rule ?? s.code}`), ...(checkError ? { checkError } : {}), steps };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const health = await serve('/health');
if (!health.ok) { console.error('serve not healthy', health); process.exit(2); }
const results = [];
for (const task of TASKS) {
  if (ONLY && !ONLY.includes(task.id)) continue;
  if (task.needs && !process.argv.includes(`--with-${task.needs}`)) { results.push({ id: task.id, skipped: `braucht --with-${task.needs}` }); continue; }
  const skip = task.skipIf ? await task.skipIf().catch((e) => `skipIf failed: ${e.message}`) : null;
  if (skip) { results.push({ id: task.id, skipped: skip }); console.log(`- ${task.id}: skipped (${skip})`); continue; }
  const r = await runTask(task).catch((err) => ({ id: task.id, ok: false, why: `harness: ${String(err.message).slice(0, 200)}` }));
  results.push(r);
  console.log(`- ${r.id}: ${r.ok ? 'PASS' : 'FAIL'} why=${r.why} actions=${r.actions ?? 0} total=${r.ms ?? 0}ms model=${r.modelMs ?? 0}ms/${r.modelTurns ?? 0} turns actions=${r.actionMs ?? 0}ms refusals=${(r.refusals ?? []).join(',') || '-'} | ${r.summary ?? ''}`);
}
const byTool = {};
for (const r of results) for (const s of r.steps ?? []) (byTool[s.tool] ??= []).push(s.ms);
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const latency = Object.fromEntries(Object.entries(byTool).map(([tool, ms]) => [tool, { n: ms.length, medianMs: median(ms), maxMs: Math.max(...ms) }]));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ model: MODEL, at: new Date().toISOString(), passed: results.filter((r) => r.ok).length, failed: results.filter((r) => r.ok === false).length, skipped: results.filter((r) => r.skipped).length, latency, results: results.map(({ steps, ...r }) => r) }, null, 2));
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => r.ok === false).length, skipped: results.filter((r) => r.skipped).length, latency }));
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
