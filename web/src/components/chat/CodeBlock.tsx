import { useMemo } from 'react';
import { tokenize } from './highlight';
import CopyButton from './CopyButton';

export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const toks = useMemo(() => tokenize(code, lang), [code, lang]);
  return (
    <div className="group/code my-3 overflow-hidden rounded-xl border border-white/[0.07] bg-ink-950">
      <div className="flex h-9 items-center justify-between border-b border-white/[0.05] pl-3.5 pr-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-mute">{lang || 'code'}</span>
        <CopyButton text={code} compact />
      </div>
      <pre className="scroll-y overflow-x-auto p-3.5 font-mono text-[13px] leading-[1.6] text-fg-2">
        <code>
          {toks.map((t, i) => (t.t ? <span key={i} className={`tok-${t.t}`}>{t.v}</span> : t.v))}
        </code>
      </pre>
    </div>
  );
}
