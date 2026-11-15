import { useStore } from '../../lib/store';
import { VOICE_OPTIONS, optionByKey, voiceStore } from '../../lib/voice';
import { setVoiceOption } from '../../lib/voiceController';
import { healthText, statusStore } from '../../lib/status';
import { chooseVoice, voiceUnavailableNotice } from '../../lib/voiceChoice';
import { Check } from 'lucide-react';
import HealthDot from '../ui/HealthDot';
import Popover from '../ui/Popover';
import VoiceNamePicker from './VoiceNamePicker';

export default function ProviderMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { option, state } = useStore(voiceStore);
  const providers = useStore(statusStore, (s) => s.providers);
  const effective = chooseVoice(optionByKey(option), providers);
  return (
    <Popover open={open} onClose={onClose} side="top" align="left" className="w-72 max-w-[calc(100vw-6rem)] max-h-[min(650px,calc(100dvh-190px))] overflow-y-auto overscroll-contain">
      <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-mute">Sprachmodell</p>
      <p className="px-3 pb-2 text-xs text-dim">Startet mit {effective.run.label}{effective.picked ? ` · ${voiceUnavailableNotice(effective.picked, effective.run)}` : ''}</p>
      {VOICE_OPTIONS.map((o) => {
        const health = providers[o.provider];
        const hint = health?.state === 'failed' ? `Nicht verfügbar · ${healthText(health)}` : health?.state === 'off' ? 'Nicht eingerichtet' : o.hint;
        return (
          <button
            key={o.key}
            type="button"
            role="menuitemradio"
            aria-checked={o.key === option}
            onClick={() => {
              setVoiceOption(o.key);
            }}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${o.key === option ? 'bg-violet/12' : 'hover:bg-white/[0.05]'}`}
          >
            <span title={healthText(health)} className="flex"><HealthDot health={health} className="h-2 w-2" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{o.label}</span>
              <span className={`block text-xs ${health?.state === 'failed' ? 'text-amber/90' : 'text-dim'}`}>{hint}</span>
            </span>
            {o.key === option && <Check className="h-4 w-4 shrink-0 text-violet-light" />}
          </button>
        );
      })}
      {open && <VoiceNamePicker provider={optionByKey(option).provider} running={state !== 'idle' && state !== 'error'} />}
    </Popover>
  );
}
