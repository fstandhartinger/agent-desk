import { memo } from 'react';
import { AlertCircle, AudioLines, Bot, Mic, Keyboard, MapPin, RefreshCw, Square } from 'lucide-react';
import type { Msg } from '../../lib/conversation';
import { textOf } from '../../lib/conversation';
import { fmtUsd, modelLabel } from '../../lib/format';
import Markdown from './Markdown';
import ToolChip from './ToolChip';
import ClaudeProposalCard from './ClaudeProposalCard';
import HandoffCard from './HandoffCard';
import CopyButton from './CopyButton';

const VIA_LABEL = { voice: 'Gesprochen', dictation: 'Diktiert', text: '', typed: 'Getippt' } as const;

function ViaBadge({ via }: { via: Msg['via'] }) {
  if (via === 'text') return null;
  const Icon = via === 'voice' ? AudioLines : via === 'typed' ? Keyboard : Mic;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-mute">
      <Icon className="h-3 w-3" /> {VIA_LABEL[via]}
    </span>
  );
}

function UserMessage({ m }: { m: Msg }) {
  return (
    <div className="flex animate-rise flex-col items-end gap-1.5">
      {(m.context || m.via !== 'text') && (
        <div className="flex items-center gap-2">
          {m.context && (
            <span className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-full bg-violet/10 px-2 py-0.5 text-[11px] font-medium text-violet-light">
              <MapPin className="h-3 w-3 shrink-0" /> {m.context}
            </span>
          )}
          <ViaBadge via={m.via} />
        </div>
      )}
      <div className={`max-w-[88%] whitespace-pre-wrap rounded-[20px] rounded-br-md border px-4 py-2.5 text-[15px] leading-relaxed text-fg ${m.via === 'voice' ? 'border-violet/20 bg-violet/[0.09]' : 'border-white/[0.08] bg-white/[0.06]'}`}>
        {textOf(m) || <span className="text-mute">…</span>}
      </div>
    </div>
  );
}

interface Props { m: Msg; streaming: boolean; onRetry?: () => void; onHandoff?: () => void }

function AssistantMessage({ m, streaming, onRetry, onHandoff }: Props) {
  const text = textOf(m);
  const waiting = streaming && m.parts.length === 0;
  return (
    <div className="group/msg animate-rise">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-violet to-moss">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-900" />
        </span>
        <span className="text-[12px] font-semibold text-fg-2">Desk</span>
        <ViaBadge via={m.via} />
      </div>
      <div className="pl-7">
        {waiting && !m.statusText && (
          <div className="flex items-center gap-1.5 py-2" aria-label="Antwort wird erstellt">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-breathe rounded-full bg-moss" style={{ animationDelay: `${i * 0.18}s`, animationDuration: '1.2s' }} />
            ))}
          </div>
        )}
        {streaming && m.statusText && (
          <p role="status" className="flex animate-fade items-center gap-2 py-1 text-[13px] text-dim">
            <span className="h-1.5 w-1.5 shrink-0 animate-breathe rounded-full bg-violet-light" />
            {m.statusText}
          </p>
        )}
        {m.parts.map((p, i) => (p.kind === 'tool' ? <ToolChip key={p.tool.id} tool={p.tool} /> : p.kind === 'handoff' ? <HandoffCard key={p.card.id} card={p.card} /> : p.kind === 'claude' ? <ClaudeProposalCard key={p.card.id} card={p.card} /> : <Markdown key={i} text={p.text} />))}
        {streaming && m.parts.length > 0 && <span className="caret" aria-hidden />}
        {m.status === 'error' && (
          <div role="alert" className="mt-2 flex items-start gap-2.5 rounded-xl border border-danger/20 bg-danger/[0.05] px-3.5 py-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="text-red-200">{m.error || 'Die Antwort ist fehlgeschlagen.'}</p>
              {onRetry && (
                <button type="button" onClick={onRetry} className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-red-300 hover:text-red-200">
                  <RefreshCw className="h-3.5 w-3.5" /> Erneut versuchen
                </button>
              )}
            </div>
          </div>
        )}
        {m.status === 'stopped' && (
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-mute">
            <Square className="h-3 w-3" /> Gestoppt
          </p>
        )}
        {!streaming && text && m.status !== 'error' && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 opacity-100 transition-opacity lg:opacity-0 lg:group-hover/msg:opacity-100 lg:focus-within:opacity-100">
            <CopyButton text={text} />
            {onHandoff && (
              <button type="button" onClick={onHandoff} title="Als Aufgabe an Claude Code übergeben – mit dieser Antwort und dem Chatverlauf"
                className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-mute transition-colors hover:bg-papaya/10 hover:text-papaya">
                <Bot className="h-3.5 w-3.5" /> An Claude übergeben
              </button>
            )}
            {onRetry && (
              <button type="button" onClick={onRetry} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-mute transition-colors hover:bg-white/[0.05] hover:text-fg-2">
                <RefreshCw className="h-3.5 w-3.5" /> Neu
              </button>
            )}
            {(m.model || m.costUsd) && (
              <span data-testid="model-badge" className="ml-1 whitespace-nowrap text-[11px] text-mute" title={m.model}>
                {[m.model && modelLabel(m.model), m.costUsd ? fmtUsd(m.costUsd) : ''].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const MessageView = memo(function MessageView(props: Props) {
  return props.m.role === 'user' ? <UserMessage m={props.m} /> : <AssistantMessage {...props} />;
});
export default MessageView;
