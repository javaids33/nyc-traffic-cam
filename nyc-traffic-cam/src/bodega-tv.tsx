import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lock, Maximize2, Minimize2, Pause, Play, Radio, X } from 'lucide-react';
import { apiUrl } from './api';
import {
  audioOff,
  audioSetVol,
  audioToggle,
  audioTuneRadio,
  nowPlayingLabel,
  STATIONS,
  useAudio,
} from './audio-store';

export const CHANNEL_LINEUP = [2, 4, 5, 7, 9, 11, 13, 21, 25, 31];

export type TVCaption = {
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  coords?: { lat: number; lng: number } | null;
  occurrences?: number | null;
};

export function useClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return t;
}

/* Free, key-less weather via open-meteo. Refreshes every 15 min. */
const WEATHER_ICON: Record<number, string> = {
  0: '☀', 1: '🌤', 2: '⛅', 3: '☁',
  45: '🌫', 48: '🌫',
  51: '🌦', 53: '🌦', 55: '🌦', 56: '🌧', 57: '🌧',
  61: '🌧', 63: '🌧', 65: '🌧', 66: '🌧', 67: '🌧',
  71: '🌨', 73: '🌨', 75: '🌨', 77: '🌨',
  80: '🌦', 81: '🌧', 82: '🌧',
  85: '🌨', 86: '🌨',
  95: '⛈', 96: '⛈', 99: '⛈',
};
/* NYC banter — short captions instead of clinical descriptions. */
const WEATHER_COND: Record<number, string> = {
  0:  'is what it is',
  1:  'mostly clear',
  2:  'half and half',
  3:  'gray sky kinda day',
  45: 'fog · go slow',
  48: 'fog · go slow',
  51: 'spitting',
  53: 'spitting',
  55: 'spitting · grab a hood',
  61: 'rain · cabs are full',
  63: 'rain · cabs are full',
  65: 'pouring · stay in',
  66: 'wintry mix · careful',
  67: 'wintry mix · careful',
  71: 'snow · subway weather',
  73: 'snow · subway weather',
  75: 'whiteout · stay in',
  77: 'snow grains',
  80: 'on/off showers',
  81: 'on/off showers',
  82: 'pouring',
  85: 'snow showers',
  86: 'snow showers',
  95: 'thunder · take the stairs',
  96: 'thunder + hail',
  99: 'thunder + hail',
};
function useNycWeather() {
  const [w, setW] = useState<{ temp: string; cond: string; icon: string } | null>(null);
  useEffect(() => {
    let stop = false;
    const fetchOnce = async () => {
      try {
        const r = await fetch(
          'https://api.open-meteo.com/v1/forecast?latitude=40.78&longitude=-73.97&current_weather=true&temperature_unit=fahrenheit',
        );
        if (!r.ok) return;
        const j = await r.json();
        const cw = j?.current_weather;
        if (stop || !cw || typeof cw.temperature !== 'number') return;
        const code = Number(cw.weathercode) || 0;
        setW({
          temp: `${Math.round(cw.temperature)}°F`,
          cond: WEATHER_COND[code] ?? '',
          icon: WEATHER_ICON[code] ?? '·',
        });
      } catch { /* noop */ }
    };
    fetchOnce();
    const i = setInterval(fetchOnce, 15 * 60 * 1000);
    return () => { stop = true; clearInterval(i); };
  }, []);
  return w;
}

/* ────────────────────────────────────────────────── BodegaTV
   The reusable wood-cabinet CRT. Display-only — the parent decides
   what camera to show, when to flip channels, and any lock state. */

/* The TV pulls frames straight from the public NYC TMC image endpoint when
   `liveSource="nyctmc"`. Each tick uses Date.now() as the cache-buster, which
   matches the upstream cadence (~1-2s). */
const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

