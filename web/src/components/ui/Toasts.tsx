import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { useStore } from '../../lib/store';
import { dismissToast, toastStore } from '../../lib/toast';

const ICON = { info: Info, error: AlertCircle, success: CheckCircle2 };
const TONE = { info: 'text-violet-light', error: 'text-danger', success: 'text-moss' };

export default function Toasts() {
  const toasts = useStore(toastStore);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-[calc(var(--sat)+64px)] z-[90] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const Icon = ICON[t.tone];
        return (
          <div key={t.id} className="pointer-events-auto flex max-w-md animate-rise items-start gap-2.5 rounded-2xl border border-white/10 bg-ink-750/95 px-4 py-3 text-sm text-fg shadow-[0_20px_50px_-12px_rgb(0_0_0/0.7)] backdrop-blur-xl">
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE[t.tone]}`} />
            <span className="min-w-0 flex-1">{t.text}</span>
            {t.action && (
              <button type="button" onClick={() => { dismissToast(t.id); t.action!.run(); }}
                className="-my-1 ml-1 shrink-0 rounded-full bg-white/[0.08] px-3 py-1 text-[13px] font-medium text-fg transition-colors hover:bg-white/[0.14]">
                {t.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
