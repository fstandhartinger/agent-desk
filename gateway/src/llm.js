import { cfg } from './config.js';
import { limits } from './limits.js';
import { TEXT, modelError } from './messages.js';
import { markFailure, markOk } from './providerHealth.js';
import { short } from './redact.js';

const HEADERS = () => ({
  authorization: `Bearer ${cfg.openrouterKey()}`,
  'content-type': 'application/json',
  'http-referer': cfg.deskOrigin(),
  'x-title': 'Agent Desk',
});

// Used only when OpenRouter reports no cost; deliberately on the expensive side so the daily cap stays safe.
const estimateUsd = (inTok, outTok) => (inTok * 0.5 + outTok * 2) / 1e6;

function record(usage) {
  const inTok = usage?.prompt_tokens ?? 0;
  const outTok = usage?.completion_tokens ?? 0;
  const costUsd = typeof usage?.cost === 'number' ? usage.cost : estimateUsd(inTok, outTok);
  limits.addCost(costUsd);
  return { usage: { in: inTok, out: outTok }, costUsd };
}

async function failure(response) {
  const message = modelError(response.status);
  if ([401, 402, 403].includes(response.status)) markFailure('openrouter', message);
  return new Error(message);
}

// Critic round 2, P2-9: private content (mail, Discord, transcripts) goes to these models, so every OpenRouter call asks for
// providers that neither collect nor retain it. `zdr` narrows routing to zero-data-retention endpoints; if a model has
// none, OpenRouter answers 404 and we retry once without `zdr` but still with `data_collection: 'deny'` (remembered per model
// for 10 minutes so the next calls skip the failing attempt).
export const PRIVACY = Object.freeze({ data_collection: 'deny' });
const NO_ZDR_MS = 10 * 60_000;
const noZdrUntil = new Map(); // model -> epoch ms

export const privacyProvider = (model, now = Date.now()) => ((noZdrUntil.get(model) ?? 0) > now ? { ...PRIVACY } : { ...PRIVACY, zdr: true });

/** POST a chat body with the privacy routing; one fallback without zdr when no ZDR endpoint serves the model. */
export async function postOpenRouter(url, headers, body, signal) {
  const send = (provider) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...body, provider: { ...body.provider, ...provider } }), signal });
  const first = privacyProvider(body.model);
  const response = await send(first);
  if (response.status !== 404 || !first.zdr) return response;
  await response.body?.cancel().catch(() => {});
  noZdrUntil.set(body.model, Date.now() + NO_ZDR_MS);
  console.warn(`${new Date().toISOString()} llm: no zero-data-retention endpoint for ${short(body.model, 80)}; retrying with data_collection=deny only`);
  return send({ ...PRIVACY });
}

/** Tests only. */
export const resetPrivacyRouting = () => noZdrUntil.clear();

const toolSpecs = (tools) => tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** OpenRouter streaming chat. Yields {delta} | {toolCalls:[{id,name,args}]} | {usage, costUsd}. */
export async function* streamChat({ model, messages, tools, signal }) {
  if (!cfg.openrouterKey()) throw new Error(TEXT.textModelMissing);
  const body = { model, messages, stream: true, usage: { include: true }, reasoning: { effort: cfg.reasoningEffort() } };
  if (tools?.length) Object.assign(body, { tools: toolSpecs(tools), tool_choice: 'auto' });
  const response = await postOpenRouter(`${cfg.openrouterBase()}/chat/completions`, HEADERS(), body, signal);
  if (!response.ok) throw await failure(response);

  markOk('openrouter');
  const calls = [];
  let usage;
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.error) throw new Error(`Die Antwort des Textmodells wurde unterbrochen: ${short(json.error.message || 'unbekannter Fehler', 120)}`);
      if (json.usage) usage = json.usage;
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) yield { delta: delta.content };
      for (const tc of delta?.tool_calls || []) {
        const slot = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
  }
  const finished = calls.filter((c) => c.name);
  if (finished.length) yield { toolCalls: finished.map((c, i) => ({ ...c, id: c.id || `call_${i}` })) };
  yield record(usage);
}

/** One non-streaming call that must return a JSON object; null on any failure. */
export async function completeJSON({ model, messages, maxTokens = 800 }) {
  if (!cfg.openrouterKey()) return null;
  try {
    const response = await postOpenRouter(`${cfg.openrouterBase()}/chat/completions`, HEADERS(),
      { model, messages, max_tokens: maxTokens, response_format: { type: 'json_object' }, usage: { include: true }, reasoning: { effort: 'minimal' } },
      AbortSignal.timeout(20_000));
    if (!response.ok) return null;
    const json = await response.json();
    record(json.usage);
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? '');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One non-streaming chat turn with optional tools (the illustrator's loop). Returns {message, usage, costUsd};
 * `message.tool_calls` is [{id, name, args}] (args = raw JSON string). Cost goes into the daily spend like every other call.
 */
export async function completeChat({ model, messages, tools, json = false, maxTokens = 4000, signal }) {
  if (!cfg.openrouterKey()) throw new Error(TEXT.textModelMissing);
  const body = { model, messages, max_tokens: maxTokens, usage: { include: true }, reasoning: { effort: cfg.reasoningEffort() } };
  if (tools?.length) Object.assign(body, { tools: toolSpecs(tools), tool_choice: 'auto' });
  if (json) body.response_format = { type: 'json_object' };
  const response = await postOpenRouter(`${cfg.openrouterBase()}/chat/completions`, HEADERS(), body, signal);
  if (!response.ok) throw await failure(response);
  markOk('openrouter');
  const data = await response.json();
  if (data.error) throw new Error(`Das Textmodell hat nicht geantwortet: ${short(data.error.message || 'unbekannter Fehler', 120)}`);
  const message = data.choices?.[0]?.message ?? {};
  return {
    message: {
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: (message.tool_calls ?? []).map((c, i) => ({ id: c.id || `call_${i}`, name: c.function?.name ?? '', args: c.function?.arguments ?? '' })).filter((c) => c.name),
    },
    ...record(data.usage),
  };
}