export function BodegaTV({
  cameraId,
  caption,
  channelNumber,
  flashKey,
  staticOn,
  large = false,
  locked = false,
  onScreenClick,
  onClose,
  refreshSec = 1.5,
  liveSource = 'nyctmc',
}: {
  cameraId: string | null;
  caption: TVCaption | null;
  channelNumber: number;
  flashKey: number;
  staticOn: boolean;
  large?: boolean;
  locked?: boolean;
  onScreenClick?: () => void;
  onClose?: () => void;
  refreshSec?: number;
  liveSource?: 'nyctmc' | 'backend';
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [isFs, setIsFs] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const clock = useClock();

  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), refreshSec * 1000);
    return () => clearInterval(i);
  }, [refreshSec]);

  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const toggleFullscreen = () => {
    if (!wrapRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      wrapRef.current.requestFullscreen?.().catch(() => { /* user cancelled or unsupported */ });
    }
  };

  const hh = String(clock.getHours()).padStart(2, '0');
  const mm = String(clock.getMinutes()).padStart(2, '0');
  const screenMinH = large ? 380 : 260;

  return (
    <div ref={wrapRef} className="select-none w-full bodega-tv-fullscreen">
      {/* rabbit-ear antennas — taller on large */}
      <div className="relative h-0">
        <div
          className="antenna"
          style={{ left: '38%', transform: 'rotate(-32deg)', height: large ? 96 : 72 }}
        />
        <div
          className="antenna"
          style={{ right: '38%', transform: 'rotate(28deg)', height: large ? 86 : 64 }}
        />
        {/* ON AIR neon sign — only large variant */}
        {large && (
          <div className="absolute -left-2 top-[-72px] hidden md:block">
            <div
              className="font-bungee text-[28px] tracking-[0.05em] neon"
              style={{ transform: 'rotate(-8deg)', color: '#ff5582' }}
            >
              ON AIR
            </div>
            <div className="text-[9px] font-typewriter uppercase tracking-[0.3em] text-[#ff5582]/60 mt-0.5">
              · live broadcast ·
            </div>
          </div>
        )}
      </div>

      {/* wood cabinet — fat back CRT vibe */}
      <div
        className="wood-grain relative"
        style={{
          borderTopLeftRadius: 22,
          borderTopRightRadius: 22,
          padding: large ? '20px 18px 24px' : '14px 12px 18px',
          boxShadow:
            '0 30px 0 -14px rgba(0,0,0,0.85), 0 18px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,228,160,0.08), inset 0 -22px 36px rgba(0,0,0,0.55)',
        }}
      >
        {/* top vents + nameplate row */}
        <div className="flex items-center justify-between mb-2 text-[10px] tracking-[0.3em] uppercase font-typewriter text-[#f3e9c0]/85">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 bg-[#ff5026] rec-dot rounded-full" style={{ boxShadow: '0 0 6px #ff5026' }} />
            <span className="font-bungee tracking-[0.08em] text-[12px] text-[#f3e9c0]">RCA</span>
            <span className="text-[#f3e9c0]/60">· SOLID-STATE COLOR · TC-21 ·</span>
          </span>
          <span className="hidden md:flex items-center gap-1 flex-1 justify-center mx-4">
            {Array.from({ length: 22 }).map((_, i) => (
              <span
                key={i}
                className="h-[3px] flex-1 max-w-[10px]"
                style={{
                  background: 'linear-gradient(90deg, rgba(0,0,0,0.85), rgba(60,40,20,0.4))',
                  boxShadow: 'inset 0 1px 0 rgba(255,210,120,0.08)',
                }}
              />
            ))}
          </span>
          <span className="hidden md:inline tabular text-[#f3e9c0]/55">CH {String(channelNumber).padStart(2, '0')} · {hh}:{mm}</span>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="ml-2 text-[#f3e9c0]/85 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            title={isFs ? 'Exit fullscreen (esc)' : 'Fullscreen the TV'}
            aria-label={isFs ? 'Exit fullscreen' : 'Enter fullscreen'}
          >
            {isFs ? <Minimize2 className="w-3.5 h-3.5" aria-hidden /> : <Maximize2 className="w-3.5 h-3.5" aria-hidden />}
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-[#f3e9c0]/85 hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              aria-label="Close TV"
            >
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>

        {/* fat cabinet row: speaker grille | screen | knob stack */}
        <div className="flex items-stretch gap-2 sm:gap-3">
          {/* left speaker grille — only on large variant */}
          {large && <SpeakerGrille />}

        {/* screen bezel */}
        <div
          className="relative bg-black overflow-hidden cursor-pointer flex-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          style={{
            border: large ? '14px solid #0e0a07' : '8px solid #1a1410',
            borderRadius: '28px / 18px',
            boxShadow:
              'inset 0 0 60px rgba(0,0,0,0.95), 0 0 0 3px rgba(255,255,255,0.08), 0 0 70px rgba(255,150,40,0.08), inset 0 0 0 1px rgba(0,0,0,0.6)',
          }}
          role={onScreenClick ? 'button' : undefined}
          tabIndex={onScreenClick ? 0 : undefined}
          aria-label={onScreenClick ? (locked ? 'Unlock channel' : 'Lock current channel') : undefined}
          onClick={onScreenClick}
          onKeyDown={(e) => {
            if (!onScreenClick) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onScreenClick(); }
          }}
        >
          <div
            key={flashKey}
            className="relative crt-overlay"
            style={{ animation: 'tv-channel-flip 0.55s cubic-bezier(.6,.05,.35,1)' }}
          >
            {cameraId && caption ? (
              <>
                {(() => {
                  const hour = nycHourNow();
                  const deadHours = hour >= 2 && hour < 5;
                  return deadHours ? (
                    <DeadHoursCard large={large} />
                  ) : (
                    <SmoothCamFrame
                      cameraId={cameraId}
                      tick={tick}
                      liveSource={liveSource}
                      alt={caption.title}
                      minHeight={screenMinH}
                    />
                  );
                })()}
                <span className="vhs-band" />
                <CornerGuides large={large} />

                {/* lower-third chyron, NY1-style */}
                <div className="absolute bottom-0 left-0 right-0">
                  <div
                    className="bg-[#003B70]/95 border-t-2 border-b-2 border-[#FFD600] px-3 py-2 flex items-end gap-3"
                  >
                    <div className="flex-1 min-w-0 text-white">
                      <div className="text-[10px] tracking-[0.28em] uppercase font-typewriter text-[#FFD600]">
                        — NOW PLAYING — CHANNEL {channelNumber}
                      </div>
                      <ChyronTitle title={caption.title} large={large} />

                      {caption.subtitle && (
                        <div className="text-[11px] text-white/85 mt-0.5 line-clamp-1">{caption.subtitle}</div>
                      )}
                      {caption.meta && (
                        <div className="text-[10px] text-[#FFD600]/85 mt-0.5 font-typewriter uppercase tracking-[0.2em] line-clamp-1">
                          {caption.meta}
                        </div>
                      )}
                    </div>
                    <div className="text-right text-[10px] tabular text-white/75 uppercase leading-relaxed shrink-0 font-mono">
                      {caption.coords && (
                        <div>{caption.coords.lat.toFixed(4)}, {caption.coords.lng.toFixed(4)}</div>
                      )}
                      {caption.occurrences && caption.occurrences > 1 && (
                        <div>×{caption.occurrences}</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* small "LOCKED" sticker top-right of the screen if held */}
                {locked && (
                  <div className="absolute top-2 right-2 flex items-center gap-1 bg-[#FFD600] text-black px-2 py-0.5 text-[9px] font-bungee uppercase tracking-[0.18em]">
                    <Lock className="w-2.5 h-2.5" /> LOCKED
                  </div>
                )}
              </>
            ) : (
              <div
                className="grid place-items-center text-center text-[#FFD600]/80 text-[12px] uppercase tracking-[0.28em] font-typewriter"
                style={{ minHeight: screenMinH }}
              >
                — STANDBY — TUNING —
              </div>
            )}
          </div>

          {staticOn && <div className="crt-static absolute inset-0 pointer-events-none opacity-75" />}
        </div>

          {/* right knob stack — large variant only */}
          {large && (
            <div className="flex flex-col items-center justify-between gap-2 py-1 pr-1 w-[64px] sm:w-[80px] shrink-0">
              <KnobDial label="CHAN" value={String(channelNumber).padStart(2, '0')} digit />
              <KnobDial label="VOL" value="●●●○○" />
              <KnobDial label="TINT" small />
              <KnobDial label="V·HOLD" small />
              <button
                title="POWER"
                aria-label="power"
                className="mt-auto rounded-full bg-[#0a0805] border-2 border-[#3b2a14] w-7 h-7 grid place-items-center"
                style={{ boxShadow: 'inset 0 -2px 4px rgba(0,0,0,0.7), 0 1px 0 rgba(255,210,140,0.06)' }}
              >
                <span className="block w-2.5 h-2.5 rounded-full" style={{ background: '#ff5026', boxShadow: '0 0 6px #ff5026' }} />
              </button>
            </div>
          )}
        </div>

        {/* in-cabinet mini audio control — also visible when the TV is
            fullscreen, since the audio panel itself lives outside the
            fullscreen element. Drives the same shared audio store. */}
        <CabinetAudioBar />

        {/* bottom rail — left: model badge.  Right: a single decorative
            row of indicator LEDs.  We dropped the fake button strip
            entirely; if a control isn't wired up, it shouldn't claim
            to be one. */}
        <div className="mt-2 flex items-center gap-2 sm:gap-3">
          <span className="text-[9px] tracking-[0.3em] uppercase font-typewriter text-[#f3e9c0]/55">
            ★ TC-21 · TRINITRON STYLE COLOR
          </span>
          <div className="flex-1 flex items-center justify-end gap-2">
            <span className="text-[8px] tracking-[0.22em] uppercase font-typewriter text-[#f3e9c0]/45">SIGNAL</span>
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="w-1.5 h-3"
                style={{
                  background: i < 4 ? '#7be57b' : '#3a3a3a',
                  boxShadow: i < 4 ? '0 0 4px #7be57b' : 'none',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* base / pedestal — sells the "fat back" depth */}
      <div
        className="mx-auto h-2"
        style={{
          width: '88%',
          background: 'linear-gradient(180deg, #1a120a 0%, #050302 100%)',
          borderBottomLeftRadius: 6,
          borderBottomRightRadius: 6,
          boxShadow: '0 14px 24px rgba(0,0,0,0.7)',
        }}
      />
    </div>
  );
}

/* NYC local hour, used by the dead-hours card and by reactive fauna.
   Rough check (Math.abs offset minus -240 → ~America/New_York, ignoring DST
   nuance — close enough for "is it the middle of the night"). */
function useNycHour() {
  const [h, setH] = useState(() => nycHourNow());
  useEffect(() => {
    const i = setInterval(() => setH(nycHourNow()), 60_000);
    return () => clearInterval(i);
  }, []);
  return h;
}
function nycHourNow(): number {
  // Use Intl to get NYC hour reliably regardless of viewer locale.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  });
  return parseInt(fmt.format(new Date()), 10) || 0;
}

/* In-cabinet audio bar. Same controls as the corner panel but always
   visible inside the TV chassis, so the radio/ambience can be driven
   even when the TV is fullscreened (the corner panel is outside the
   fullscreen element and therefore hidden). */
