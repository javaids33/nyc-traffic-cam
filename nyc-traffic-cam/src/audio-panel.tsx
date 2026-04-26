import { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones, Radio as RadioIcon, X } from 'lucide-react';

/* Combined audio dock: one button in the bottom-right that opens a
   panel with two tabs — RADIO (live NYC streams) and AMBIENCE
   (synthesized AC hum / subway / street noise). Volume is shared
   across both, but only one source plays at a time. */

type Station = {
  id: string;
  call: string;
  freq: string;
  vibe: string;
  url: string;
};

const STATIONS: Station[] = [
  { id: 'wnyc-fm',  call: 'WNYC',  freq: '93.9 FM',     vibe: 'public radio · news · talk',          url: 'https://fm939.wnyc.org/wnycfm' },
  { id: 'wnyc-am',  call: 'WNYC',  freq: '820 AM',      vibe: 'spoken word · interviews',            url: 'https://am820.wnyc.org/wnycam' },
  { id: 'wbgo',     call: 'WBGO',  freq: '88.3 FM',     vibe: 'jazz · 24/7',                          url: 'https://wbgo.streamguys1.com/wbgo128' },
  { id: 'wqxr',     call: 'WQXR',  freq: '105.9 FM',    vibe: 'classical',                            url: 'https://stream.wqxr.org/wqxr' },
  { id: 'wfuv',     call: 'WFUV',  freq: '90.7 FM',     vibe: 'fordham · adult album alternative',    url: 'https://onair.wfuv.org/onair-hi.mp3' },
  { id: 'wbai',     call: 'WBAI',  freq: '99.5 FM',     vibe: 'pacifica · community',                 url: 'https://wbai.streamguys1.com/wbai' },
  { id: 'wkcr',     call: 'WKCR',  freq: '89.9 FM',     vibe: 'columbia · jazz / specialty',          url: 'https://wkcr-secure.cc.columbia.edu:8000/listen' },
  { id: 'wfmu',     call: 'WFMU',  freq: '91.1 FM',     vibe: 'freeform · weird in the best way',     url: 'https://stream0.wfmu.org/freeform-128k.mp3' },
  { id: 'wsou',     call: 'WSOU',  freq: '89.5 FM',     vibe: 'seton hall · loud rock',               url: 'https://stream.wsou.net/wsou.mp3' },
  { id: 'lot',      call: 'LOT',   freq: 'GREENPOINT',  vibe: 'brooklyn indie · live djs',            url: 'https://thelotradio.out.airtime.pro/thelotradio_a' },
  { id: 'nts1',     call: 'NTS',   freq: 'CH. 1',       vibe: 'global · curated · london ↔ ny',       url: 'https://stream-relay-geo.ntslive.net/stream' },
  { id: 'nts2',     call: 'NTS',   freq: 'CH. 2',       vibe: 'global · curated · b-side',            url: 'https://stream-relay-geo.ntslive.net/stream2' },
  { id: 'kexp',     call: 'KEXP',  freq: '90.3 SEA',    vibe: 'seattle · indie · sister station',     url: 'https://kexp-mp3-128.streamguys1.com/kexp128.mp3' },
];

/* === Synthesized ambience modes (Web Audio) === */
type AmbienceMode = 'ac' | 'subway' | 'street';
const AMBIENCE: { id: AmbienceMode; label: string; gloss: string }[] = [
  { id: 'ac',     label: 'AC HUM',  gloss: 'window unit, july' },
  { id: 'subway', label: 'SUBWAY',  gloss: 'tracks below the deli' },
  { id: 'street', label: 'STREET',  gloss: 'sirens, distant' },
];

