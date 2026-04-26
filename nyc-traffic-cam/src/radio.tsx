import { useEffect, useRef, useState } from 'react';
import { Radio, X } from 'lucide-react';

/* NYC radio picker. HTML5 <audio> pointed at public-domain or freely
   redistributed station streams. No keys, no SDK, no analytics —
   each click hits the station's own CDN. */

type Station = {
  id: string;
  call: string;     // call letters
  freq: string;     // dial position
  name: string;     // human-readable
  vibe: string;     // one-line description for the dropdown
  url: string;      // direct audio stream
};

const STATIONS: Station[] = [
  {
    id: 'wnyc',
    call: 'WNYC',
    freq: '93.9 FM',
    name: 'WNYC FM',
    vibe: 'public radio · news · talk',
    url: 'https://fm939.wnyc.org/wnycfm',
  },
  {
    id: 'wbgo',
    call: 'WBGO',
    freq: '88.3 FM',
    name: 'WBGO Newark/NYC',
    vibe: 'jazz · 24/7',
    url: 'https://wbgo.streamguys1.com/wbgo128',
  },
  {
    id: 'wqxr',
    call: 'WQXR',
    freq: '105.9 FM',
    name: 'WQXR',
    vibe: 'classical',
    url: 'https://stream.wqxr.org/wqxr',
  },
  {
    id: 'lot',
    call: 'LOT',
    freq: 'GREENPOINT',
    name: 'The Lot Radio',
    vibe: 'brooklyn indie · live djs',
    url: 'https://thelotradio.out.airtime.pro/thelotradio_a',
  },
  {
    id: 'wfmu',
    call: 'WFMU',
    freq: '91.1 FM',
    name: 'WFMU Jersey City',
    vibe: 'freeform · weird in the best way',
    url: 'https://stream0.wfmu.org/freeform-128k.mp3',
  },
];

export function RadioWidget() {
  const [open, setOpen] = useState(false);
  const [station, setStation] = useState<Station | null>(null);
  const [playing, setPlaying] = useState(false);
  const [vol, setVol] = useState(0.6);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Re-apply volume whenever it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = vol;
  }, [vol]);

  // Tear down audio on unmount so it doesn't keep streaming after navigation.
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
    };
  }, []);

  const tune = (s: Station) => {
    setError(null);
    setStation(s);
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'none';
      audioRef.current.addEventListener('error', () => {
        setError('signal lost');
        setPlaying(false);
      });
      audioRef.current.addEventListener('playing', () => setPlaying(true));
      audioRef.current.addEventListener('pause', () => setPlaying(false));
    }
    audioRef.current.src = s.url;
    audioRef.current.volume = vol;
    audioRef.current.play().catch(() => {
      setError('autoplay blocked — tap again');
      setPlaying(false);
    });
  };

  const toggle = () => {
    if (!audioRef.current || !station) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => {
        setError('signal lost');
        setPlaying(false);
      });
    }
  };

  const stop = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    setStation(null);
    setPlaying(false);
    setError(null);
  };

  return (
    <div className="fixed bottom-3 right-3 z-40 pointer-events-auto">
      {open ? (
        <div
          className="bg-black/90 border border-[#FFD600] px-3 py-2 font-typewriter text-[10px] uppercase tracking-[0.2em] w-[260px]"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[#FFD600] flex items-center gap-1.5">
              <Radio className="w-3 h-3" />
              NYC RADIO
            </span>
            <button onClick={() => setOpen(false)} className="text-white/55 hover:text-white">
              <X className="w-3 h-3" />
            </button>
          </div>

          <ul className="space-y-1">
            {STATIONS.map((s) => {
              const active = station?.id === s.id;
              return (
                <li key={s.id}>
                  <button
                    onClick={() => tune(s)}
                    className={`w-full text-left px-2 py-1 border transition-colors flex items-baseline justify-between gap-2 ${
                      active
                        ? 'bg-[#FFD600] text-black border-[#FFD600]'
                        : 'border-white/15 text-white/80 hover:border-[#FFD600] hover:text-[#FFD600]'
                    }`}
                  >
                    <span className="font-bungee tracking-[0.04em] text-[12px]">{s.call}</span>
                    <span className={`text-[8px] tracking-[0.18em] ${active ? 'text-black/70' : 'text-white/45'}`}>
                      {s.freq}
                    </span>
                  </button>
                  {active && (
                    <div className={`mt-0.5 px-2 text-[9px] tracking-[0.18em] ${error ? 'text-[#ff5582]' : 'text-white/55'}`}>
                      {error ?? s.vibe}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {station && (
            <div className="mt-2 pt-2 border-t border-white/10 flex items-center gap-2">
              <button
                onClick={toggle}
                className="px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors text-[10px] tracking-[0.2em]"
              >
                {playing ? '■ STOP' : '▶ PLAY'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={vol}
                onChange={(e) => setVol(parseFloat(e.target.value))}
                className="flex-1"
                title="volume"
              />
              <button
                onClick={stop}
                className="text-white/45 hover:text-white text-[10px] tracking-[0.2em]"
                title="off"
              >
                OFF
              </button>
            </div>
          )}

          <div className="mt-2 text-[8px] tracking-[0.18em] text-white/35">
            streams hosted by each station. plays at your own bandwidth.
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="bg-black/80 border border-[#FFD600]/70 px-2.5 py-1 flex items-center gap-1.5 font-typewriter text-[10px] uppercase tracking-[0.2em] text-[#FFD600] hover:bg-black"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
          title="Tune in to NYC radio"
        >
          <Radio className="w-3 h-3" />
          <span>{station ? `${station.call} · ${playing ? 'ON' : 'PAUSED'}` : 'RADIO'}</span>
        </button>
      )}
    </div>
  );
}
