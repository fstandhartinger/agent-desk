import crypto from 'node:crypto';
import { readJson, sendJson, clientIp } from './http.js';
import { cfg } from './config.js';
import { audit } from './audit.js';
import { originOk, readSession, safeEqual } from './auth.js';
import { deviceError as fail } from './deviceMedia.js';

const NONCE = /^[A-Za-z0-9_-]{43}$/;
const TTL = 5 * 60_000;
// Separate browser approval nonce and native-only polling secret: learning a URL cannot collect credentials.
export function createPairing({ now, rate, mint, origin }) {
  const pending = new Map();
  function prune() { for (const [id, p] of pending) if (p.expiresAt <= now()) pending.delete(id); }
  return async function pairing(req, res, path) {
    if (!path.startsWith('/api/device/pairing/')) return false;
    if (req.method !== 'POST') throw fail('Methode nicht erlaubt.', 405);
    if (req.headers.origin && !originOk(req)) throw fail('Zugriff verweigert.', 403);
    if (!cfg.sessionSecret()) throw fail('Anmeldung nicht eingerichtet.', 503);
    rate(`pair-ip:${clientIp(req)}`, 90);
    prune();
    if (path === '/api/device/pairing/start') {
      rate(`pair-start:${clientIp(req)}`, 5); rate('pair-start-global', 60);
      if (pending.size >= 500) throw fail('Bitte später erneut verbinden.', 429);
      const { callbackUrl } = await readJson(req, 1024);
      if (typeof callbackUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}\/ScreenAgent\/[A-Za-z0-9_-]{43}\/$/.test(callbackUrl)) throw fail('Ungültige App-Verbindung.');
      let callback;
      try { callback = new URL(callbackUrl); } catch { throw fail('Ungültige App-Verbindung.'); }
      if (!callback.port || Number(callback.port) < 1024 || Number(callback.port) > 65535) throw fail('Ungültige App-Verbindung.');
      const pairId = crypto.randomBytes(32).toString('base64url');
      const pollToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now() + TTL;
      pending.set(pairId, { callbackUrl, pollHash: crypto.createHash('sha256').update(pollToken).digest('hex'), expiresAt, state: 'pending', failures: 0 });
      audit({ action: 'device.pair.start', ip: clientIp(req), actor: 'anonymous' });
      sendJson(res, 200, { pairId, pollToken, expiresAt, browserUrl: `${origin()}/device?pair=${pairId}` });
    } else {
      const body = await readJson(req, 1024);
      if (!NONCE.test(body.pairId ?? '')) throw fail('Verbindung abgelaufen. In der App neu starten.', 410);
      const p = pending.get(body.pairId);
      if (path === '/api/device/pairing/confirm') {
        const session = readSession(req);
        if (!session) throw fail('Bitte anmelden.', 401);
        if (session.deviceHash) throw fail('Bitte im normalen Browser anmelden.', 403);
        if (!originOk(req)) throw fail('Zugriff verweigert.', 403);
        rate(`pair-confirm:${session.sid}`, 10);
        if (!p || p.state === 'consumed') throw fail('Verbindung abgelaufen. In der App neu starten.', 410);
        // Domain-separated deterministic proof keeps a repeated owner confirmation idempotent without storing it.
        p.expiresAt = Math.min(p.expiresAt, now() + 2 * 60_000);
        const proof = crypto.createHmac('sha256', cfg.sessionSecret()).update('device-pair-approval-v1:' + body.pairId).digest('base64url');
        p.proofHash = crypto.createHash('sha256').update(proof).digest('hex');
        p.state = p.state === 'pending' ? 'approved' : p.state;
        audit({ action: 'device.pair.confirm', ip: clientIp(req) });
        // Proof goes only to the signed-in browser and its local app callback, never to the remote poller.
        sendJson(res, 200, { ok: true, callbackUrl: p.callbackUrl + '?proof=' + proof });
      } else if (path === '/api/device/pairing/poll') {
        const digest = crypto.createHash('sha256').update(String(body.pollToken ?? '')).digest('hex');
        if (!p || !NONCE.test(body.pollToken ?? '') || !safeEqual(p.pollHash, digest)) throw fail('Verbindung abgelaufen. In der App neu starten.', 410);
        if (p.state === 'pending' || p.state === 'issuing') sendJson(res, 202, { status: 'pending' });
        else if (p.state === 'approved') {
          if (!body.approvalProof) { sendJson(res, 202, { status: 'pending' }); return true; }
          const proofHash = crypto.createHash('sha256').update(String(body.approvalProof)).digest('hex');
          if (!NONCE.test(body.approvalProof) || !safeEqual(p.proofHash, proofHash)) {
            if (++p.failures >= 3) p.state = 'consumed';
            throw fail('App-Bestätigung ungültig. In der App neu starten.', 410);
          }
          // Reserve before any await: concurrent polls must never create two devices or deliver twice.
          p.state = 'issuing';
          try { const value = await mint(); p.state = 'consumed'; audit({ action: 'device.pair.issued', ip: clientIp(req), detail: value.deviceId }); sendJson(res, 200, value); }
          catch (err) { p.state = 'consumed'; throw err; }
        } else throw fail('Verbindung bereits abgeschlossen. In der App neu starten.', 410);
      } else throw fail('Nicht gefunden.', 404);
    }
    return true;
  };
}
