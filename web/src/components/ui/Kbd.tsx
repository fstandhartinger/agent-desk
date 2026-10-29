export default function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] px-1.5 font-sans text-[11px] font-medium text-dim">
      {children}
    </kbd>
  );
}
