import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Environment access. Read lazily so tests can set process.env before starting a server.
const env = (name, fallback = '') => process.env[name] ?? fallback;
const capUsd = (name, fallback) => { const raw = env(name, '').trim(); if (!raw) return fallback; const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : fallback; };

export const cfg = {
  port: () => Number(env('PORT', '8080')),
  accessCode: () => env('DESK_ACCESS_CODE'),
  sessionSecret: () => env('DESK_SESSION_SECRET'),
  bridgeToken: () => env('BRIDGE_TOKEN'),
  deskOrigin: () => env('DESK_ORIGIN', 'https://desk.app.mintapis.com'),
  explainerOrigin: () => env('EXPLAINER_ORIGIN', 'https://explainers.app.mintapis.com'),
  explainerContextToken: () => env('EXPLAINER_CONTEXT_TOKEN'), // bearer for the private context.json / deepdive.md (never sent to the browser)
  textModel: () => env('DESK_TEXT_MODEL', 'deepseek/deepseek-v4.1-flash-20261017:nitro'),
  vizModel: () => env('DESK_VIZ_MODEL') || cfg.textModel(),
  intentModel: () => env('DESK_INTENT_MODEL') || cfg.textModel(), // the intent fallback of the voice action triggers (intentTrigger.js)
  intentTrigger: () => env('DESK_INTENT_TRIGGER', 'on') !== 'off', // kill switch: off = only the hard trigger words open the two voice actions
  canvasModel: () => env('DESK_CANVAS_MODEL') || 'deepseek/deepseek-v4.1-flash-20261017:nitro',
  canvasDebounceMs: () => Number(env('DESK_CANVAS_DEBOUNCE_MS', '1200')),
  canvasTimeoutMs: () => Number(env('DESK_CANVAS_TIMEOUT_MS', '25000')),
  xaiSilenceMs: () => Number(env('DESK_XAI_SILENCE_MS', '1000')), // xAI server VAD: a pause shorter than this does not end the turn (live 2 Nov: xAI accepts it; 1000 ms still splits a 1.4 s pause and 1500 ms does not, but that adds a second to every answer, and the merge in session.js handles what still splits); 0 = vendor default
  userMergeMs: () => Number(env('DESK_VOICE_MERGE_MS', '1500')), // user transcript fragments within this window are one question
  canvasEarly: () => env('DESK_CANVAS_EARLY', '1') !== '0', // kill switch of the early illustrator
  canvasResearchMs: () => Number(env('DESK_CANVAS_RESEARCH_MS', '6000')),
  activityViz: () => env('DESK_ACTIVITY_VIZ') === '1',
  // GPT-Live delegation backend (round 10, measured live: see the r10 RESULT); Astra is never run at high/xhigh
  openaiDelegateModel: () => env('DESK_OPENAI_DELEGATE_MODEL', 'gpt-6-astra'), // Florian 14 Nov: Astra "weil es besonders intelligent ist"; astra/low measured as fast as sol/low (agent-desk-fixes-20261114)
  openaiDelegateEffort: () => env('DESK_OPENAI_DELEGATE_EFFORT', 'low'),
  voiceWatchdogMs: () => Number(env('DESK_VOICE_WATCHDOG_MS', '6000')), // no assistant audio this long after a tool result -> ask again
  voiceNoAnswerMs: () => Number(env('DESK_VOICE_NO_ANSWER_MS', '10000')), // a question with no answer and no running tool this long -> recovery (later than the adapter nudge above)
  visionCapUsdHour: () => Number(env('DESK_VISION_CAP_USD_HOUR', '0.6')), // screen vision cost per session hour (sliding window)
  visionPriceIn: () => Number(env('DESK_VISION_PRICE_IN', '0.75')), // USD per 1M tokens, gemini-3.8-flash (2 Nov 2026; doubles 1 Jan 2027)
  visionPriceOut: () => Number(env('DESK_VISION_PRICE_OUT', '3.75')),
  visionTimeoutMs: () => Number(env('DESK_VISION_TIMEOUT_MS', '8000')), // interval / start / foreground frames: nobody waits (3 Nov: 6 s sat on the tail of 3.3-5.9 s)
  visionFreshTimeoutMs: () => Number(env('DESK_VISION_FRESH_TIMEOUT_MS', '6000')), // a fresh look is awaited by voice (visionFreshWaitMs 5.5 s)
  visionFreshWaitMs: () => Number(env('DESK_VISION_FRESH_WAIT_MS', '5500')),
  allowedModels: () => [cfg.textModel(), ...env('DESK_ALLOWED_MODELS').split(',').map((m) => m.trim()).filter(Boolean)],
  reasoningEffort: () => env('DESK_TEXT_REASONING', 'low'),
  // computer-use loop (item F): exact allowlist, only anthropic ids without a route suffix; DESK_COMPUTER_MODEL cannot leave it
  computerModels: () => { const ok = env('DESK_COMPUTER_MODELS', 'anthropic/claude-sonnet-5.5').split(',').map((m) => m.trim()).filter((m) => /^anthropic\/[a-z0-9][a-z0-9.-]*$/.test(m)); return ok.length ? ok : ['anthropic/claude-sonnet-5.5']; },
  computerModel: () => { const list = cfg.computerModels(), m = env('DESK_COMPUTER_MODEL').trim(); return list.includes(m) ? m : list[0]; },
  // caps: a value that is not a finite number >= 0 (NaN, text, negative) falls back to the default; it never disables the cap
  computerRunUsd: () => capUsd('DESK_COMPUTER_RUN_USD', 1.5),
  computerDayUsd: () => capUsd('DESK_COMPUTER_DAY_USD', 5),
  computerStatePath: () => env('DESK_COMPUTER_STATE', process.env.NODE_ENV === 'production' ? join(tmpdir(), 'agent-desk-computer-day.json') : ''), // the daily spend survives a gateway restart (not a new container without a volume)
  dailyCapUsd: () => Number(env('DESK_DAILY_USD_CAP', '15')),
  vizGraceMs: () => Number(env('DESK_VIZ_GRACE_MS', '3500')),
  openrouterKey: () => env('OPENROUTER_API_KEY'),
  openrouterBase: () => env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  openaiKey: () => env('OPENAI_API_KEY'),
  openaiBase: () => env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
  xaiKey: () => env('XAI_API_KEY'),
  xaiBase: () => env('XAI_BASE_URL', 'https://api.x.ai/v1'),
  googleKey: () => env('GOOGLE_API_KEY'),
  googleBase: () => env('GOOGLE_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
  elevenKey: () => env('ELEVENLABS_API_KEY'),
  elevenBase: () => env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io/v1'),
};

export function providerFlags() {
  return {
    openrouter: Boolean(env('OPENROUTER_API_KEY')),
    openai: Boolean(env('OPENAI_API_KEY')),
    google: Boolean(env('GOOGLE_API_KEY')),
    xai: Boolean(env('XAI_API_KEY')),
    elevenlabs: Boolean(env('ELEVENLABS_API_KEY')),
  };
}
