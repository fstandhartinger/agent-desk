interface Props<T extends string> { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; size?: 'sm' | 'md' }

export default function Segmented<T extends string>({ value, options, onChange, label, size = 'md' }: Props<T>) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full border border-white/[0.07] bg-white/[0.03] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={`rounded-full font-medium transition-colors ${size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-[13px]'} ${o.value === value ? 'bg-white/[0.1] text-fg shadow-sm' : 'text-dim hover:text-fg-2'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
