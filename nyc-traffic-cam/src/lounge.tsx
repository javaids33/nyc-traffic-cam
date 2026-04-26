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

function rough_borough(lat: number, lng: number): string {
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

    const worthwhile = allAlerts.filter(
      (a) =>
        !a.resolved_at &&
        a.severity >= 5 &&
        a.kind !== 'static_feed' &&
        a.kind !== 'camera_offline',
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
      const others = allCams.filter((c) => c.id !== cur?.cameraId && c.last_polled_at);
      const pool = others.length ? others : allCams;
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
      <BodegaAwning
        rightSlot={
          <a
            href="/dashboard"
            className="ml-2 px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
          >
            Mission Control →
          </a>
        }
      />
      <QuarterStash />
      <RollingQuarter />

      <main className="flex-1 relative flex items-center justify-center px-6 pb-12 overflow-hidden">
        <SkylineBg />
        <CornerBrasstack />

        <div className="w-full max-w-[860px] relative z-10">
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

          <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.22em] font-typewriter text-[#FFD600]/85 px-1">
            <span>
              {locked
                ? '★ LOCKED — TAP SCREEN TO RESUME ★'
                : 'AUTO-SURFING · 18s DWELL · TAP SCREEN TO HOLD'}
            </span>
            <span className="hidden md:inline text-white/45">
              tuning {alerts.filter((a) => !a.resolved_at && a.severity >= 5).length} live · {cameras.length} cams citywide
            </span>
          </div>
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

const NYC_FOOD = [
  'pork roll · egg · cheese',
  'chopped cheese on a roll',
  'bacon egg & cheese',
  'a slice, dollar regular',
  'halal cart over rice',
  'dirty water dog',
  'salt bagel + scallion schmear',
  'pizza rat special',
  'arnold palmer',
  'egg cream, no chocolate',
  'plantains, two ways',
  'bodega coffee, light + sweet',
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

function TimesSquareTicker({ alerts }: { alerts: Alert[] }) {
  const items = alerts
    .filter((a) => !a.resolved_at && a.severity >= 5)
    .slice(0, 18)
    .map((a) => `★ SEV ${a.severity} · ${a.camera_name ?? a.camera_id}`);
  const filler = items.length === 0
    ? ['★ STANDBY · CITY IS QUIET · GOOD VIBES', '★ TUNE IN · 954 CAMS · FREE FOREVER', '★ DOLLAR SLICE INDEX: STABLE']
    : items;
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
