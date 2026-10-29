// Vertical regions of the Live Canvas. Header, diagram, "mehr ↓" strip and footer never overlap: the pill gets its
// own strip below the scroll area (outside the content) and the footer height is measured, not guessed.
export interface FrameInput { height: number; compact: boolean; headerH?: number; footerH: number; scroll: boolean }
export interface Frame {
  top: number; // diagram area starts here (below the title)
  bottom: number; // distance of the diagram area from the canvas bottom (above pill strip and footer)
  pill: { top: number; bottom: number } | null; // strip for "mehr ↓", in px from the canvas top
  footerTop: number;
}

export const PILL_STRIP = 30;
export const SCROLL_PAD = 10;

/** Distance of the header (label + title) from the canvas top. */
export const headerTop = (compact: boolean) => (compact ? 14 : 24);

export function canvasFrame({ height, compact, headerH = 0, footerH, scroll }: FrameInput): Frame {
  // headerH is the measured header (a long title wraps to two lines); before measuring assume one line.
  const top = headerH ? headerTop(compact) + headerH + (compact ? 12 : 18) : compact ? 76 : 104;
  // footerH is the measured footer (steps + caption + its own bottom padding); without one keep a small margin.
  const footerTop = height - (footerH || (compact ? 12 : 20));
  const gap = footerH ? (compact ? 10 : 14) : 0;
  const pillH = scroll ? PILL_STRIP : 0;
  const bottom = height - footerTop + gap + pillH;
  return { top, bottom, pill: scroll ? { top: footerTop - gap - pillH, bottom: footerTop - gap } : null, footerTop };
}
