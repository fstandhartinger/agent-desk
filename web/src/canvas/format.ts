// German number formatting for canvas values ("1.234,5 €", "38 %", "12,5 Std").
const nf = new Map<string, Intl.NumberFormat>();
function fmt(digits: number, compact = false): Intl.NumberFormat {
  const key = `${digits}|${compact}`;
  let f = nf.get(key);
  if (!f) {
    f = new Intl.NumberFormat('de-DE', compact
      ? { notation: 'compact', maximumFractionDigits: digits }
      : { minimumFractionDigits: 0, maximumFractionDigits: digits });
    nf.set(key, f);
  }
  return f;
}

const SYMBOL: Record<string, string> = { EUR: '€', '€': '€', USD: '$', $: '$', GBP: '£', CHF: 'CHF' };
const MONEY = new Set(['€', '$', '£', 'CHF']);

/** Fraction digits that keep a value honest without noise: money gets cents unless whole, big numbers none. */
function digitsFor(value: number, money: boolean): number {
  const a = Math.abs(value);
  if (Number.isInteger(value)) return 0;
  if (money) return a >= 10000 ? 0 : 2;
  return a >= 1000 ? 0 : 2; // trailing zeros are dropped: 12,25 · 41,5 · 3
}

/** A plain German number: 1234.5 → "1.234,5". */
export function fmtNumber(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return '–';
  return fmt(digits ?? digitsFor(value, false)).format(value);
}

/** Value with unit in German style: (165, "USD") → "165 $", (12.5, "%") → "12,5 %", (3.5, "EUR") → "3,50 €". */
export function fmtValue(value: number, unit?: string, opts: { compact?: boolean } = {}): string {
  if (!Number.isFinite(value)) return '–';
  const u = (unit ?? '').trim();
  const sym = SYMBOL[u.toUpperCase()] ?? u;
  const money = MONEY.has(sym);
  const digits = digitsFor(value, money);
  const num = opts.compact && Math.abs(value) >= 10000
    ? fmt(1, true).format(value)
    : money && digits === 2
      ? new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
      : fmt(digits).format(value);
  return sym ? `${num}\u202f${sym}` : num;
}

/** Share as German percent: 0.3846 → "38,5 %"; below 10 % one decimal, otherwise whole numbers when ≥ 10. */
export function fmtPercent(share: number): string {
  if (!Number.isFinite(share)) return '–';
  const p = share * 100;
  const digits = p > 0 && p < 10 ? 1 : 0;
  return `${fmt(digits).format(Number(p.toFixed(digits)))} %`;
}

/** "2026-10-24" / "2026-10-24 09:20" → "24. Okt" / "24. Okt, 09:20"; anything else unchanged. */
export function fmtDate(s: string, withYear = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s));
  if (!m) return String(s);
  const MON = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const base = `${Number(m[3])}. ${MON[Number(m[2]) - 1] ?? m[2]}${withYear ? ` ${m[1]}` : ''}`;
  return m[4] ? `${base}, ${m[4]}:${m[5]}` : base;
}

/** Nice axis ticks (1-2-5 steps) covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max === min) max = min + 1;
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
