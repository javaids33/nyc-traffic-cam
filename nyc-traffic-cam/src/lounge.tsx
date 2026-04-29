import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCameras } from './api';
import type { Alert, Camera } from './types';
import {
  BodegaAwning,
  BodegaTV,
  CHANNEL_LINEUP,
  StreetFauna,
  type TVCaption,
} from './bodega-tv';
import { QuarterStash, RollingQuarter, QuarterIcon, useQuarters, HiddenCoin } from './quarter';
import { AudioPanel } from './audio-panel';
import { recordTune, loreLine } from './cam-lore';

const ALERT_LABELS_LONG: Record<string, string> = {
  sudden_change: 'SUDDEN CHANGE',
  static_feed: 'FROZEN FEED',
  camera_offline: 'CAMERA OFFLINE',
  high_activity: 'HIGH ACTIVITY',
};

type Channel = { cameraId: string; caption: TVCaption };

const SURF_INTERVAL_MS = 18_000;     // ~18s dwell — long enough to vibe
const STATIC_FLIP_MS = 380;
const RESUME_AFTER_LOCK_MS = 90_000; // unlock auto-resumes 90s after locking, in case you forget

type Borough = 'ALL' | 'MANHATTAN' | 'BRONX' | 'BROOKLYN' | 'QUEENS' | 'STATEN ISLAND';

const BOROUGH_TABS: { id: Borough; label: string; short: string }[] = [
  { id: 'ALL',           label: 'ALL FIVE',  short: 'ALL' },
  { id: 'MANHATTAN',     label: 'MANHATTAN', short: 'MAN' },
  { id: 'BRONX',         label: 'BRONX',     short: 'BX' },
  { id: 'BROOKLYN',      label: 'BROOKLYN',  short: 'BK' },
  { id: 'QUEENS',        label: 'QUEENS',    short: 'QNS' },
  { id: 'STATEN ISLAND', label: 'STATEN IS', short: 'SI' },
];

function rough_borough(lat: number, lng: number): Borough {
  // Loose bounding boxes — Easter-egg accuracy, not survey-grade.
  if (lat > 40.78 && lng > -73.94) return 'BRONX';
  if (lng < -74.05) return 'STATEN ISLAND';
  if (lat < 40.7 && lng > -73.95) return 'BROOKLYN';
  if (lng > -73.93) return 'QUEENS';
  return 'MANHATTAN';
}

