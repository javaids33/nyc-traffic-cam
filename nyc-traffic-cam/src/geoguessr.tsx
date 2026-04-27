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
import confetti from 'canvas-confetti';
import { RoughNotation } from 'react-rough-notation';
import { apiUrl } from './api';

/* CartoDB Voyager — cream-paper base, soft blue water, readable street
   labels. Way friendlier than the near-black "dark_all" raster, which
   was hard to read against the dark page chrome. Voyager keeps the
   nighttime-arcade vibe while passing accessibility for label contrast. */
const OSM_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
        'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
      maxzoom: 20,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#e8e2d0' } },
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
      paint: {
        'raster-saturation': -0.05,
        'raster-contrast': 0.08,
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

/* Distance bands — borrowed from how a New Yorker actually thinks about
   space. "Same block" is ~80 m, "same neighborhood" is ~1 km, "same
   borough" is ~6 km, beyond that you're in the wrong borough or worse.
   Each band has a min score floor so the user always feels rewarded
   when they hit the band, plus a smooth falloff inside the band. */
type Band = {
  id: string;
  label: string;
  blurb: string;
  color: string;
  upTo: number;     // meters — inclusive upper bound
  floor: number;    // min score awarded at upTo
  ceiling: number;  // max score awarded at the start of the band
  emoji: string;
};

const SCORE_BANDS: Band[] = [
  { id: 'bullseye', label: 'BULLSEYE',         blurb: 'on the dot · you\'ve actually been there', color: '#FFD600', upTo: 50,    floor: 95, ceiling: 100, emoji: '🎯' },
  { id: 'block',    label: 'SAME BLOCK',       blurb: 'one corner over · u smell the halal cart', color: '#B5F500', upTo: 200,   floor: 80, ceiling: 95,  emoji: '🚏' },
  { id: 'nbhd',     label: 'SAME NEIGHBORHOOD', blurb: 'right zip · wrong avenue',                 color: '#6CBE45', upTo: 1000,  floor: 60, ceiling: 80,  emoji: '🏘️' },
  { id: 'district', label: 'SAME DISTRICT',     blurb: 'a couple stops off',                       color: '#0039A6', upTo: 3000,  floor: 35, ceiling: 60,  emoji: '🚇' },
  { id: 'borough',  label: 'SAME BOROUGH',      blurb: 'roughly · take the bus',                   color: '#FF6319', upTo: 8000,  floor: 15, ceiling: 35,  emoji: '🗽' },
  { id: 'wrong',    label: 'WRONG BOROUGH',     blurb: 'that\'s a whole different vibe',           color: '#d11a2a', upTo: 25_000, floor: 1,  ceiling: 15,  emoji: '🌉' },
  { id: 'lost',     label: 'JERSEY?',           blurb: 'are u even on the map?',                   color: '#5a2a55', upTo: Infinity, floor: 0, ceiling: 1, emoji: '😬' },
];

function bandFor(distanceMeters: number): Band {
  for (const b of SCORE_BANDS) if (distanceMeters <= b.upTo) return b;
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}

function scoreFor(distanceMeters: number): number {
  // Find the band, then linearly interpolate within it from the
  // band's ceiling at the lower edge down to its floor at upTo.
  const idx = SCORE_BANDS.findIndex((b) => distanceMeters <= b.upTo);
  if (idx < 0) return 0;
  const band = SCORE_BANDS[idx];
  const lower = idx === 0 ? 0 : SCORE_BANDS[idx - 1].upTo;
  if (!Number.isFinite(band.upTo)) return band.floor;
  const t = Math.min(1, Math.max(0, (distanceMeters - lower) / (band.upTo - lower)));
  return Math.round(band.ceiling - (band.ceiling - band.floor) * t);
}

function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

function fireConfetti(intensity: 'big' | 'medium' = 'medium') {
  const opts = {
    particleCount: intensity === 'big' ? 160 : 70,
    spread: 75,
    startVelocity: intensity === 'big' ? 55 : 40,
    origin: { y: 0.6 },
    colors: ['#FFD600', '#FF6319', '#d11a2a', '#0039A6', '#6CBE45'],
  };
  try {
    confetti(opts);
    if (intensity === 'big') {
      setTimeout(() => confetti({ ...opts, angle: 60, origin: { x: 0, y: 0.7 } }), 220);
      setTimeout(() => confetti({ ...opts, angle: 120, origin: { x: 1, y: 0.7 } }), 260);
    }
  } catch { /* noop */ }
}

/* The shape of a fetched challenge from the server — populated only
   when the URL has `?h=<hash>`, otherwise null and we fall back to the
   deterministic seed picker. */
type FetchedChallenge = {
  hash: string;
  cameras: string[];     // camera UUIDs the sharer played
  score: number | null;  // sharer's score (replaces the legacy ?score= param)
  grade: string | null;
  expires_at: number;
};

export default function GeoGuessr() {
  // URL state — seed for deterministic picks; optional friend score for the challenge banner.
  // If `?h=<hash>` is present we IGNORE seed and ride the explicit
  // 5-camera list pinned on the server, so the challenge survives
  // upstream changes to the camera pool (the original failure mode of
  // pure-deterministic seeds).
  const initial = useMemo(() => {
    if (typeof window === 'undefined') {
      return { seed: '', friendScore: null as number | null, hash: null as string | null };
    }
    const url = new URL(window.location.href);
    const seedParam = url.searchParams.get('seed');
    const scoreParam = url.searchParams.get('score');
    const hashParam = url.searchParams.get('h');
    return {
      seed: seedParam || randomSeed(),
      friendScore: scoreParam ? parseInt(scoreParam, 10) || null : null,
      hash: hashParam,
    };
  }, []);
  const [seed] = useState(initial.seed);

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [challenge, setChallenge] = useState<FetchedChallenge | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [roundIdx, setRoundIdx] = useState(0);
  const [rounds, setRounds] = useState<RoundState[]>(() =>
    Array.from({ length: ROUNDS }, () => ({ guess: null, distance: null, score: null })),
  );
  const [done, setDone] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  // Friend score: prefer the one pinned in the challenge row over the
  // legacy ?score= URL param.
  const friendScore = challenge?.score ?? initial.friendScore;

  useEffect(() => {
    fetchCameras()
      .then((cs) => setCameras(cs.filter((c) => c.lat && c.lng)))
      .catch(() => {});
  }, []);

  // If the URL points at a challenge hash, fetch its pinned 5 cameras.
  useEffect(() => {
    if (!initial.hash) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/challenges/${initial.hash}`));
        if (!r.ok) {
          if (stop) return;
          setChallengeError(
            r.status === 410 || r.status === 404
              ? 'this challenge expired (24h limit) — playing a fresh seed'
              : `couldn't load challenge (${r.status}) — playing a fresh seed`,
          );
          return;
        }
        const j = (await r.json()) as FetchedChallenge;
        if (!stop) setChallenge(j);
      } catch {
        if (!stop) setChallengeError('couldn\'t reach challenge server — playing a fresh seed');
      }
    })();
    return () => { stop = true; };
  }, [initial.hash]);

  // Refresh the cam image every 2s while guessing
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 2000);
    return () => clearInterval(i);
  }, []);

  // The 5 cameras for this run. If a challenge was loaded, use its
  // pinned UUIDs verbatim (so two players see the same cams even if
  // the upstream pool changed). Otherwise fall back to the
  // deterministic seed picker.
  const roundCameras: Camera[] = useMemo(() => {
    if (!cameras.length) return [];
    if (challenge) {
      const byId = new Map(cameras.map((c) => [c.id, c]));
      const out: Camera[] = [];
      for (const id of challenge.cameras) {
        const c = byId.get(id);
        if (c) out.push(c);
      }
      return out.slice(0, ROUNDS);
    }
    const used = new Set<string>();
    const out: Camera[] = [];
    for (let i = 0; out.length < ROUNDS && i < ROUNDS * 4; i++) {
      const c = cameras[hash(seed, out.length + i * 13) % cameras.length];
      if (!c || used.has(c.id)) continue;
      used.add(c.id);
      out.push(c);
    }
    return out;
  }, [cameras, seed, challenge]);

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
    // Reward great guesses with confetti — bullseye is the big drop.
    if (score >= 95) fireConfetti('big');
    else if (score >= 80) fireConfetti('medium');
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

      <main className="flex-1 px-3 py-5 z-10 max-w-[1400px] mx-auto w-full">
        <div className="flex items-baseline justify-between mb-1">
          <div className="font-bungee text-[36px] sm:text-[48px] leading-[0.95] uppercase">
            ★ Cam <span className="text-[#FFD600]">GeoGuessr</span>
          </div>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55 hidden sm:block">
            {challenge ? <>challenge · <span className="text-[#FFD600]">{challenge.hash}</span> · 24h pin</> : <>seed · {seed}</>}
          </div>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mb-4">
          guess where this nyc cam is · 5 rounds · click the map · closer = more points
        </div>

        {friendScore != null && !done && (
          <div className="mb-4 px-3 py-2 bg-[#FFD600]/10 border-2 border-[#FFD600] font-typewriter text-[11px] uppercase tracking-[0.18em] text-[#FFD600]">
            ★ Challenge incoming · a friend scored {friendScore}/{ROUNDS * 100}
            {challenge?.grade ? ` (${challenge.grade.toLowerCase()})` : ''} · beat them
          </div>
        )}
        {challengeError && !done && (
          <div className="mb-4 px-3 py-2 bg-[#ff8a3a]/10 border-2 border-[#ff8a3a] font-typewriter text-[11px] uppercase tracking-[0.18em] text-[#ff8a3a]">
            ★ {challengeError}
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
            challenge={challenge}
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

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {/* camera image — gets more screen real estate now; the cam is
            the actual puzzle, the map is just the answer surface */}
        <div className="relative bg-black border-2 border-[#FFD600]/40" style={{ aspectRatio: '16 / 9', minHeight: 380 }}>
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

        {/* map — same height as the cam pane on lg so the two read as a
            balanced pair rather than the map dominating the cam */}
        <div
          className="relative border-2 border-[#FFD600]/40 bg-[#e8e2d0] overflow-hidden h-[360px] sm:h-[420px] lg:h-[480px]"
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
          <div className="flex items-center gap-3 flex-wrap">
            {(() => {
              const b = bandFor(round.distance);
              return (
                <span
                  className="px-2 py-1 font-bungee text-[14px] uppercase tracking-[0.04em]"
                  style={{
                    background: b.color,
                    color: b.color === '#FFD600' || b.color === '#B5F500' ? '#000' : '#fff',
                    boxShadow: '3px 3px 0 #000',
                    border: '2px solid #000',
                  }}
                >
                  <span className="mr-1.5" aria-hidden>{b.emoji}</span>
                  {b.label}
                </span>
              );
            })()}
            <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85">
              {bandFor(round.distance).blurb}
            </div>
            <div className="font-typewriter text-[12px] uppercase tracking-[0.18em] ml-auto">
              <span className="text-white/65">off · </span>
              <span className="text-[#FFD600] tabular">{fmtDist(round.distance)}</span>
              <span className="text-white/65 ml-3">+ </span>
              <span className="text-[#FFD600] tabular text-[16px]">{round.score}</span>
              <span className="text-white/45"> / 100</span>
            </div>
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
              'line-color': '#d11a2a',
              'line-width': 3,
              'line-dasharray': [2, 2],
              'line-opacity': 0.92,
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
  challenge,
  onReplay,
}: {
  rounds: RoundState[];
  roundCameras: Camera[];
  seed: string;
  friendScore: number | null;
  totalScore: number;
  challenge: FetchedChallenge | null;
  onReplay: () => void;
}) {
  const [copied, setCopied] = useState<'url' | 'text' | null>(null);
  // Challenge hash for the brag link. If we already loaded a challenge
  // (the player came in via someone else's link), reuse that hash so
  // chains of friends play the SAME 5 cams. Otherwise we POST our 5
  // cam IDs to the server on first share and cache the hash.
  const [shareHash, setShareHash] = useState<string | null>(challenge?.hash ?? null);
  const [shareMinting, setShareMinting] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const max = ROUNDS * 100;

  const grade = (() => {
    const pct = totalScore / max;
    if (pct >= 0.85) return { label: 'NATIVE NEW YORKER', color: '#6CBE45' };
    if (pct >= 0.65) return { label: 'KNOWS THE CITY', color: '#FFD600' };
    if (pct >= 0.40) return { label: 'TOURIST WITH POTENTIAL', color: '#FF8A3A' };
    if (pct >= 0.20) return { label: 'BRIDGE & TUNNEL', color: '#FF6319' };
    return { label: 'JUST GOT OFF THE BUS', color: '#FF5582' };
  })();

  // Big finale confetti — fires once when the summary mounts if the
  // user did well enough.
  useEffect(() => {
    const pct = totalScore / max;
    if (pct >= 0.65) fireConfetti('big');
    else if (pct >= 0.4) fireConfetti('medium');
  }, [totalScore, max]);

  // Mint a fresh challenge on the server: POST our 5 cam UUIDs, get a
  // 6-char hash back. We do this lazily — only when the user first
  // tries to share — so casual players never touch the backend.
  const ensureHash = async (): Promise<string | null> => {
    if (shareHash) return shareHash;
    if (shareMinting) return null;
    setShareMinting(true);
    setShareError(null);
    try {
      const r = await fetch(apiUrl('/api/challenges'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cameras: roundCameras.map((c) => c.id),
          score: totalScore,
          grade: grade.label,
        }),
      });
      if (!r.ok) {
        const detail = (await r.json().catch(() => null))?.detail ?? `${r.status}`;
        throw new Error(detail);
      }
      const j = (await r.json()) as { hash: string };
      setShareHash(j.hash);
      return j.hash;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      setShareError(`couldn't mint share link · ${msg} · falling back to seed`);
      return null;
    } finally {
      setShareMinting(false);
    }
  };

  // The "live" URL that ALWAYS works as a share — uses the hash if
  // we've minted one, otherwise the legacy seed-based link.
  const shareUrl = (() => {
    if (typeof window === 'undefined') return '';
    const u = new URL(window.location.href);
    u.searchParams.delete('h');
    u.searchParams.delete('seed');
    u.searchParams.delete('score');
    if (shareHash) {
      u.searchParams.set('h', shareHash);
    } else {
      u.searchParams.set('seed', seed);
      u.searchParams.set('score', String(totalScore));
    }
    return u.toString();
  })();

  const copy = async (kind: 'url' | 'text') => {
    // Mint hash on first copy attempt
    const h = await ensureHash();
    const u = (() => {
      if (typeof window === 'undefined') return shareUrl;
      const url = new URL(window.location.href);
      url.searchParams.delete('h');
      url.searchParams.delete('seed');
      url.searchParams.delete('score');
      if (h) url.searchParams.set('h', h);
      else {
        url.searchParams.set('seed', seed);
        url.searchParams.set('score', String(totalScore));
      }
      return url.toString();
    })();
    const txt =
      `★ NYC CAM GEOGUESSR\nI scored ${totalScore}/${max} — ${grade.label}.\nPlay the same 5 cameras: ${u}`;
    try {
      await navigator.clipboard.writeText(kind === 'url' ? u : txt);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch { /* noop */ }
  };

  const tryNativeShare = async () => {
    const h = await ensureHash();
    const u = (() => {
      if (typeof window === 'undefined') return shareUrl;
      const url = new URL(window.location.href);
      url.searchParams.delete('h');
      url.searchParams.delete('seed');
      url.searchParams.delete('score');
      if (h) url.searchParams.set('h', h);
      else {
        url.searchParams.set('seed', seed);
        url.searchParams.set('score', String(totalScore));
      }
      return url.toString();
    })();
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as Navigator & { share: (d: { title: string; text: string; url: string }) => Promise<void> }).share({
          title: 'NYC Cam GeoGuessr',
          text: `I scored ${totalScore}/${max} — ${grade.label}. Beat me:`,
          url: u,
        });
        return;
      } catch { /* user cancelled or unsupported */ }
    }
    copy('text');
  };

  return (
    <div>
      <div className="text-center mb-6">
        <div className="font-bungee text-[40px] sm:text-[64px] leading-[0.95] uppercase text-[#FFD600] inline-block">
          <RoughNotation type="underline" color="#FF6319" show strokeWidth={3} padding={0} animationDelay={250} animationDuration={1100}>
            <span>★ FINAL ★</span>
          </RoughNotation>
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

      {/* round breakdown — each card colored by the band the player landed in */}
      <div className="grid gap-2 sm:grid-cols-5 mb-6">
        {rounds.map((r, i) => {
          const cam = roundCameras[i];
          const band = r.distance != null ? bandFor(r.distance) : null;
          return (
            <div
              key={i}
              className="bg-black/55 px-2 py-2"
              style={{ border: `1px solid ${band ? band.color + '88' : 'rgba(255,214,0,0.35)'}` }}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-bungee text-[12px] uppercase text-[#FFD600]">R{i + 1}</span>
                <span className="font-tabloid text-[18px] tabular text-white">+{r.score ?? 0}</span>
              </div>
              <div className="font-typewriter text-[9px] uppercase tracking-[0.16em] text-white/65 line-clamp-2 mt-1">
                {cam?.name ?? '—'}
              </div>
              {band && (
                <div className="font-bungee text-[9px] uppercase tracking-[0.06em] mt-1" style={{ color: band.color }}>
                  {band.emoji} {band.label}
                </div>
              )}
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
          {shareHash
            ? <>challenge · <span className="text-[#FFD600]">{shareHash}</span> · same 5 cameras pinned for 24h · scores ride along</>
            : <>seed · {seed} · pinning a real challenge link the moment you copy or share</>}
        </div>
        {shareMinting && (
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/65 mt-1">
            ⚙ minting share link…
          </div>
        )}
        {shareError && (
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-[#ff8a3a] mt-1">
            ★ {shareError}
          </div>
        )}
      </div>
    </div>
  );
}