function CabinetAudioBar() {
  const { src, vol, playing, error } = useAudio();
  const label = nowPlayingLabel(src);
  const station = src?.kind === 'radio' ? STATIONS.find((s) => s.id === src.stationId) : null;
  const idx = station ? STATIONS.findIndex((s) => s.id === station.id) : -1;
  const cycleStation = (delta: number) => {
    if (!STATIONS.length) return;
    const next = STATIONS[((idx === -1 ? 0 : idx) + delta + STATIONS.length) % STATIONS.length];
    audioTuneRadio(next);
  };
  return (
    <div
      className="mt-3 px-2 py-1.5 flex items-center gap-2 border border-[#f3e9c0]/15"
      style={{
        background: 'linear-gradient(180deg,#0a0805 0%,#1a1006 100%)',
        boxShadow: 'inset 0 1px 0 rgba(255,210,140,0.06)',
      }}
      role="group"
      aria-label="In-cabinet audio control"
    >
      <Radio className="w-3 h-3 text-[#FFD600] shrink-0" aria-hidden />
      <button
        type="button"
        onClick={() => cycleStation(-1)}
        className="text-[#f3e9c0]/75 hover:text-[#FFD600] text-[12px] font-mono shrink-0 px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        aria-label="Previous station"
        title="Previous station"
      >
        ◀
      </button>
      <button
        type="button"
        onClick={() => {
          if (src) audioToggle();
          else audioTuneRadio(STATIONS[2]); // default to WBGO
        }}
        className="text-[#FFD600] hover:text-white shrink-0 grid place-items-center w-5 h-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        aria-label={playing ? 'Pause audio' : 'Play audio'}
        title={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="w-3 h-3" aria-hidden /> : <Play className="w-3 h-3" aria-hidden />}
      </button>
      <button
        type="button"
        onClick={() => cycleStation(1)}
        className="text-[#f3e9c0]/75 hover:text-[#FFD600] text-[12px] font-mono shrink-0 px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        aria-label="Next station"
        title="Next station"
      >
        ▶
      </button>
      <span
        className="font-typewriter text-[9px] uppercase tracking-[0.18em] truncate flex-1 min-w-0"
        style={{ color: error ? '#ff8a9a' : '#f3e9c0' }}
        aria-live="polite"
      >
        {error ? error : label ?? 'audio off'}
      </span>
      <label className="flex items-center gap-1 shrink-0">
        <span className="sr-only">Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={vol}
          onChange={(e) => audioSetVol(parseFloat(e.target.value))}
          className="w-16 accent-[#FFD600]"
          aria-label="Volume"
        />
      </label>
      {src && (
        <button
          type="button"
          onClick={audioOff}
          className="text-[#f3e9c0]/55 hover:text-white text-[8px] tracking-[0.18em] shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          aria-label="Stop audio"
          title="Stop"
        >
          OFF
        </button>
      )}
    </div>
  );
}

/* Dead-hours late-night idle screen — runs 2am-5am NYC. The actual
   cameras are mostly empty intersections at that hour, so we lean
   into it: a stylized "WE'LL BE RIGHT BACK" cable-access card. */
