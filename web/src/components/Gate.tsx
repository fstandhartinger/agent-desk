import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Clapperboard, Eye, EyeOff, Loader2, Lock, Send } from 'lucide-react';
import { ApiError, auth, errorMessage, fmtRetry } from '../lib/api';
import Logo from './Logo';
import { deepLinkNext, requestLoginLink, type LinkResult } from '../lib/loginLink';

// Can this browser mask a text field? If not, fall back to type=password (masking beats PM isolation).
const canMask = typeof CSS !== 'undefined' && (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc'));

type GateError = { text: string; retryAfter?: number };

/** Seconds left until `until`, ticking once per second; 0 when no lockout is active. */
function useCountdown(until: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export default function Gate({ onUnlocked, initialError }: { onUnlocked: () => void; initialError?: GateError | null }) {
  const [code, setCode] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError?.text ?? null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(initialError?.retryAfter ? Date.now() + initialError.retryAfter * 1000 : null);
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const locked = useCountdown(lockedUntil);

  // From an explainer link on a phone the keyboard would cover the Telegram explanation, so no autofocus there.
  useEffect(() => { if (!deepLinkNext(location)) input.current?.focus(); }, []);
  // A failed login link (hashchange while the gate is open) reports here too.
  useEffect(() => {
    if (!initialError) return;
    setError(initialError.text);
    if (initialError.retryAfter) setLockedUntil(Date.now() + initialError.retryAfter * 1000);
  }, [initialError]);
  useEffect(() => {
    if (lockedUntil && !locked) {
      setLockedUntil(null);
      setError(null);
    }
  }, [locked, lockedUntil]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!code.trim() || busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login(code.trim());
      onUnlocked();
    } catch (err) {
      // The server's own (German) text, e.g. "Code stimmt nicht" or "Zu viele Versuche – erneut möglich in 15 min."
      setError(errorMessage(err));
      if (err instanceof ApiError && err.retryAfter) setLockedUntil(Date.now() + err.retryAfter * 1000);
      setShake((n) => n + 1);
      setBusy(false);
      input.current?.select();
    }
  }

  const masked = canMask && !reveal;
  const next = deepLinkNext(location);
  return (
    <main className="stage-glow relative flex min-h-full items-center justify-center overflow-hidden px-5 pb-[calc(var(--sab)+24px)] pt-[calc(var(--sat)+24px)]">
      <GateBackdrop />
      <div className="relative w-full max-w-[400px] animate-rise">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo size={56} />
          <h1 className="mt-5 text-[28px] font-semibold tracking-[-0.02em] text-fg">Agent Desk</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-dim">Erklärung ansehen, nachfragen, Aufgaben an Claude Code geben – live.</p>
        </div>
        {next && <LinkRequest next={next} />}
        <form
          onSubmit={submit}
          key={shake}
          className={`rounded-3xl border border-white/[0.08] bg-ink-800/80 p-2 shadow-[0_30px_80px_-20px_rgb(0_0_0/0.8)] backdrop-blur-xl ${shake ? 'animate-shake' : ''}`}
        >
          <label htmlFor="desk-code" className="sr-only">Zugangscode</label>
          <div className="flex items-center gap-2 rounded-[18px] border border-white/[0.06] bg-ink-900/70 pl-4 pr-1.5 transition-colors focus-within:border-violet/50">
            <Lock className="h-4 w-4 shrink-0 text-mute" />
            <input
              ref={input}
              id="desk-code"
              type={canMask ? 'text' : 'password'}
              className={`h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:tracking-normal placeholder:text-mute ${masked ? 'masked' : ''}`}
              placeholder="Zugangscode"
              name="agent-desk-access-code"
              aria-label="Zugangscode"
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              data-form-type="other"
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              value={code}
              onChange={(e) => setCode(e.target.value)}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'desk-code-err' : undefined}
            />
            {canMask && (
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-mute transition-colors hover:bg-white/[0.06] hover:text-fg"
                aria-label={reveal ? 'Code verbergen' : 'Code anzeigen'}
                aria-pressed={reveal}
              >
                {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={!code.trim() || busy || locked > 0}
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-[18px] bg-moss text-[15px] font-semibold text-ink-900 transition-[background-color,opacity,transform] hover:bg-moss-light active:scale-[0.99] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : locked > 0 ? <span className="tabular">Gesperrt – erneut {fmtRetry(locked)}</span> : <>Öffnen <ArrowRight className="h-4 w-4" /></>}
          </button>
        </form>
        <p id="desk-code-err" role="alert" className={`mt-4 min-h-5 text-center text-sm text-danger/90 transition-opacity ${error ? 'opacity-100' : 'opacity-0'}`}>
          {error}
        </p>
        <p className="mt-2 text-center text-xs text-mute">Privat. Der Login-Link aus Telegram meldet dich automatisch an.</p>
      </div>
    </main>
  );
}

/** From an explainer page without a session: explain the Telegram link and offer to send a fresh one. */
function LinkRequest({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const locked = useCountdown(lockedUntil);
  useEffect(() => { if (lockedUntil && !locked) setLockedUntil(null); }, [locked, lockedUntil]);
  async function send() {
    if (busy || locked) return;
    setBusy(true);
    const r = await requestLoginLink(next);
    setResult(r);
    if (!r.ok && r.retryAfter) setLockedUntil(Date.now() + r.retryAfter * 1000);
    if (r.ok) setLockedUntil(Date.now() + 60_000); // no double sends from an impatient second tap
    setBusy(false);
  }
  return (
    <section aria-labelledby="gate-link-h" className="mb-4 rounded-3xl border border-violet/25 bg-violet/[0.06] p-4 text-left">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet/15 text-violet-light"><Clapperboard className="h-[18px] w-[18px]" /></span>
        <div className="min-w-0">
          <h2 id="gate-link-h" className="text-[15px] font-semibold text-fg">Du kommst von einer Erklärseite</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-dim">
            Öffne zuerst den Login-Link aus Telegram – er meldet dich an und bringt dich genau zu dieser Erklärung zurück.
            Keinen Link mehr? Dann schick dir einen neuen.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={send}
        disabled={busy || locked > 0}
        className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-[18px] bg-violet text-[15px] font-semibold text-white transition-[background-color,opacity,transform] hover:bg-violet-light active:scale-[0.99] disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        {result?.ok ? 'Link geschickt' : 'Neuen Login-Link per Telegram schicken'}
      </button>
      <p role="status" aria-live="polite" className={`mt-2 min-h-5 text-center text-[13px] ${result ? (result.ok ? 'text-moss' : 'text-danger/90') : ''}`}>
        {result?.text}
        {!result?.ok && locked > 0 && !result?.text.includes('erneut möglich') && <span className="tabular"> Erneut möglich {fmtRetry(locked)}.</span>}
      </p>
    </section>
  );
}

/** Slow drifting accent dots — the explainer stage in the background. */
function GateBackdrop() {
  const dots = [
    { c: '#63D297', x: '12%', y: '22%', s: 220, d: '0s' },
    { c: '#8B5CF6', x: '82%', y: '18%', s: 280, d: '-3s' },
    { c: '#FA5D19', x: '72%', y: '82%', s: 180, d: '-6s' },
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {dots.map((d) => (
        <span
          key={d.c}
          className="absolute rounded-full blur-[90px] animate-breathe"
          style={{ left: d.x, top: d.y, width: d.s, height: d.s, background: d.c, opacity: 0.18, animationDelay: d.d, animationDuration: '9s', translate: '-50% -50%' }}
        />
      ))}
      <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.035)_1px,transparent_1px)] [background-size:28px_28px] [mask-image:radial-gradient(70%_60%_at_50%_45%,black,transparent)]" />
    </div>
  );
}
