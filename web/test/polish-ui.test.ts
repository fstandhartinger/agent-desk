import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render real components with the same TSX/CSS loader used by the app, without opening a port.
test('voice controls show the effective provider, typed badge, phone state and unclipped dock', async () => {
  Object.assign(globalThis, { matchMedia: () => ({ matches: false }) });
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  try {
    const { voiceStore } = await vite.ssrLoadModule('/src/lib/voice.ts');
    const { statusStore } = await vite.ssrLoadModule('/src/lib/status.ts');
    const { default: Composer, ProviderMenu } = await vite.ssrLoadModule('/src/components/chat/Composer.tsx');
    statusStore.set({ ...statusStore.get(), providers: { xai: { state: 'failed' }, gemini: { state: 'ok' } } });
    voiceStore.set({ ...voiceStore.get(), state: 'idle', option: 'xai' });
    const composer = renderToStaticMarkup(createElement(Composer));
    assert.match(composer, /Live sprechen mit Gemini 3.8 Live/);
    assert.doesNotMatch(composer, /Live sprechen mit Grok/);
    assert.match(renderToStaticMarkup(createElement(ProviderMenu, { open: true, onClose() {} })), /Startet mit Gemini 3.8 Live/);
    const { default: MessageView } = await vite.ssrLoadModule('/src/components/chat/MessageView.tsx');
    assert.match(renderToStaticMarkup(createElement(MessageView, { m: { id: 'typed', role: 'user', via: 'typed', parts: [{ kind: 'text', text: 'Hallo' }], ts: 0, status: 'done' } })), /Getippt/);
    voiceStore.set({ ...voiceStore.get(), state: 'listening', active: 'gemini' });
    const { default: Fab } = await vite.ssrLoadModule('/src/components/voice/VoiceFab.tsx');
    assert.match(renderToStaticMarkup(createElement(Fab, { showState: true })), /bottom-\[calc\(100%\+28px\)\]/);
    assert.match(renderToStaticMarkup(createElement(Fab, { showState: true })), /Ich höre zu/);
    const { default: Dock } = await vite.ssrLoadModule('/src/components/voice/VoiceDock.tsx');
    const dock = renderToStaticMarkup(createElement(Dock));
    assert.doesNotMatch(dock, /overflow-hidden/);
    assert.match(dock, /Gemini 3.8 Live/);
    const { default: Session, FollowUp } = await vite.ssrLoadModule('/src/components/live/SessionView.tsx');
    const session = renderToStaticMarkup(createElement(Session, { sid: 'test', title: 'Test', onBack() {} }));
    assert.doesNotMatch(session, /0\/–/);
    assert.match(renderToStaticMarkup(createElement(FollowUp, { sid: 'test', busy: true })), /placeholder="Wird nach diesem Schritt zugestellt …"/);
  } finally { await vite.close(); }
});