export function DeadHoursCard({ large }: { large?: boolean }) {
  const minH = large ? 380 : 260;
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  const stamp = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(t);
  return (
    <div
      className="relative w-full overflow-hidden grid place-items-center text-center"
      style={{
        minHeight: minH,
        aspectRatio: '16 / 9',
        background: 'repeating-linear-gradient(0deg, #0a0a18 0px, #0a0a18 2px, #060611 2px, #060611 4px)',
      }}
    >
      <div className="px-6">
        <div className="font-bungee text-[#FFD600] tracking-[0.04em] uppercase" style={{ fontSize: large ? 44 : 30, lineHeight: 1, textShadow: '3px 3px 0 #d11a2a, 0 0 18px #FFD60055' }}>
          We&apos;ll Be Right Back
        </div>
        <div className="mt-3 font-typewriter text-[11px] uppercase tracking-[0.32em] text-white/65">
          ★ NYC dead-hours · {stamp} et ★
        </div>
        <div className="mt-2 font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/35 max-w-[460px] mx-auto">
          streets are empty · only cabs and ghosts · we&apos;ll resume regular programming around 5 a.m.
        </div>
        <div className="mt-4 flex justify-center gap-2 text-[#FFD600]/85">
          {['◉', '◉', '◉', '◉'].map((d, i) => (
            <span key={i} className="text-[18px]" style={{ animation: `dead-hours-blink 2.4s ${i * 0.4}s ease-in-out infinite` }}>{d}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* Chyron title that scrolls when the camera name overflows the box —
   so "CROSS ISLAND PKWY @ THROGS NECK BR ENTRANCE" reads end-to-end
   instead of being chopped at "THROGSNE...". Short titles render
   normally; long ones use a slow marquee. */
function ChyronTitle({ title, large }: { title: string; large?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const measure = () => {
      const c = ref.current, s = innerRef.current;
      if (!c || !s) return;
      setOverflow(s.scrollWidth > c.clientWidth + 4);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [title]);
  return (
    <div
      ref={ref}
      className={`font-tabloid leading-tight uppercase mt-0.5 overflow-hidden ${large ? 'text-[28px]' : 'text-[22px]'}`}
    >
      {overflow ? (
        <div className="inline-block whitespace-nowrap" style={{ animation: 'chyron-scroll 18s linear infinite' }}>
          <span ref={innerRef} className="pr-12">{title}</span>
          <span aria-hidden className="pr-12">{title}</span>
        </div>
      ) : (
        <span ref={innerRef} className="block whitespace-nowrap">{title}</span>
      )}
    </div>
  );
}

/* perforated speaker grille — flanks the screen on the wide cabinet */
function SpeakerGrille() {
  return (
    <div
      className="hidden sm:block w-[44px] md:w-[64px] shrink-0 self-stretch relative rounded-[14px]"
      style={{
        background:
          'radial-gradient(circle at 50% 30%, #2a1d10 0%, #14100a 60%, #050302 100%)',
        border: '1px solid #0c0703',
        boxShadow: 'inset 0 1px 0 rgba(255,210,140,0.08), inset 0 -2px 4px rgba(0,0,0,0.85)',
        backgroundImage:
          'radial-gradient(circle, rgba(0,0,0,0.85) 1.4px, transparent 1.6px)',
        backgroundSize: '8px 8px',
        backgroundPosition: '4px 4px',
      }}
      aria-hidden
    />
  );
}

/* one of the right-side knob dials. Uses a faux-3D radial gradient. */
function KnobDial({
  label,
  value,
  digit,
  small,
}: {
  label: string;
  value?: string;
  digit?: boolean;
  small?: boolean;
}) {
  const sz = small ? 30 : 44;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        style={{
          width: sz,
          height: sz,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 28%, #efe2bd 0%, #b89968 22%, #5b401d 60%, #2a1c0a 100%)',
          boxShadow:
            'inset 0 -3px 6px rgba(0,0,0,0.7), inset 0 2px 3px rgba(255,235,180,0.45), 0 1px 0 rgba(0,0,0,0.6)',
          position: 'relative',
        }}
      >
        {digit && value ? (
          <span
            className="absolute inset-0 grid place-items-center font-crt text-[14px] text-[#FFD600]"
            style={{ textShadow: '0 0 6px #FFD600cc' }}
          >
            {value}
          </span>
        ) : (
          <span
            className="absolute"
            style={{
              top: 3,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 2,
              height: small ? 8 : 12,
              background: '#0a0703',
              borderRadius: 1,
            }}
          />
        )}
      </div>
      <span className="text-[8px] tracking-[0.18em] uppercase font-typewriter text-[#f3e9c0]/70">
        {label}
      </span>
      {!digit && value && (
        <span className="text-[8px] tabular text-[#ff8a3a]/85" style={{ letterSpacing: 1 }}>{value}</span>
      )}
    </div>
  );
}

/* Double-buffered cam frame: never collapses between ticks.
   Two stacked <img>s, swap once the next finishes loading; on camera
   change we hard-reset the front layer so we never show the previous
   camera's last frame stretched into a new aspect ratio. */
function SmoothCamFrame({
  cameraId,
  tick,
  liveSource,
  alt,
  minHeight,
}: {
  cameraId: string;
  tick: number;
  liveSource: 'nyctmc' | 'backend';
  alt: string;
  minHeight: number;
}) {
  const buildSrc = (t: number) =>
    liveSource === 'nyctmc'
      ? NYCTMC_IMG(cameraId, t)
      : apiUrl(`/api/cameras/${cameraId}/snapshot.jpg?t=${t}`);

  const [front, setFront] = useState<string>(() => buildSrc(tick));
  const [back, setBack] = useState<string | null>(null);

  // On camera change: blow away both buffers and start fresh.
  useEffect(() => {
    setFront(buildSrc(tick));
    setBack(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);

  // On tick change: stage the new frame in the back buffer; promote it
  // to front only when it has decoded.
  useEffect(() => {
    const next = buildSrc(tick);
    if (next === front) return;
    setBack(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, cameraId]);

  return (
    <div
      className="relative w-full bg-black overflow-hidden"
      style={{ minHeight, aspectRatio: '16 / 9' }}
    >
      <img
        src={front}
        alt={alt}
        referrerPolicy="no-referrer"
        decoding="async"
        className="absolute inset-0 w-full h-full object-cover block"
      />
      {back && (
        <img
          src={back}
          alt=""
          aria-hidden
          referrerPolicy="no-referrer"
          decoding="async"
          className="absolute inset-0 w-full h-full object-cover block opacity-0"
          onLoad={() => {
            setFront(back);
            setBack(null);
          }}
          onError={() => setBack(null)}
        />
      )}
    </div>
  );
}

export function CornerGuides({ large }: { large?: boolean }) {
  const sz = large ? 'w-5 h-5' : 'w-4 h-4';
  return (
    <>
      <span className={`absolute top-2 left-2 border-t border-l border-[#FFD600]/80 ${sz}`} />
      <span className={`absolute top-2 right-2 border-t border-r border-[#FFD600]/80 ${sz}`} />
      <span className={`absolute bottom-12 left-2 border-b border-l border-[#FFD600]/80 ${sz}`} />
      <span className={`absolute bottom-12 right-2 border-b border-r border-[#FFD600]/80 ${sz}`} />
    </>
  );
}

export function KnobChannel({ value }: { value: number }) {
  return (
    <div className="channel-digit text-2xl leading-none px-2 py-0.5 min-w-[44px] text-center font-crt">
      {String(value).padStart(2, '0')}
    </div>
  );
}

/* ────────────────────────────────────────────────── BodegaAwning
   The shared header strip across all pages. */

export function BodegaAwning({ rightSlot }: { rightSlot?: ReactNode }) {
  const weather = useNycWeather();
  return (
    <div className="relative shrink-0">
      <div className="metrocard-tape h-1.5" />

      {/* light-bulb marquee strip — slow soft pulse, not a strobe */}
      <div className="bg-[#0a0a0a] h-3 flex items-center justify-around overflow-hidden">
        {Array.from({ length: 40 }).map((_, i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-[#FFD600]"
            style={{
              boxShadow: '0 0 4px #FFD600, 0 0 9px #FFD60088',
              animation: `bulb-chase 4.2s ease-in-out infinite`,
              animationDelay: `${(i % 8) * 0.55}s`,
              opacity: 0.85,
            }}
          />
        ))}
      </div>

      <div
        className="bg-[#1B5E20] text-white px-3 sm:px-4 pt-1.5 pb-2 flex items-center gap-3 sm:gap-4 border-b-2 border-[#FFD600] relative"
        style={{ boxShadow: '0 4px 0 #0F3812, inset 0 -1px 0 rgba(0,0,0,0.4)' }}
      >
        <a href="/" className="font-bungee uppercase tracking-[0.06em] text-[16px] sm:text-[22px] leading-none whitespace-nowrap hover:text-[#FFD600] transition-colors">
          NYC <span className="text-[#FFD600] flicker">★</span> TRAFFIC <span className="text-[#FFD600]">CAM</span>{' '}
          <span className="text-white riso">CO.</span>
        </a>

        <span className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 border border-[#ff5582] text-[#ff5582] font-bungee text-[10px] uppercase tracking-[0.18em] neon">
          OPEN · 24 / 7
        </span>

        <span className="ml-auto flex items-center gap-3 sm:gap-4 justify-end">
          {weather && (
            <a
              href="/about"
              className="font-typewriter text-[10px] tracking-[0.18em] uppercase text-white/85 hover:text-[#FFD600] flex items-center gap-1"
              title="NYC right now"
            >
              <span>{weather.icon}</span>
              <span>{weather.temp}</span>
              <span className="hidden lg:inline text-white/55">{weather.cond}</span>
            </a>
          )}
          <span className="hidden sm:inline font-typewriter text-[10px] tracking-[0.2em] uppercase text-[#FFD600]">
            NYC · {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          {rightSlot}
        </span>
      </div>

      <div
        className="h-3"
        style={{
          background:
            'radial-gradient(circle at 10px 0, transparent 7px, #1B5E20 7.5px) repeat-x',
          backgroundSize: '20px 12px',
          backgroundPositionY: '0',
        }}
      />
    </div>
  );
}

/* ────────────────────────────────────────────────── StreetFauna */

export function StreetFauna({ ratMode = false, motion = false }: { ratMode?: boolean; motion?: boolean }) {
  // The rat is always around — it is a NYC bodega; there is always a rat.
  // Other moving fauna (cab, pigeon, hot-dog cart…) is opt-in via `motion`
  // so the page doesn't read like a busy screensaver. Rat mode (Konami)
  // turns on the whole moving strip plus rat reinforcements.
  const showMotion = motion || ratMode;
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 overflow-hidden h-[40px]">
        <Rat />
        {ratMode && <Rat seedOffset={1} />}
        {ratMode && <Rat seedOffset={2} />}
        {ratMode && <Rat seedOffset={3} />}
      </div>
      {showMotion && (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 overflow-hidden h-[140px]">
          <YellowCab />
          <Pigeon />
          <SubwayCar />
          <HotDogCart />
          <PretzelCart />
          <NewspaperFlying />
          <ManholeSteam left="22%" delay="2s" />
          <ManholeSteam left="71%" delay="11s" />
          <DeliveryScooter />
          <DollarBlowing />
        </div>
      )}
      {/* Ambient layer — always on, very rare cadence so the page feels
          alive without becoming a busy screensaver. Each piece spawns
          on its own (long) timer and removes itself on animation end. */}
      <AmbientSky />
      {ratMode && <FlyingPizza />}
      <FireHydrant />
      <SodiumStreetLamp />
      <StatueOfLiberty />
      <BodegaCat />
    </>
  );
}

/* AmbientSky: very-occasional set-pieces that drift in the EMPTY sky
   areas of the page — outside the centered content column. Each lives
   in a `pointer-events-none` layer at z:0 so even at peak motion they
   never block clicks or sit over the TV.

   Pieces are clipped to specific bands:
     - pigeons  → top 14vh, never enters the content band
     - pizza    → top 14vh, same arc band as the pigeons
     - balloon  → right side rail (or left rail), rises straight up

   The full-viewport TickerTape was pulled — overlapped controls. */
function AmbientSky() {
  return (
    <>
      {/* sky band — top 14vh of viewport, ambient gliders only */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-0 overflow-hidden" style={{ height: '14vh' }}>
        <RareDrifter intervalMs={[200_000, 400_000]} render={(k) => <PizzaArc key={k} />} />
        <RareDrifter intervalMs={[180_000, 360_000]} render={(k) => <PigeonFlock key={k} />} />
      </div>
      {/* right rail — narrow vertical slot for balloon escapes; only
          shows on lg+ screens where there's room outside the 1400px
          content column for the balloon to rise without crossing the UI */}
      <div
        className="pointer-events-none fixed top-0 bottom-0 z-0 overflow-hidden hidden lg:block"
        style={{ right: 0, width: 'max(60px, calc((100vw - 1400px) / 2))' }}
      >
        <RareDrifter intervalMs={[120_000, 240_000]} render={(k) => <RailBalloon key={k} />} />
      </div>
    </>
  );
}

function RareDrifter({
  intervalMs,
  render,
  initialDelayMs = 8_000,
}: {
  intervalMs: [number, number];
  render: (key: number) => React.ReactNode;
  initialDelayMs?: number;
}) {
  // Mounts a child once, lets its CSS animation play out, then waits a
  // random gap before remounting. Each mount uses a fresh key so the
  // browser starts the keyframes from 0 every time.
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = intervalMs[0] + Math.random() * (intervalMs[1] - intervalMs[0]);
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    setTimeout(() => { if (!stop) setSeed((s) => s + 1); }, initialDelayMs);
    tick();
    return () => { stop = true; };
  }, [intervalMs, initialDelayMs]);
  if (seed === 0) return null;
  return <>{render(seed)}</>;
}

function Rat({ seedOffset = 0 }: { seedOffset?: number }) {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 25_000 + Math.random() * 50_000 + seedOffset * 4_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, [seedOffset]);
  const duration = 3 + ((seed * 37 + seedOffset * 11) % 20) / 10;
  return (
    <div key={seed} className="absolute bottom-2 will-change-transform" style={{ animation: `rat-run ${duration}s linear` }}>
      <svg viewBox="0 0 70 26" width="56" height="20" aria-hidden>
        <path
          d="M 42 18 Q 56 8, 68 18"
          stroke="#1a0f0a"
          strokeWidth="1.6"
          fill="none"
          strokeLinecap="round"
          style={{ transformOrigin: '42px 18px', animation: 'rat-tail 0.18s ease-in-out infinite' }}
        />
        <ellipse cx="22" cy="18" rx="18" ry="6.5" fill="#1a0f0a" />
        <ellipse cx="6" cy="16" rx="6" ry="5" fill="#1a0f0a" />
        <circle cx="6" cy="11" r="2" fill="#2a1810" />
        <circle cx="3.5" cy="15.5" r="0.6" fill="#ff3b3b" />
        <rect x="14" y="22" width="2" height="4" fill="#1a0f0a" />
        <rect x="22" y="22" width="2" height="4" fill="#1a0f0a" />
        <rect x="30" y="22" width="2" height="4" fill="#1a0f0a" />
      </svg>
    </div>
  );
}

function YellowCab() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 60_000 + Math.random() * 120_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div key={`cab-${seed}`} className="absolute bottom-7 will-change-transform" style={{ animation: 'cab-drive 9s linear' }}>
      <svg viewBox="0 0 130 40" width="120" height="34" aria-hidden>
        <ellipse cx="65" cy="38" rx="55" ry="2" fill="rgba(0,0,0,0.45)" />
        <path d="M 8 26 L 22 12 L 90 12 L 110 22 L 122 22 L 122 30 L 8 30 Z" fill="#FAB80F" stroke="#1a1a1a" strokeWidth="1.2" />
        <path d="M 28 14 L 50 14 L 50 24 L 22 24 Z" fill="#0a1830" opacity="0.9" />
        <path d="M 54 14 L 86 14 L 96 22 L 54 22 Z" fill="#0a1830" opacity="0.9" />
        <rect x="48" y="6" width="20" height="6" rx="1" fill="#1a1a1a" />
        <text x="58" y="11" textAnchor="middle" fontSize="4.5" fontFamily="Anton, Impact, sans-serif" fill="#FAB80F">TAXI</text>
        <g transform="translate(54 24)">
          {Array.from({ length: 6 }).map((_, i) => (
            <rect key={i} x={i * 5} y={-2} width="5" height="4" fill={i % 2 ? '#1a1a1a' : '#FAB80F'} />
          ))}
        </g>
        <circle cx="32" cy="32" r="6" fill="#1a1a1a" />
        <circle cx="32" cy="32" r="2.2" fill="#666" />
        <circle cx="100" cy="32" r="6" fill="#1a1a1a" />
        <circle cx="100" cy="32" r="2.2" fill="#666" />
      </svg>
    </div>
  );
}

function Pigeon() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 40_000 + Math.random() * 60_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div
      key={`pigeon-${seed}`}
      className="absolute will-change-transform"
      style={{ bottom: 90, animation: 'pigeon-fly 7s linear' }}
    >
      <svg viewBox="0 0 40 20" width="36" height="18" aria-hidden>
        <ellipse cx="22" cy="12" rx="10" ry="4" fill="#404f63" />
        <ellipse cx="10" cy="11" rx="5" ry="3.5" fill="#3a4658" />
        <circle cx="6" cy="11" r="0.8" fill="#ff8c1a" />
        {/* wings — flapping */}
        <path
          d="M 18 8 Q 22 0, 28 4 Q 24 7, 22 11 Z"
          fill="#5a6878"
          style={{ transformOrigin: '22px 11px', animation: 'wing-flap 0.18s ease-in-out infinite' }}
        />
        <path d="M 28 12 L 36 14 L 28 14 Z" fill="#404f63" />
      </svg>
    </div>
  );
}

function ManholeSteam({ left, delay }: { left: string; delay: string }) {
  return (
    <div className="absolute bottom-1 w-12 h-20" style={{ left }} aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute bottom-0 left-1/2 w-8 h-12 rounded-full"
          style={{
            background: 'radial-gradient(ellipse at center, rgba(220,225,235,0.55), rgba(220,225,235,0))',
            transform: `translateX(-50%)`,
            animation: `steam-drift ${5 + i}s ease-out infinite`,
            animationDelay: `calc(${delay} + ${i * 1.4}s)`,
          }}
        />
      ))}
    </div>
  );
}

/* ────────── More street creatures ────────── */

function HotDogCart() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 90_000 + Math.random() * 150_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div key={`dog-${seed}`} className="absolute bottom-3 will-change-transform" style={{ animation: 'cab-drive 14s linear' }}>
      <svg viewBox="0 0 130 110" width="110" height="92" aria-hidden>
        {/* shadow */}
        <ellipse cx="65" cy="106" rx="50" ry="2" fill="rgba(0,0,0,0.4)" />
        {/* umbrella pole */}
        <rect x="64" y="34" width="2.5" height="44" fill="#1a1a1a" />
        {/* umbrella canopy — Sabrett yellow with red trim */}
        <path d="M 16 36 Q 65 -2, 114 36 Z" fill="#FFD600" />
        <path d="M 16 36 Q 65 8, 114 36" stroke="#d11a2a" strokeWidth="2.5" fill="none" />
        {/* umbrella flap shadows */}
        <g stroke="#1a1a1a" strokeWidth="0.6" opacity="0.4">
          <path d="M 28 33 Q 28 8, 65 4" fill="none"/>
          <path d="M 102 33 Q 102 8, 65 4" fill="none"/>
        </g>
        {/* "SABRETT" arch text */}
        <text x="65" y="22" textAnchor="middle" fontSize="6" fontFamily="Anton, Impact, sans-serif" fill="#0039A6" letterSpacing="1">SABRETT</text>
        {/* cart body */}
        <rect x="22" y="78" width="86" height="22" rx="2" fill="#e6e8ec" stroke="#1a1a1a" strokeWidth="1" />
        {/* cart panels */}
        <rect x="26" y="82" width="22" height="14" fill="#FFD600" stroke="#1a1a1a" />
        <rect x="52" y="82" width="22" height="14" fill="#d11a2a" stroke="#1a1a1a" />
        <rect x="78" y="82" width="26" height="14" fill="#0039A6" stroke="#1a1a1a" />
        <text x="89" y="92" textAnchor="middle" fontSize="5" fontFamily="Anton, Impact, sans-serif" fill="#FFD600" letterSpacing="0.4">$3</text>
        {/* steam from one chamber */}
        <g opacity="0.45">
          <ellipse cx="36" cy="76" rx="3" ry="2" fill="#fff"/>
          <ellipse cx="62" cy="74" rx="3.5" ry="2.2" fill="#fff"/>
        </g>
        {/* wheels */}
        <circle cx="34" cy="100" r="5" fill="#1a1a1a" />
        <circle cx="34" cy="100" r="1.8" fill="#666" />
        <circle cx="96" cy="100" r="5" fill="#1a1a1a" />
        <circle cx="96" cy="100" r="1.8" fill="#666" />
      </svg>
    </div>
  );
}