export default function Lounge() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  // Alerts pipeline disabled — keep an empty alerts array so child
  // components that still take an `alerts` prop (ChannelGuide,
  // CityServicesRail) gracefully render their empty states without
  // having to be re-plumbed.
  const alerts: Alert[] = [];

  const [focus, setFocus] = useState<Channel | null>(null);
  const [channelIdx, setChannelIdx] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const [staticOn, setStaticOn] = useState(false);
  const [locked, setLocked] = useState(false);
  const [ratMode, setRatMode] = useState(false);
  const [showHotkeys, setShowHotkeys] = useState(false);
  const [borough, setBorough] = useState<Borough>('ALL');
  const boroughRef = useRef<Borough>('ALL');
  useEffect(() => { boroughRef.current = borough; }, [borough]);
  const [intro, setIntro] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !sessionStorage.getItem('nyc-cam-seen');
  });


  // initial fetch — alerts pipeline disabled, cameras only
  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);

  // periodic cameras refresh (status updates)
  useEffect(() => {
    const i = setInterval(() => {
      fetchCameras().then(setCameras).catch(() => {});
    }, 15_000);
    return () => clearInterval(i);
  }, []);

  // The live-alert websocket + alert-merge effect was removed when we
  // retired realtime anomaly detection. ChannelGuide gracefully shows
  // its empty state ("quiet streets · b-roll only") so the UI stays
  // intact. To resurrect, re-import openAlertSocket / fetchAlerts and
  // restore the merge logic.

  // Roulette state: just refs to the current focus and the live camera
  // pool, so surfNext doesn't need them as dependencies.
  const focusRef = useRef<Channel | null>(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  const camerasRef = useRef<Camera[]>(cameras);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);

  const flipTo = useCallback((next: Channel) => {
    recordTune(next.cameraId);
    // Decorate caption with lore line if we have one for this cam.
    const lore = loreLine(next.cameraId);
    if (lore) {
      next = {
        ...next,
        caption: {
          ...next.caption,
          meta: next.caption.meta ? `${next.caption.meta} · ${lore}` : lore,
        },
      };
    }
    setStaticOn(true);
    setFocus(next);
    setChannelIdx((i) => (i + 1) % CHANNEL_LINEUP.length);
    setFlashKey((k) => k + 1);
    const t = setTimeout(() => setStaticOn(false), STATIC_FLIP_MS);
    return () => clearTimeout(t);
  }, []);

  // Pure camera roulette: spin the wheel, land somewhere. No alert
  // priority, no severity weights — every camera in the borough has an
  // equal shot. Click-to-tune in the alert list still works as a manual
  // override, but the site's auto-pick is just chance.
  const surfNext = useCallback(() => {
    const cur = focusRef.current;
    const allCams = camerasRef.current;
    const b = boroughRef.current;
    if (!allCams.length) return;

    const inBorough = b === 'ALL' ? allCams : allCams.filter((c) => rough_borough(c.lat, c.lng) === b);
    const baseline = inBorough.length ? inBorough : allCams;
    const others = baseline.filter((c) => c.id !== cur?.cameraId);
    const pool = others.length ? others : baseline;
    const c = pool[Math.floor(Math.random() * pool.length)];

    flipTo({
      cameraId: c.id,
      caption: {
        title: c.name ?? c.id,
        subtitle: null,
        meta: `ROULETTE · ${rough_borough(c.lat, c.lng)}`,
        coords: { lat: c.lat, lng: c.lng },
      },
    });
  }, [flipTo]);

  // First pick once we have data
  useEffect(() => {
    if (!focus && (cameras.length || alerts.length)) surfNext();
  }, [cameras.length, alerts.length, focus, surfNext]);

  // Auto-cycle (paused while locked)
  useEffect(() => {
    if (locked) return;
    const i = setInterval(() => surfNext(), SURF_INTERVAL_MS);
    return () => clearInterval(i);
  }, [locked, surfNext]);

  // Auto-unlock after a long while so the channel doesn't get stuck if you wander off
  useEffect(() => {
    if (!locked) return;
    const t = setTimeout(() => setLocked(false), RESUME_AFTER_LOCK_MS);
    return () => clearTimeout(t);
  }, [locked]);

  // MetroCard intro: dismiss after 3.7s — long enough to actually read
  // the card before it swipes back out. Remembered in sessionStorage so
  // it only plays on the first visit per tab.
  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => {
      setIntro(false);
      try { sessionStorage.setItem('nyc-cam-seen', '1'); } catch { /* noop */ }
    }, 3700);
    return () => clearTimeout(t);
  }, [intro]);

  // Keyboard: space spins the roulette, L locks the channel, ? toggles
  // the hotkeys panel, ESC closes/unlocks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'l' || e.key === 'L') {
        setLocked((v) => !v);
      } else if (e.key === '?') {
        setShowHotkeys((v) => !v);
      } else if (e.key === 'Escape') {
        setShowHotkeys(false);
        setLocked(false);
      } else if (e.key === ' ') {
        surfNext();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [surfNext]);

  // Konami code → RAT MODE
  useEffect(() => {
    const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let buf: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      buf.push(e.key.toLowerCase());
      if (buf.length > code.length) buf.shift();
      const ok = buf.length === code.length && buf.every((k, i) => k === code[i].toLowerCase());
      if (ok) {
        setRatMode((v) => !v);
        buf = [];
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden text-white" style={{
      background: 'radial-gradient(ellipse at 50% 30%, #1a1530 0%, #0a0a18 55%, #06060c 100%)',
    }}>
      <BodegaAwning />
      <QuarterStash />
      <RollingQuarter />
      <AudioPanel />

      <main className="flex-1 relative flex items-start justify-center px-2 sm:px-6 pt-6 sm:pt-8 pb-6 overflow-y-auto">
        <SkylineBg />
        <CornerBrasstack />

        <div className="w-full max-w-[1400px] relative z-10 grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_260px] xl:grid-cols-[300px_minmax(0,1fr)_300px] items-start">
          <ChannelGuide
            alerts={alerts}
            currentCameraId={focus?.cameraId ?? null}
            channelNumber={CHANNEL_LINEUP[channelIdx]}
            onTune={(a) => {
              flipTo({
                cameraId: a.camera_id,
                caption: {
                  title: a.camera_name ?? a.camera_id,
                  subtitle: a.message,
                  meta: `${ALERT_LABELS_LONG[a.kind] ?? a.kind} · SEV ${a.severity}`,
                  coords: { lat: a.lat, lng: a.lng },
                  occurrences: a.occurrence_count,
                },
              });
              setLocked(true);
            }}
          />

          <div className="min-w-0">
            {/* borough filter — its own sub-header bar so it doesn't get
                visually swallowed by the awning's toothy bottom edge.
                Opaque so the TV's "ON AIR / live broadcast" neon sign
                behind it doesn't bleed through. */}
            <div
              className="relative z-20 mb-3 px-2 py-1.5 flex flex-wrap items-center gap-1 font-typewriter text-[10px] uppercase tracking-[0.18em] bg-[#0a0a14] border border-[#FFD600]/40"
              style={{ boxShadow: '2px 2px 0 #d11a2a' }}
            >
              <span className="text-[#FFD600] mr-1.5 font-bungee text-[11px] tracking-[0.06em] hidden sm:inline">★ TUNE BY BOROUGH</span>
              {BOROUGH_TABS.map((b) => {
                const active = borough === b.id;
                return (
                  <button
                    key={b.id}
                    onClick={() => {
                      setBorough(b.id);
                      // Force a fresh pick that respects the new filter — don't wait
                      // for the 18s tick.
                      setLocked(false);
                      setTimeout(() => surfNext(), 0);
                    }}
                    className={`px-2 py-0.5 border transition-colors ${
                      active
                        ? 'bg-[#FFD600] text-black border-[#FFD600]'
                        : 'border-white/20 text-white/75 hover:border-[#FFD600] hover:text-[#FFD600]'
                    }`}
                    title={b.label}
                  >
                    <span className="sm:hidden">{b.short}</span>
                    <span className="hidden sm:inline">{b.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <BodegaTV
                cameraId={focus?.cameraId ?? null}
                caption={focus?.caption ?? null}
                channelNumber={CHANNEL_LINEUP[channelIdx]}
                flashKey={flashKey}
                staticOn={staticOn}
                locked={locked}
                large
                onScreenClick={() => setLocked((l) => !l)}
              />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 px-1">
              <button
                type="button"
                onClick={() => surfNext()}
                title="Next channel (space)"
                className="px-3 py-1.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] sm:text-[11px] uppercase tracking-[0.22em]"
                style={{ boxShadow: '2px 2px 0 #d11a2a' }}
              >
                CH ▶ NEXT
              </button>
              <button
                type="button"
                onClick={() => setLocked((l) => !l)}
                title="Lock / unlock the channel"
                className={`px-3 py-1.5 border transition-colors font-typewriter text-[10px] sm:text-[11px] uppercase tracking-[0.22em] ${
                  locked
                    ? 'bg-[#FFD600] text-black border-[#FFD600]'
                    : 'border-white/30 text-white/75 hover:border-[#FFD600] hover:text-[#FFD600]'
                }`}
              >
                {locked ? '🔒 LOCKED' : 'HOLD CHANNEL'}
              </button>
              <span className="hidden sm:inline text-[10px] tracking-[0.22em] uppercase font-typewriter text-[#FFD600]/65 ml-1">
                {locked ? '— tap screen or HOLD again to resume —' : 'auto-surfs every 18s'}
              </span>
              <span className="ml-auto text-[10px] tracking-[0.22em] uppercase font-typewriter text-white/45">
                roulette · {cameras.length} cams in the wheel
              </span>
            </div>

            <ModesRack />
          </div>

          <CityServicesRail alerts={alerts} cameras={cameras} />
        </div>
      </main>

      <TimesSquareTicker />
      <FooterMatchbook />

      <StreetFauna ratMode={ratMode} />
      <FreshFlowers />
      <ScratchOffs />

      {/* Easter-egg quarter spots planted on existing decorative props.
          Each respawns ~6 min after pickup. Encouraged exploration. */}
      <HiddenCoin
        spotId="lounge-hydrant"
        size={18}
        hint="under the fire hydrant — +1¢"
        style={{ left: 14, bottom: 96 }}
      />
      <HiddenCoin
        spotId="lounge-cat"
        size={20}
        hint="behind the bodega cat — +2¢"
        payout={2}
        style={{ right: 22, bottom: 60 }}
      />
      <HiddenCoin
        spotId="lounge-cup"
        size={18}
        hint="next to the anthora cup — +1¢"
        style={{ right: 130, bottom: 138 }}
      />
      <HiddenCoin
        spotId="lounge-newsstand"
        size={18}
        hint="kicked under the newsstand — +1¢"
        style={{ left: 'calc(50% - 230px)', top: 130 }}
      />
      <HiddenCoin
        spotId="lounge-rat"
        size={16}
        hint="the rat dropped one — +3¢"
        payout={3}
        respawnMs={9 * 60 * 1000}
        style={{ left: 80, bottom: 44 }}
      />
      <HiddenCoin
        spotId="lounge-skyline"
        size={16}
        hint="caught between buildings — +1¢"
        style={{ right: 'calc(50% - 280px)', bottom: 240 }}
      />
      <HiddenCoin
        spotId="lounge-awning"
        size={16}
        hint="lodged in the awning bulbs — +2¢"
        payout={2}
        style={{ left: '50%', top: 12 }}
      />

      {ratMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 bg-[#FFD600] text-black px-3 py-1 font-bungee text-[12px] uppercase tracking-[0.2em]" style={{ boxShadow: '3px 3px 0 #d11a2a' }}>
          ↑↑↓↓←→←→BA · RAT MODE — TYPE AGAIN TO STOP
        </div>
      )}

      {showHotkeys && <HotkeysPanel onClose={() => setShowHotkeys(false)} />}

      {intro && <MetroCardIntro />}
    </div>
  );
}

/* ────────────────────────────────────────────────── atmospheric pieces */

function SkylineBg() {
  // A simple stylized SVG NYC silhouette pinned to the bottom edge, plus an
  // amber sodium-lamp glow rising up from underneath.
  return (
    <>
      {/* warm sodium-lamp glow */}
      <div
        className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 50% 100%, rgba(255, 168, 60, 0.18) 0%, rgba(255, 168, 60, 0.05) 40%, transparent 75%)',
        }}
      />
      <svg
        viewBox="0 0 1600 220"
        className="absolute bottom-0 inset-x-0 w-full h-[220px] pointer-events-none"
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <linearGradient id="sky" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#04060c" stopOpacity="0" />
            <stop offset="100%" stopColor="#04060c" />
          </linearGradient>
        </defs>
        {/* far skyline */}
        <g fill="#0d111a">
          <path d="M 0 220 L 0 140 L 60 140 L 60 110 L 110 110 L 110 130 L 160 130 L 160 90 L 220 90 L 220 130 L 290 130 L 290 100 L 350 100 L 350 70 L 410 70 L 410 130 L 480 130 L 480 110 L 540 110 L 540 140 L 620 140 L 620 100 L 700 100 L 700 130 L 770 130 L 770 90 L 840 90 L 840 130 L 920 130 L 920 110 L 990 110 L 990 140 L 1080 140 L 1080 100 L 1160 100 L 1160 130 L 1240 130 L 1240 90 L 1320 90 L 1320 130 L 1400 130 L 1400 110 L 1480 110 L 1480 140 L 1600 140 L 1600 220 Z" />
          {/* lit windows — random tiny rectangles */}
          {Array.from({ length: 70 }).map((_, i) => {
            const x = (i * 53 + 13) % 1600;
            const y = 100 + ((i * 17) % 60);
            const lit = (i * 7) % 3 === 0;
            return <rect key={i} x={x} y={y} width="2" height="3" fill={lit ? '#FFD27A' : '#1a2030'} opacity={lit ? 0.9 : 0.4} />;
          })}
        </g>
        <rect x="0" y="0" width="1600" height="220" fill="url(#sky)" />
      </svg>

      {/* steam from a manhole — drifting up center-frame */}
      <div className="absolute left-1/2 -translate-x-1/2 bottom-[200px] w-32 h-32 pointer-events-none" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="absolute bottom-0 left-1/2 w-20 h-24 rounded-full"
            style={{
              background:
                'radial-gradient(ellipse at center, rgba(220,225,235,0.25), rgba(220,225,235,0))',
              transform: 'translateX(-50%)',
              animation: `steam-drift ${7 + i * 1.2}s ease-out infinite`,
              animationDelay: `${i * 2.1}s`,
            }}
          />
        ))}
      </div>
    </>
  );
}

