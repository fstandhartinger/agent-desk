// Official API names, verified 2026-11-15. Never forward an unchecked client value.
// OpenAI: developers.openai.com/api/docs/guides/live-conversations
// Gemini: ai.google.dev/gemini-api/docs/speech-generation
// xAI: GET api.x.ai/v1/tts/voices (multilingual, 28 voices).
import samples from './voice-samples.json' with { type: 'json' };

const voice = (provider, id, note, label = id[0].toUpperCase() + id.slice(1)) => ({
  id, label, note, sample: samples[provider]?.includes(id) ? `/voice-samples/${provider}/${id}.mp3` : null,
});
const female = new Set('ara aurora carina celeste eve iris liora luna ursa'.split(' '));
const xai = 'altair ara atlas aurora carina castor celeste cosmo eve helios helix iris kepler leo liora lumen luna lux naksh orion perseus rex rigel sal sirius ursa zagan zenith'
  .split(' ').map((id) => voice('xai', id, `${female.has(id) ? 'weiblich' : 'männlich'} · mehrsprachig`));
const openai = [
  ...['nuri', 'juni'].map((id) => voice('openai', id, 'weiblich · deutsch · natürlich')),
  voice('openai', 'flitz', 'männlich · deutsch · natürlich'),
  ...'alloy ash ballad cedar coral echo marin sage shimmer verse'.split(' ').map((id) => voice('openai', id, 'mehrsprachig')),
];
const gemini = [
  ['Zephyr', 'hell'], ['Puck', 'beschwingt'], ['Charon', 'informativ'], ['Kore', 'bestimmt'], ['Fenrir', 'aufgeregt'],
  ['Leda', 'jugendlich'], ['Orus', 'bestimmt'], ['Aoede', 'luftig'], ['Callirrhoe', 'entspannt'], ['Autonoe', 'hell'],
  ['Enceladus', 'hauchig'], ['Iapetus', 'klar'], ['Umbriel', 'entspannt'], ['Algieba', 'geschmeidig'], ['Despina', 'geschmeidig'],
  ['Erinome', 'klar'], ['Algenib', 'rau'], ['Rasalgethi', 'informativ'], ['Laomedeia', 'beschwingt'], ['Achernar', 'weich'],
  ['Alnilam', 'bestimmt'], ['Schedar', 'gleichmäßig'], ['Gacrux', 'reif'], ['Pulcherrima', 'direkt'], ['Achird', 'freundlich'],
  ['Zubenelgenubi', 'locker'], ['Vindemiatrix', 'sanft'], ['Sadachbia', 'lebhaft'], ['Sadaltager', 'kenntnisreich'], ['Sulafat', 'warm'],
].map(([id, note]) => voice('gemini', id, note));

export const DEFAULT_VOICE = Object.freeze({ xai: 'eve', openai: 'marin', gemini: 'Sulafat', 'gemini-fast': 'Sulafat' });
export const VOICES = Object.freeze({ xai, openai, gemini, 'gemini-fast': gemini });

export function resolveVoice(provider, requested) {
  if (!Object.hasOwn(VOICES, provider)) return undefined;
  return VOICES[provider]?.find((v) => v.id === requested)?.id ?? DEFAULT_VOICE[provider];
}

export function voiceCatalog() {
  return { providers: Object.fromEntries(['xai', 'openai', 'gemini'].map((p) => [p, { default: DEFAULT_VOICE[p], voices: VOICES[p] }])) };
}
