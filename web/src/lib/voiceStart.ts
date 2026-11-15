// Loaded only when starting voice; picker metadata and entry diagnostics stay out of initial JS.
import { voiceNameForStart } from './voiceNames';
import { buildEntry, clientInfo } from './clientInfo';
import { focusedCanvasId } from '../canvas/bus';
import type { VoiceOption } from './voice';
import type { PageContext } from './types';

export async function prepareVoiceStart(opt: VoiceOption, page: PageContext | undefined) {
  const voice = await voiceNameForStart(opt.provider);
  // Capture the voice now, but read focus/device/entry when the WebSocket actually opens.
  return () => voiceStartMessage(opt, page, voice);
}

export function voiceStartMessage(opt: VoiceOption, page: PageContext | undefined, voice?: string) {
  return { type: 'start', voice, page, lang: 'de',
    client: clientInfo(Boolean(globalThis.matchMedia?.('(min-width: 1024px)').matches)),
    entry: buildEntry(location, page?.pointId), focusedCanvasId: focusedCanvasId(),
    ...(opt.variant ? { variant: opt.variant } : {}),
  };
}
