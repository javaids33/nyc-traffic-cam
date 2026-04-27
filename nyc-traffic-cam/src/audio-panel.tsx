import { useState } from 'react';
import { Headphones, Radio as RadioIcon, X } from 'lucide-react';
import {
  AMBIENCE,
  STATIONS,
  audioOff,
  audioSetVol,
  audioStartAmbience,
  audioToggle,
  audioTuneRadio,
  nowPlayingLabel,
  useAudio,
  type Station,
} from './audio-store';

/* Combined audio dock: one button in the bottom-left that opens a
   panel with two tabs — RADIO (live NYC streams) and AMBIENCE
   (synthesized AC hum / subway / street noise). All state lives in
   audio-store so the in-TV mini-control can drive the same source. */

export function AudioPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'radio' | 'ambience'>('radio');
  const { src, vol, playing, error } = useAudio();

  const onClickStation = (s: Station) => {
    if (src?.kind === 'radio' && src.stationId === s.id) {
      audioToggle();
    } else {
      audioTuneRadio(s);
    }
  };

  const label = nowPlayingLabel(src);

  return (
    <div className="fixed bottom-3 md:bottom-20 left-3 z-40 pointer-events-auto">
      {open ? (
        <div
          role="dialog"
          aria-label="Audio panel — radio and ambience"
          className="bg-black border border-[#FFD600] font-typewriter text-[10px] uppercase tracking-[0.18em] w-[280px] sm:w-[300px]"
          style={{ boxShadow: '4px 4px 0 #d11a2a' }}
        >
          <div className="flex items-stretch border-b border-[#FFD600]/40">
            <TabBtn active={tab === 'radio'} onClick={() => setTab('radio')} aria-label="Radio tab">
              <RadioIcon className="w-3 h-3" aria-hidden /> RADIO
            </TabBtn>
            <TabBtn active={tab === 'ambience'} onClick={() => setTab('ambience')} aria-label="Ambience tab">
              <Headphones className="w-3 h-3" aria-hidden /> AMBIENCE
            </TabBtn>
            <button
              onClick={() => setOpen(false)}
              className="px-2 text-white/65 hover:text-white border-l border-[#FFD600]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              aria-label="Close audio panel"
              type="button"
            >
              <X className="w-3 h-3" aria-hidden />
            </button>
          </div>

          {tab === 'radio' ? (
            <ul className="max-h-[260px] overflow-y-auto" role="list">
              {STATIONS.map((s) => {
                const active = src?.kind === 'radio' && src.stationId === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => onClickStation(s)}
                      aria-pressed={active}
                      aria-label={`${s.call} ${s.freq} — ${s.vibe}`}
                      className={`w-full text-left px-3 py-1.5 flex items-baseline justify-between gap-2 border-b border-white/5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600] ${
                        active ? 'bg-[#FFD600]/15 text-[#FFD600]' : 'text-white/85 hover:bg-white/5 hover:text-[#FFD600]'
                      }`}
                    >
                      <span className="flex items-baseline gap-2 min-w-0">
                        <span className={`font-bungee text-[12px] tracking-[0.04em] ${active ? 'text-[#FFD600]' : 'text-white'}`}>{s.call}</span>
                        <span className="text-[8px] tracking-[0.18em] text-white/55">{s.freq}</span>
                      </span>
                      <span className="text-[8px] tracking-[0.16em] text-white/55 normal-case lowercase truncate">
                        {active && playing ? '· on air' : s.vibe}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="px-3 py-3">
              <div className="grid grid-cols-3 gap-1.5">
                {AMBIENCE.map((m) => {
                  const active = src?.kind === 'ambience' && src.mode === m.id;
                  return (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => (active ? audioOff() : audioStartAmbience(m.id))}
                      title={m.gloss}
                      aria-pressed={active}
                      aria-label={`${m.label} ambience — ${m.gloss}`}
                      className={`px-2 py-2 border text-[10px] tracking-[0.18em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600] ${
                        active ? 'bg-[#FFD600] text-black border-[#FFD600]' : 'border-white/20 text-white/85 hover:border-[#FFD600] hover:text-[#FFD600]'
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[8px] tracking-[0.18em] text-white/55 normal-case lowercase">
                synthesized — no audio assets, no network.
              </div>
            </div>
          )}

          <div className="border-t border-[#FFD600]/40 px-3 py-2 flex items-center gap-2">
            <span className="text-[9px] tracking-[0.18em] text-white/65 truncate flex-1" aria-live="polite">
              {error ? <span className="text-[#ff8a9a]">{error}</span> : (label ? `▶ ${label}` : 'select a station')}
            </span>
            <label className="flex items-center gap-1">
              <span className="sr-only">Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={vol}
                onChange={(e) => audioSetVol(parseFloat(e.target.value))}
                className="w-20 accent-[#FFD600]"
                aria-label="Volume"
              />
            </label>
            {src && (
              <button
                type="button"
                onClick={audioOff}
                className="text-white/75 hover:text-white text-[9px] tracking-[0.18em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
                aria-label="Stop audio"
              >
                OFF
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="bg-black border border-[#FFD600] px-3 py-1.5 flex items-center gap-2 font-typewriter text-[10px] uppercase tracking-[0.2em] text-[#FFD600] hover:bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
          aria-label={label ? `Audio panel — ${label} playing` : 'Open audio panel'}
        >
          <RadioIcon className="w-3 h-3" aria-hidden />
          <span>{label ?? 'AUDIO'}</span>
          {playing && <span className="w-1.5 h-1.5 rounded-full bg-[#FFD600]" aria-hidden style={{ boxShadow: '0 0 6px #FFD600' }} />}
        </button>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
  ...rest
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 px-3 py-2 flex items-center justify-center gap-1.5 text-[10px] tracking-[0.2em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FFD600] ${
        active ? 'bg-[#FFD600] text-black' : 'text-[#FFD600]/80 hover:text-[#FFD600]'
      }`}
      {...rest}
    >
      {children}
    </button>
  );
}