function PretzelCart() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 110_000 + Math.random() * 180_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div key={`pretz-${seed}`} className="absolute bottom-3 will-change-transform" style={{ animation: 'cab-drive 16s linear' }}>
      <svg viewBox="0 0 110 100" width="92" height="84" aria-hidden>
        <ellipse cx="55" cy="96" rx="42" ry="2" fill="rgba(0,0,0,0.4)" />
        {/* glass display case */}
        <rect x="14" y="34" width="82" height="38" fill="rgba(255,255,255,0.18)" stroke="#666" strokeWidth="1" />
        {/* pretzels (3 in a row) */}
        {[24, 44, 64].map((x, i) => (
          <g key={i} transform={`translate(${x} 50)`}>
            <circle cx="0" cy="0" r="6" fill="none" stroke="#a86a2a" strokeWidth="2.2" />
            <path d="M -4 -3 Q 0 -7, 4 -3 M -2 0 L 2 0" stroke="#a86a2a" strokeWidth="2" fill="none" strokeLinecap="round" />
          </g>
        ))}
        <text x="84" y="50" textAnchor="middle" fontSize="6" fontFamily="Anton, Impact, sans-serif" fill="#a86a2a">$2</text>
        {/* base */}
        <rect x="10" y="72" width="90" height="20" rx="2" fill="#FFD600" stroke="#1a1a1a" />
        <text x="55" y="86" textAnchor="middle" fontSize="6" fontFamily="Anton, Impact, sans-serif" fill="#1a1a1a" letterSpacing="0.6">PRETZELS</text>
        {/* wheels */}
        <circle cx="22" cy="92" r="5" fill="#1a1a1a" />
        <circle cx="22" cy="92" r="1.8" fill="#666" />
        <circle cx="88" cy="92" r="5" fill="#1a1a1a" />
        <circle cx="88" cy="92" r="1.8" fill="#666" />
      </svg>
    </div>
  );
}

