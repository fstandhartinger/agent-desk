import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export default function CopyButton({ text, compact }: { text: string; compact?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={done ? 'Kopiert' : 'Kopieren'}
      title={done ? 'Kopiert' : 'Kopieren'}
      className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-colors ${done ? 'bg-moss/10 text-moss' : 'text-mute hover:bg-white/[0.05] hover:text-fg-2'}`}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {!compact && <span>{done ? 'Kopiert' : 'Kopieren'}</span>}
    </button>
  );
}
