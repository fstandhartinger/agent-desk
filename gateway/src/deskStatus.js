// Live facts about the desk itself (round 8, critic r7 C3): which voice providers work right now, which models the text
// agent and the illustrator use, which bridges are connected. Gateway-local (providerHealth + the bridge hub), so the
// illustrator and the agents never have to guess the answer from old job notes.
import { cfg } from './config.js';
import { snapshot as providerSnapshot } from './providerHealth.js';
import { MODELS as GEMINI_MODELS } from './voice/gemini.js';
import { TRANSCRIBE_MODELS } from './transcribe.js';

const VOICE_MODELS = { xai: 'grok-voice-3.0', openai: 'gpt-live-1', gemini: GEMINI_MODELS.thinking.replace(/^models\//, '') };
const WHO = { xai: 'xAI (Grok Voice)', openai: 'OpenAI (GPT-Live)', gemini: 'Google (Gemini Live)' };

/** "arbeitet" | "gestört: <Grund>" | "noch nicht geprüft" | "kein Schlüssel" for one provider entry of providerHealth.snapshot(). */
function stateOf(p) {
  if (!p.configured) return 'kein Schlüssel';
  if (p.ok === true) return 'arbeitet';
  if (p.ok === false) return `gestört${p.reason ? `: ${p.reason}` : ''}`;
  return 'noch nicht geprüft (kein bekannter Fehler)';
}

/** The facts as a plain object (what GET /api/status carries, in the words a drawing needs). */
export function deskStatus(hub) {
  const providers = providerSnapshot();
  return {
    asOf: new Date().toISOString(),
    voiceProviders: Object.keys(VOICE_MODELS).map((name) => ({ provider: WHO[name], model: VOICE_MODELS[name], state: stateOf(providers[name] ?? { configured: false }), ...(providers[name]?.checkedAt ? { checkedAt: providers[name].checkedAt } : {}) })),
    models: { text: cfg.textModel(), illustrator: cfg.canvasModel(), activity: cfg.vizModel(), dictation: [TRANSCRIBE_MODELS.primary, ...TRANSCRIBE_MODELS.fallback] },
    otherProviders: ['openrouter', 'elevenlabs'].map((name) => ({ provider: name, state: stateOf(providers[name] ?? { configured: false }) })),
    bridges: (hub?.status?.() ?? []).map((b) => ({ host: b.host, connected: b.connected !== false, since: b.since, claudeSessions: b.claude })),
    note: 'Live state of the desk; it overrides anything in job notes or the conversation about providers, credit or models.',
  };
}

/**
 * Round 9 (critic r8 C3): the models the desk really uses, straight from config.js and the voice adapters, as prompt lines.
 * The illustrator draws only these (it once drew "Claude über Abos" as the text model).
 */
export const MODEL_FACT_LINES = 6; // the first six lines of deskModelFacts() are the model list (the allow-list of names)
export function deskModelFacts() {
  const voice = Object.keys(VOICE_MODELS).map((name) => `${WHO[name]} = ${VOICE_MODELS[name]}`).join('; ');
  return [
    'Desk-Fakten (config.js, gelten immer; Modellnamen in Zeichnungen NUR aus dieser Liste):',
    `- Text-Agent (Chat): ${cfg.textModel()} über OpenRouter`,
    `- Zeichnerin (Canvas): ${cfg.canvasModel()} über OpenRouter`,
    `- Aktivitäts-Canvas: ${cfg.vizModel()} über OpenRouter`,
    `- Voice-Provider: ${voice}`,
    `- Diktat (Spracheingabe im Chat): ElevenLabs ${TRANSCRIBE_MODELS.primary}, Ersatz OpenAI ${TRANSCRIBE_MODELS.fallback.join(' / ')} (transcribe.js)`,
    '- Claude Code läuft nur als Session auf der Bridge, wenn Florian es verlangt; es ist kein Modell des Gateways. Es gibt kein Abo-Modell im Gateway.',
    '- Das Gateway-Programm liegt in gateway/src (Node, kein Framework); nenne es zuerst und belege es mit diesen Dateien.',
  ];
}

/** Model-looking names that occur in `text`, lower-cased ("deepseek", "gpt-live-1"). */
const MODEL_NAME = /\b(?:claude|opus|sonnet|haiku|gpt[\w.-]*|gemini[\w.-]*|grok[\w.-]*|deepseek[\w.-]*|llama[\w.-]*|mistral[\w.-]*|qwen[\w.-]*|kimi[\w.-]*|glm[\w.-]*)/gi;
export function modelNamesIn(text) {
  return [...new Set([...String(text ?? '').matchAll(MODEL_NAME)].map((m) => m[0].toLowerCase()))];
}