function SubwayCar() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 75_000 + Math.random() * 90_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div key={`sub-${seed}`} className="absolute will-change-transform" style={{ bottom: 0, animation: 'cab-drive 7s linear' }}>
      <svg viewBox="0 0 240 60" width="220" height="55" aria-hidden>
        {/* track */}
        <rect x="0" y="56" width="240" height="2" fill="#3a3a40" />
        {/* shadow */}
        <ellipse cx="120" cy="55" rx="100" ry="1.5" fill="rgba(0,0,0,0.55)" />
        {/* car body — silver with red stripe */}
        <rect x="6" y="14" width="228" height="36" rx="4" fill="#cdd2d8" stroke="#1a1a1a" strokeWidth="1" />
        <rect x="6" y="22" width="228" height="3" fill="#EE352E" />
        <rect x="6" y="42" width="228" height="3" fill="#EE352E" />
        {/* windows */}
        {[20, 50, 80, 110, 140, 170, 200].map((x, i) => (
          <rect key={i} x={x} y="28" width="22" height="11" fill="#0a1830" stroke="#1a1a1a" strokeWidth="0.5" />
        ))}
        {/* doors (slimmer panels) */}
        <rect x="42" y="14" width="3" height="36" fill="#1a1a1a" />
        <rect x="132" y="14" width="3" height="36" fill="#1a1a1a" />
        <rect x="222" y="14" width="3" height="36" fill="#1a1a1a" />
        {/* line bullet on the front */}
        <circle cx="222" cy="20" r="6" fill="#0039A6" />
        <text x="222" y="23" textAnchor="middle" fontSize="7" fontFamily="Helvetica, Arial, sans-serif" fontWeight="800" fill="#fff">A</text>
        {/* headlight glow */}
        <circle cx="234" cy="32" r="3" fill="#FFD27A" opacity="0.85" />
      </svg>
    </div>
  );
}

function NewspaperFlying() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 100_000 + Math.random() * 200_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  // Pages from common NY tabloid front pages
  const headlines = [
    'FORD TO CITY: DROP DEAD',
    'HEADLESS BODY IN TOPLESS BAR',
    'WHO STOLE THE BAGEL?',
    'EXCLUSIVE: PIGEON SUMMIT',
    'RAT NAMED MAYOR',
  ];
  const headline = headlines[seed % headlines.length];
  return (
    <div
      key={`news-${seed}`}
      className="absolute will-change-transform"
      style={{ bottom: 70, animation: 'pigeon-fly 6s linear', transform: 'rotate(-12deg)' }}
    >
      <svg viewBox="0 0 80 60" width="64" height="48" aria-hidden>
        <rect x="2" y="2" width="76" height="56" fill="#f1ead8" stroke="#1a1a1a" strokeWidth="1" />
        <text x="40" y="14" textAnchor="middle" fontSize="6" fontFamily="Anton, Impact, sans-serif" fill="#d11a2a">{headline}</text>
        {/* fake columns */}
        {[20, 27, 34, 41, 48, 55].map((y, i) => (
          <rect key={i} x="6" y={y} width={i % 2 ? 30 : 68} height="1.2" fill="#888" />
        ))}
      </svg>
    </div>
  );
}

function FlyingPizza() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 120_000 + Math.random() * 240_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  if (seed === 0) return null;
  // tumbling slice from top-right diagonally to bottom-left
  return (
    <div
      key={`pizza-${seed}`}
      className="pointer-events-none fixed z-30"
      style={{
        right: '-80px',
        top: '8%',
        animation: 'pizza-tumble 4s ease-in forwards',
      }}
    >
      <svg viewBox="0 0 80 80" width="64" height="64" aria-hidden>
        {/* slice */}
        <path d="M 8 8 L 72 8 L 40 76 Z" fill="#f7c66a" stroke="#a86a2a" strokeWidth="1.2" />
        {/* crust at top */}
        <path d="M 8 8 L 72 8 L 70 14 L 10 14 Z" fill="#d09c4f" />
        {/* sauce wash */}
        <path d="M 12 14 L 68 14 L 42 70 Z" fill="#d11a2a" opacity="0.7" />
        {/* cheese melt */}
        <path d="M 14 18 L 66 18 L 42 64 Z" fill="#fff8c2" opacity="0.6" />
        {/* pepperoni */}
        <circle cx="28" cy="28" r="4" fill="#a32424" />
        <circle cx="50" cy="28" r="4" fill="#a32424" />
        <circle cx="38" cy="46" r="4" fill="#a32424" />
        <circle cx="30" cy="54" r="3" fill="#a32424" />
      </svg>
    </div>
  );
}

