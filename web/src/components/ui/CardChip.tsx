import { Copy } from 'lucide-react';
import { copyText } from '../../lib/clipboard';

export default function CardChip({ cardId, className = '' }: { cardId?: number; className?: string }) {
  if (!cardId) return null;
  return <button type="button" onClick={() => void copyText(`Karte ${cardId}`)}
    title={`Karte ${cardId} kopieren`} aria-label={`Karte ${cardId} kopieren`}
    className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs font-medium text-fg-2 transition-colors hover:bg-white/[0.08] ${className}`}>
    Karte {cardId}<Copy className="h-3 w-3 text-dim" aria-hidden="true" />
  </button>;
}
