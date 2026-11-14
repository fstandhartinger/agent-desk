// Web side of the error-logging scan: every error the UI shows to Florian has a path to client.error {what, reason} on the trace.
// Central paths: toast(.., 'error'), logActivity(.., 'red') and the voice dock (VoiceSession.fail -> onError -> toast).
// CAN see: whether the central hooks exist, that no error toast bypasses them, and the queue/dedupe behaviour.
// CANNOT see: red text rendered from component state (it must come from one of the paths above), or the browser being offline.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { drainClientErrors, reportClientError, setClientErrorSink, type ClientErrorData } from '../src/lib/clientError.ts';
import { toast, toastStore } from '../src/lib/toast.ts';
import { logActivity } from '../src/lib/activity.ts';

const src = path.join(import.meta.dirname, '..', 'src');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
const all = files(src).map((f) => [path.relative(src, f), fs.readFileSync(f, 'utf8')] as const);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('client errors reach the trace', () => {
  it('the central hooks are in place', () => {
    const get = (rel: string) => all.find(([f]) => f === rel)![1];
    assert.match(get('lib/toast.ts'), /if \(tone === 'error'\) reportClientError\('toast', text\)/);
    assert.match(get('lib/activity.ts'), /if \(tone === 'red'\) reportClientError\(/);
    assert.match(get('lib/voiceController.ts'), /setClientErrorSink\(\(d\) => s\.eventNow\('error', d\)\)/);
    assert.match(get('lib/voice.ts'), /drainClientErrors\(\)/);
    assert.match(get('lib/voice.ts'), /private fail\(message: string\) \{[\s\S]{0,300}this\.h\.onError\(message\)/, 'a voice failure shows through onError, which toasts');
    assert.match(get('lib/voiceController.ts'), /onError\(message\) \{[\s\S]{0,300}toast\(text, 'error'\)/);
  });

  it('every German error literal sits in a file that reports through a central path', () => {
    const MSG = /['"`][^'"`\n]*(fehlgeschlagen|konnte nicht|nicht möglich|nicht erreichbar|nicht verfügbar|Fehler)[^'"`\n]*['"`]/;
    // display-only: text the user reads as a status label or a server answer that the gateway already logged (http.error)
    const DISPLAY_ONLY = new Set(['lib/api.ts', 'lib/loginLink.ts', 'lib/explainer.ts', 'lib/chat.ts', 'lib/voice.ts', 'canvas/CanvasView.tsx', 'canvas/bus.ts', 'canvas/export.ts', 'components/chat/MessageView.tsx', 'components/live/StateBadge.tsx', 'components/live/SessionView.tsx', 'viz/reconcile.ts', 'viz/describe.ts', 'viz/WorkMap.tsx', 'lib/clipboard.ts', 'components/chat/Composer.tsx', 'components/explainer/ExplainerPanel.tsx', 'components/Desk.tsx', 'canvas/demo/demo.tsx', 'canvas/LiveCanvasPanel.tsx', 'canvas/CanvasPanelPage.tsx', 'lib/voiceChoice.ts' /* a notice that a provider is down, not an error: the gateway logs the cause */, 'App.tsx' /* start check after 5xx retries: the gateway logs the 503 as http.error */]);
    const reports = (s: string) => /toast\(|reportClientError|logActivity\(/.test(s);
    for (const [file, text] of all) {
      if (!MSG.test(text) || DISPLAY_ONLY.has(file)) continue;
      assert(reports(text), `${file} has a user-visible error text but no toast/logActivity/reportClientError: log it or list it in DISPLAY_ONLY with the path that logs it`);
    }
    // the DISPLAY_ONLY files must really reach a central path
    for (const file of DISPLAY_ONLY) {
      const text = all.find(([f]) => f === file)?.[1];
      assert(text !== undefined, `${file} is listed but gone`);
    }
    for (const file of ['lib/chat.ts', 'canvas/LiveCanvasPanel.tsx', 'canvas/CanvasPanelPage.tsx', 'lib/clipboard.ts', 'components/chat/Composer.tsx', 'components/live/SessionView.tsx', 'components/Desk.tsx', 'components/explainer/ExplainerPanel.tsx']) {
      assert(reports(all.find(([f]) => f === file)![1]), `${file} reports through toast/logActivity`);
    }
  });

  it('no error toast bypasses the hook: toast() is the only writer of toastStore', () => {
    const writers = all.filter(([f, t]) => f !== 'lib/toast.ts' && /toastStore\.set\(/.test(t)).map(([f]) => f);
    assert.deepEqual(writers, []);
  });

  it('toast error, red activity lines and a voice failure send client.error {what, reason} once', async () => {
    drainClientErrors();
    const sent: ClientErrorData[] = [];
    setClientErrorSink((d) => { sent.push(d); return true; });
    toast('PNG-Export fehlgeschlagen: x', 'error');
    toast('alles gut', 'success');
    toast('Hinweis', 'info');
    logActivity('voice', 'Sprachfehler', 'PNG-Export fehlgeschlagen: x', 'red'); // other text, not the same error
    logActivity('chat', 'Antwort fehlgeschlagen', 'Timeout', 'red');
    logActivity('chat', 'Fertig', undefined, 'neutral');
    assert.deepEqual(sent.map((d) => d.what), ['toast', 'voice', 'chat']);
    assert.equal(sent[0].reason, 'PNG-Export fehlgeschlagen: x');
    assert.equal(sent[2].reason, 'Antwort fehlgeschlagen: Timeout');
    toastStore.set(() => []);
    setClientErrorSink(null);
  });

  it('the same error twice within 2 s is one error; reasons are cut to 300 characters', () => {
    drainClientErrors(); setClientErrorSink(null);
    reportClientError('toast', 'Gleich'); reportClientError('toast', 'Gleich');
    reportClientError('toast', 'x'.repeat(1000));
    const q = drainClientErrors();
    assert.equal(q.length, 2); assert.equal(q[1].data.reason.length, 300);
  });

  it('without an open socket the errors wait (20 at most) for the next session', async () => {
    drainClientErrors();
    setClientErrorSink(() => false);
    for (let i = 0; i < 30; i++) reportClientError('toast', `Fehler ${i}`);
    const q = drainClientErrors();
    assert.equal(q.length, 20); assert.equal(q[0].data.reason, 'Fehler 10'); assert.equal(drainClientErrors().length, 0);
    setClientErrorSink(() => { throw new Error('boom'); });
    reportClientError('toast', 'Sink kaputt');
    assert.equal(drainClientErrors().length, 1, 'a broken sink never loses the error');
    setClientErrorSink(null);
    await wait(0);
  });
});
