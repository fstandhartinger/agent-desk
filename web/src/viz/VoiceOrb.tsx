// Owned by the viz slice. Levels are 0..1 RMS, updated ~30x/s by the caller.
// One canvas, one rAF loop that reads the latest props from a ref: the orb breathes with the mic (moss) and the
// speaker (violet); states add a spinner ring (connecting), shimmer (thinking), ripples (speaking) or a red tint.
import { useEffect, useRef } from 'react';
import { alpha, C } from './theme';
import { useLatest } from './hooks';
import './viz.css';

export interface VoiceOrbProps {
  state: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';
  micLevel: number;
  speakerLevel: number;
  provider?: string;
  size?: number;
  /** Hide the state/provider caption under the orb (e.g. inside a compact button). */
  bare?: boolean;
}

const STATE_LABEL: Record<VoiceOrbProps['state'], string> = {
  idle: 'Bereit', connecting: 'Verbinde …', listening: 'Ich höre zu', thinking: 'Denke nach …', speaking: 'Spricht', error: 'Verbindung gestört',
};

const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a: number[], b: number[], k: number) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const css = (c: number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const MOSS = rgb(C.moss), VIOLET = rgb(C.violet), AMBER = rgb(C.amber), RED = rgb(C.red), IDLE = rgb('#6f6e86');

export default function VoiceOrb({ state, micLevel, speakerLevel, provider, size = 160, bare }: VoiceOrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const props = useLatest({ state, micLevel, speakerLevel });

  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const box = size * 1.5; // room for ripples and glow outside the orb
    cv.width = Math.round(box * dpr);
    cv.height = Math.round(box * dpr);
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let mic = 0, spk = 0, hue = IDLE, raf = 0, last = performance.now();
    const ripples: { born: number; strength: number }[] = [];
    let nextRipple = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now / 1000;
      const p = props.current;
      // Attack fast, release slow — feels like a VU meter, not jitter.
      const follow = (cur: number, target: number) => cur + (target - cur) * (target > cur ? 1 - Math.exp(-dt * 28) : 1 - Math.exp(-dt * 7));
      mic = follow(mic, Math.min(1, Math.max(0, p.micLevel) * 1.6));
      spk = follow(spk, Math.min(1, Math.max(0, p.speakerLevel) * 1.6));
      const target = p.state === 'error' ? RED : p.state === 'thinking' ? mix(VIOLET, AMBER, 0.35)
        : p.state === 'speaking' ? VIOLET : p.state === 'listening' ? (spk > mic ? VIOLET : MOSS)
        : p.state === 'connecting' ? mix(IDLE, VIOLET, 0.4) : IDLE;
      hue = mix(hue, target, 1 - Math.exp(-dt * 6));
      const level = Math.max(mic, spk);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, box, box);
      const cx = box / 2, cy = box / 2;
      const base = size * 0.3;
      const breathe = reduced ? 0 : Math.sin(t * 1.6) * 0.025 + (p.state === 'thinking' ? Math.sin(t * 3.2) * 0.02 : 0);
      const r = base * (1 + breathe + level * 0.32);

      // outer glow
      const glow = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, r * 2.3);
      glow.addColorStop(0, css(hue, 0.28 + level * 0.25));
      glow.addColorStop(1, css(hue, 0));
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(cx, cy, r * 2.3, 0, Math.PI * 2); ctx.fill();

      // speaking: ripples born on loud syllables
      if (!reduced && p.state === 'speaking' && spk > 0.12 && now > nextRipple) {
        ripples.push({ born: now, strength: spk });
        nextRipple = now + 260 - spk * 120;
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const k = (now - ripples[i].born) / 1400;
        if (k >= 1) { ripples.splice(i, 1); continue; }
        ctx.strokeStyle = css(VIOLET, (1 - k) * 0.55 * ripples[i].strength + 0.05 * (1 - k));
        ctx.lineWidth = 2 * (1 - k) + 0.5;
        ctx.beginPath(); ctx.arc(cx, cy, r * (1.05 + k * 1.1), 0, Math.PI * 2); ctx.stroke();
      }

      // body: organic blob, its waviness follows the voice level
      const n = 96;
      const amp = r * (0.015 + level * 0.11);
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const w = Math.sin(a * 3 + t * 2.1) * 0.5 + Math.sin(a * 5 - t * 3.3) * 0.3 + Math.sin(a * 2 + t * 1.3) * 0.2;
        const rr = r + amp * w;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.05);
      body.addColorStop(0, css(mix(hue, [255, 255, 255], 0.55)));
      body.addColorStop(0.45, css(hue, 0.95));
      body.addColorStop(1, css(mix(hue, [14, 14, 18], 0.55), 0.95));
      ctx.fillStyle = body;
      ctx.fill();

      // thinking: a bright arc sweeping around the orb
      if (p.state === 'thinking' || p.state === 'connecting') {
        const a0 = reduced ? 0 : t * (p.state === 'connecting' ? 4.2 : 2.4);
        const ringR = p.state === 'connecting' ? r * 1.32 : r * 1.16;
        ctx.lineCap = 'round';
        ctx.lineWidth = p.state === 'connecting' ? 3 : 2.5;
        ctx.strokeStyle = css(hue, 0.18);
        ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2); ctx.stroke();
        const g = ctx.createConicGradient(a0, cx, cy);
        g.addColorStop(0, css(hue, 0));
        g.addColorStop(0.28, css(mix(hue, [255, 255, 255], 0.3), 0.95));
        g.addColorStop(0.3, css(hue, 0));
        ctx.strokeStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, ringR, a0, a0 + Math.PI * 0.6); ctx.stroke();
      }

      // listening: soft moss ring that swells with the mic
      if (p.state === 'listening') {
        ctx.lineWidth = 2;
        ctx.strokeStyle = css(MOSS, 0.25 + mic * 0.6);
        ctx.beginPath(); ctx.arc(cx, cy, r * (1.12 + mic * 0.25), 0, Math.PI * 2); ctx.stroke();
      }

      if (p.state === 'error') {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(cx - 2, cy - r * 0.38, 4, r * 0.45);
        ctx.beginPath(); ctx.arc(cx, cy + r * 0.25, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size, props]);

  const box = size * 1.5;
  return (
    <div className="vz-root" role="status" aria-label={`Sprachmodus: ${STATE_LABEL[state]}${provider ? ` (${provider})` : ''}`}
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', width: size }}>
      <div style={{ width: size, height: size, position: 'relative' }}>
        <canvas ref={canvas} style={{ position: 'absolute', width: box, height: box, left: -(box - size) / 2, top: -(box - size) / 2, pointerEvents: 'none' }} />
      </div>
      {!bare && (
        <div style={{ marginTop: size * 0.06, textAlign: 'center', lineHeight: 1.3, whiteSpace: 'nowrap' }}>
          <div key={state} className="vz-fade" style={{ fontSize: Math.max(12, size * 0.085), fontWeight: 600, color: state === 'error' ? C.red : C.fg }}>
            {STATE_LABEL[state]}
          </div>
          {provider && (
            <div style={{ marginTop: 2, fontSize: Math.max(10, size * 0.065), letterSpacing: 2, textTransform: 'uppercase', color: alpha(C.dim, 0.9) }}>{provider}</div>
          )}
        </div>
      )}
    </div>
  );
}
