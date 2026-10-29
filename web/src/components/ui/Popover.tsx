import { useEffect, useRef, type ReactNode } from 'react';

interface Props { open: boolean; onClose: () => void; children: ReactNode; className?: string; align?: 'left' | 'right'; side?: 'top' | 'bottom' }

/** Lightweight anchored menu: closes on outside click and Escape. Parent must be `relative`. */
export default function Popover({ open, onClose, children, className = '', align = 'right', side = 'bottom' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      className={`absolute z-50 animate-pop rounded-2xl border border-white/10 bg-ink-800/95 p-1.5 shadow-[0_24px_64px_-12px_rgb(0_0_0/0.7)] backdrop-blur-xl ${align === 'right' ? 'right-0' : 'left-0'} ${side === 'bottom' ? 'top-full mt-2 origin-top' : 'bottom-full mb-2 origin-bottom'} ${className}`}
    >
      {children}
    </div>
  );
}
