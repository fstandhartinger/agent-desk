import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'ghost' | 'soft' | 'primary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  ghost: 'text-dim hover:text-fg hover:bg-white/[0.06]',
  soft: 'text-fg-2 bg-white/[0.05] border border-white/[0.07] hover:bg-white/[0.09] hover:text-fg',
  primary: 'text-ink-900 bg-moss hover:bg-moss-light shadow-[0_0_0_1px_rgb(99_210_151/0.3),0_8px_24px_-8px_rgb(99_210_151/0.5)]',
  danger: 'text-white bg-danger/90 hover:bg-danger',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  active?: boolean;
  children: ReactNode;
}

/** Square/round icon button with a required accessible label (also shown as tooltip). */
export default function IconButton({ label, variant = 'ghost', size = 'md', active, className = '', children, ...rest }: Props) {
  const dims = size === 'sm' ? 'h-8 w-8' : size === 'lg' ? 'h-12 w-12' : 'h-10 w-10';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform,box-shadow] duration-150 active:scale-[0.94] disabled:opacity-40 disabled:active:scale-100 ${dims} ${active ? 'bg-violet/15 text-violet-light' : VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
