import { createStore } from './store';
import { uid } from './format';

export interface ToastAction { label: string; run: () => void }
export interface Toast { id: string; text: string; tone: 'info' | 'error' | 'success'; action?: ToastAction }
export const toastStore = createStore<Toast[]>([]);

export const dismissToast = (id: string) => toastStore.set((t) => t.filter((x) => x.id !== id));

/** Toasts with an action (e.g. "Erneut versuchen") stay longer so there is time to tap it. */
export function toast(text: string, tone: Toast['tone'] = 'info', ms?: number, action?: ToastAction) {
  const id = uid('t_');
  toastStore.set((t) => [...t.slice(-2), { id, text, tone, action }]);
  window.setTimeout(() => dismissToast(id), ms ?? (action ? 9000 : 4200));
}
