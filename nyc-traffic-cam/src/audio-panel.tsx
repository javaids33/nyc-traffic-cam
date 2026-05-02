import { useEffect, useRef, useState } from 'react';
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

/* AudioPanel — horizontal Panasonic-style boombox.

   Visual reference: classic late-90s/early-2000s portable stereo
   (RX-ED50 / RX-DT505 era). Two big circular speakers flanking a
   central cassette deck + LCD frequency display + transport row,
   topped by a carrying handle and a telescoping antenna.

   Behaviors:
     - Renders at app root (main.tsx) so it persists across every
       route. Each navigation is a real page reload (no React
       Router), so we can't keep audio playing — but the position
       and last-tuned station are restored from localStorage so the
       boombox reappears in the same spot with the same dial.
     - Draggable: grab the chassis (handle bar or any non-button
       region) and drop anywhere; position saves to localStorage.
     - Collapses to a launcher tab on screens < lg — chassis is
       too wide for phones.

   Audio store (audio-store.ts) is unchanged — only this view is
   different. The player's HTMLAudioElement is module-singleton, so
   pause/resume/volume all still work the same. */

const POS_KEY = 'nyc-boombox-pos';
const COLLAPSE_KEY = 'nyc-boombox-collapsed';
const SCALE_KEY = 'nyc-boombox-scale';
const DEFAULT_POS = { x: 12, y: 110 };
const MIN_SCALE = 0.55;
const MAX_SCALE = 1.4;
// Below this viewport width the chassis can't fit, and the boombox is
// noisy enough to dominate a phone — always start docked.
const NARROW_VIEWPORT = 1024;

type Pos = { x: number; y: number };

function loadCollapsed(): boolean {
  if (typeof window !== 'undefined' && window.innerWidth < NARROW_VIEWPORT) return true;
  try {
    const v = localStorage.getItem(COLLAPSE_KEY);
    // First-time visitors: dock by default. The boombox is opt-in —
    // surfacing a 600px stereo on first paint felt aggressive.
    if (v === null) return true;
    return v === '1';
  } catch { return true; }
}

function loadScale(): number {
  try {
    const raw = localStorage.getItem(SCALE_KEY);
    if (!raw) return 1;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
  } catch { return 1; }
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return DEFAULT_POS;
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') {
      // Clamp to viewport so a previously-saved position from a
      // bigger window doesn't put the boombox off-screen.
      const maxX = Math.max(0, window.innerWidth - 200);
      const maxY = Math.max(0, window.innerHeight - 100);
      return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) };
    }
  } catch { /* private mode etc */ }
  return DEFAULT_POS;
}