function makeBrownNoise(ctx: AudioContext) {
  const buf = ctx.createBuffer(1, 2 * ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    d[i] = (last + 0.02 * w) / 1.02;
    last = d[i];
    d[i] *= 3.5;
  }
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true;
  return s;
}
function makePinkNoise(ctx: AudioContext) {
  const buf = ctx.createBuffer(1, 2 * ctx.sampleRate, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886*b0 + w*0.0555179;
    b1 = 0.99332*b1 + w*0.0750759;
    b2 = 0.96900*b2 + w*0.1538520;
    b3 = 0.86650*b3 + w*0.3104856;
    b4 = 0.55000*b4 + w*0.5329522;
    b5 = -0.7616*b5 - w*0.0168980;
    d[i] = (b0+b1+b2+b3+b4+b5+b6 + w*0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true;
  return s;
}

type Source = { kind: 'radio'; stationId: string } | { kind: 'ambience'; mode: AmbienceMode } | null;

export function AudioPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'radio' | 'ambience'>('radio');
  const [src, setSrc] = useState<Source>(null);
  const [vol, setVol] = useState(0.55);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const ambienceStopRef = useRef<(() => void) | null>(null);

  const stopAll = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    ambienceStopRef.current?.();
    ambienceStopRef.current = null;
    setPlaying(false);
  }, []);

  const tuneRadio = (s: Station) => {
    setError(null);
    stopAll();
    setSrc({ kind: 'radio', stationId: s.id });
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = 'none';
      audioRef.current.addEventListener('error', () => {
        setError('signal lost — try another station');
        setPlaying(false);
      });
      audioRef.current.addEventListener('playing', () => setPlaying(true));
      audioRef.current.addEventListener('pause', () => setPlaying(false));
    }
    audioRef.current.src = s.url;
    audioRef.current.volume = vol;
    audioRef.current.play().catch(() => {
      setError('autoplay blocked — tap the station again');
      setPlaying(false);
    });
  };

  const startAmbience = (mode: AmbienceMode) => {
    setError(null);
    stopAll();
    setSrc({ kind: 'ambience', mode });
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctx();
      masterRef.current = ctxRef.current.createGain();
      masterRef.current.gain.value = vol;
      masterRef.current.connect(ctxRef.current.destination);
    }
    const ctx = ctxRef.current!;
    const master = masterRef.current!;
    const stops: (() => void)[] = [];

    if (mode === 'ac') {
      const noise = makeBrownNoise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 600;
      const gn = ctx.createGain(); gn.gain.value = 0.6;
      noise.connect(lp).connect(gn).connect(master);
      const hum = ctx.createOscillator();
      hum.type = 'sine'; hum.frequency.value = 60;
      const hgn = ctx.createGain(); hgn.gain.value = 0.12;
      hum.connect(hgn).connect(master);
      noise.start(); hum.start();
      stops.push(() => { try { noise.stop(); hum.stop(); } catch { /* noop */ } });
    } else if (mode === 'subway') {
      const noise = makeBrownNoise(ctx);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 250;
      const gn = ctx.createGain(); gn.gain.value = 0.85;
      noise.connect(lp).connect(gn).connect(master);
      noise.start();
      const swell = setInterval(() => {
        const t = ctx.currentTime;
        gn.gain.cancelScheduledValues(t);
        gn.gain.setValueAtTime(gn.gain.value, t);
        gn.gain.linearRampToValueAtTime(1.4 + Math.random() * 0.6, t + 1.2);
        gn.gain.linearRampToValueAtTime(0.85, t + 5);
      }, 12_000 + Math.random() * 12_000);
      const squeal = setInterval(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = 1800 + Math.random() * 1200;
        og.gain.value = 0;
        o.connect(og).connect(master);
        og.gain.linearRampToValueAtTime(0.05, t + 0.2);
        og.gain.linearRampToValueAtTime(0, t + 1.6);
        o.start(t); o.stop(t + 1.7);
      }, 45_000 + Math.random() * 45_000);
      stops.push(() => { try { noise.stop(); } catch { /* noop */ } clearInterval(swell); clearInterval(squeal); });
    } else if (mode === 'street') {
      const noise = makePinkNoise(ctx);
      const gn = ctx.createGain(); gn.gain.value = 0.4;
      noise.connect(gn).connect(master);
      noise.start();
      const siren = setInterval(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'sawtooth'; og.gain.value = 0;
        o.connect(og).connect(master);
        og.gain.linearRampToValueAtTime(0.05, t + 0.4);
        og.gain.linearRampToValueAtTime(0.04, t + 4);
        og.gain.linearRampToValueAtTime(0, t + 5);
        o.frequency.setValueAtTime(700, t);
        for (let i = 0; i < 6; i++) {
          o.frequency.linearRampToValueAtTime(1100, t + 0.4 + i * 0.7);
          o.frequency.linearRampToValueAtTime(700,  t + 0.7 + i * 0.7);
        }
        o.start(t); o.stop(t + 5);
      }, 50_000 + Math.random() * 60_000);
      const horn = setInterval(() => {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'square'; o.frequency.value = 320; og.gain.value = 0;
        o.connect(og).connect(master);
        og.gain.linearRampToValueAtTime(0.04, t + 0.05);
        og.gain.linearRampToValueAtTime(0.04, t + 0.35);
        og.gain.linearRampToValueAtTime(0, t + 0.5);
        o.start(t); o.stop(t + 0.55);
      }, 70_000 + Math.random() * 80_000);
      stops.push(() => { try { noise.stop(); } catch { /* noop */ } clearInterval(siren); clearInterval(horn); });
    }

    ambienceStopRef.current = () => stops.forEach((s) => s());
    setPlaying(true);
  };

  // Apply volume changes live to whichever source is active.
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = vol;
    if (masterRef.current) masterRef.current.gain.value = vol;
  }, [vol]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopAll();
      ctxRef.current?.close();
    };
  }, [stopAll]);

  const onClickStation = (s: Station) => {
    if (src?.kind === 'radio' && src.stationId === s.id && playing) {
      audioRef.current?.pause();
    } else {
      tuneRadio(s);
    }
  };

  const offEverything = () => {
    stopAll();
    setSrc(null);
  };

  const nowPlayingLabel = (() => {
    if (!src) return null;
    if (src.kind === 'radio') {
      const s = STATIONS.find((x) => x.id === src.stationId);
      return s ? `${s.call} · ${s.freq}` : null;
    }
    return AMBIENCE.find((m) => m.id === src.mode)?.label ?? null;
  })();

  return (
    <div className="fixed bottom-3 right-3 z-40 pointer-events-auto">
      {open ? (
        <div
          className="bg-black/92 border border-[#FFD600] font-typewriter text-[10px] uppercase tracking-[0.18em] w-[300px]"
          style={{ boxShadow: '4px 4px 0 #d11a2a' }}
        >
          {/* tabs row */}
          <div className="flex items-stretch border-b border-[#FFD600]/40">
            <TabBtn active={tab === 'radio'}     onClick={() => setTab('radio')}>
              <RadioIcon className="w-3 h-3" /> RADIO
            </TabBtn>
            <TabBtn active={tab === 'ambience'} onClick={() => setTab('ambience')}>
              <Headphones className="w-3 h-3" /> AMBIENCE
            </TabBtn>
            <button
              onClick={() => setOpen(false)}
              className="px-2 text-white/55 hover:text-white border-l border-[#FFD600]/40"
              aria-label="close"
            >
              <X className="w-3 h-3" />
            </button>
          </div>

          {/* contents */}
          {tab === 'radio' ? (
            <div className="max-h-[280px] overflow-y-auto">
              {STATIONS.map((s) => {
                const active = src?.kind === 'radio' && src.stationId === s.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => onClickStation(s)}
                    className={`w-full text-left px-3 py-1.5 flex items-baseline justify-between gap-2 border-b border-white/5 transition-colors ${
                      active ? 'bg-[#FFD600]/15 text-[#FFD600]' : 'text-white/80 hover:bg-white/5 hover:text-[#FFD600]'
                    }`}
                  >
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className={`font-bungee text-[12px] tracking-[0.04em] ${active ? 'text-[#FFD600]' : 'text-white'}`}>{s.call}</span>
                      <span className="text-[8px] tracking-[0.18em] text-white/45">{s.freq}</span>
                    </span>
                    <span className="text-[8px] tracking-[0.16em] text-white/40 normal-case lowercase truncate">
                      {active && playing ? '· on air' : s.vibe}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="px-3 py-3">
              <div className="grid grid-cols-3 gap-1.5">
                {AMBIENCE.map((m) => {
                  const active = src?.kind === 'ambience' && src.mode === m.id;
                  return (
                    <button
                      key={m.id}
                      onClick={() => (active ? offEverything() : startAmbience(m.id))}
                      title={m.gloss}
                      className={`px-2 py-2 border text-[10px] tracking-[0.18em] transition-colors ${
                        active
                          ? 'bg-[#FFD600] text-black border-[#FFD600]'
                          : 'border-white/15 text-white/80 hover:border-[#FFD600] hover:text-[#FFD600]'
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 text-[8px] tracking-[0.18em] text-white/40 normal-case lowercase">
                synthesized — no audio assets, no network.
              </div>
            </div>
          )}

          {/* shared transport bar */}
          <div className="border-t border-[#FFD600]/40 px-3 py-2 flex items-center gap-2">
            <span className="text-[9px] tracking-[0.18em] text-white/55 truncate flex-1">
              {error ? <span className="text-[#ff5582]">{error}</span> : (nowPlayingLabel ? `▶ ${nowPlayingLabel}` : 'select a station')}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={vol}
              onChange={(e) => setVol(parseFloat(e.target.value))}
              className="w-20"
              title="volume"
            />
            {src && (
              <button
                onClick={offEverything}
                className="text-white/55 hover:text-white text-[9px] tracking-[0.18em]"
                title="off"
              >
                OFF
              </button>
            )}
          </div>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="bg-black/85 border border-[#FFD600]/70 px-3 py-1.5 flex items-center gap-2 font-typewriter text-[10px] uppercase tracking-[0.2em] text-[#FFD600] hover:bg-black"
          style={{ boxShadow: '3px 3px 0 #d11a2a' }}
          title="Audio: NYC radio + synthesized ambience"
        >
          <RadioIcon className="w-3 h-3" />
          <span>{nowPlayingLabel ? `${nowPlayingLabel}` : 'AUDIO'}</span>
          {playing && <span className="w-1.5 h-1.5 rounded-full bg-[#FFD600]" style={{ boxShadow: '0 0 6px #FFD600' }} />}
        </button>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 flex items-center justify-center gap-1.5 text-[10px] tracking-[0.2em] transition-colors ${
        active ? 'bg-[#FFD600] text-black' : 'text-[#FFD600]/70 hover:text-[#FFD600]'
      }`}
    >
      {children}
    </button>
  );
}