function FireHydrant() {
  // Fixed in the bottom-left, occasional water spurt
  const [spurt, setSpurt] = useState(false);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 60_000 + Math.random() * 120_000;
      setTimeout(() => {
        if (stop) return;
        setSpurt(true);
        setTimeout(() => setSpurt(false), 3500);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div className="pointer-events-none fixed left-3 bottom-1 z-10 hidden md:block" aria-hidden>
      <svg viewBox="0 0 40 70" width="38" height="64">
        {/* base */}
        <rect x="6" y="58" width="28" height="6" fill="#7a141d" />
        {/* body */}
        <rect x="10" y="22" width="20" height="38" rx="3" fill="#a32424" stroke="#1a1a1a" strokeWidth="1" />
        {/* top cap */}
        <rect x="8" y="14" width="24" height="10" rx="2" fill="#8a1c20" stroke="#1a1a1a" />
        {/* cap top */}
        <rect x="14" y="6" width="12" height="10" rx="2" fill="#7a141d" />
        {/* side nozzle */}
        <circle cx="32" cy="34" r="5" fill="#7a141d" stroke="#1a1a1a" />
        <circle cx="32" cy="34" r="2" fill="#1a1a1a" />
        {/* chains/bolts */}
        <circle cx="20" cy="32" r="1.2" fill="#1a1a1a" />
        <circle cx="20" cy="44" r="1.2" fill="#1a1a1a" />
      </svg>
      {spurt && (
        <div className="absolute left-[34px] bottom-[28px] pointer-events-none">
          {Array.from({ length: 10 }).map((_, i) => (
            <span
              key={i}
              className="absolute w-1.5 h-1.5 rounded-full bg-blue-200"
              style={{
                left: i * 4,
                top: -i * 2,
                opacity: 1 - i * 0.08,
                animation: 'cab-drive 1.5s ease-out',
                animationDelay: `${i * 0.05}s`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SodiumStreetLamp() {
  // Tall amber-glow street lamp on the left edge, fixed
  return (
    <div className="pointer-events-none fixed left-2 bottom-16 z-0 hidden lg:block" aria-hidden>
      <svg viewBox="0 0 60 260" width="50" height="220">
        {/* post */}
        <rect x="27" y="40" width="6" height="220" fill="#1a1a1a" />
        {/* arm */}
        <path d="M 30 40 Q 30 22, 18 18" stroke="#1a1a1a" strokeWidth="6" fill="none" />
        {/* lamp head */}
        <ellipse cx="14" cy="22" rx="11" ry="6" fill="#1a1a1a" />
        <ellipse cx="14" cy="24" rx="9" ry="4" fill="#FFB347" opacity="0.95" />
        {/* glow */}
        <circle cx="14" cy="24" r="36" fill="#FFB347" opacity="0.18" />
        <circle cx="14" cy="24" r="22" fill="#FFB347" opacity="0.32" />
      </svg>
    </div>
  );
}

function StatueOfLiberty() {
  // Tiny silhouette in a top corner — Easter egg
  return (
    <div className="pointer-events-none fixed left-3 top-32 z-10 hidden xl:block opacity-50" aria-hidden>
      <svg viewBox="0 0 60 110" width="42" height="80">
        {/* island base */}
        <rect x="0" y="100" width="60" height="10" fill="#1a3a2a" />
        {/* pedestal */}
        <rect x="20" y="78" width="20" height="22" fill="#7a857a" />
        {/* body */}
        <path d="M 24 78 L 36 78 L 38 50 L 22 50 Z" fill="#8fbf9a" />
        {/* head */}
        <circle cx="30" cy="42" r="5" fill="#8fbf9a" />
        {/* crown spikes */}
        {[-8, -5, -2, 1, 4, 7].map((dx, i) => (
          <line key={i} x1={30 + dx} y1="38" x2={30 + dx * 1.2} y2="32" stroke="#8fbf9a" strokeWidth="1.2" />
        ))}
        {/* arm holding torch */}
        <path d="M 36 56 L 50 36 L 52 30" stroke="#8fbf9a" strokeWidth="3" fill="none" strokeLinecap="round" />
        {/* flame */}
        <path d="M 49 28 Q 52 22 55 28 Q 53 24 51 26 Z" fill="#FFD600" />
        <circle cx="52" cy="27" r="3" fill="#FFD600" opacity="0.4" />
        {/* book in left hand */}
        <rect x="18" y="62" width="6" height="4" fill="#8fbf9a" />
      </svg>
    </div>
  );
}

function BodegaCat() {
  // Reactive: night cat sleeps with Zs · daytime cat sits up alert ·
  // around feeding time (8am, 6pm) the cat is gone (out for tuna).
  const hour = useNycHour();
  const sleeping = hour >= 22 || hour < 7;
  const feeding  = hour === 8 || hour === 18;

  if (feeding) {
    return (
      <div className="pointer-events-none fixed left-12 bottom-2 z-10 hidden md:block font-typewriter text-[9px] uppercase tracking-[0.18em] text-white/40" aria-hidden>
        ⌒ cat is gone — feeding time ⌒
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed left-12 bottom-2 z-10 hidden md:block" aria-hidden>
      <svg viewBox="0 0 80 40" width="64" height="32">
        <ellipse cx="40" cy="38" rx="34" ry="2" fill="rgba(0,0,0,0.4)" />
        {sleeping ? (
          <>
            {/* curled body */}
            <ellipse cx="40" cy="26" rx="32" ry="12" fill="#3a2818" />
            <ellipse cx="62" cy="22" rx="9" ry="8" fill="#3a2818" />
            <path d="M 56 16 L 58 12 L 60 16 M 65 14 L 67 11 L 69 16" stroke="#3a2818" strokeWidth="1.5" fill="#3a2818" />
            <path d="M 14 28 Q 4 22, 12 14 Q 18 10, 24 14" stroke="#3a2818" strokeWidth="6" fill="none" strokeLinecap="round" />
            <text x="50" y="6" fontSize="10" fontFamily="Bungee, Impact, sans-serif" fill="#999" opacity="0.6">z</text>
            <text x="58" y="2" fontSize="6" fontFamily="Bungee, Impact, sans-serif" fill="#999" opacity="0.4">z</text>
          </>
        ) : (
          <>
            {/* sitting up — alert daytime pose */}
            <ellipse cx="44" cy="32" rx="14" ry="6" fill="#3a2818" />
            <rect x="36" y="18" width="16" height="14" rx="3" fill="#3a2818" />
            <circle cx="44" cy="14" r="7" fill="#3a2818" />
            <path d="M 38 9 L 40 4 L 42 10 M 46 10 L 48 4 L 50 9" stroke="#3a2818" strokeWidth="1.6" fill="#3a2818" />
            <circle cx="42" cy="13" r="0.9" fill="#fff" />
            <circle cx="46" cy="13" r="0.9" fill="#fff" />
            {/* tail flicked */}
            <path d="M 56 30 Q 66 22, 60 14" stroke="#3a2818" strokeWidth="5" fill="none" strokeLinecap="round" />
          </>
        )}
      </svg>
    </div>
  );
}


/* ──────────────────────────────────────── new ambient set-pieces */

/* DeliveryScooter — orange Vespa-ish scooter with a delivery box on
   the back. Zips along the bottom faster than the cab. */
function DeliveryScooter() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 80_000 + Math.random() * 140_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  return (
    <div key={`scoot-${seed}`} className="absolute bottom-5 will-change-transform" style={{ animation: 'scooter-zip 6s linear' }}>
      <svg viewBox="0 0 110 50" width="92" height="42" aria-hidden>
        <ellipse cx="55" cy="46" rx="42" ry="2" fill="rgba(0,0,0,0.45)" />
        {/* delivery box */}
        <rect x="14" y="6" width="22" height="20" rx="2" fill="#FF6319" stroke="#1a1a1a" strokeWidth="1" />
        <rect x="16" y="9" width="18" height="3" fill="#FFD600" />
        <text x="25" y="22" textAnchor="middle" fontSize="6" fontFamily="Bungee, Impact, sans-serif" fill="#fff">EATS</text>
        {/* body */}
        <path d="M 30 26 L 70 26 L 86 36 L 26 36 Z" fill="#d96412" stroke="#1a1a1a" strokeWidth="1" />
        {/* seat */}
        <rect x="38" y="22" width="22" height="6" rx="2" fill="#1a1a1a" />
        {/* handlebars */}
        <path d="M 78 16 L 92 16 M 92 16 L 92 30" stroke="#1a1a1a" strokeWidth="2" fill="none" strokeLinecap="round" />
        {/* headlight */}
        <circle cx="92" cy="32" r="3" fill="#FFD600" />
        {/* rider — silhouette */}
        <ellipse cx="62" cy="14" rx="6" ry="6" fill="#1a1a1a" />
        <path d="M 56 20 Q 62 8, 68 20 L 70 32 L 56 32 Z" fill="#1a1a1a" />
        <rect x="56" y="6" width="12" height="9" rx="2" fill="#FFD600" />
        {/* wheels */}
        <circle cx="32" cy="40" r="6" fill="#1a1a1a" />
        <circle cx="32" cy="40" r="2" fill="#666" />
        <circle cx="84" cy="40" r="6" fill="#1a1a1a" />
        <circle cx="84" cy="40" r="2" fill="#666" />
      </svg>
    </div>
  );
}

/* DollarBlowing — a $1 bill tumbling along the sidewalk. Slow drift,
   tumble rotation suggests the wind decided this. */
function DollarBlowing() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 50_000 + Math.random() * 100_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  const drift = ((seed * 41) % 24) - 12;
  return (
    <div
      key={`buck-${seed}`}
      className="absolute will-change-transform"
      style={{
        bottom: 14 + drift,
        animation: 'buck-blow 11s linear',
      }}
    >
      <svg viewBox="0 0 60 26" width="56" height="24" aria-hidden style={{ animation: 'buck-tumble 1.3s ease-in-out infinite' }}>
        <rect x="1" y="1" width="58" height="24" rx="1" fill="#9bb892" stroke="#3d5a35" strokeWidth="0.6" />
        <circle cx="30" cy="13" r="6" fill="#dde8d6" stroke="#3d5a35" strokeWidth="0.4" />
        <text x="30" y="16" textAnchor="middle" fontSize="7" fontFamily="serif" fill="#3d5a35" fontWeight="700">1</text>
        <text x="6" y="6" fontSize="3.5" fontFamily="serif" fill="#3d5a35">ONE</text>
        <text x="46" y="22" fontSize="3.5" fontFamily="serif" fill="#3d5a35">DOLLAR</text>
        <circle cx="6" cy="22" r="2" fill="none" stroke="#3d5a35" strokeWidth="0.4" />
        <circle cx="54" cy="6" r="2" fill="none" stroke="#3d5a35" strokeWidth="0.4" />
      </svg>
    </div>
  );
}

/* RailBalloon — single red balloon, rises straight up the right side
   rail. Stays inside its parent container so it never enters the
   centered content column. */
function RailBalloon() {
  return (
    <div
      className="absolute left-1/2 -translate-x-1/2 will-change-transform"
      style={{
        bottom: -90,
        animation: 'rail-balloon-rise 24s linear forwards',
      }}
      aria-hidden
    >
      <div style={{ animation: 'balloon-bob 3.4s ease-in-out infinite' }}>
        <svg viewBox="0 0 70 110" width="44" height="70">
          <path d="M 35 56 Q 38 80, 32 108" stroke="#1a1a1a" strokeWidth="0.6" fill="none" />
          <ellipse cx="35" cy="32" rx="26" ry="30" fill="#d11a2a" />
          <ellipse cx="24" cy="20" rx="6" ry="9" fill="#fff" opacity="0.5" />
          <path d="M 31 60 L 35 56 L 39 60 L 35 64 Z" fill="#9c0e1c" />
        </svg>
      </div>
    </div>
  );
}

/* PizzaArc — single slice flying left-to-right across the top sky band
   only. Stays in its parent's 14vh container so it never enters the
   content area. The "arc" is now a flat traverse (vertical motion is
   subtle bobbing) so it sits flush in the band. */
function PizzaArc() {
  const yPx = 8 + Math.random() * 30; // px from top of the 14vh band
  return (
    <div
      className="absolute will-change-transform"
      style={{
        left: -80,
        top: yPx,
        animation: 'pizza-skim 14s linear forwards',
      }}
      aria-hidden
    >
      <div style={{ animation: 'pizza-spin 2.6s linear infinite' }}>
        <svg viewBox="0 0 80 80" width="44" height="44">
          <path d="M 8 8 L 72 8 L 40 76 Z" fill="#f7c66a" stroke="#a86a2a" strokeWidth="1.2" />
          <path d="M 8 8 L 72 8 L 70 14 L 10 14 Z" fill="#d09c4f" />
          <path d="M 12 14 L 68 14 L 42 70 Z" fill="#d11a2a" opacity="0.7" />
          <path d="M 14 18 L 66 18 L 42 64 Z" fill="#fff8c2" opacity="0.55" />
          <circle cx="28" cy="28" r="4" fill="#a32424" />
          <circle cx="50" cy="28" r="4" fill="#a32424" />
          <circle cx="38" cy="46" r="4" fill="#a32424" />
          <circle cx="30" cy="54" r="3" fill="#a32424" />
        </svg>
      </div>
    </div>
  );
}

/* PigeonFlock — a 3-pigeon V drifts across the upper screen. Each
   pigeon has its own wing-flap delay so they look loosely synced. */
function PigeonFlock() {
  const yPx = 16 + Math.random() * 40; // pixels from top of the 14vh band
  return (
    <div
      className="absolute will-change-transform"
      style={{
        left: -120,
        top: yPx,
        animation: 'flock-glide 18s linear forwards',
      }}
      aria-hidden
    >
      <FlockPigeon delay="0s"   offsetX={0}  offsetY={0} />
      <FlockPigeon delay="0.2s" offsetX={-22} offsetY={14} />
      <FlockPigeon delay="0.1s" offsetX={-22} offsetY={-14} />
    </div>
  );
}

function FlockPigeon({ delay, offsetX, offsetY }: { delay: string; offsetX: number; offsetY: number }) {
  return (
    <div
      className="absolute"
      style={{ left: offsetX, top: offsetY, animation: `flock-bob 2.4s ease-in-out infinite`, animationDelay: delay }}
    >
      <svg viewBox="0 0 60 28" width="42" height="20">
        <ellipse cx="30" cy="18" rx="16" ry="5" fill="#5a6068" />
        <circle cx="46" cy="14" r="4" fill="#5a6068" />
        <circle cx="48" cy="13" r="0.8" fill="#fff" />
        <path d="M 50 14 L 56 12 L 50 16 Z" fill="#FF6319" />
        {/* flapping wings — independent vertical via animation */}
        <path d="M 18 16 Q 22 4, 32 12" stroke="#3e434a" strokeWidth="3" fill="none" strokeLinecap="round" style={{ transformOrigin: '32px 14px', animation: `wing-flap 0.36s ease-in-out infinite`, animationDelay: delay }} />
        <path d="M 18 18 Q 22 28, 32 20" stroke="#3e434a" strokeWidth="3" fill="none" strokeLinecap="round" style={{ transformOrigin: '32px 18px', animation: `wing-flap 0.36s ease-in-out infinite reverse`, animationDelay: delay }} />
      </svg>
    </div>
  );
}

/* TickerTape removed — full-viewport confetti drift conflicted with
   the centered UI. If we want a parade effect, fire canvas-confetti
   at a specific event (jackpot, transfer success) instead of running
   it as ambient background. */
