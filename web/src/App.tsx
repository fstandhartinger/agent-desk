import { useEffect, useState } from 'react';
import { ApiError, auth, errorMessage } from './lib/api';
import { takeHashCode } from './lib/hashLogin';
import Gate from './components/Gate';
import Desk from './components/Desk';
import Logo from './components/Logo';
import { resetArtifactEntry } from './components/ArtifactContext';

type Phase = 'checking' | 'gate' | 'desk';
type GateError = { text: string; retryAfter?: number };

async function linkLogin(code: string): Promise<GateError | null> {
  try {
    await auth.login(code);
    return null;
  } catch (e) {
    const text = e instanceof ApiError && e.status === 401 ? 'Der Login-Link ist ungültig oder abgelaufen.' : errorMessage(e);
    return { text, retryAfter: e instanceof ApiError ? e.retryAfter : undefined };
  }
}

// One startup check per page load, shared across effect re-runs (React runs effects twice in development; a second,
// parallel /me without the fresh cookie used to win the race and show the gate after a successful link login).
let startup: Promise<{ phase: Phase; error: GateError | null }> | null = null;
function checkStartup() {
  startup ??= (async () => {
    const code = takeHashCode();
    const error = code ? await linkLogin(code) : null;
    if (code && !error) return { phase: 'desk' as const, error };
    try {
      await auth.me();
      return { phase: 'desk' as const, error: null };
    } catch {
      return { phase: 'gate' as const, error };
    }
  })();
  return startup;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [gateError, setGateError] = useState<GateError | null>(null);

  useEffect(() => {
    let live = true;
    void checkStartup().then((r) => {
      if (!live) return;
      setGateError(r.error);
      setPhase(r.phase);
    });
    // A login link opened in a tab that already shows the page only changes the hash (critic D12).
    const onHash = async () => {
      const code = takeHashCode();
      if (!code) return;
      const error = await linkLogin(code);
      setGateError(error);
      if (!error) setPhase('desk');
    };
    const onUnauthorized = () => { resetArtifactEntry(); setPhase('gate'); };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('desk:unauthorized', onUnauthorized);
    return () => {
      live = false;
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('desk:unauthorized', onUnauthorized);
    };
  }, []);

  if (phase === 'checking') {
    return (
      <div className="stage-glow flex h-full items-center justify-center" aria-busy="true" aria-label="Lädt">
        <div className="animate-breathe">
          <Logo size={44} />
        </div>
      </div>
    );
  }
  if (phase === 'gate') return <Gate initialError={gateError} onUnlocked={() => setPhase('desk')} />;
  return <Desk onLoggedOut={() => { resetArtifactEntry(); setPhase('gate'); }} />;
}
