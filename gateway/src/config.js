// Environment access. Read lazily so tests can set process.env before starting a server.
const env = (name, fallback = '') => process.env[name] ?? fallback;

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
  canvasModel: () => env('DESK_CANVAS_MODEL') || 'deepseek/deepseek-v4.1-flash-20261017:nitro',
  canvasDebounceMs: () => Number(env('DESK_CANVAS_DEBOUNCE_MS', '1200')),
  canvasTimeoutMs: () => Number(env('DESK_CANVAS_TIMEOUT_MS', '25000')),
  userMergeMs: () => Number(env('DESK_VOICE_MERGE_MS', '1500')), // user transcript fragments within this window are one question
  canvasEarly: () => env('DESK_CANVAS_EARLY', '1') !== '0', // kill switch of the early illustrator
  canvasResearchMs: () => Number(env('DESK_CANVAS_RESEARCH_MS', '6000')),
  activityViz: () => env('DESK_ACTIVITY_VIZ') === '1',
  // GPT-Live delegation backend (round 10, measured live: see the r10 RESULT); Astra is never run at high/xhigh
  openaiDelegateModel: () => env('DESK_OPENAI_DELEGATE_MODEL', 'gpt-6.1-sol'),
  openaiDelegateEffort: () => env('DESK_OPENAI_DELEGATE_EFFORT', 'low'),
  voiceWatchdogMs: () => Number(env('DESK_VOICE_WATCHDOG_MS', '6000')), // no assistant audio this long after a tool result -> ask again
  allowedModels: () => [cfg.textModel(), ...env('DESK_ALLOWED_MODELS').split(',').map((m) => m.trim()).filter(Boolean)],
  reasoningEffort: () => env('DESK_TEXT_REASONING', 'low'),
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