/* Plastic-wrapped sidewalk flower bucket — every NYC bodega has one. */
function FreshFlowers() {
  return (
    <div className="pointer-events-none fixed left-[120px] bottom-1 z-10 hidden lg:block" aria-hidden>
      <svg viewBox="0 0 70 110" width="58" height="92">
        {/* shadow */}
        <ellipse cx="35" cy="106" rx="28" ry="2" fill="rgba(0,0,0,0.4)" />
        {/* black bucket */}
        <path d="M 12 56 L 18 100 L 52 100 L 58 56 Z" fill="#1a1a1a" stroke="#0a0a0a" strokeWidth="1" />
        <ellipse cx="35" cy="56" rx="23" ry="4" fill="#2a2a2a" />
        <ellipse cx="35" cy="56" rx="20" ry="3" fill="#0a0a0a" />
        {/* "$5" cardboard tag taped to the front */}
        <rect x="22" y="74" width="14" height="10" fill="#f1ead8" stroke="#1a1a1a" strokeWidth="0.6" transform="rotate(-6 29 79)" />
        <text x="29" y="82" textAnchor="middle" fontSize="7" fontFamily="Anton, Impact, sans-serif" fill="#d11a2a" transform="rotate(-6 29 79)">$5</text>
        {/* cellophane wrap (a translucent cone behind the stems) */}
        <path d="M 14 50 L 35 14 L 56 50 Z" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.35)" strokeWidth="0.6" />
        {/* stems */}
        <line x1="26" y1="48" x2="26" y2="22" stroke="#2f6a2a" strokeWidth="1.3" />
        <line x1="35" y1="48" x2="35" y2="14" stroke="#2f6a2a" strokeWidth="1.3" />
        <line x1="44" y1="48" x2="44" y2="20" stroke="#2f6a2a" strokeWidth="1.3" />
        {/* leaves */}
        <ellipse cx="29" cy="32" rx="3" ry="1.6" fill="#3a8030" transform="rotate(-30 29 32)" />
        <ellipse cx="41" cy="34" rx="3" ry="1.6" fill="#3a8030" transform="rotate(28 41 34)" />
        {/* roses — three blooms */}
        <g>
          <circle cx="26" cy="20" r="6" fill="#d11a2a" />
          <circle cx="26" cy="19" r="3" fill="#ff5c3a" />
          <circle cx="26" cy="18.5" r="1.4" fill="#ffb3a3" />
        </g>
        <g>
          <circle cx="35" cy="12" r="6.4" fill="#e9b8d8" />
          <circle cx="35" cy="11" r="3.2" fill="#fbd4e8" />
          <circle cx="35" cy="10.5" r="1.4" fill="#fff0f6" />
        </g>
        <g>
          <circle cx="44" cy="18" r="5.6" fill="#FFD600" />
          <circle cx="44" cy="17.5" r="2.8" fill="#fff19a" />
          <circle cx="44" cy="17" r="1.2" fill="#fff" />
        </g>
        {/* baby's breath specks */}
        {[[20,30],[30,26],[40,26],[50,30],[24,40],[46,40]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="0.8" fill="#fff" opacity="0.7" />
        ))}
      </svg>
    </div>
  );
}

/* Lottery scratch-off rack — taped-up "WIN $$$" placard. Sits in the
   awning corner area on wider screens. Now a real link: clicking it
   takes you to /scratch where you can spend $1 in collected quarters
   on an actual playable scratch-off. */
function ScratchOffs() {
  return (
    <a
      href="/scratch"
      className="fixed right-2 top-[150px] z-10 hidden 2xl:block focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      title="Scratch-off — collect $1 to play"
      aria-label="Scratch-off — collect $1 in coins to play"
    >
      <div
        className="bg-[#0a0a0a] border-2 border-[#FFD600] px-2 py-2 hover:scale-[1.04] transition-transform"
        style={{
          boxShadow: '3px 3px 0 #d11a2a, 0 0 14px rgba(255,214,0,0.22)',
          transform: 'rotate(2deg)',
        }}
      >
        <div className="font-bungee uppercase text-[10px] tracking-[0.16em] text-[#FFD600] text-center mb-1.5">
          ★ Lotto ★
        </div>
        <div className="grid grid-cols-2 gap-1">
          {[
            { c: '#d11a2a', t: '$5', n: 'CASH BLAST' },
            { c: '#0039A6', t: '$3', n: 'LUCKY 7' },
            { c: '#00933C', t: '$10', n: 'BIG APPLE' },
            { c: '#ff8a3a', t: '$2', n: 'SUBWAY $$' },
          ].map((s, i) => (
            <div
              key={i}
              className="px-1.5 py-1 text-center"
              style={{ background: s.c, transform: `rotate(${(i % 2 ? -1.5 : 1.5)}deg)` }}
            >
              <div className="font-bungee text-[12px] leading-none text-white">{s.t}</div>
              <div className="font-typewriter text-[6px] uppercase tracking-[0.18em] text-white/85 mt-0.5">{s.n}</div>
            </div>
          ))}
        </div>
        <div className="font-typewriter text-[7px] uppercase tracking-[0.22em] text-[#FFD600]/65 text-center mt-1.5">
          play · $1 · 4 quarters
        </div>
      </div>
    </a>
  );
}

