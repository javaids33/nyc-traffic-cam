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

  // Channel-surf: pick the next thing to put on screen.
  // Priority: worthwhile alerts (sev ≥ 5, not boring kinds), else a random camera.
  const focusRef = useRef<Channel | null>(focus);
  useEffect(() => {
    focusRef.current = focus;
  }, [focus]);

  const camerasRef = useRef<Camera[]>(cameras);
  useEffect(() => { camerasRef.current = cameras; }, [cameras]);
  const alertsRef = useRef<Alert[]>(alerts);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

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

  const surfNext = useCallback(() => {
    const cur = focusRef.current;
    const allAlerts = alertsRef.current;
    const allCams = camerasRef.current;
    const b = boroughRef.current;

    const worthwhile = allAlerts.filter(
      (a) =>
        !a.resolved_at &&
        a.severity >= 5 &&
        a.kind !== 'static_feed' &&
        a.kind !== 'camera_offline' &&
        (b === 'ALL' || rough_borough(a.lat, a.lng) === b),
    );

    let next: Channel | null = null;

    if (worthwhile.length > 0) {
      // Avoid landing on the same camera if we have other options.
      const others = worthwhile.filter((a) => a.camera_id !== cur?.cameraId);
      const pool = others.length ? others : worthwhile;
      // Weight by severity so spicier alerts come up more often.
      const weights = pool.map((a) => a.severity * a.severity);
      const total = weights.reduce((s, w) => s + w, 0);
      let r = Math.random() * total;
      let chosen = pool[0];
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) { chosen = pool[i]; break; }
      }
      next = {
        cameraId: chosen.camera_id,
        caption: {
          title: chosen.camera_name ?? chosen.camera_id,
          subtitle: chosen.message,
          meta: `${ALERT_LABELS_LONG[chosen.kind] ?? chosen.kind} · SEV ${chosen.severity} · ${rough_borough(chosen.lat, chosen.lng)}`,
          coords: { lat: chosen.lat, lng: chosen.lng },
          occurrences: chosen.occurrence_count,
        },
      };
    } else if (allCams.length) {
      const inBorough = b === 'ALL' ? allCams : allCams.filter((c) => rough_borough(c.lat, c.lng) === b);
      const baseline = inBorough.length ? inBorough : allCams;
      const others = baseline.filter((c) => c.id !== cur?.cameraId && c.last_polled_at);
      const pool = others.length ? others : baseline;
      const c = pool[Math.floor(Math.random() * pool.length)];
      next = {
        cameraId: c.id,
        caption: {
          title: c.name ?? c.id,
          subtitle: 'just vibes',
          meta: `B-ROLL · ${rough_borough(c.lat, c.lng)}`,
          coords: { lat: c.lat, lng: c.lng },
        },
      };
    }

    if (next) flipTo(next);
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

  // MetroCard intro: dismiss after 1.6s and remember in sessionStorage
  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => {
      setIntro(false);
      try { sessionStorage.setItem('nyc-cam-seen', '1'); } catch { /* noop */ }
    }, 1600);
    return () => clearTimeout(t);
  }, [intro]);

  // Keyboard hotkeys: 1-9 channel jump, L lock, ? hotkeys panel, ESC close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key >= '1' && e.key <= '9') {
        // Pick the Nth active worthwhile alert (or fall back to surfNext)
        const worthwhile = alertsRef.current.filter(
          (a) => !a.resolved_at && a.severity >= 5 && a.kind !== 'static_feed' && a.kind !== 'camera_offline',
        );
        const i = parseInt(e.key, 10) - 1;
        if (worthwhile[i]) {
          flipTo({
            cameraId: worthwhile[i].camera_id,
            caption: {
              title: worthwhile[i].camera_name ?? worthwhile[i].camera_id,
              subtitle: worthwhile[i].message,
              meta: `${ALERT_LABELS_LONG[worthwhile[i].kind] ?? worthwhile[i].kind} · SEV ${worthwhile[i].severity} · ${rough_borough(worthwhile[i].lat, worthwhile[i].lng)}`,
              coords: { lat: worthwhile[i].lat, lng: worthwhile[i].lng },
              occurrences: worthwhile[i].occurrence_count,
            },
          });
        } else {
          surfNext();
        }
      } else if (e.key === 'l' || e.key === 'L') {
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
  }, [flipTo, surfNext]);

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
                tuning {alerts.filter((a) => !a.resolved_at && a.severity >= 5).length} live · {cameras.length} cams
              </span>
            </div>
          </div>

          <CityServicesRail alerts={alerts} cameras={cameras} />
        </div>
      </main>

      <TimesSquareTicker alerts={alerts} />
      <FooterMatchbook />

      <StreetFauna ratMode={ratMode} />

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

