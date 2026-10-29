import { toast } from './toast';

export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(field);
      const active = document.activeElement as HTMLElement | null;
      try {
        field.select();
        if (!document.execCommand('copy')) throw new Error('copy unavailable');
      } finally { field.remove(); active?.focus(); }
    }
    toast('kopiert', 'success', 1800);
  } catch { toast('Kopieren nicht möglich. Bitte die Browserberechtigung prüfen.', 'error'); }
}

export async function copyPng(url: string, filename: string) {
  const image = fetch(url, { credentials: 'same-origin' }).then(async (res) => {
    if (!res.ok) throw new Error('frame missing');
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (bytes.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('invalid PNG');
    return new Blob([blob], { type: 'image/png' });
  });
  // Start the write in the user's click/key event. Promise-valued ClipboardItems keep activation while the PNG loads.
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard unavailable');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
    toast('Endbild kopiert', 'success', 1800);
    return;
  } catch { /* Permissions or unsupported browser: offer the same PNG as a file. */ }
  try {
    const url = URL.createObjectURL(await image);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast('Endbild heruntergeladen – Bildkopie ist hier nicht verfügbar.', 'info');
  } catch { toast('Endbild noch nicht verfügbar. Bitte später erneut versuchen.', 'error'); }
}