function CornerBrasstack() {
  // The Anthora — "We Are Happy To Serve You" Greek diner cup. Doubles
  // as the tip jar: clicking opens buymeacoffee.com/sjava in a new tab.
  return (
    <a
      href="https://buymeacoffee.com/sjava"
      target="_blank"
      rel="noopener noreferrer"
      className="group fixed right-4 bottom-24 z-30 hidden md:block transition-transform hover:scale-[1.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      title="like the site? buy me a coffee — anthora optional"
      aria-label="Buy me a coffee — opens in a new tab"
    >
      {/* steam — three plumes drifting up from the cup */}
      <div className="relative h-14 w-24 mx-auto pointer-events-none" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="absolute bottom-0 w-6 h-12 rounded-full"
            style={{
              left: `${20 + i * 18}%`,
              background:
                'radial-gradient(ellipse at center, rgba(235,238,245,0.7), rgba(235,238,245,0))',
              transform: 'translateX(-50%)',
              animation: `steam-drift ${3.5 + (i % 2) * 1.4}s ease-out infinite`,
              animationDelay: `${i * 0.9}s`,
              filter: 'blur(0.6px)',
            }}
          />
        ))}
      </div>
      <svg viewBox="0 0 100 130" width="120" height="156" aria-hidden>
        <defs>
          <linearGradient id="anthoraSide" x1="0" x2="1">
            <stop offset="0%" stopColor="#0a3a82" />
            <stop offset="50%" stopColor="#0049b0" />
            <stop offset="100%" stopColor="#06306a" />
          </linearGradient>
          <linearGradient id="anthoraShade" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(255,255,255,0.08)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.25)" />
          </linearGradient>
          <pattern id="meander" x="0" y="0" width="14" height="6" patternUnits="userSpaceOnUse">
            <path d="M 0 4 L 4 4 L 4 1 L 8 1 L 8 4 L 12 4" stroke="#fff" strokeWidth="0.9" fill="none" />
          </pattern>
        </defs>

        {/* cup body — slight taper */}
        <path d="M 12 22 L 22 124 L 78 124 L 88 22 Z" fill="url(#anthoraSide)" stroke="#04204c" strokeWidth="1" />

        {/* white inner shield panel */}
        <path
          d="M 28 36 Q 30 32 34 32 L 66 32 Q 70 32 72 36 L 70 96 Q 68 100 64 100 L 36 100 Q 32 100 30 96 Z"
          fill="#fdfdfb"
          stroke="#04204c"
          strokeWidth="0.6"
        />

        {/* Greek meander border — top */}
        <rect x="14" y="30" width="72" height="4" fill="url(#meander)" />
        {/* Greek meander border — bottom */}
        <rect x="14" y="116" width="72" height="4" fill="url(#meander)" />

        {/* "WE ARE HAPPY / TO SERVE YOU" — orange tabloid lettering */}
        <text x="50" y="49" textAnchor="middle" fontSize="6.5" fontWeight="700" fontFamily="Anton, Impact, 'Bungee', sans-serif" fill="#d96412" letterSpacing="0.4">
          WE ARE HAPPY
        </text>
        <text x="50" y="58" textAnchor="middle" fontSize="6.5" fontWeight="700" fontFamily="Anton, Impact, 'Bungee', sans-serif" fill="#d96412" letterSpacing="0.4">
          TO SERVE YOU
        </text>

        {/* three little espresso cups with steam squiggles above each */}
        {[34, 50, 66].map((cx, i) => (
          <g key={i}>
            {/* steam squiggles */}
            <path
              d={`M ${cx - 2} 70 q 1 -3 0 -6 q -1 -3 0 -6`}
              stroke="#d96412"
              strokeWidth="0.9"
              fill="none"
              opacity="0.85"
            />
            <path
              d={`M ${cx} 71 q 1 -3 0 -6 q -1 -3 0 -6`}
              stroke="#d96412"
              strokeWidth="0.9"
              fill="none"
              opacity="0.65"
            />
            <path
              d={`M ${cx + 2} 70 q 1 -3 0 -6 q -1 -3 0 -6`}
              stroke="#d96412"
              strokeWidth="0.9"
              fill="none"
              opacity="0.85"
            />
            {/* cup outline + saucer */}
            <ellipse cx={cx} cy="84" rx="6.5" ry="1" fill="#d96412" opacity="0.9" />
            <path
              d={`M ${cx - 5} 76 L ${cx + 5} 76 L ${cx + 4} 83 L ${cx - 4} 83 Z`}
              fill="#d96412"
              stroke="#9c4708"
              strokeWidth="0.4"
            />
            {/* handle */}
            <path d={`M ${cx + 5} 78 q 3 0 3 3 q 0 2 -2 2`} stroke="#d96412" strokeWidth="1" fill="none" />
          </g>
        ))}

        {/* outer shadow shading for depth */}
        <path d="M 12 22 L 22 124 L 78 124 L 88 22 Z" fill="url(#anthoraShade)" />

        {/* white rim at top */}
        <ellipse cx="50" cy="22" rx="40" ry="6" fill="#fdfdfb" />
        <ellipse cx="50" cy="20" rx="40" ry="5" fill="#0a3a82" />
        <ellipse cx="50" cy="20" rx="36" ry="3.5" fill="#000814" />

        {/* tiny "TIP THE COOK" overlay — only on hover */}
      </svg>
      <div className="absolute -top-2 right-1 px-1.5 py-0.5 bg-[#FFD600] text-black font-bungee text-[9px] tracking-[0.16em] uppercase opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" style={{ boxShadow: '2px 2px 0 #d11a2a' }}>
        ★ TIP $1
      </div>
    </a>
  );
}

/* The bodega has opinions. */
const NYC_FOOD = [
  'pork roll · egg · cheese · salt pepper ketchup',
  'chopped cheese · no ketchup · don’t even ask',
  'bacon egg & cheese on a roll · 4.50 fight me',
  'a slice, dollar regular, fold it like a man',
  'halal cart over rice · white sauce · extra hot',
  'dirty water dog · mustard · sauerkraut',
  'salt bagel + scallion schmear · everything is a lie',
  'pizza rat special · don’t look down',
  'arnold palmer · half & half · easy ice',
  'egg cream · no chocolate · u-bet only',
  'plantains, two ways · maduros & tostones',
  'bodega coffee · light & sweet · already poured',
  'sandwich is six bucks now and that’s the news',
  'cash only after midnight, atm’s in the back, broken',
];

/* The classic NYC MTA bull's-eye — black disc, blue ring, white "MTA"
   wordmark. Used as the badge for the Turnstile mode tile so it reads
   instantly as "subway thing", not "the F train". */
function MtaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-label="MTA">
      <circle cx="20" cy="20" r="19" fill="#000" />
      <circle cx="20" cy="20" r="16.5" fill="none" stroke="#0039A6" strokeWidth="3" />
      <text
        x="20"
        y="25"
        textAnchor="middle"
        fontSize="13"
        fontWeight="900"
        fontFamily="Helvetica, Arial, sans-serif"
        fill="#fff"
        letterSpacing="0.5"
      >
        MTA
      </text>
    </svg>
  );
}

/* "More at the deli" rack — surfaces the other modes prominently right
   under the TV so first-time visitors actually find them. Each card is
   a chunky linkable tile with iconography that tells you what mode it
   is at a glance. */
type Mode = {
  href: string;
  badge: string | 'MTA';
  badgeBg: string;
  title: string;
  sub: string;
  accent: string;
  cta?: string;
};
const MODES: Mode[] = [
  {
    href: '/turnstile',
    badge: 'MTA',
    badgeBg: '#000',
    title: 'Hop the Turnstile',
    sub: 'pick any line · transfer mid-ride · door window = nyc cam',
    accent: '#FF6319',
    cta: '▸ PUSH',
  },
  {
    href: '/geoguessr',
    badge: '?',
    badgeBg: '#FFD600',
    title: 'Cam GeoGuessr',
    sub: '5 rounds · pin the cam on the map · share to challenge',
    accent: '#FFD600',
  },
  {
    href: '/scratch',
    badge: '$',
    badgeBg: '#d11a2a',
    title: 'Scratch-Off',
    sub: 'collect $1 in coins · scratch for cash · refund quarters',
    accent: '#d11a2a',
    cta: '★ NEW',
  },
  {
    href: '/game',
    badge: '25¢',
    badgeBg: '#B5F500',
    title: "Jimmy's Arcade",
    sub: 'type nyc slang · 3 difficulties · grab quarters from the lounge',
    accent: '#B5F500',
  },
  {
    href: '/shrine',
    badge: '✦',
    badgeBg: '#0039A6',
    title: 'Mamdani Shrine',
    sub: 'civic temple · live council bills · scriptures of the platform',
    accent: '#FFD600',
  },
  {
    href: '/poi',
    badge: '🌉',
    badgeBg: '#FF6319',
    title: 'POI Feed',
    sub: 'cameras with a point of interest · classified once · static',
    accent: '#FF6319',
    cta: '★ NEW',
  },
];

