// Loaded only when starting voice; picker metadata and entry diagnostics stay out of initial JS.
import { selectedVoiceName, voiceNameForStart } from './voiceNames';
import { buildEntry, clientInfo } from './clientInfo';
import { focusedCanvasId } from '../canvas/bus';
import type { VoiceOption } from './voice';
import type { PageContext } from './types';

export async function prepareVoiceStart(opt: VoiceOption, page: PageContext | undefined, startupCard?: string) {
  const preferred = voiceNameForStart(opt.provider);
  const voice = startupCard ? selectedVoiceName(opt.provider) : await preferred;
  // Capture the voice now, but read focus/device/entry when the WebSocket actually opens.
  return () => voiceStartMessage(opt, page, voice, startupCard);
}

export function voiceStartMessage(opt: VoiceOption, page: PageContext | undefined, voice?: string, startupCard?: string) {
  return { type: 'start', voice, page, lang: 'de',
    client: clientInfo(Boolean(globalThis.matchMedia?.('(min-width: 1024px)').matches)),
    entry: buildEntry(location, page?.pointId), focusedCanvasId: focusedCanvasId(),
    ...(startupCard ? { startupCard } : {}),
    ...(opt.variant ? { variant: opt.variant } : {}),
  };
}
