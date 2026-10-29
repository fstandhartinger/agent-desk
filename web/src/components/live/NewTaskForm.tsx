import { useMemo, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, Rocket } from 'lucide-react';
import { startSession } from '../../lib/claude';
import { currentContext } from '../../lib/page';
import { convStore, textOf } from '../../lib/conversation';
import { chatTranscript, type ClaudeDraft } from '../../lib/handoff';
import { errorMessage } from '../../lib/api';
import { fmtTime, truncate } from '../../lib/format';
import Segmented from '../ui/Segmented';

function prefill(): string {
  const ctx = currentContext();
  const lastUser = [...convStore.get().messages].reverse().find((m) => m.role === 'user');
  const lines: string[] = [];
  if (ctx) lines.push(`Kontext: Erklärseite „${ctx.title}“ (${ctx.slug}) bei ${fmtTime(ctx.t)}${ctx.point ? `, Punkt „${ctx.point.title}“` : ''}.`);
  if (lastUser) lines.push(`Zuletzt im Chat gefragt: „${truncate(textOf(lastUser), 200)}“`);
  return lines.length ? `${lines.join('\n')}\n\nAufgabe: ` : '';
}

export default function NewTaskForm({ draft, onCancel, onStarted }: { draft?: ClaudeDraft; onCancel: () => void; onStarted: (sid: string) => void }) {
  const initial = useMemo(() => draft?.prompt ?? prefill(), [draft]);
  const [prompt, setPrompt] = useState(initial);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [model, setModel] = useState<'opus' | 'sonnet'>('opus');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const task = prompt.slice(initial.length).trim() || prompt.trim();
  const autoTitle = truncate(task.split('\n')[0] || 'Desk-Aufgabe', 60);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!task || busy) return;
    setBusy(true);
    setError(null);
    try {
      const chatContext = draft?.chatContext ?? (chatTranscript(convStore.get().messages) || undefined);
      const sid = await startSession({ title: title.trim() || autoTitle, prompt: prompt.trim(), model, page: currentContext(), chatContext });
      onStarted(sid);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <button type="button" onClick={onCancel} aria-label="Zurück" className="flex h-9 w-9 items-center justify-center rounded-full text-dim hover:bg-white/[0.06] hover:text-fg">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <p className="text-[15px] font-semibold text-fg">Neue Claude-Code-Aufgabe</p>
      </div>
      <div className="scroll-y min-h-0 flex-1 space-y-4 px-4 pb-4">
        <div>
          <label htmlFor="ct-title" className="mb-1.5 block text-xs font-medium text-dim">Titel</label>
          <input id="ct-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={autoTitle} className="h-11 w-full rounded-xl border border-white/[0.08] bg-ink-850 px-3.5 text-[15px] text-fg outline-none placeholder:text-mute focus:border-papaya/50" />
        </div>
        <div>
          <label htmlFor="ct-prompt" className="mb-1.5 block text-xs font-medium text-dim">Auftrag</label>
          <textarea
            id="ct-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={9}
            autoFocus
            onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
            onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submit(e)}
            className="w-full resize-none rounded-xl border border-white/[0.08] bg-ink-850 px-3.5 py-3 text-[15px] leading-relaxed text-fg outline-none placeholder:text-mute focus:border-papaya/50"
            placeholder="Was soll Claude Code tun?"
          />
          <p className="mt-1.5 text-xs text-mute">Läuft wie jeder Job: AGENTS.md, Board und STATE.md gelten. Seitenkontext und {draft?.chatContext ? 'der Chatverlauf bis zu dieser Antwort werden' : 'Chatverlauf werden'} mitgeschickt.</p>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-dim">Modell</span>
          <Segmented label="Modell" value={model} onChange={setModel} options={[{ value: 'opus', label: 'Opus' }, { value: 'sonnet', label: 'Sonnet' }]} />
        </div>
        {error && <p role="alert" className="rounded-xl border border-danger/20 bg-danger/[0.05] px-3 py-2 text-sm text-red-200">{error} Du kannst es mit „Starten“ gleich noch einmal versuchen.</p>}
      </div>
      <div className="border-t border-white/[0.05] px-4 py-3">
        <button type="submit" disabled={!task || busy} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-papaya text-[15px] font-semibold text-white transition-colors hover:bg-[#ff7a3d] disabled:opacity-40">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />} Starten
        </button>
      </div>
    </form>
  );
}
