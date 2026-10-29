import { useEffect } from 'react';
import { getPlayer, pageStore, selectPoint } from '../lib/page';
import { toggleVoice } from '../lib/voiceController';
import { toggleKino } from '../lib/layout';

const typing = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

/** Space play/pause, `/` focus composer, `V` voice, `K` Kino, arrows seek, Esc closes the point card. */
export function useShortcuts(focusComposer: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const active = document.activeElement;
      if (typing(active)) return;
      const onButton = active instanceof HTMLButtonElement || active?.getAttribute('role') === 'slider';
      const player = getPlayer();
      if (e.code === 'Space' && !onButton && player) {
        e.preventDefault();
        player.toggle();
      } else if (e.key === '/') {
        e.preventDefault();
        focusComposer();
      } else if (e.key === 'v' || e.key === 'V') {
        e.preventDefault();
        toggleVoice();
      } else if ((e.key === 'k' || e.key === 'K') && matchMedia('(min-width: 1024px)').matches && pageStore.get().explainer) {
        e.preventDefault();
        toggleKino();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && player && !onButton) {
        e.preventDefault();
        player.seek(player.time() + (e.key === 'ArrowLeft' ? -5 : 5));
      } else if (e.key === 'Escape' && pageStore.get().pointId) {
        selectPoint(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusComposer]);
}
