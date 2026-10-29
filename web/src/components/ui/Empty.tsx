import type { ReactNode } from 'react';

export default function Empty({ icon, title, children, className = '' }: { icon: ReactNode; title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center px-6 py-10 text-center ${className}`}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.07] bg-white/[0.03] text-dim">{icon}</div>
      <p className="text-[15px] font-medium text-fg">{title}</p>
      {children && <div className="mt-1.5 max-w-xs text-sm leading-relaxed text-dim">{children}</div>}
    </div>
  );
}
