// Voice relay entry point (contract: gateway/src/contracts.js). The browser never talks to a vendor.
import { createXai } from './xai.js';
import { createOpenAI } from './openai.js';
import { createGemini, MODELS } from './gemini.js';
import { runVoiceSession } from './session.js';

const PROVIDERS = {
  xai: { create: createXai, key: 'XAI_API_KEY' },
  openai: { create: createOpenAI, key: 'OPENAI_API_KEY' },
  gemini: { create: createGemini, key: 'GOOGLE_API_KEY' },
};

export function handleVoiceUpgrade(req, socket, head, deps) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.searchParams.get('provider') ?? 'xai';
  const provider = PROVIDERS[name];
  if (!provider) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const fast = url.searchParams.get('model') === 'fast' || url.searchParams.get('variant') === 'fast';
  deps.wss.handleUpgrade(req, socket, head, (ws) => {
    runVoiceSession(ws, deps, {
      provider: name,
      apiKey: process.env[provider.key],
      create: (opts, emit) => provider.create(name === 'gemini' && fast ? { ...opts, model: MODELS.fast } : opts, emit),
    });
  });
}