function ModesRack() {
  return (
    <section
      className="mt-4 px-3 py-3 border-2 border-[#FFD600]/55 bg-black/55"
      style={{ boxShadow: '4px 4px 0 #d11a2a' }}
      aria-label="More modes at the deli"
    >
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-bungee text-[14px] uppercase tracking-[0.04em] text-[#FFD600]">
          ★ More at the Deli
        </span>
        <span className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/55">
          back rooms · pick a door
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
        {MODES.map((m) => (
          <a
            key={m.href}
            href={m.href}
            className="group relative bg-[#0a0a14] border-2 border-white/15 hover:border-[color:var(--accent)] hover:bg-black px-2.5 pt-2 pb-6 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            style={{ ['--accent' as string]: m.accent }}
          >
            <div className="flex items-start gap-2">
              {m.badge === 'MTA' ? (
                <MtaLogo size={26} />
              ) : (
                <span
                  className="grid place-items-center w-7 h-7 rounded-full font-bungee text-[12px] leading-none shrink-0"
                  style={{ background: m.badgeBg, color: m.badgeBg === '#FFD600' || m.badgeBg === '#B5F500' ? '#000' : '#fff' }}
                >
                  {m.badge}
                </span>
              )}
              <span
                className="font-bungee text-[12px] sm:text-[13px] uppercase leading-tight tracking-[0.02em] group-hover:text-[color:var(--accent)] transition-colors min-w-0 break-words"
                style={{ color: '#fff' }}
              >
                {m.title}
              </span>
            </div>
            <div className="font-typewriter text-[9px] uppercase tracking-[0.16em] text-white/65 mt-1.5 line-clamp-2">
              {m.sub}
            </div>
            <div className="absolute bottom-1 left-2 right-2 flex items-center justify-between gap-2">
              {m.cta ? (
                <span
                  className="font-bungee text-[8.5px] tracking-[0.16em] uppercase px-1.5 py-0.5"
                  style={{
                    background: m.accent,
                    color: m.accent === '#FFD600' || m.accent === '#B5F500' ? '#000' : '#fff',
                    boxShadow: '2px 2px 0 #000',
                  }}
                >
                  {m.cta}
                </span>
              ) : <span />}
              <span className="font-typewriter text-[9px] tracking-[0.22em] uppercase text-white/35 group-hover:text-[color:var(--accent)] transition-colors">
                go →
              </span>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

function FooterMatchbook() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setIdx((x) => (x + 1) % NYC_FOOD.length), 6000);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="shrink-0 border-t border-white/10 bg-black/60 backdrop-blur-sm px-4 py-1.5 flex items-center gap-3 text-[9px] uppercase tracking-[0.22em] font-typewriter text-white/55 z-30">
      <span>★</span>
      <span>Public-domain footage, NYC DOT</span>
      <span className="text-white/25">·</span>
      <span>954 cams, perpetual broadcast</span>
      <span className="text-white/25 hidden md:inline">·</span>
      <span className="hidden md:inline text-[#FFD600]/80">today’s special: <span className="text-white/85">{NYC_FOOD[idx]}</span></span>
      <span className="ml-auto flex items-center gap-3">
        <a href="/about" className="hover:text-[#FFD600] transition-colors">about ?</a>
      </span>
    </div>
  );
}

/* ────────────────────────── extras ────────────────────────── */

/* Left rail: a printed-paper "TONIGHT'S LINEUP" strip — newsstand insert vibe.
   Lists what's currently on, what's coming up, and the active alert count. */
function ChannelGuide({
  alerts,
  currentCameraId,
  channelNumber,
  onTune,
}: {
  alerts: Alert[];
  currentCameraId: string | null;
  channelNumber: number;
  onTune?: (a: Alert) => void;
}) {
  const upcoming = alerts
    .filter((a) => !a.resolved_at && a.severity >= 5 && a.camera_id !== currentCameraId)
    .slice(0, 6);
  const stamp = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <div className="hidden lg:flex flex-col gap-3 self-start">
    <aside
      className="text-[#1a1410] font-typewriter relative"
      style={{
        background: 'repeating-linear-gradient(180deg, #f3e9c0 0px, #f3e9c0 22px, #ecdfa9 22px, #ecdfa9 23px)',
        boxShadow: '4px 6px 0 rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.18)',
        borderLeft: '6px solid #d11a2a',
        padding: '14px 16px 18px',
        transform: 'rotate(-0.5deg)',
      }}
    >
      <div className="flex items-baseline justify-between mb-3 border-b-2 border-black/35 pb-2">
        <div>
          <div className="font-bungee text-[18px] leading-none uppercase tracking-[0.04em]">TV Guide</div>
          <div className="text-[9px] uppercase tracking-[0.3em] mt-1 text-[#1a1410]/65">{stamp} · 25¢</div>
        </div>
        <div className="text-right">
          <div className="font-tabloid text-[13px] leading-none uppercase">Vol. 26</div>
          <div className="text-[8px] uppercase tracking-[0.3em] text-[#1a1410]/55">No. 117</div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-[9px] uppercase tracking-[0.3em] text-[#d11a2a]">★ NOW PLAYING</div>
        <div className="font-bungee text-[14px] leading-tight uppercase">
          CH {String(channelNumber).padStart(2, '0')}
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#1a1410]/75">live traffic surf</div>
      </div>

      <div className="text-[9px] uppercase tracking-[0.3em] text-[#1a1410]/65 mb-1.5">★ Up Next · click to tune</div>
      <ul className="text-[11px] leading-snug space-y-0.5">
        {upcoming.length === 0 && (
          <li className="text-[#1a1410]/55 italic">— quiet streets · b-roll only —</li>
        )}
        {upcoming.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              onClick={() => onTune?.(a)}
              className="w-full text-left flex items-start gap-2 py-1 px-1 -mx-1 hover:bg-[#d11a2a] hover:text-white transition-colors group cursor-pointer"
            >
              <span className="text-[#d11a2a] mt-[3px] group-hover:text-white">●</span>
              <span className="line-clamp-2 uppercase tracking-[0.06em]">
                {a.camera_name ?? a.camera_id}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-4 pt-3 border-t border-dashed border-black/30 text-[10px] uppercase tracking-[0.18em] text-[#1a1410]/65">
        <a href="/about" className="hover:text-[#d11a2a]">how this works →</a>
      </div>
    </aside>

    {/* Below the TV Guide: a compact "POCKET CHANGE" board so the empty
        left rail isn't just dead space. Quick view of the user's
        quarter stash plus a tap-to-find easter-egg coin pile. */}
    <PocketChange />
    </div>
  );
}

/* Small left-rail prop: a sticky-tape "tip jar" / quarter stash card.
   It's also a clickable easter-egg — clicking the cup gives back a
   quarter once every ~90s, so casual exploration is rewarded. */
function PocketChange() {
  const { count, add } = useQuarters();
  // Per-tab cooldown so the click isn't spammable. localStorage keeps it
  // from resetting on every render and respects multiple tabs.
  const [cooldown, setCooldown] = useState<number>(0);
  useEffect(() => {
    const i = setInterval(() => {
      const last = parseInt(localStorage.getItem('nyc-pocket-tap') || '0', 10) || 0;
      const remain = Math.max(0, 90_000 - (Date.now() - last));
      setCooldown(remain);
    }, 1000);
    return () => clearInterval(i);
  }, []);
  const ready = cooldown <= 0;
  const tap = () => {
    if (!ready) return;
    add(1);
    localStorage.setItem('nyc-pocket-tap', String(Date.now()));
    setCooldown(90_000);
  };
  return (
    <aside
      className="text-white font-typewriter px-3 py-3 relative"
      style={{
        background: '#0e0f14',
        border: '2px solid #FFD600',
        boxShadow: '4px 4px 0 #d11a2a',
        transform: 'rotate(0.6deg)',
      }}
      aria-label="Pocket change · quarter stash and quick links"
    >
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-bungee text-[14px] uppercase tracking-[0.04em] text-[#FFD600]">★ Pocket Change</span>
        <span className="text-[9px] uppercase tracking-[0.22em] text-white/45">cash only</span>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <QuarterIcon size={28} />
        <div>
          <div className="font-tabloid text-[28px] tabular leading-none text-white">×{count}</div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-white/55">quarters · ${(count * 0.25).toFixed(2)}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={tap}
        disabled={!ready}
        className="w-full px-2 py-1.5 font-bungee text-[11px] uppercase tracking-[0.06em] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        style={{
          background: ready ? '#FFD600' : '#2a2a2e',
          color: ready ? '#000' : 'rgba(255,255,255,0.5)',
          border: '2px solid #000',
          boxShadow: ready ? '3px 3px 0 #d11a2a' : 'none',
        }}
        title="tap the jar — easter egg, gives a quarter every ~90s"
      >
        {ready ? '★ TAP THE JAR · +1 ¢' : `cooldown · ${Math.ceil(cooldown / 1000)}s`}
      </button>
      <div className="mt-3 pt-2 border-t border-dashed border-white/15 grid gap-1">
        <a href="/scratch" className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-white/85 hover:text-[#FFD600]">
          <span>★ scratch-off</span><span className="text-white/35">$1 →</span>
        </a>
        <a href="/turnstile" className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-white/85 hover:text-[#FFD600]">
          <span>★ hop the turnstile</span><span className="text-white/35">25¢ →</span>
        </a>
        <a href="/game" className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-white/85 hover:text-[#FFD600]">
          <span>★ jimmy's arcade</span><span className="text-white/35">25¢ →</span>
        </a>
      </div>
      <div className="mt-2 text-[8.5px] uppercase tracking-[0.22em] text-white/45 leading-snug">
        ★ rolling quarters drift across the bottom · check the rat, the cat, the cup, the hydrant
      </div>
    </aside>
  );
}

/* Right rail: NYC city services snapshot — subway bullets, weather, dollar
   slice index, and a fake (but plausible) lottery number block. */
/* The current local NYC hour + weekday, refreshed every minute. */
function useNycMoment() {
  const get = () => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const hour = parseInt(fmt.find((p) => p.type === 'hour')?.value ?? '0', 10) || 0;
    const weekday = fmt.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    return { hour, weekday };
  };
  const [m, setM] = useState(get);
  useEffect(() => {
    const i = setInterval(() => setM(get()), 60_000);
    return () => clearInterval(i);
  }, []);
  return m;
}

/* "What's good right now" — copy keyed by local NYC hour and weekday.
   Hard-coded windows; no API. The point is the voice. */
function rightNowCopy(hour: number, weekday: string): { headline: string; sub: string; vibe: string } {
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  if (hour >= 2 && hour < 5)   return { headline: 'Dead Hours', sub: '3 a.m. is for cabs and ghosts.',                         vibe: 'BQE wide open · no honking · go home' };
  if (hour >= 5 && hour < 7)   return { headline: 'First Light', sub: 'Bagel guys are firing up the boilers.',                  vibe: 'wholesale flowers · garbage trucks · the city stretches' };
  if (hour >= 7 && hour < 9)   return { headline: 'Morning Rush', sub: 'Schools dump out, BQE plugs up.',                       vibe: 'expect delays · 4/5/6 packed · don\'t be the guy holding the door' };
  if (hour >= 9 && hour < 12)  return { headline: 'Coffee Hours', sub: weekend ? 'Brunch line at the diner already deep.' : 'The city has logged in.', vibe: 'cabs angry · contractors double-parked · runners on the bridge' };
  if (hour >= 12 && hour < 14) return { headline: 'Lunch Rush', sub: 'Halal carts deep, slice line out the door.',              vibe: 'midtown deadlocked · cyclists weaving · don\'t call it lunch break' };
  if (hour >= 14 && hour < 16) return { headline: 'School\'s Out', sub: 'Kids back on the trains, block parties starting.',      vibe: 'avoid the L · ice cream truck on every corner' };
  if (hour >= 16 && hour < 19) return { headline: 'Evening Rush', sub: 'BQE solid, FDR a parking lot.',                          vibe: 'expect delays · don\'t take the GW · take the bridge instead' };
  if (hour >= 19 && hour < 22) return { headline: weekend ? 'Friday Energy' : 'Dinner Hours', sub: weekend ? 'L train chaos starts now.' : 'Bodegas firing up the chopped cheese.', vibe: 'cabs full · subway tolerable · LES picking up' };
  if (hour >= 22 || hour < 2)  return { headline: 'Late Hours', sub: 'Dollar slice index: holding firm.',                       vibe: 'last call coming · 4 train running local · take a yellow not an uber' };
  return { headline: 'Right Now', sub: 'NYC is up to something.', vibe: 'tune in' };
}

function RightNowCard() {
  const { hour, weekday } = useNycMoment();
  const c = rightNowCopy(hour, weekday);
  return (
    <div
      className="bg-[#FFD600] text-black px-3 py-3"
      style={{ boxShadow: '4px 4px 0 rgba(0,0,0,0.7)' }}
    >
      <div className="flex items-baseline justify-between border-b-2 border-black/30 pb-1.5 mb-2">
        <span className="font-bungee text-[13px] uppercase tracking-[0.04em]">★ Right Now</span>
        <span className="text-[8px] uppercase tracking-[0.3em] text-black/55 tabular">
          {weekday} · {String(hour).padStart(2, '0')}:00 et
        </span>
      </div>
      <div className="font-tabloid text-[18px] leading-tight uppercase">{c.headline}</div>
      <div className="text-[11px] mt-1 text-black/85">{c.sub}</div>
      <div className="mt-2 pt-1 border-t border-black/25 text-[10px] uppercase tracking-[0.16em] text-black/70">
        {c.vibe}
      </div>
    </div>
  );
}

/* Live MTA route status from subwaynow.app — public CORS-friendly
   feed sourced from MTA GTFS-RT. Refreshes every 90s. */
type MtaRoute = { id: string; status: string; color: string; text_color?: string };
function useMtaRoutes() {
  const [routes, setRoutes] = useState<MtaRoute[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await fetch('https://api.subwaynow.app/routes');
        if (!r.ok) throw new Error('mta http ' + r.status);
        const j = await r.json();
        if (stop) return;
        const out: MtaRoute[] = [];
        for (const route of Object.values<Record<string, unknown>>(j.routes ?? {})) {
          out.push({
            id: String(route.id ?? ''),
            status: String(route.status ?? 'Good Service'),
            color: String(route.color ?? '#666'),
            text_color: typeof route.text_color === 'string' ? route.text_color : undefined,
          });
        }
        setRoutes(out);
        setError(false);
      } catch {
        if (!stop) setError(true);
      }
    };
    load();
    const i = setInterval(load, 90_000);
    return () => { stop = true; clearInterval(i); };
  }, []);
  return { routes, error };
}

function MtaServicePanel() {
  const { routes, error } = useMtaRoutes();
  const trouble = routes.filter(
    (r) => r.status && r.status.toLowerCase() !== 'good service',
  );
  const summary = error
    ? 'mta feed unreachable'
    : routes.length === 0
      ? 'loading…'
      : trouble.length === 0
        ? 'good service all lines'
        : `${trouble.length} line${trouble.length === 1 ? '' : 's'} disrupted`;
  return (
    <div className="bg-[#003B70] border-2 border-[#FFD600] px-3 py-3" style={{ boxShadow: '4px 4px 0 rgba(0,0,0,0.6)' }}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-bungee text-[14px] uppercase tracking-[0.04em] text-[#FFD600]">MTA Service</div>
        <div className={`text-[8px] uppercase tracking-[0.3em] ${error || trouble.length ? 'text-[#ff5582]' : 'text-white/70'}`}>{summary}</div>
      </div>

      {/* All bullets — colored normally, dimmed if in good service when delays exist
          so the eye lands on the troubled lines. */}
      <div className="flex flex-wrap gap-1.5">
        {routes.length === 0 && (
          <div className="text-[9px] uppercase tracking-[0.22em] text-white/55">…</div>
        )}
        {routes.map((r) => {
          const ok = r.status.toLowerCase() === 'good service';
          return (
            <span
              key={r.id}
              className="subway-bullet text-[11px]"
              style={{
                background: r.color,
                color: r.text_color || '#fff',
                opacity: trouble.length ? (ok ? 0.35 : 1) : 1,
              }}
              title={`${r.id}: ${r.status}`}
            >
              {r.id}
            </span>
          );
        })}
      </div>

      {/* Trouble list — short status lines for the affected routes */}
      {trouble.length > 0 && (
        <ul className="mt-3 space-y-1 text-[10px] uppercase tracking-[0.12em] font-typewriter">
          {trouble.slice(0, 6).map((r) => (
            <li key={r.id} className="flex items-baseline gap-2">
              <span
                className="subway-bullet text-[10px] shrink-0"
                style={{ background: r.color, color: r.text_color || '#fff' }}
              >
                {r.id}
              </span>
              <span className="text-white/85 line-clamp-2">{r.status.toLowerCase()}</span>
            </li>
          ))}
          {trouble.length > 6 && (
            <li className="text-[9px] tracking-[0.2em] text-white/45">+ {trouble.length - 6} more</li>
          )}
        </ul>
      )}

      <div className="mt-2 text-[8px] uppercase tracking-[0.22em] text-white/45">
        feed: subwaynow.app · refreshed 90s
      </div>
    </div>
  );
}

function CityServicesRail({ alerts, cameras }: { alerts: Alert[]; cameras: Camera[] }) {
  const active = alerts.filter((a) => !a.resolved_at);
  const sevHigh = active.filter((a) => a.severity >= 7).length;
  const polled = cameras.length;
  // Pick a stable (per-day) faux Pick-3 / Pick-4 set so the page feels alive
  // but doesn't change on every rerender.
  const day = Math.floor(Date.now() / 86_400_000);
  const pick3 = String(((day * 137) % 1000)).padStart(3, '0');
  const pick4 = String(((day * 911) % 10_000)).padStart(4, '0');
  const win4 = String(((day * 401) % 10_000)).padStart(4, '0');
  return (
    <aside className="hidden lg:flex flex-col gap-3 self-stretch text-white">
      <RightNowCard />

      <MtaServicePanel />

      {/* Lottery / city stats — newspaper-back-page energy */}
      <div className="bg-[#0b0b14] border border-[#FFD600] px-3 py-3" style={{ boxShadow: '4px 4px 0 #d11a2a' }}>
        <div className="flex items-baseline justify-between border-b border-[#FFD600]/30 pb-1.5 mb-2">
          <span className="font-bungee text-[13px] uppercase tracking-[0.04em] text-[#FFD600]">NY Lotto</span>
          <span className="text-[8px] uppercase tracking-[0.3em] text-white/55">midday draw</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <NumberBox label="NUMBERS" digits={pick3} />
          <NumberBox label="WIN 4" digits={pick4} />
          <NumberBox label="TAKE 5" digits={win4} />
        </div>
        <div className="mt-2 text-[9px] uppercase tracking-[0.22em] text-white/55">
          for entertainment · pull a quarter, play arcade
        </div>
      </div>

      {/* "Vital signs" stats panel */}
      <div className="bg-black/55 border border-[#FFD600]/40 px-3 py-3 backdrop-blur-sm">
        <div className="font-bungee text-[13px] uppercase tracking-[0.04em] text-[#FFD600] mb-2">
          City Vitals
        </div>
        <ul className="text-[11px] font-typewriter uppercase tracking-[0.14em] text-white/85 space-y-1">
          <li className="flex justify-between"><span className="text-white/55">cameras online</span><span className="tabular text-[#FFD600]">{polled}</span></li>
          <li className="flex justify-between"><span className="text-white/55">live alerts</span><span className="tabular text-[#ff5582]">{active.length}</span></li>
          <li className="flex justify-between"><span className="text-white/55">heavy (sev≥7)</span><span className="tabular text-[#ff5582]">{sevHigh}</span></li>
          <li className="flex justify-between"><span className="text-white/55">$ slice index</span><span className="tabular text-[#FFD600]">$1.50</span></li>
          <li className="flex justify-between"><span className="text-white/55">subway swipe</span><span className="tabular text-[#FFD600]">$2.90</span></li>
        </ul>
      </div>
    </aside>
  );
}

function NumberBox({ label, digits }: { label: string; digits: string }) {
  return (
    <div className="text-center">
      <div className="text-[8px] uppercase tracking-[0.22em] text-white/55 mb-1">{label}</div>
      <div className="flex justify-center gap-0.5">
        {digits.split('').map((d, i) => (
          <span
            key={i}
            className="font-crt text-[18px] leading-none px-1.5 py-1 bg-black border border-[#FFD600]/40 text-[#FFD600] tabular"
            style={{ textShadow: '0 0 6px #FFD600cc' }}
          >
            {d}
          </span>
        ))}
      </div>
    </div>
  );
}

/* NYC 311 Open Data — recent service requests (noise complaints,
   pothole reports, water main, etc.) for the bottom ticker. The
   endpoint is CORS-* and responds with raw JSON, no auth. */
type T311 = { created_date: string; complaint_type: string; descriptor?: string; incident_address?: string; borough?: string };
function use311() {
  const [items, setItems] = useState<T311[]>([]);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const url =
          'https://data.cityofnewyork.us/resource/erm2-nwe9.json' +
          '?$select=created_date,complaint_type,descriptor,incident_address,borough' +
          '&$order=created_date DESC&$limit=20';
        const r = await fetch(url);
        if (!r.ok) return;
        const j = (await r.json()) as T311[];
        if (!stop) setItems(j);
      } catch { /* swallow — ticker has fallback */ }
    };
    load();
    const i = setInterval(load, 5 * 60_000);
    return () => { stop = true; clearInterval(i); };
  }, []);
  return items;
}

