import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MapLibre,
  Marker,
  Source,
  Layer,
  type MapRef,
} from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

/* Self-contained MapLibre style backed by CartoDB's Dark Matter raster
   tiles. They look way better than raw OSM for a dark site — clean
   typography, muted streets, real water polygons. Free tier, no key,
   CORS-friendly. */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
      maxzoom: 20,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d12' } },
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
      paint: {
        'raster-saturation': 0.05,
        'raster-contrast': 0.05,
      },
    },
  ],
};
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';

/* ──────────────────────────────────────────────────────────────────────
   /geoguessr — five rounds of "where in NYC is this traffic cam?"
   The site shows you a live frame from a random NYC DOT cam; you click
   on a NYC map to guess the camera's location. Closer = more points.
   Seed in the URL makes it shareable: send `/geoguessr?seed=ABC123` to
   a friend and they play the same five cameras.
   ──────────────────────────────────────────────────────────────────── */

const ROUNDS = 5;
const NYC_CENTER: [number, number] = [-73.95, 40.73];

const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

type Guess = { lat: number; lng: number } | null;
type RoundState = { guess: Guess; distance: number | null; score: number | null };

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// FNV-1a 32-bit, decent enough to spread cameras across rounds.
function hash(seed: string, round: number): number {
  let h = 2166136261;
  const s = `${seed}:${round}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// Haversine — meters between two lat/lng points.
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function scoreFor(distanceMeters: number): number {
  // Smooth exponential decay: ~100 at 0m, ~71 at 500m, ~37 at 2km, ~14 at 5km.
  return Math.max(0, Math.round(100 * Math.exp(-distanceMeters / 2000)));
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export default function GeoGuessr() {
  // URL state — seed for deterministic picks; optional friend score for the challenge banner.
  const initial = useMemo(() => {
    if (typeof window === 'undefined') return { seed: '', friendScore: null as number | null };
    const url = new URL(window.location.href);
    const seedParam = url.searchParams.get('seed');
    const scoreParam = url.searchParams.get('score');
    return {
      seed: seedParam || randomSeed(),
      friendScore: scoreParam ? parseInt(scoreParam, 10) || null : null,
    };
  }, []);
  const [seed] = useState(initial.seed);
  const friendScore = initial.friendScore;

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [roundIdx, setRoundIdx] = useState(0);
  const [rounds, setRounds] = useState<RoundState[]>(() =>
    Array.from({ length: ROUNDS }, () => ({ guess: null, distance: null, score: null })),
  );
  const [done, setDone] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    fetchCameras()
      .then((cs) => setCameras(cs.filter((c) => c.lat && c.lng)))
      .catch(() => {});
  }, []);

  // Refresh the cam image every 2s while guessing
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 2000);
    return () => clearInterval(i);
  }, []);

  // Deterministic pick of 5 cameras from the seed
  const roundCameras: Camera[] = useMemo(() => {
    if (!cameras.length) return [];
    const used = new Set<string>();
    const out: Camera[] = [];
    for (let i = 0; out.length < ROUNDS && i < ROUNDS * 4; i++) {
      const c = cameras[hash(seed, out.length + i * 13) % cameras.length];
      if (!c || used.has(c.id)) continue;
      used.add(c.id);
      out.push(c);
    }
    return out;
  }, [cameras, seed]);

  const cam = roundCameras[roundIdx];
  const round = rounds[roundIdx];
  const revealed = round?.score != null;
  const totalScore = rounds.reduce((s, r) => s + (r.score ?? 0), 0);

  const setGuess = (g: Guess) => {
    if (revealed) return;
    setRounds((prev) => {
      const next = [...prev];
      next[roundIdx] = { ...next[roundIdx], guess: g };
      return next;
    });
  };

  const lockGuess = () => {
    if (!round?.guess || !cam) return;
    const d = haversine(round.guess.lat, round.guess.lng, cam.lat, cam.lng);
    const score = scoreFor(d);
    setRounds((prev) => {
      const next = [...prev];
      next[roundIdx] = { ...next[roundIdx], distance: d, score };
      return next;
    });
  };

  const nextRound = () => {
    if (roundIdx >= ROUNDS - 1) {
      setDone(true);
    } else {
      setRoundIdx(roundIdx + 1);
    }
  };

  const replay = () => {
    // New seed, fresh rounds
    const url = new URL(window.location.href);
    url.searchParams.delete('seed');
    url.searchParams.delete('score');
    window.location.href = url.toString();
  };

  return (
    <div
      className="min-h-screen w-screen flex flex-col text-white"
      style={{ background: 'radial-gradient(ellipse at 50% 25%,#1a1530 0%,#0a0a18 55%,#06060c 100%)' }}
    >
      <BodegaAwning
        rightSlot={
          <a
            href="/"
            className="ml-2 px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
          >
            ← LOUNGE
          </a>
        }
      />
      <QuarterStash />
      <RollingQuarter />

      <main className="flex-1 px-3 py-5 z-10 max-w-[1200px] mx-auto w-full">
        <div className="flex items-baseline justify-between mb-1">
          <div className="font-bungee text-[36px] sm:text-[48px] leading-[0.95] uppercase">
            ★ Cam <span className="text-[#FFD600]">GeoGuessr</span>
          </div>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55 hidden sm:block">
            seed · {seed}
          </div>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mb-4">
          guess where this nyc cam is · 5 rounds · click the map · closer = more points
        </div>

        {friendScore != null && !done && (
          <div className="mb-4 px-3 py-2 bg-[#FFD600]/10 border-2 border-[#FFD600] font-typewriter text-[11px] uppercase tracking-[0.18em] text-[#FFD600]">
            ★ Challenge incoming · a friend scored {friendScore}/{ROUNDS * 100} on this seed · beat them
          </div>
        )}

        {!done ? (
          <RoundView
            roundIdx={roundIdx}
            cam={cam}
            tick={tick}
            round={round}
            rounds={rounds}
            revealed={revealed}
            onGuess={setGuess}
            onLock={lockGuess}
            onNext={nextRound}
            totalScore={totalScore}
          />
        ) : (
          <Summary
            rounds={rounds}
            roundCameras={roundCameras}
            seed={seed}
            friendScore={friendScore}
            totalScore={totalScore}
            onReplay={replay}
          />
        )}
      </main>

      <StreetFauna />
    </div>
  );
}

/* ──────────────────────────────────────── single round */

function RoundView({
  roundIdx,
  cam,
  tick,
  round,
  rounds,
  revealed,
  onGuess,
  onLock,
  onNext,
  totalScore,
}: {
  roundIdx: number;
  cam: Camera | undefined;
  tick: number;
  round: RoundState;
  rounds: RoundState[];
  revealed: boolean;
  onGuess: (g: Guess) => void;
  onLock: () => void;
  onNext: () => void;
  totalScore: number;
}) {
  return (
    <>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className="font-bungee text-[20px] uppercase text-[#FFD600]">
          ★ Round {roundIdx + 1} / {ROUNDS}
        </span>
        <span className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65">
          total · {totalScore}
        </span>
        <RoundDots rounds={rounds} currentIdx={roundIdx} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* camera image */}
        <div className="relative bg-black border-2 border-[#FFD600]/40" style={{ aspectRatio: '16 / 9', minHeight: 280 }}>
          {cam ? (
            <img
              key={cam.id}
              src={NYCTMC_IMG(cam.id, tick)}
              alt="guess this camera"
              referrerPolicy="no-referrer"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#FFD600]/65">
              loading cam pool…
            </div>
          )}
          <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/85 border border-[#FFD600] text-[#FFD600] font-bungee text-[11px] uppercase tracking-[0.16em]">
            ★ where in nyc?
          </div>
          {revealed && cam && (
            <div className="absolute bottom-2 left-2 right-2 bg-black/85 border border-[#FFD600] px-2 py-1 font-typewriter text-[10px] uppercase tracking-[0.16em] text-white">
              ✓ {cam.name ?? cam.id}
            </div>
          )}
        </div>

        {/* map */}
        <div
          className="relative border-2 border-[#FFD600]/40 bg-[#0a0a14] overflow-hidden h-[360px] sm:h-[420px] lg:h-[460px]"
        >
          <GuessMap cam={cam} guess={round?.guess ?? null} revealed={revealed} onGuess={onGuess} />
          <div className="absolute top-2 left-2 z-10 px-2 py-0.5 bg-black/85 border border-[#FFD600] text-[#FFD600] font-bungee text-[11px] uppercase tracking-[0.16em] pointer-events-none">
            ★ click to drop a pin
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {!revealed ? (
          <button
            type="button"
            onClick={onLock}
            disabled={!round?.guess}
            className="px-4 py-2 font-bungee text-[16px] uppercase tracking-[0.04em] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#FFD600', color: '#000', border: '3px solid #000', boxShadow: '5px 5px 0 #d11a2a' }}
          >
            ★ LOCK GUESS ★
          </button>
        ) : (
          <button
            type="button"
            onClick={onNext}
            className="px-4 py-2 font-bungee text-[16px] uppercase tracking-[0.04em]"
            style={{ background: '#FF6319', color: '#fff', border: '3px solid #000', boxShadow: '5px 5px 0 #d11a2a' }}
          >
            {roundIdx >= ROUNDS - 1 ? '★ SEE TOTAL ★' : 'NEXT ROUND →'}
          </button>
        )}
        {revealed && round.distance != null && (
          <div className="font-typewriter text-[12px] uppercase tracking-[0.18em]">
            <span className="text-white/65">distance · </span>
            <span className="text-[#FFD600] tabular">{fmtDist(round.distance)}</span>
            <span className="text-white/65 ml-3">round score · </span>
            <span className="text-[#FFD600] tabular text-[14px]">+{round.score}</span>
          </div>
        )}
        {!revealed && !round?.guess && (
          <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/45">
            click anywhere on the nyc map to drop a pin
          </span>
        )}
      </div>
    </>
  );
}

function RoundDots({ rounds, currentIdx }: { rounds: RoundState[]; currentIdx: number }) {
  return (
    <div className="flex items-center gap-1">
      {rounds.map((r, i) => {
        const done = r.score != null;
        const here = i === currentIdx;
        return (
          <span
            key={i}
            className="block rounded-full"
            style={{
              width: here ? 12 : 8,
              height: here ? 12 : 8,
              background: done ? '#FFD600' : here ? '#fff' : 'rgba(255,255,255,0.18)',
              boxShadow: here ? '0 0 8px #FFD600' : 'none',
            }}
            title={done ? `round ${i + 1}: +${r.score}` : `round ${i + 1}`}
          />
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────── interactive map */

function GuessMap({
  cam,
  guess,
  revealed,
  onGuess,
}: {
  cam: Camera | undefined;
  guess: Guess;
  revealed: boolean;
  onGuess: (g: Guess) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Watch the container — MapLibre needs an explicit resize() any time
  // its parent dimensions change (image-load layout shifts, viewport
  // changes, etc.). This + a few timed kicks paints the first frame
  // reliably AND keeps the canvas sized to the box afterwards.
  useEffect(() => {
    const fire = () => {
      const m = mapRef.current?.getMap?.();
      try { m?.resize(); m?.triggerRepaint(); } catch { /* noop */ }
    };
    const ids = [80, 240, 600, 1400].map((d) => window.setTimeout(fire, d));
    let ro: ResizeObserver | null = null;
    if (containerRef.current && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(fire);
      ro.observe(containerRef.current);
    }
    return () => {
      ids.forEach(clearTimeout);
      ro?.disconnect();
    };
  }, []);

  // When we reveal, fly to fit the guess + actual into view
  useEffect(() => {
    if (!revealed || !cam || !guess || !mapRef.current) return;
    const minLng = Math.min(cam.lng, guess.lng);
    const maxLng = Math.max(cam.lng, guess.lng);
    const minLat = Math.min(cam.lat, guess.lat);
    const maxLat = Math.max(cam.lat, guess.lat);
    mapRef.current.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 60, duration: 800 },
    );
  }, [revealed, cam, guess]);

  const lineGeo = revealed && guess && cam ? {
    type: 'FeatureCollection' as const,
    features: [{
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [[guess.lng, guess.lat], [cam.lng, cam.lat]],
      },
      properties: {},
    }],
  } : null;

  return (
    <div ref={containerRef} className="absolute inset-0">
    <MapLibre
      ref={mapRef}
      initialViewState={{ longitude: NYC_CENTER[0], latitude: NYC_CENTER[1], zoom: 9.6 }}
      mapStyle={OSM_STYLE}
      attributionControl={false}
      style={{ position: 'absolute', inset: 0 }}
      cursor={revealed ? 'default' : 'crosshair'}
      onLoad={() => {
        const m = mapRef.current?.getMap?.();
        try { m?.resize(); m?.triggerRepaint(); } catch { /* noop */ }
      }}
      onClick={(e) => {
        if (revealed) return;
        onGuess({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      }}
    >
      {guess && (
        <Marker longitude={guess.lng} latitude={guess.lat} anchor="bottom">
          <PinIcon color="#FFD600" label="you" />
        </Marker>
      )}
      {revealed && cam && (
        <Marker longitude={cam.lng} latitude={cam.lat} anchor="bottom">
          <PinIcon color="#FF6319" label="cam" />
        </Marker>
      )}
      {lineGeo && (
        <Source id="guess-line" type="geojson" data={lineGeo}>
          <Layer
            id="guess-line-layer"
            type="line"
            paint={{
              'line-color': '#FFD600',
              'line-width': 2.4,
              'line-dasharray': [2, 2],
              'line-opacity': 0.85,
            }}
          />
        </Source>
      )}
    </MapLibre>
    </div>
  );
}

function PinIcon({ color, label }: { color: string; label: string }) {
  return (
    <div className="relative" style={{ transform: 'translateY(2px)' }}>
      <svg viewBox="0 0 28 38" width="28" height="38" aria-hidden>
        <path d="M 14 1 C 6 1 1 7 1 14 C 1 22 14 36 14 36 C 14 36 27 22 27 14 C 27 7 22 1 14 1 Z" fill={color} stroke="#000" strokeWidth="1.5" />
        <circle cx="14" cy="14" r="5" fill="#000" />
      </svg>
      <div
        className="absolute -top-1 left-full ml-1 px-1.5 py-0.5 font-bungee text-[9px] uppercase tracking-[0.12em] whitespace-nowrap"
        style={{ background: color, color: '#000', boxShadow: '2px 2px 0 #000' }}
      >
        {label}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────── summary + share */

function Summary({
  rounds,
  roundCameras,
  seed,
  friendScore,
  totalScore,
  onReplay,
}: {
  rounds: RoundState[];
  roundCameras: Camera[];
  seed: string;
  friendScore: number | null;
  totalScore: number;
  onReplay: () => void;
}) {
  const [copied, setCopied] = useState<'url' | 'text' | null>(null);
  const max = ROUNDS * 100;

  const grade = (() => {
    const pct = totalScore / max;
    if (pct >= 0.85) return { label: 'NATIVE NEW YORKER', color: '#6CBE45' };
    if (pct >= 0.65) return { label: 'KNOWS THE CITY', color: '#FFD600' };
    if (pct >= 0.40) return { label: 'TOURIST WITH POTENTIAL', color: '#FF8A3A' };
    if (pct >= 0.20) return { label: 'BRIDGE & TUNNEL', color: '#FF6319' };
    return { label: 'JUST GOT OFF THE BUS', color: '#FF5582' };
  })();

  const shareUrl = (() => {
    if (typeof window === 'undefined') return '';
    const u = new URL(window.location.href);
    u.searchParams.set('seed', seed);
    u.searchParams.set('score', String(totalScore));
    return u.toString();
  })();

  const shareText =
    `★ NYC CAM GEOGUESSR\nI scored ${totalScore}/${max} — ${grade.label}.\nPlay the same 5 cameras: ${shareUrl}`;

  const copy = async (kind: 'url' | 'text') => {
    try {
      await navigator.clipboard.writeText(kind === 'url' ? shareUrl : shareText);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch { /* noop */ }
  };

  const tryNativeShare = async () => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as Navigator & { share: (d: { title: string; text: string; url: string }) => Promise<void> }).share({
          title: 'NYC Cam GeoGuessr',
          text: `I scored ${totalScore}/${max} — ${grade.label}. Beat me:`,
          url: shareUrl,
        });
        return;
      } catch { /* user cancelled or unsupported */ }
    }
    copy('text');
  };

  return (
    <div>
      <div className="text-center mb-6">
        <div className="font-bungee text-[40px] sm:text-[64px] leading-[0.95] uppercase text-[#FFD600]">
          ★ FINAL ★
        </div>
        <div className="font-tabloid text-[88px] leading-none mt-2 tabular" style={{ color: grade.color }}>
          {totalScore}<span className="text-white/45 text-[42px]"> / {max}</span>
        </div>
        <div className="font-bungee text-[18px] uppercase tracking-[0.06em] mt-2" style={{ color: grade.color }}>
          ★ {grade.label} ★
        </div>
        {friendScore != null && (
          <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] mt-3 text-white/75">
            your friend · {friendScore} · {totalScore > friendScore ? 'you beat them ★' : totalScore === friendScore ? 'tie game' : 'they got you'}
          </div>
        )}
      </div>

      {/* round breakdown */}
      <div className="grid gap-2 sm:grid-cols-5 mb-6">
        {rounds.map((r, i) => {
          const cam = roundCameras[i];
          return (
            <div key={i} className="bg-black/55 border border-[#FFD600]/40 px-2 py-2">
              <div className="flex items-baseline justify-between">
                <span className="font-bungee text-[12px] uppercase text-[#FFD600]">R{i + 1}</span>
                <span className="font-tabloid text-[18px] tabular text-white">+{r.score ?? 0}</span>
              </div>
              <div className="font-typewriter text-[9px] uppercase tracking-[0.16em] text-white/65 line-clamp-2 mt-1">
                {cam?.name ?? '—'}
              </div>
              {r.distance != null && (
                <div className="font-typewriter text-[9px] uppercase tracking-[0.16em] text-white/45 mt-0.5 tabular">
                  off by {fmtDist(r.distance)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* share row */}
      <div className="bg-black/55 border-2 border-[#FFD600] px-4 py-4" style={{ boxShadow: '4px 4px 0 #d11a2a' }}>
        <div className="font-bungee text-[16px] uppercase tracking-[0.04em] text-[#FFD600] mb-2">
          ★ Challenge a friend
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/75 mb-3">
          send this link · they play the same 5 cameras and try to beat your score
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <button
            onClick={tryNativeShare}
            className="px-3 py-1.5 font-bungee text-[12px] uppercase tracking-[0.06em]"
            style={{ background: '#FFD600', color: '#000', border: '2px solid #000', boxShadow: '3px 3px 0 #d11a2a' }}
          >
            ★ SHARE
          </button>
          <button
            onClick={() => copy('url')}
            className="px-3 py-1.5 font-bungee text-[12px] uppercase tracking-[0.06em]"
            style={{ background: '#0e0f14', color: '#FFD600', border: '2px solid #FFD600' }}
          >
            {copied === 'url' ? '✓ COPIED' : 'COPY LINK'}
          </button>
          <button
            onClick={() => copy('text')}
            className="px-3 py-1.5 font-bungee text-[12px] uppercase tracking-[0.06em]"
            style={{ background: '#0e0f14', color: '#FFD600', border: '2px solid #FFD600' }}
          >
            {copied === 'text' ? '✓ COPIED' : 'COPY BRAG'}
          </button>
          <button
            onClick={onReplay}
            className="px-3 py-1.5 font-bungee text-[12px] uppercase tracking-[0.06em] ml-auto"
            style={{ background: '#FF6319', color: '#fff', border: '2px solid #000', boxShadow: '3px 3px 0 #000' }}
          >
            ↻ NEW GAME
          </button>
        </div>
        <input
          readOnly
          value={shareUrl}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-[#0a0a14] border border-white/15 px-2 py-1.5 font-mono text-[11px] text-white/85"
        />
        <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-2">
          seed · {seed} · cameras are deterministic per seed · scores ride along the link
        </div>
      </div>
    </div>
  );
}
