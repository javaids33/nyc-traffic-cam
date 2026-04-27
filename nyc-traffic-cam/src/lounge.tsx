import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAlerts, fetchCameras, openAlertSocket } from './api';
import type { Alert, Camera } from './types';
import {
  BodegaAwning,
  BodegaTV,
  CHANNEL_LINEUP,
  StreetFauna,
  type TVCaption,
} from './bodega-tv';
import { QuarterStash, RollingQuarter } from './quarter';
import { AudioPanel } from './audio-panel';
import { recordAlert, recordTune, loreLine } from './cam-lore';

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
  const [alerts, setAlerts] = useState<Alert[]>([]);

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

  // initial fetch
  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
    fetchAlerts({ sinceSeconds: 6 * 3600 }).then(setAlerts).catch(() => {});
  }, []);

  // periodic cameras refresh (status updates)
  useEffect(() => {
    const i = setInterval(() => {
      fetchCameras().then(setCameras).catch(() => {});
    }, 15_000);
    return () => clearInterval(i);
  }, []);

  // live alert stream
  useEffect(() => {
    const close = openAlertSocket((evt) => {
      if (evt.type === 'alert_opened') {
        recordAlert(evt.camera_id);
      }
      if (evt.type === 'alert_opened' || evt.type === 'alert_updated') {
        setAlerts((prev) => {
          const idx = prev.findIndex((a) => a.id === evt.id);
          const merged: Alert = {
            id: evt.id,
            camera_id: evt.camera_id,
            camera_name: evt.camera_name,
            lat: evt.lat,
            lng: evt.lng,
            kind: evt.kind,
            severity: evt.severity,
            message: evt.message,
            details: null,
            thumbnail_b64: idx >= 0 ? prev[idx].thumbnail_b64 : null,
            has_image: evt.has_image ?? (idx >= 0 ? prev[idx].has_image : false),
            created_at: idx >= 0 ? prev[idx].created_at : evt.created_at ?? evt.updated_at,
            updated_at: evt.updated_at,
            resolved_at: null,
            occurrence_count: evt.occurrence_count,
          };
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = merged;
            return next;
          }
          return [merged, ...prev].slice(0, 200);
        });
      } else if (evt.type === 'alert_resolved') {
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === evt.alert_id ? { ...a, resolved_at: Math.floor(Date.now() / 1000) } : a,
          ),
        );
      }
    });
    return close;
  }, []);

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

      <main className="flex-1 relative flex items-start justify-center px-2 sm:px-6 pt-3 pb-6 overflow-y-auto">
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
            {/* borough filter — local TV station chooser */}
            <div className="mb-2 flex flex-wrap items-center gap-1 px-1 font-typewriter text-[10px] uppercase tracking-[0.18em]">
              <span className="text-white/45 mr-1 hidden sm:inline">tune by borough:</span>
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
                        : 'border-white/20 text-white/65 hover:border-[#FFD600] hover:text-[#FFD600]'
                    }`}
                    title={b.label}
                  >
                    <span className="sm:hidden">{b.short}</span>
                    <span className="hidden sm:inline">{b.label}</span>
                  </button>
                );
              })}
            </div>
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
   awning corner area on wider screens; a quiet bodega counter prop. */
function ScratchOffs() {
  return (
    <div className="pointer-events-none fixed right-2 top-[150px] z-10 hidden 2xl:block" aria-hidden>
      <div
        className="bg-[#0a0a0a] border-2 border-[#FFD600] px-2 py-2"
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
          mega · take 5 · pick 3
        </div>
      </div>
    </div>
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

/* "More at the deli" rack — surfaces the other modes prominently right
   under the TV so first-time visitors actually find them. Each card is
   a chunky linkable tile with iconography that tells you what mode it
   is at a glance. */
const MODES = [
  {
    href: '/turnstile',
    badge: 'F',
    badgeBg: '#FF6319',
    title: 'Hop the Turnstile',
    sub: 'ride blind through 5 stops · door window = nyc cam',
    accent: '#FF6319',
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
    href: '/game',
    badge: '25¢',
    badgeBg: '#B5F500',
    title: "Jimmy's Arcade",
    sub: 'type nyc slang · 3 difficulties · grab quarters from the lounge',
    accent: '#B5F500',
  },
  {
    href: '/about',
    badge: '?',
    badgeBg: '#0039A6',
    title: 'About + Credits',
    sub: 'how this thing works · what is real · what is bit',
    accent: '#0039A6',
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
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {MODES.map((m) => (
          <a
            key={m.href}
            href={m.href}
            className="group relative bg-[#0a0a14] border-2 border-white/15 hover:border-[color:var(--accent)] hover:bg-black px-2.5 py-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            style={{ ['--accent' as string]: m.accent }}
          >
            <div className="flex items-center gap-2">
              <span
                className="grid place-items-center w-7 h-7 rounded-full font-bungee text-[12px] leading-none shrink-0"
                style={{ background: m.badgeBg, color: m.badgeBg === '#FFD600' || m.badgeBg === '#B5F500' ? '#000' : '#fff' }}
              >
                {m.badge}
              </span>
              <span
                className="font-bungee text-[13px] sm:text-[14px] uppercase leading-tight tracking-[0.02em] group-hover:text-[color:var(--accent)] transition-colors"
                style={{ color: '#fff' }}
              >
                {m.title}
              </span>
            </div>
            <div className="font-typewriter text-[9px] uppercase tracking-[0.16em] text-white/65 mt-1.5 line-clamp-2">
              {m.sub}
            </div>
            <span className="absolute bottom-1 right-2 font-typewriter text-[9px] tracking-[0.22em] uppercase text-white/35 group-hover:text-[color:var(--accent)] transition-colors">
              go →
            </span>
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
    <aside
      className="hidden lg:block self-stretch text-[#1a1410] font-typewriter relative"
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
  return (
    <div className="fixed inset-0 z-50 pointer-events-none overflow-hidden bg-black/70 backdrop-blur-sm grid place-items-center">
      <div
        className="metrocard"
        style={{
          width: 360,
          height: 220,
          background: '#FFD600',
          color: '#003B70',
          padding: 18,
          fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
          boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
          animation: 'metrocard-swipe 3.5s cubic-bezier(.4,.0,.2,1) forwards',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1 }}>★ MetroCard</div>
        <div style={{ fontSize: 28, fontWeight: 900, marginTop: 12, lineHeight: 1.05 }}>
          NYC TRAFFIC<br/>CAM CO.
        </div>
        <div style={{ fontSize: 11, marginTop: 12, fontWeight: 600 }}>
          GOOD FOR ONE FARE · UNLIMITED RIDES THROUGH THE CITY'S TRAFFIC FEEDS
        </div>
        <div style={{ fontSize: 11, marginTop: 24, display: 'flex', justifyContent: 'space-between' }}>
          <span>EXP — NEVER</span>
          <span style={{ fontFamily: 'IBM Plex Mono, monospace' }}>0000 0000 0954 LIVE</span>
        </div>
      </div>
      <style>{`
        @keyframes metrocard-swipe {
          0%   { transform: translateX(140vw) rotate(2deg) skewX(-4deg); }
          22%  { transform: translateX(0) rotate(0deg) skewX(0); }
          85%  { transform: translateX(0) rotate(0deg) skewX(0); opacity: 1; }
          100% { transform: translateX(-150vw) rotate(-3deg) skewX(4deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