function fmt311Age(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / (24 * 60))}d ago`;
}

/* City activity ticker — pure NYC: 311 service requests, MTA service
   disruptions, and a few static "city is alive" lines as filler. No
   camera alerts; the TV chyron carries that. */
function TimesSquareTicker() {
  const requests311 = use311();
  const { routes: mta } = useMtaRoutes();

  const lines311 = requests311.slice(0, 12).map((c) => {
    const where = [c.incident_address, c.borough].filter(Boolean).join(' · ').toUpperCase();
    const what = (c.descriptor || c.complaint_type).toUpperCase();
    return `◉ 311 · ${what} · ${where || 'NYC'} · ${fmt311Age(c.created_date)}`;
  });
  const linesMta = mta
    .filter((r) => r.status && r.status.toLowerCase() !== 'good service')
    .slice(0, 8)
    .map((r) => `🚇 MTA · ${r.id} · ${r.status.toUpperCase()}`);
  // Static "alive" lines — keep the loop visibly NYC even when feeds are quiet
  const linesAlive = [
    '★ NYC · 8.4M PEOPLE · 24/7',
    '★ DOLLAR SLICE INDEX · HOLDING STEADY',
    '★ HALAL CART OF THE WEEK · 53RD & 6TH',
    '★ ALT-SIDE PARKING IN EFFECT',
    '★ EAST RIVER FERRY · ON TIME',
  ];
  const interleaved: string[] = [];
  const max = Math.max(lines311.length, linesMta.length);
  for (let i = 0; i < max; i++) {
    if (lines311[i]) interleaved.push(lines311[i]);
    if (linesMta[i]) interleaved.push(linesMta[i]);
    if (i < linesAlive.length && (i % 3 === 2)) interleaved.push(linesAlive[i % linesAlive.length]);
  }
  const filler = interleaved.length === 0 ? linesAlive : interleaved;
  const track = [...filler, ...filler];
  return (
    <div className="shrink-0 ticker-led border-y border-[#FFD600]/35 overflow-hidden">
      <div className="ticker-track py-1 text-[#ff8a3a] font-crt text-[18px] tracking-[0.05em] uppercase">
        {track.map((line, i) => (
          <span key={i} className="px-3" style={{ textShadow: '0 0 6px #ff8a3a, 0 0 14px #ff8a3a55' }}>
            {line}
          </span>
        ))}
      </div>
    </div>
  );
}

function HotkeysPanel({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="bg-[#0b0b14] border border-[#FFD600] p-6 max-w-[420px] w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <div className="font-bungee text-[#FFD600] text-2xl uppercase tracking-[0.06em] mb-3">Channel Guide</div>
        <ul className="space-y-2 text-sm font-typewriter uppercase tracking-[0.16em] text-white/85">
          <li><kbd className="text-[#FFD600]">space</kbd> · spin the roulette</li>
          <li><kbd className="text-[#FFD600]">L</kbd> · lock current channel</li>
          <li><kbd className="text-[#FFD600]">click TV</kbd> · same as L</li>
          <li><kbd className="text-[#FFD600]">esc</kbd> · close / unlock</li>
          <li><kbd className="text-[#FFD600]">?</kbd> · this menu</li>
          <li className="pt-2 text-white/45">try ↑↑↓↓←→←→BA</li>
        </ul>
      </div>
    </div>
  );
}

function MetroCardIntro() {
  // Faithful pastiche of the iconic gold MTA MetroCard: gold gradient
  // body, top-left MTA roundel, big italic blue "MetroCard" wordmark
  // skewed against the slope, the black magnetic stripe along the
  // bottom, and the yellow ribbon with chevron arrows + "Insert this
  // way / This side facing you". One swipe in, hold ~3s, swipe out.
  return (
    <div className="fixed inset-0 z-[60] pointer-events-none overflow-hidden bg-black/75 backdrop-blur-sm grid place-items-center">
      <div
        className="metrocard relative"
        style={{
          width: 'min(620px, 88vw)',
          aspectRatio: '1.586 / 1',
          borderRadius: 14,
          overflow: 'hidden',
          background:
            'linear-gradient(135deg, #F8B11C 0%, #FBC93B 38%, #F2A50C 70%, #C77F00 100%)',
          boxShadow: '0 30px 70px rgba(0,0,0,0.7), 0 8px 22px rgba(0,0,0,0.5), inset 0 0 0 2px #ffffff66',
          animation: 'metrocard-swipe 4.2s cubic-bezier(.4,.0,.2,1) forwards',
        }}
      >
        {/* Glossy laminate sheen in upper-left */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at 28% 22%, #ffffff66 0%, transparent 48%)',
            mixBlendMode: 'screen',
          }}
        />

        {/* MTA roundel — yellow disc with white "MTA" */}
        <div
          className="absolute"
          style={{
            top: '7%',
            left: '5%',
            width: '21%',
            aspectRatio: '1',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 35%, #FFE066 0%, #E8A317 60%, #B17600 100%)',
            boxShadow: 'inset 0 0 0 3px #ffffff55, 0 4px 12px #00000044',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: '"Bungee", "Helvetica Neue", sans-serif',
            color: '#FFF8DC',
            fontSize: 'clamp(18px, 4.5vw, 36px)',
            fontWeight: 900,
            textShadow: '2px 2px 0 #00000044',
            letterSpacing: '0.04em',
          }}
        >
          MTA
        </div>

        {/* Big italic blue MetroCard wordmark */}
        <div
          className="absolute"
          style={{
            top: '20%',
            left: '5%',
            right: '5%',
            fontFamily: '"Bungee", "Helvetica Neue", sans-serif',
            fontWeight: 900,
            fontStyle: 'italic',
            fontSize: 'clamp(34px, 9.5vw, 84px)',
            lineHeight: 0.95,
            color: '#0039A6',
            letterSpacing: '-0.02em',
            transform: 'skewX(-10deg)',
            textShadow: '4px 4px 0 #00000022, 6px 6px 14px #00000055',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          MetroCard<sup style={{ fontSize: '0.32em', marginLeft: 4 }}>®</sup>
        </div>

        {/* Subtle nyc·traffic·cam·co micro-print row, like the wave pattern on the real card */}
        <div
          className="absolute"
          style={{
            top: '53%',
            left: '6%',
            right: '6%',
            fontFamily: '"IBM Plex Mono", monospace',
            fontSize: 'clamp(9px, 1.3vw, 13px)',
            color: '#0039A6',
            opacity: 0.7,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
          }}
        >
          ★ NYC Traffic Cam Co. · Single Fare · Unlimited Rides Through The City's Feeds
        </div>

        {/* Black magnetic stripe */}
        <div
          className="absolute inset-x-0"
          style={{
            bottom: '14%',
            height: '13%',
            background: 'linear-gradient(180deg, #1a1a1a 0%, #050505 50%, #1a1a1a 100%)',
            boxShadow: 'inset 0 1px 0 #ffffff22, inset 0 -1px 0 #00000088',
          }}
        />

        {/* Yellow instruction ribbon — Insert this way · This side facing you */}
        <div
          className="absolute inset-x-0 flex items-center justify-between px-3"
          style={{
            bottom: 0,
            height: '14%',
            background: 'linear-gradient(180deg, #FFD600 0%, #F6B800 100%)',
            borderTop: '1px solid #00000033',
            fontFamily: '"Bungee", "Helvetica Neue", sans-serif',
            fontSize: 'clamp(9px, 1.4vw, 15px)',
            color: '#000',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            fontWeight: 900,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <MetroChevrons /> Insert this way
          </span>
          <span style={{ flex: 1, textAlign: 'center', color: '#fff', textShadow: '1px 1px 0 #000' }}>
            ◀ This side facing you ◀
          </span>
        </div>
      </div>
      <style>{`
        @keyframes metrocard-swipe {
          0%   { transform: translateX(140vw) rotate(2deg) skewX(-4deg); }
          18%  { transform: translateX(0) rotate(0deg) skewX(0); }
          82%  { transform: translateX(0) rotate(0deg) skewX(0); opacity: 1; }
          100% { transform: translateX(-150vw) rotate(-3deg) skewX(4deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

function MetroChevrons() {
  return (
    <span style={{ display: 'inline-flex', gap: 2 }}>
      <span style={{ opacity: 0.55 }}>◀</span>
      <span style={{ opacity: 0.8 }}>◀</span>
      <span>◀</span>
    </span>
  );
}
