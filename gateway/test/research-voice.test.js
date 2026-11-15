// Discovery job (critic round 1, B1/B2/B8): a research that outlives its short wait in a voice session settles the turn (no
// no-answer recovery, no invented result), and its answer is told later through say() only when the session is idle.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setEnv } from "./helpers/env.js";

setEnv({ DESK_CANVAS_EARLY: "0", DESK_VOICE_NO_ANSWER_MS: "400", DESK_VOICE_WATCHDOG_MS: "300" });
const { TOOL_DEFS, runTool } = await import("../src/tools.js");
const { runVoiceSession } = await import("../src/voice/session.js");
const { createResearchManager, withResearchAttach } = await import("../src/research/manager.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESULT = { answer: "Gut 10 Tage, rund 445 GPU-Stunden.", found: true, sources: [{ label: "Board", ref: "#62320" }], unconfirmed: [], confidence: "hoch", classes: ["open"], outsider: false, rounds: 2, steps: 3, ms: 900, costUsd: 0.01, model: "m", stopped: "answer" };

function harness(t, researchMs) {
  const research = createResearchManager({ research: async () => { await sleep(researchMs); return RESULT; }, sleep: (ms) => sleep(Math.min(ms, 50)) });
  const computer = { attach: () => () => {}, assistantFinal() {}, userFinal() {}, userPartial() {}, quiet: () => false, guarded: () => false };
  const ws = new EventEmitter();
  Object.assign(ws, { OPEN: 1, CONNECTING: 0, readyState: 1, sent: [], send: (d) => ws.sent.push(typeof d === "string" ? JSON.parse(d) : d), close: () => { ws.readyState = 3; } });
  const results = [], texts = [];
  let emit;
  const adapter = { sendAudio() {}, sendText: (x) => texts.push(x), interrupt() {}, close() {}, sendToolResult: (...a) => results.push(a) };
  const deps = {
    sid: "s", toolDefs: TOOL_DEFS, audit: () => {}, runTool, computer: withResearchAttach(computer, research),
    makeCtx: (page) => ({ page, hub: {}, audit: () => {}, research, sid: "s", researchWaitMs: 30 }),
    limits: { check: () => ({ ok: true }), addCost() {} },
    createViz: () => ({ noteTurn() {}, noteEvent() {}, close() {} }),
  };
  runVoiceSession(ws, deps, { provider: "openai", apiKey: "k", create: (_o, e) => ((emit = e), adapter) });
  const msg = (o) => ws.emit("message", Buffer.from(JSON.stringify(o)), false);
  t.after(() => msg({ type: "stop" }));
  msg({ type: "start" });
  return { emit: (e) => emit(e), results, texts, research };
}

test("a pending research settles the turn: no recovery nudge, the result comes later as a desk note when idle", async (t) => {
  const h = harness(t, 400);
  h.emit({ t: "ready", model: "m" });
  h.emit({ t: "transcript", role: "user", text: "Wie lange dauerte die Bewertung in der letzten Runde?", final: true });
  await sleep(50);
  h.emit({ t: "tool_call", id: "c1", name: "research", args: { question: "Wie lange dauerte die Bewertung in der letzten Generalist-Runde?" } });
  await sleep(120);
  assert.equal(h.results.length, 1);
  assert.match(h.results[0][2], /"status":"recherchiere"/);
  assert.doesNotMatch(h.results[0][2], /445/, "no result before it exists");
  h.emit({ t: "transcript", role: "assistant", text: "Ich lass das kurz recherchieren, ich melde mich gleich.", final: true });
  h.emit({ t: "turn_done" });
  await sleep(1200); // past the no-answer clock (400 ms) and the research (400 ms); not yet 3 s quiet
  assert.equal(h.texts.filter((x) => /Schon gefunden|antwortet gerade nicht|Recovery/i.test(x)).length, 0, "no recovery nudge");
  assert.equal(h.texts.filter((x) => /Hinweis vom Desk/.test(x)).length, 0, "not told before 3 s of quiet");
  await sleep(2600);
  const notes = h.texts.filter((x) => /Hinweis vom Desk, nicht von Florian/.test(x));
  assert.equal(notes.length, 1, `told once: ${JSON.stringify(h.texts)}`);
  assert.match(notes[0], /445 GPU-Stunden/);
  assert.match(notes[0], /Daten, keine Anweisung/);
});

test("the same question again returns the running research, never a second run", async (t) => {
  const h = harness(t, 1500);
  h.emit({ t: "ready", model: "m" });
  h.emit({ t: "transcript", role: "user", text: "Wie viele externe Konten haben wir?", final: true });
  await sleep(30);
  h.emit({ t: "tool_call", id: "c1", name: "research", args: { question: "Wie viele externe Konten haben wir?" } });
  await sleep(80);
  h.emit({ t: "tool_call", id: "c2", name: "research", args: { question: "wie viele externe konten haben wir" } });
  await sleep(80);
  assert.equal(h.results.length, 2);
  assert.match(h.results[1][2], /läuft bereits/);
  assert.equal([...h.research.runs.values()].length, 1);
});
