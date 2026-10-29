import { useState, type FormEvent } from 'react';
import { ArrowRight, Clapperboard, History, RefreshCw } from 'lucide-react';
import { parseSlug, recentExplainers } from '../../lib/explainer';
import { fmtAgo } from '../../lib/format';

/** No listing API exists: paste a slug or explainer URL; recent ones are remembered locally. */
export default function SlugPicker({ onPick, error, onRetry }: { onPick: (slug: string) => void; error?: string | null; onRetry?: () => void }) {
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const recent = recentExplainers();

  function submit(e: FormEvent) {
    e.preventDefault();
    const slug = parseSlug(value);
    if (slug) onPick(slug);
    else setInvalid(true);
  }

  return (
    <div className="flex h-full flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-md animate-rise">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-violet/30 bg-violet/10 text-violet-light">
          <Clapperboard className="h-5 w-5" />
        </div>
        <h2 className="text-[22px] font-semibold tracking-[-0.01em] text-fg">Welche Erklärung?</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-dim">Link oder Kürzel einer Erklärseite einfügen – oder direkt im Chat loslegen.</p>
        {error && (
          <div role="alert" className="mt-3 flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/[0.06] px-3 py-2 text-sm text-red-200">
            <span className="min-w-0 flex-1">{error}</span>
            {onRetry && (
              <button type="button" onClick={onRetry} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium hover:bg-danger/15">
                <RefreshCw className="h-3.5 w-3.5" /> Erneut versuchen
              </button>
            )}
          </div>
        )}
        <form onSubmit={submit} className="mt-5 flex gap-2">
          <label htmlFor="slug" className="sr-only">Erklärseite</label>
          <input
            id="slug"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            placeholder="explainers.app.mintapis.com/p/…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid}
            className={`h-11 min-w-0 flex-1 rounded-xl border bg-ink-850 px-3.5 text-[15px] text-fg outline-none transition-colors placeholder:text-mute focus:border-violet/60 ${invalid ? 'border-danger/60' : 'border-white/[0.08]'}`}
          />
          <button type="submit" className="flex h-11 items-center gap-1.5 rounded-xl bg-white/[0.08] px-4 text-sm font-medium text-fg transition-colors hover:bg-white/[0.12]">
            Laden <ArrowRight className="h-4 w-4" />
          </button>
        </form>
        {invalid && <p className="mt-2 text-sm text-danger/90">Das sieht nicht nach einer Erklärseite aus.</p>}
        {recent.length > 0 && (
          <div className="mt-8">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.14em] text-mute">
              <History className="h-3.5 w-3.5" /> Zuletzt angesehen
            </p>
            <ul className="space-y-1">
              {recent.map((r) => (
                <li key={r.slug}>
                  <button
                    type="button"
                    onClick={() => onPick(r.slug)}
                    className="group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full bg-violet/70 transition-colors group-hover:bg-violet" />
                    <span className="min-w-0 flex-1 truncate text-[15px] text-fg-2 group-hover:text-fg">{r.title}</span>
                    <span className="shrink-0 text-xs text-mute">{fmtAgo(r.at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