function CornerBrasstack() {
  // Easter-egg corner — Greek "We Are Happy To Serve You" coffee cup with steam.
  return (
    <div className="absolute right-6 bottom-32 z-10 pointer-events-none hidden md:block" aria-hidden>
      {/* steam */}
      <div className="relative h-10 w-12 mx-auto">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="absolute bottom-0 left-1/2 w-6 h-8 rounded-full"
            style={{
              background:
                'radial-gradient(ellipse at center, rgba(220,225,235,0.55), rgba(220,225,235,0))',
              transform: 'translateX(-50%)',
              animation: `steam-drift ${4 + i}s ease-out infinite`,
              animationDelay: `${i * 1.3}s`,
            }}
          />
        ))}
      </div>
      <svg viewBox="0 0 80 90" width="78" height="86">
        {/* cup body (taper) */}
        <defs>
          <linearGradient id="cupBody" x1="0" x2="1">
            <stop offset="0%" stopColor="#0a3a82" />
            <stop offset="100%" stopColor="#0049b0" />
          </linearGradient>
        </defs>
        <path d="M 10 28 L 18 86 L 62 86 L 70 28 Z" fill="#fff" stroke="#0a3a82" strokeWidth="1.5" />
        {/* blue band */}
        <path d="M 12.6 38 L 17.6 76 L 62.4 76 L 67.4 38 Z" fill="url(#cupBody)" />
        {/* gold meander (super simplified) */}
        <g stroke="#FFD600" strokeWidth="1" fill="none" opacity="0.95">
          <path d="M 18 50 L 22 50 L 22 46 L 26 46 L 26 50 L 30 50" />
          <path d="M 34 50 L 38 50 L 38 46 L 42 46 L 42 50 L 46 50" />
          <path d="M 50 50 L 54 50 L 54 46 L 58 46 L 58 50 L 62 50" />
        </g>
        {/* "WE ARE HAPPY TO SERVE YOU" text — tiny */}
        <text x="40" y="64" textAnchor="middle" fontSize="3.5" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="0.4">
          WE ARE HAPPY
        </text>
        <text x="40" y="69" textAnchor="middle" fontSize="3.5" fill="#fff" fontFamily="Arial, sans-serif" letterSpacing="0.4">
          TO SERVE YOU
        </text>
        {/* lid rim */}
        <ellipse cx="40" cy="28" rx="30" ry="5" fill="#1a1a1a" />
        <ellipse cx="40" cy="27" rx="30" ry="4" fill="#0a3a82" />
      </svg>
    </div>
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
        <a href="/game" className="hover:text-[#FFD600] transition-colors">Jimmy's Arcade ★</a>
        <span className="text-white/25">·</span>
        <a href="/about" className="hover:text-[#FFD600] transition-colors">about ?</a>
        <span className="text-white/25">·</span>
        <a href="/dashboard" className="text-[#FFD600]/80 hover:text-[#FFD600] transition-colors">/dashboard →</a>
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

function TimesSquareTicker({ alerts }: { alerts: Alert[] }) {
  const requests311 = use311();
  const camLines = alerts
    .filter((a) => !a.resolved_at && a.severity >= 5)
    .slice(0, 8)
    .map((a) => `★ CAM SEV ${a.severity} · ${a.camera_name ?? a.camera_id}`);
  const lines311 = requests311.slice(0, 8).map((c) => {
    const where = [c.incident_address, c.borough].filter(Boolean).join(' · ').toUpperCase();
    const what = (c.descriptor || c.complaint_type).toUpperCase();
    return `◉ 311 · ${what} · ${where || 'NYC'} · ${fmt311Age(c.created_date)}`;
  });
  // Interleave so the two streams alternate.
  const interleaved: string[] = [];
  const max = Math.max(camLines.length, lines311.length);
  for (let i = 0; i < max; i++) {
    if (camLines[i]) interleaved.push(camLines[i]);
    if (lines311[i]) interleaved.push(lines311[i]);
  }
  const filler = interleaved.length === 0
    ? ['★ STANDBY · CITY IS QUIET · GOOD VIBES', '★ TUNE IN · 954 CAMS · FREE FOREVER', '★ DOLLAR SLICE INDEX: STABLE']
    : interleaved;
  // Duplicate to make the loop seamless
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
          <li><kbd className="text-[#FFD600]">1–9</kbd> · jump to active alert N</li>
          <li><kbd className="text-[#FFD600]">space</kbd> · surf to next channel</li>
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
          animation: 'metrocard-swipe 1.5s cubic-bezier(.4,.0,.2,1) forwards',
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
          0% { transform: translateX(140vw) rotate(2deg) skewX(-4deg); }
          55% { transform: translateX(0) rotate(0deg) skewX(0); }
          85% { transform: translateX(0) rotate(0deg) skewX(0); opacity: 1; }
          100% { transform: translateX(-150vw) rotate(-3deg) skewX(4deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
