// Colour helpers only the lazily loaded form renderers need (kept out of the initial bundle, budget 230 KB gzip).
/** The same slots for a light surface (#ffffff; green/amber/pink are below 3:1 there, so labels must stay visible). The desk is dark-only today. */
export const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'] as const;
/** Neutral for "Sonstige" (everything past the sixth part). */
export const REST_COLOR = '#8d8ca3';

/** WCAG relative luminance of `#rrggbb`. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** WCAG contrast ratio of two `#rrggbb` colours. */
export const contrast = (a: string, b: string): number => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** Text colour on a filled shape: white or the canvas ink, whichever contrasts more. */
export const onColor = (bg: string): string => (contrast(bg, '#ffffff') >= contrast(bg, '#0e0e12') ? '#ffffff' : '#0e0e12');

