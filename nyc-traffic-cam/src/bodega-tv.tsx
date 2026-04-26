import { useEffect, useState, type ReactNode } from 'react';
import { Lock, X } from 'lucide-react';
import { apiUrl } from './api';

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

/* ────────────────────────────────────────────────── BodegaTV
   The reusable wood-cabinet CRT. Display-only — the parent decides
   what camera to show, when to flip channels, and any lock state. */

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
  refreshSec = 3,
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
}) {
  const [tick, setTick] = useState(0);
  const clock = useClock();

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), refreshSec * 1000);
    return () => clearInterval(i);
  }, [refreshSec]);

  const hh = String(clock.getHours()).padStart(2, '0');
  const mm = String(clock.getMinutes()).padStart(2, '0');
  const screenMinH = large ? 380 : 260;

  return (
    <div className="select-none w-full">
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

      {/* wood cabinet */}
      <div
        className="wood-grain px-4 pt-3 pb-4 rounded-md relative"
        style={{ borderTopLeftRadius: 18, borderTopRightRadius: 18 }}
      >
        {/* nameplate */}
        <div className="flex items-center justify-between mb-2 text-[10px] tracking-[0.3em] uppercase font-typewriter text-[#f3e9c0]/80">
          <span className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 bg-[#ff5026] rec-dot rounded-full" />
            <span>RCA · COLOR · TC-21</span>
          </span>
          <span className="hidden md:inline">CH {String(channelNumber).padStart(2, '0')} · {hh}:{mm}</span>
          {onClose && (
            <button onClick={onClose} className="text-[#f3e9c0]/70 hover:text-white transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* screen bezel */}
        <div
          className="relative bg-black overflow-hidden cursor-pointer"
          style={{
            border: large ? '8px solid #1a1410' : '6px solid #1a1410',
            borderRadius: '22px / 14px',
            boxShadow:
              'inset 0 0 50px rgba(0,0,0,0.95), 0 0 0 2px rgba(255,255,255,0.06), 0 0 60px rgba(255,150,40,0.06)',
          }}
          onClick={onScreenClick}
        >
          <div
            key={flashKey}
            className="relative crt-overlay"
            style={{ animation: 'tv-channel-flip 0.55s cubic-bezier(.6,.05,.35,1)' }}
          >
            {cameraId && caption ? (
              <>
                <img
                  key={`tv-${cameraId}-${tick}`}
                  src={apiUrl(`/api/cameras/${cameraId}/snapshot.jpg?t=${tick}`)}
                  alt={caption.title}
                  className="w-full bg-black block"
                  style={{ minHeight: screenMinH, objectFit: 'cover' }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.opacity = '0.2';
                  }}
                />
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
                      <div className={`font-tabloid leading-tight uppercase truncate mt-0.5 ${large ? 'text-[28px]' : 'text-[22px]'}`}>
                        {caption.title}
                      </div>
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

        {/* knob row */}
        <div className="flex items-center justify-between mt-3 px-1">
          <div className="flex items-center gap-3">
            <KnobChannel value={channelNumber} />
            <div className="text-[9px] uppercase tracking-[0.3em] text-[#f3e9c0]/70 font-typewriter">CHANNEL</div>
          </div>
          <div className="text-[9px] tracking-[0.3em] uppercase font-typewriter text-[#f3e9c0]/55 hidden md:block">
            BODEGA · CAFÉ · LOTTO · ATM
          </div>
          <div className="flex items-center gap-2">
            <div className="flex gap-[2px]">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="w-1 h-3 bg-[#ff5026]"
                  style={{ opacity: i < 3 ? 0.95 : 0.25, boxShadow: i < 3 ? '0 0 4px #ff5026' : 'none' }}
                />
              ))}
            </div>
            <div className="text-[9px] uppercase tracking-[0.3em] text-[#f3e9c0]/70 font-typewriter">VOL</div>
          </div>
        </div>
      </div>
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
   The shared header strip used on both Lounge and Dashboard pages. */

export function BodegaAwning({ rightSlot }: { rightSlot?: ReactNode }) {
  return (
    <div className="relative shrink-0">
      <div className="metrocard-tape h-1.5" />

      {/* light-bulb marquee strip */}
      <div className="bg-[#0a0a0a] h-3 flex items-center justify-around overflow-hidden">
        {Array.from({ length: 60 }).map((_, i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-[#FFD600]"
            style={{
              boxShadow: '0 0 4px #FFD600, 0 0 9px #FFD60088',
              animation: `bulb-chase 1.4s ease-in-out infinite`,
              animationDelay: `${(i % 6) * 0.18}s`,
              opacity: 0.9,
            }}
          />
        ))}
      </div>

      <div
        className="bg-[#1B5E20] text-white px-4 pt-1 pb-2 flex items-center gap-4 border-b-2 border-[#FFD600] relative"
        style={{ boxShadow: '0 4px 0 #0F3812, inset 0 -1px 0 rgba(0,0,0,0.4)' }}
      >
        <a href="/" className="font-bungee uppercase tracking-[0.06em] text-[22px] leading-none whitespace-nowrap hover:text-[#FFD600] transition-colors">
          NYC <span className="text-[#FFD600] flicker">★</span> TRAFFIC <span className="text-[#FFD600]">CAM</span>{' '}
          <span className="text-white riso">CO.</span>
        </a>

        <span className="hidden md:inline-flex flex-col items-center px-2 py-0.5 border border-[#FFD600] text-[#FFD600] font-typewriter text-[8px] leading-none uppercase tracking-[0.18em]">
          <span>EST.</span><span>2026</span>
        </span>

        <span className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 hidden lg:inline">
          · open 24 hrs · cold beer · lotto · pork roll · live cams ·
        </span>

        <span className="ml-auto flex items-center gap-3">
          <span className="subway-bullet" style={{ background: '#EE352E' }}>1</span>
          <span className="subway-bullet" style={{ background: '#00933C' }}>4</span>
          <span className="subway-bullet" style={{ background: '#0039A6' }}>A</span>
          <span className="subway-bullet" style={{ background: '#A7A9AC', color: '#000' }}>L</span>
          <span className="font-typewriter text-[10px] tracking-[0.2em] uppercase text-[#FFD600] pl-2">
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

export function StreetFauna() {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 overflow-hidden h-[120px]">
      <Rat />
      <YellowCab />
      <Pigeon />
      <ManholeSteam left="22%" delay="2s" />
      <ManholeSteam left="71%" delay="11s" />
    </div>
  );
}

function Rat() {
  const [seed, setSeed] = useState(0);
  useEffect(() => {
    let stop = false;
    const tick = () => {
      const wait = 25_000 + Math.random() * 50_000;
      setTimeout(() => {
        if (stop) return;
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    tick();
    return () => { stop = true; };
  }, []);
  const duration = 3 + ((seed * 37) % 20) / 10;
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