export function AudioPanel(_props: { inline?: boolean } = {}) {
  const { src, vol, playing, error } = useAudio();
  const [tab, setTab] = useState<'radio' | 'ambience'>('radio');
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [pos, setPos] = useState<Pos>(loadPos);
  const [scale, setScale] = useState<number>(loadScale);
  const dragStateRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeStateRef = useRef<{ startX: number; startY: number; origScale: number } | null>(null);
  const chassisRef = useRef<HTMLDivElement | null>(null);

  // Persist position whenever it changes (after a drag ends).
  useEffect(() => {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);
  useEffect(() => {
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed]);
  useEffect(() => {
    try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* ignore */ }
  }, [scale]);

  // Re-clamp on window resize so the boombox doesn't drift off
  // when the viewport shrinks below its previous saved position.
  useEffect(() => {
    const onResize = () => setPos((p) => {
      const maxX = Math.max(0, window.innerWidth - 200);
      const maxY = Math.max(0, window.innerHeight - 100);
      return { x: Math.min(maxX, p.x), y: Math.min(maxY, p.y) };
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onClickStation = (s: Station) => {
    if (src?.kind === 'radio' && src.stationId === s.id) {
      audioToggle();
    } else {
      audioTuneRadio(s);
    }
  };

  // ── Drag handling ────────────────────────────────────────────
  const onDragStart = (e: React.PointerEvent) => {
    // Don't start dragging when the gesture lands on a control —
    // those have their own click semantics and we'd hijack them.
    const target = e.target as HTMLElement;
    if (target.closest('button, input, a, label, [data-no-drag]')) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  };
  const onDragMove = (e: React.PointerEvent) => {
    const st = dragStateRef.current;
    if (!st) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    const maxX = Math.max(0, window.innerWidth - (chassisRef.current?.offsetWidth ?? 200));
    const maxY = Math.max(0, window.innerHeight - (chassisRef.current?.offsetHeight ?? 100));
    setPos({
      x: Math.min(maxX, Math.max(0, st.origX + dx)),
      y: Math.min(maxY, Math.max(0, st.origY + dy)),
    });
  };
  const onDragEnd = () => { dragStateRef.current = null; };

  // Resize handle — drag the bottom-right corner to scale the
  // entire chassis. Tracks horizontal+vertical movement, picks the
  // larger axis to drive the scale delta.
  const onResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    resizeStateRef.current = { startX: e.clientX, startY: e.clientY, origScale: scale };
  };
  const onResizeMove = (e: React.PointerEvent) => {
    const st = resizeStateRef.current;
    if (!st) return;
    e.stopPropagation();
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    // Use the larger of dx/dy as the dominant gesture and scale at
    // 0.003 per pixel — gives a nice tactile rate where 200px of
    // drag covers the full MIN→MAX range.
    const delta = Math.max(dx, dy) * 0.003;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, st.origScale + delta));
    setScale(next);
  };
  const onResizeEnd = (e: React.PointerEvent) => {
    if (!resizeStateRef.current) return;
    e.stopPropagation();
    resizeStateRef.current = null;
  };

  const label = nowPlayingLabel(src);

  return (
    <>
      {/* Launcher — desktop and mobile get different treatments.
          Desktop (≥lg, 1024px+): full antenna-tower badge with a
          blinking aviation light + concentric broadcast rings while
          playing. The user explicitly likes this on desktop.
          Mobile (<lg): a quiet flush-left "radio" tab with no
          animation — keeps phones from feeling shouty. */}
      {collapsed && (
        <>
          {/* DESKTOP launcher (lg breakpoint and above) — antenna tower */}
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="hidden lg:flex fixed left-0 z-50 pointer-events-auto items-stretch hover:left-[2px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600] transition-all"
            style={{ top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', padding: 0 }}
            title="Open the boombox · radio + ambience"
            aria-label={playing ? `Boombox playing ${label} — click to expand` : 'Open boombox radio'}
          >
            <div
              className="bg-black border-y-2 border-r-2 border-[#FFD600] flex flex-col items-center justify-center gap-2 px-1.5 py-3"
              style={{ minHeight: 180, boxShadow: '3px 3px 0 #d11a2a' }}
            >
              <span
                className="font-bungee text-[#FFD600] text-[11px] tracking-[0.18em] uppercase"
                style={{ writingMode: 'vertical-rl' }}
              >
                {playing && label ? label : 'BODEGA-FM'}
              </span>
              {playing && (
                <span
                  className="w-2 h-2 rounded-full bg-[#FFD600]"
                  aria-hidden
                  style={{ boxShadow: '0 0 6px #FFD600', animation: 'tip-bounce 1.2s ease-in-out infinite' }}
                />
              )}
              <span
                className="font-typewriter text-[8px] tracking-[0.2em] uppercase text-[#FFD600]/55"
                style={{ writingMode: 'vertical-rl' }}
              >
                tap · open
              </span>
            </div>
            <svg
              width="38"
              height="180"
              viewBox="0 0 38 180"
              aria-hidden
              style={{ filter: 'drop-shadow(2px 0 0 #d11a2a)' }}
            >
              <circle cx="19" cy="6" r="4" fill="#ff3a3a" style={{ filter: 'drop-shadow(0 0 6px #ff3a3a)' }}>
                <animate attributeName="opacity" values="1;0.4;1" dur="1.2s" repeatCount="indefinite" />
              </circle>
              <line x1="19" y1="10" x2="19" y2="22" stroke="#c9ccd2" strokeWidth="1.5" />
              <line x1="19" y1="22" x2="9" y2="170" stroke="#c9ccd2" strokeWidth="2" />
              <line x1="19" y1="22" x2="29" y2="170" stroke="#c9ccd2" strokeWidth="2" />
              {[40, 60, 80, 100, 120, 140, 160].map((y, i) => {
                const t = (y - 22) / (170 - 22);
                const half = 1 + t * 9;
                return (
                  <g key={i}>
                    <line x1={19 - half} y1={y} x2={19 + half} y2={y} stroke="#c9ccd2" strokeWidth="1.4" />
                    <line x1={19 - half} y1={y - 6} x2={19 + half} y2={y + 6} stroke="#7a7c80" strokeWidth="0.9" />
                  </g>
                );
              })}
              {playing && (
                <g>
                  {[16, 24, 32].map((r, i) => (
                    <circle
                      key={r}
                      cx="19"
                      cy="40"
                      r={r}
                      fill="none"
                      stroke="#FFD600"
                      strokeWidth="0.8"
                      opacity="0.65"
                    >
                      <animate attributeName="r" from={r} to={r + 18} dur="1.6s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
                      <animate attributeName="opacity" from="0.65" to="0" dur="1.6s" begin={`${i * 0.4}s`} repeatCount="indefinite" />
                    </circle>
                  ))}
                </g>
              )}
            </svg>
          </button>

          {/* MOBILE launcher (<lg) — quiet flush-left badge */}
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="flex lg:hidden fixed left-0 z-40 pointer-events-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            style={{
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'rgba(10,10,18,0.65)',
              border: '1px solid rgba(255,214,0,0.32)',
              borderLeft: 'none',
              borderRadius: '0 4px 4px 0',
              padding: '8px 4px',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              color: 'rgba(255,214,0,0.72)',
            }}
            title={playing && label ? `On air: ${label} — open the boombox` : 'Open the radio'}
            aria-label={playing ? `Boombox playing ${label} — click to expand` : 'Open boombox radio'}
          >
            <span
              className="font-typewriter"
              style={{
                writingMode: 'vertical-rl',
                fontSize: 9,
                letterSpacing: '0.22em',
                textTransform: 'uppercase',
              }}
            >
              {playing && label ? label : 'radio'}
            </span>
            {playing && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-[#FFD600]"
                aria-hidden
                style={{ boxShadow: '0 0 4px #FFD600', opacity: 0.85 }}
              />
            )}
          </button>
        </>
      )}

      <aside
        ref={chassisRef}
        className={`${collapsed ? 'hidden' : 'flex'} fixed z-40 pointer-events-auto select-none`}
        style={{
          left: pos.x,
          top: pos.y,
          touchAction: 'none',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
        aria-label={`Boombox audio panel — drag to reposition, scale ${Math.round(scale * 100)}%`}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        {/* Whole chassis. Width is the main lever — at 520px it
            reads as the Panasonic; on narrow screens it scales
            down via the lg: collapse path above. */}
        <div
          className="relative font-typewriter overflow-hidden"
          style={{
            width: 600,
            background: 'linear-gradient(180deg,#34363c 0%,#1c1e22 22%,#0e1014 100%)',
            border: '2px solid #000',
            borderRadius: 14,
            boxShadow:
              '6px 6px 0 #d11a2a, inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -14px 22px rgba(0,0,0,0.6), 0 18px 24px rgba(0,0,0,0.55)',
          }}
        >
          {/* Subway-era graffiti — confined to the chassis chrome
              that's NOT used by controls. Two strips:
                · top-right top corner above the speakers (the empty
                  bezel area between the brand strip and the speaker)
                · bottom strip in the ~6px of dark chassis margin
                  below the volume slider
              Pointer-events:none, mix-blend:screen so it reads as
              spray paint on plastic without stealing clicks. */}
          {/* TOP-RIGHT CORNER tag — small, hugs the chassis edge */}
          <svg
            className="absolute pointer-events-none"
            width="120"
            height="20"
            viewBox="0 0 120 20"
            aria-hidden
            style={{ top: 28, right: 8, mixBlendMode: 'screen', opacity: 0.75 }}
          >
            <g transform="rotate(-3 60 12)">
              <text
                x="2"
                y="14"
                fontSize="11"
                fontFamily="'Permanent Marker', 'Marker Felt', cursive"
                fontWeight="900"
                fill="#ff3a8a"
                stroke="#a8064a"
                strokeWidth="0.6"
                style={{ paintOrder: 'stroke fill' }}
              >
                ★ 5-BORO ALL CITY
              </text>
            </g>
          </svg>
          {/* TOP-LEFT — tiny tag right of the brand strip's mounting
              bolts area (under the antenna). Cyan + lime. */}
          <svg
            className="absolute pointer-events-none"
            width="58"
            height="16"
            viewBox="0 0 58 16"
            aria-hidden
            style={{ top: 30, left: 10, mixBlendMode: 'screen', opacity: 0.7 }}
          >
            <text
              x="0"
              y="12"
              fontSize="10"
              fontFamily="'Bungee', 'Impact', sans-serif"
              fontWeight="900"
              fill="#3ad6ff"
              stroke="#0e6a8a"
              strokeWidth="0.5"
              style={{ paintOrder: 'stroke fill' }}
            >
              FM·NYC
            </text>
            <line x1="2" y1="14" x2="6" y2="16" stroke="#3ad6ff" strokeWidth="0.6" opacity="0.7" />
          </svg>
          {/* BOTTOM EDGE — narrow strip of graffiti tags scrawled
              across the chassis foot, between the speaker grilles
              and the chassis bottom border. Sits inside the black
              padding strip that runs full-width below the controls. */}
          <svg
            className="absolute left-0 right-0 pointer-events-none"
            width="100%"
            height="14"
            viewBox="0 0 600 14"
            preserveAspectRatio="none"
            aria-hidden
            style={{ bottom: 0, mixBlendMode: 'screen', opacity: 0.7 }}
          >
            <g fill="#B5F500" stroke="#5e8400" strokeWidth="0.4" style={{ paintOrder: 'stroke fill' }}>
              <text x="14" y="11" fontSize="9" fontFamily="'Permanent Marker', cursive" transform="rotate(-2 30 11)">
                BORN IN BX 76
              </text>
            </g>
            <g fill="#FF8A3A" stroke="#a04210" strokeWidth="0.4" style={{ paintOrder: 'stroke fill' }}>
              <text x="220" y="11" fontSize="9" fontFamily="'Permanent Marker', cursive" transform="rotate(2 250 11)">
                BLOCK PARTY · 88
              </text>
            </g>
            <g fill="#3ad6ff" stroke="#0e6a8a" strokeWidth="0.4" style={{ paintOrder: 'stroke fill' }}>
              <text x="430" y="11" fontSize="9" fontFamily="'Permanent Marker', cursive" transform="rotate(-1 460 11)">
                NO SLEEP TIL BK
              </text>
            </g>
            {/* tiny paint specks scattered between the tags */}
            <g fill="#fdfdfb" opacity="0.4">
              <circle cx="120" cy="8" r="0.7" />
              <circle cx="350" cy="6" r="0.8" />
              <circle cx="555" cy="9" r="0.6" />
            </g>
          </svg>

          {/* ── Top: handle + antenna + brand ─────────────────── */}
          <div className="relative h-[34px]">
            {/* Telescoping antenna */}
            <div
              aria-hidden
              className="absolute"
              style={{
                left: 22,
                top: -56,
                width: 2,
                height: 70,
                background: 'linear-gradient(180deg,#dadadd 0%,#7a7c80 60%,#3a3c40 100%)',
                transform: 'rotate(-8deg)',
                transformOrigin: 'bottom left',
                borderRadius: 1,
                boxShadow: '0 0 0 1px #000',
              }}
            />
            <div
              aria-hidden
              className="absolute"
              style={{
                left: 16,
                top: 6,
                width: 12,
                height: 12,
                background: 'radial-gradient(circle at 30% 30%, #4a4c52 0%, #1a1c20 80%)',
                borderRadius: '50%',
                border: '1px solid #000',
              }}
            />
            {/* Carrying handle — chrome arc */}
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2"
              style={{
                top: -18,
                width: 220,
                height: 26,
                border: '3px solid #c9ccd2',
                borderBottom: 'none',
                borderRadius: '20px 20px 0 0',
                background: 'transparent',
                boxShadow: 'inset 0 -4px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(0,0,0,0.7)',
              }}
            />
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2"
              style={{
                top: 4,
                width: 232,
                height: 4,
                background: 'linear-gradient(180deg,#1c1e22 0%,#0a0c0f 100%)',
                borderTop: '1px solid #000',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}
            />
            {/* Brand — top-right */}
            <span
              className="absolute right-[88px] top-2 font-bungee text-[10px] tracking-[0.08em]"
              style={{
                color: '#c9ccd2',
                textShadow: '0 1px 0 #000, 0 0 8px rgba(201,204,210,0.18)',
              }}
              data-no-drag
            >
              ★ BODEGA-FM
            </span>
            {/* Discoverable DOCK button — folds the boombox into a
                vertical antenna-tower tab on the right edge. Sits
                at the top-right of the chassis so it's visible
                immediately, instead of buried in the volume row. */}
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Dock to the side — boombox folds into a small antenna tower on the right edge. Click the tower to expand back."
              aria-label="Dock boombox to right side"
              data-no-drag
              className="absolute right-2 top-1.5 px-2 py-0.5 font-bungee text-[10px] tracking-[0.16em] uppercase border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors"
            >
              DOCK ▶
            </button>
          </div>

          {/* ── Body row: speaker · center stack · speaker ──────── */}
          <div className="flex items-stretch gap-2 px-3 pb-3">
            {/* Left speaker */}
            <Speaker label="Bi-AMP" />

            {/* Center stack: LCD display + cassette window + transport */}
            <div className="flex-1 flex flex-col gap-1.5 min-w-0">
              {/* LCD frequency display */}
              <div
                className="relative"
                style={{
                  height: 40,
                  background: 'linear-gradient(180deg,#a4c08b 0%,#7da06c 50%,#5b8050 100%)',
                  border: '1px solid #000',
                  borderRadius: 3,
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.4), inset 0 -1px 0 rgba(255,255,255,0.1)',
                }}
              >
                <div
                  className="absolute inset-0 px-2 flex items-center justify-between font-mono text-[14px] tracking-wider text-[#0a0c08]"
                  style={{ textShadow: '0 1px 0 rgba(255,255,255,0.25)' }}
                  aria-live="polite"
                  data-no-drag
                >
                  <span className="font-bungee tabular truncate flex-1">
                    {error ? '!! ERR' : label ? `▸ ${label}` : '— STDBY —'}
                  </span>
                  <span className="font-bungee text-[12px] ml-2 opacity-90">
                    {playing ? '►' : '❚❚'} · {Math.round(vol * 100)}
                  </span>
                </div>
                {/* faux LCD scanline */}
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background:
                      'repeating-linear-gradient(0deg, rgba(0,0,0,0.05) 0 1px, transparent 1px 3px)',
                  }}
                  aria-hidden
                />
              </div>

              {/* Cassette window — twin reels */}
              <div
                className="relative px-2 py-1.5"
                style={{
                  background: 'linear-gradient(180deg,#0a0c10 0%,#04060a 100%)',
                  border: '1px solid #000',
                  borderRadius: 3,
                  boxShadow: 'inset 0 0 14px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.05)',
                }}
              >
                <div className="flex items-center justify-around h-[40px]">
                  {[0, 1].map((i) => (
                    <svg
                      key={i}
                      width="36"
                      height="36"
                      viewBox="0 0 48 48"
                      className={playing ? 'tape-reel' : 'tape-reel tape-reel-paused'}
                      aria-hidden
                    >
                      <circle cx="24" cy="24" r="22" fill="#1a1208" stroke="#3a2a14" strokeWidth="1" />
                      <circle cx="24" cy="24" r="14" fill="#0e0905" />
                      {[0, 60, 120, 180, 240, 300].map((deg) => (
                        <line
                          key={deg}
                          x1="24"
                          y1="24"
                          x2={24 + 12 * Math.cos((deg * Math.PI) / 180)}
                          y2={24 + 12 * Math.sin((deg * Math.PI) / 180)}
                          stroke="#3a2a14"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                        />
                      ))}
                      <circle cx="24" cy="24" r="3" fill="#FFD600" />
                    </svg>
                  ))}
                </div>
              </div>

              {/* Transport row — chunky plastic buttons */}
              <div className="grid grid-cols-5 gap-1" data-no-drag>
                <TransportBtn onClick={() => { if (src) audioToggle(); }} active={Boolean(playing)} disabled={!src} label="▶" hint="play" />
                <TransportBtn onClick={() => { if (src && playing) audioToggle(); }} active={Boolean(src && !playing)} disabled={!src} label="❚❚" hint="pause" />
                <TransportBtn onClick={audioOff} disabled={!src} label="■" hint="stop" />
                <TransportBtn onClick={() => setTab('radio')} active={tab === 'radio'} label="RAD" hint="radio band" small />
                <TransportBtn onClick={() => setTab('ambience')} active={tab === 'ambience'} label="AMB" hint="ambience band" small />
              </div>

              {/* Tuner — station / ambience scroll. Sized + contrast
                  bumped 2026-04 because the previous 8px white/55
                  station descriptions were unreadable at normal
                  zoom. Now: 12px station call sign, 11px frequency,
                  11px white/85 vibe text, 4px row padding. */}
              <div
                className="overflow-y-auto h-[124px]"
                data-no-drag
                style={{
                  background: 'linear-gradient(180deg,#06080c 0%,#0a0c10 100%)',
                  border: '1px solid #000',
                  borderRadius: 3,
                  boxShadow: 'inset 0 0 8px rgba(0,0,0,0.7)',
                }}
              >
                {tab === 'radio' ? (
                  <ul className="text-white/90" role="list">
                    {STATIONS.map((s) => {
                      const active = src?.kind === 'radio' && src.stationId === s.id;
                      return (
                        <li key={s.id}>
                          <button
                            type="button"
                            onClick={() => onClickStation(s)}
                            aria-pressed={active}
                            title={`${s.call} ${s.freq} — ${s.vibe}${active && playing ? ' · currently on air' : ''}`}
                            className={`w-full text-left px-2 py-1 flex items-baseline justify-between border-b border-white/5 transition-colors uppercase tracking-[0.14em] ${
                              active ? 'bg-[#FFD600]/15 text-[#FFD600]' : 'hover:bg-white/5 hover:text-[#FFD600]'
                            }`}
                          >
                            <span className="flex items-baseline gap-2 min-w-0">
                              <span className={`font-bungee text-[13px] tracking-[0.04em] ${active ? 'text-[#FFD600]' : 'text-white'}`}>{s.call}</span>
                              <span className={`text-[11px] tracking-[0.14em] ${active ? 'text-[#FFD600]/85' : 'text-white/65'}`}>{s.freq}</span>
                            </span>
                            <span className={`text-[11px] tracking-[0.10em] normal-case lowercase truncate ml-2 ${active ? 'text-[#FFD600]/85' : 'text-white/85'}`}>
                              {active && playing ? '· on air' : s.vibe}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="px-2 py-2 grid grid-cols-3 gap-1.5">
                    {AMBIENCE.map((m) => {
                      const active = src?.kind === 'ambience' && src.mode === m.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => (active ? audioOff() : audioStartAmbience(m.id))}
                          title={m.gloss}
                          aria-pressed={active}
                          className={`px-2 py-1.5 border text-[11px] tracking-[0.12em] uppercase transition-colors ${
                            active ? 'bg-[#FFD600] text-black border-[#FFD600]' : 'border-white/30 text-white/90 hover:border-[#FFD600] hover:text-[#FFD600]'
                          }`}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Volume slider */}
              <div className="flex items-center gap-2 px-1" data-no-drag>
                <span className="text-[8px] tracking-[0.18em] text-white/55 uppercase">Vol</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={vol}
                  onChange={(e) => audioSetVol(parseFloat(e.target.value))}
                  className="flex-1 accent-[#FFD600]"
                  aria-label="Volume"
                />
                <button
                  type="button"
                  onClick={() => setCollapsed(true)}
                  className="text-[10px] tracking-[0.18em] text-white/60 hover:text-white px-1 uppercase"
                  title="Hide the boombox"
                  aria-label="Collapse boombox"
                >
                  −
                </button>
              </div>
            </div>

            {/* Right speaker */}
            <Speaker label="Bi-AMP" />
          </div>

          {/* Drag-handle hint — only visible on hover */}
          <div
            className="absolute top-1.5 left-1/2 -translate-x-1/2 text-[10px] tracking-[0.18em] text-white/40 uppercase pointer-events-none opacity-0 hover:opacity-80 transition-opacity"
            aria-hidden
          >
            ↔ drag · ↘ resize
          </div>
          {/* Resize handle — bottom-right corner. Three diagonal
              hatch lines that read as a classic "grippy" SVG corner.
              Pointer events are hard-wired here so the gesture
              doesn't bubble up to the chassis drag handler. */}
          <div
            role="slider"
            tabIndex={0}
            aria-label={`Resize boombox — current scale ${Math.round(scale * 100)} percent`}
            aria-valuemin={Math.round(MIN_SCALE * 100)}
            aria-valuemax={Math.round(MAX_SCALE * 100)}
            aria-valuenow={Math.round(scale * 100)}
            data-no-drag
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp' || e.key === '+') {
                e.preventDefault();
                setScale((s) => Math.min(MAX_SCALE, s + 0.05));
              } else if (e.key === 'ArrowDown' || e.key === '-') {
                e.preventDefault();
                setScale((s) => Math.max(MIN_SCALE, s - 0.05));
              } else if (e.key === '0') {
                e.preventDefault();
                setScale(1);
              }
            }}
            className="absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            title={`Drag to resize (${Math.round(scale * 100)}%) · arrow keys also work · 0 to reset`}
            style={{ touchAction: 'none' }}
          >
            <svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden>
              <line x1="14" y1="6"  x2="6"  y2="14" stroke="#FFD600" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="14" y1="10" x2="10" y2="14" stroke="#FFD600" strokeWidth="1.5" strokeLinecap="round" />
              <line x1="14" y1="14" x2="14" y2="14" stroke="#FFD600" strokeWidth="2"   strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </aside>
    </>
  );
}

/* Big circular speaker with concentric rings + central cap. The
   look comes from layered radial gradients — a darker outer cone,
   a hammered metal cone-paper ring, and a glossy central dust cap. */
function Speaker({ label }: { label: string }) {
  return (
    <div
      className="relative shrink-0"
      style={{
        width: 134,
        height: 144,
        background: 'linear-gradient(180deg,#16181c 0%,#0a0c0f 100%)',
        border: '1px solid #000',
        borderRadius: 8,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -8px 14px rgba(0,0,0,0.6)',
      }}
    >
      {/* Outer chrome ring */}
      <div
        aria-hidden
        className="absolute"
        style={{
          inset: 6,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 30%, #6b6e74 0%, #2a2c30 40%, #0a0c0f 100%)',
          boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.18), inset 0 -2px 6px rgba(0,0,0,0.7), 0 0 0 1px #000',
        }}
      />
      {/* Cone paper ring */}
      <div
        aria-hidden
        className="absolute"
        style={{
          inset: 16,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 30%, #1a1c20 0%, #06080a 70%)',
          boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.85)',
        }}
      />
      {/* Concentric grooves — fake speaker grille rings */}
      {[0.55, 0.7, 0.85].map((r) => (
        <div
          key={r}
          aria-hidden
          className="absolute left-1/2 top-[68px] -translate-x-1/2 -translate-y-1/2"
          style={{
            width: 110 * r,
            height: 110 * r,
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.05)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
          }}
        />
      ))}
      {/* Center dust cap */}
      <div
        aria-hidden
        className="absolute left-1/2 top-[68px] -translate-x-1/2 -translate-y-1/2"
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 30%, #5a5d63 0%, #1a1c20 70%, #06080a 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.2), 0 0 0 1px #000',
        }}
      />
      {/* Bi-AMP badge */}
      <span
        className="absolute left-1/2 -translate-x-1/2 bottom-1 font-bungee text-[7px] tracking-[0.18em] uppercase px-1 py-0.5"
        style={{
          color: '#c9ccd2',
          background: 'linear-gradient(180deg,#22252b 0%,#0e1014 100%)',
          border: '1px solid #000',
          borderRadius: 2,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function TransportBtn({ onClick, active, disabled, label, hint, small }: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={hint}
      aria-label={hint}
      className={`font-bungee py-1.5 transition-transform active:translate-y-[1px] disabled:opacity-40 disabled:cursor-not-allowed ${small ? 'text-[10px]' : 'text-[14px]'}`}
      style={{
        background: active
          ? 'linear-gradient(180deg,#FFD600 0%,#c79f00 100%)'
          : 'linear-gradient(180deg,#3a3d44 0%,#22252b 50%,#1a1c22 100%)',
        color: active ? '#000' : '#e0e2e6',
        border: '1px solid #000',
        borderRadius: 4,
        boxShadow: active
          ? 'inset 0 1px 0 rgba(255,255,255,0.4), 0 1px 0 rgba(0,0,0,0.5)'
          : 'inset 0 1px 0 rgba(255,255,255,0.12), 0 2px 0 rgba(0,0,0,0.7)',
      }}
    >
      {label}
    </button>
  );
}
