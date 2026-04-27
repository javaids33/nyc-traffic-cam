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
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, QuarterIcon, useQuarters } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';

/* ──────────────────────────────────────────────────────────────────────
   /turnstile — Hop the Turnstile, v2.
   - Pick a line. The map shows every station that line serves, in
     subway-bullet style. Click one to set origin, click another to set
     destination.
   - Ride: side-view POV from inside the car. The cam frames the door
     window across from your seat — motion blur on the edges sells the
     "riding past it" feel. Progress tracker at the top counts stops.
   ──────────────────────────────────────────────────────────────────── */

type Station = {
  name: string;
  lat: number;
  lng: number;
  lines: string[];
};

const MTA_STATIONS_URL =
  'https://data.ny.gov/resource/39hk-dx4f.json' +
  '?$select=stop_name,gtfs_latitude,gtfs_longitude,daytime_routes,borough' +
  '&$limit=600';

const ALL_LINES = [
  '1','2','3','4','5','6','7',
  'A','B','C','D','E','F','G','J','L','M','N','Q','R','W','Z','SI',
] as const;
type Line = typeof ALL_LINES[number];

const LINE_COLOR: Record<string, string> = {
  '1': '#EE352E', '2': '#EE352E', '3': '#EE352E',
  '4': '#00933C', '5': '#00933C', '6': '#00933C',
  '7': '#B933AD',
  'A': '#0039A6', 'C': '#0039A6', 'E': '#0039A6',
  'B': '#FF6319', 'D': '#FF6319', 'F': '#FF6319', 'M': '#FF6319',
  'G': '#6CBE45',
  'J': '#996633', 'Z': '#996633',
  'L': '#A7A9AC',
  'N': '#FCCC0A', 'Q': '#FCCC0A', 'R': '#FCCC0A', 'W': '#FCCC0A',
  'SI': '#053c79',
};

function lineTextColor(line: string): string {
  return line === 'N' || line === 'Q' || line === 'R' || line === 'W' || line === 'L' ? '#000' : '#fff';
}

const STATION_DWELL_MS = 6200;
const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

function nearestCamera(cams: Camera[], s: Station): Camera | null {
  let best: { cam: Camera; d: number } | null = null;
  for (const c of cams) {
    const d = Math.hypot(c.lat - s.lat, c.lng - s.lng);
    if (!best || d < best.d) best = { cam: c, d };
  }
  return best?.cam ?? null;
}

/* MTA Open Data subway stations — every stop with lat/lng + the lines
   it serves. Cached to localStorage for a day. */
type RawStation = { stop_name: string; gtfs_latitude: string; gtfs_longitude: string; daytime_routes: string };
const STATIONS_CACHE_KEY = 'nyc-mta-stations-v1';
const STATIONS_CACHE_MS = 24 * 60 * 60 * 1000;

function useMtaStations() {
  const [stations, setStations] = useState<Station[]>(() => {
    try {
      const raw = localStorage.getItem(STATIONS_CACHE_KEY);
      if (!raw) return [];
      const cached = JSON.parse(raw) as { ts: number; data: Station[] };
      if (Date.now() - cached.ts < STATIONS_CACHE_MS) return cached.data;
    } catch { /* noop */ }
    return [];
  });
  const [loaded, setLoaded] = useState<boolean>(stations.length > 0);

  useEffect(() => {
    if (loaded) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch(MTA_STATIONS_URL);
        if (!r.ok) throw new Error('mta http ' + r.status);
        const j = (await r.json()) as RawStation[];
        if (stop) return;
        const out: Station[] = j
          .map((row) => ({
            name: row.stop_name,
            lat: parseFloat(row.gtfs_latitude),
            lng: parseFloat(row.gtfs_longitude),
            lines: (row.daytime_routes ?? '').split(/\s+/).map((s) => s.trim()).filter(Boolean),
          }))
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.name && s.lines.length > 0);
        const seen = new Set<string>();
        const dedup: Station[] = [];
        for (const s of out) {
          const key = `${s.name}|${s.lines.join(',')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          dedup.push(s);
        }
        setStations(dedup);
        setLoaded(true);
        try {
          localStorage.setItem(STATIONS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: dedup }));
        } catch { /* noop */ }
      } catch {
        if (!stop) setLoaded(true);
      }
    })();
    return () => { stop = true; };
  }, [loaded]);

  return { stations, loaded };
}

/* CARTO Dark Matter raster tiles — the same basemap used by /geoguessr,
   chosen for legibility on dark backgrounds. */
const SUBWAY_MAP_STYLE: StyleSpecification = {
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
    { id: 'carto', type: 'raster', source: 'carto' },
  ],
};

type Stage = 'idle' | 'boarding' | 'riding' | 'arrived';

export default function Turnstile() {
  const [stage, setStage] = useState<Stage>('idle');
  const [line, setLine] = useState<Line>('F');
  const [originIdx, setOriginIdx] = useState<number | null>(null);
  const [destIdx, setDestIdx] = useState<number | null>(null);
  const [stationIdx, setStationIdx] = useState(0);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const { count: quarters, spend } = useQuarters();
  const { stations, loaded: stationsLoaded } = useMtaStations();

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);

  /* Stations on the picked line, ordered N→S by latitude. (For E-W
     trunks like G/L/7 lat-order still produces a reasonable strip.) */
  const lineStations = useMemo(() => {
    return stations
      .filter((s) => s.lines.includes(line))
      .slice()
      .sort((a, b) => b.lat - a.lat);
  }, [stations, line]);

  // Reset selections when the line changes
  useEffect(() => {
    setOriginIdx(null);
    setDestIdx(null);
  }, [line]);

  /* ridePlan: ordered list of stations from origin → destination, capped
     at MAX_RIDE_STOPS so the ride doesn't take forever on long routes. */
  const MAX_RIDE_STOPS = 8;
  const ridePlan = useMemo<Station[]>(() => {
    if (originIdx == null || destIdx == null || lineStations.length === 0) return [];
    const a = Math.min(originIdx, destIdx);
    const b = Math.max(originIdx, destIdx);
    const reverse = originIdx > destIdx;
    const slice = lineStations.slice(a, b + 1);
    const ordered = reverse ? slice.slice().reverse() : slice;
    if (ordered.length <= MAX_RIDE_STOPS) return ordered;
    // Sample evenly so the user gets a feel for the whole ride
    const step = (ordered.length - 1) / (MAX_RIDE_STOPS - 1);
    const out: Station[] = [];
    for (let i = 0; i < MAX_RIDE_STOPS; i++) out.push(ordered[Math.round(i * step)]);
    return out;
  }, [lineStations, originIdx, destIdx]);

  // Auto-advance during ride
  useEffect(() => {
    if (stage !== 'riding') return;
    if (stationIdx >= ridePlan.length - 1) {
      const t = setTimeout(() => setStage('arrived'), STATION_DWELL_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStationIdx((i) => i + 1), STATION_DWELL_MS);
    return () => clearTimeout(t);
  }, [stage, stationIdx, ridePlan.length]);

  useTrainRumble(stage === 'riding');

  const swipe = () => {
    if (!spend(1)) return;
    setStage('boarding');
  };
  const board = () => {
    setStationIdx(0);
    setStage('riding');
  };
  const exit = () => {
    setStage('idle');
    setStationIdx(0);
    setOriginIdx(null);
    setDestIdx(null);
  };

  const currentStation = ridePlan[Math.min(stationIdx, Math.max(0, ridePlan.length - 1))];
  const nextStation = ridePlan[Math.min(stationIdx + 1, Math.max(0, ridePlan.length - 1))];
  const cam = currentStation ? nearestCamera(cameras, currentStation) : null;

  return (
    <div
      className="min-h-screen w-screen flex flex-col text-white"
      style={{ background: 'linear-gradient(180deg,#0a0a0e 0%,#15151c 50%,#0a0a0e 100%)' }}
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

      <main className="flex-1 px-3 py-5 z-10">
        {stage === 'idle' && <TurnstileGate quarters={quarters} onSwipe={swipe} />}
        {stage === 'boarding' && (
          <Boarding
            line={line}
            setLine={setLine}
            lineStations={lineStations}
            stationsLoaded={stationsLoaded}
            originIdx={originIdx}
            destIdx={destIdx}
            setOriginIdx={setOriginIdx}
            setDestIdx={setDestIdx}
            ridePlan={ridePlan}
            onBoard={board}
            onCancel={() => setStage('idle')}
          />
        )}
        {(stage === 'riding' || stage === 'arrived') && (
          <SubwayCarPOV
            line={line}
            ridePlan={ridePlan}
            stationIdx={stationIdx}
            arrived={stage === 'arrived'}
            cam={cam}
            nextStationName={nextStation?.name ?? ''}
            currentStation={currentStation}
            onExit={exit}
          />
        )}
      </main>

      <StreetFauna />

      <style>{TRAIN_KEYFRAMES}</style>
    </div>
  );
}

/* ──────────────────────────────────────── stage 1: turnstile gate */

function TurnstileGate({ quarters, onSwipe }: { quarters: number; onSwipe: () => void }) {
  return (
    <div className="max-w-[820px] mx-auto">
      <div className="font-bungee text-[44px] sm:text-[64px] leading-[0.95] uppercase">
        ★ Hop the <span className="text-[#FF6319]">Turnstile</span>
      </div>
      <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-7">
        ride any nyc line · click your stops on the map · cam in the door window
      </div>

      <div
        className="relative grid place-items-center mx-auto"
        style={{
          minHeight: 360,
          background: 'linear-gradient(180deg,#1f2128 0%,#13141a 60%,#0a0b10 100%)',
          border: '4px solid #1a1c22',
          boxShadow: 'inset 0 0 60px rgba(0,0,0,0.85), 0 18px 40px rgba(0,0,0,0.7)',
        }}
      >
        <div
          className="absolute inset-x-0 bottom-0 h-12 opacity-80"
          style={{
            backgroundImage:
              'repeating-linear-gradient(0deg,#1a1c22 0px,#1a1c22 2px,#0d0e13 2px,#0d0e13 22px), repeating-linear-gradient(90deg,rgba(255,255,255,0.03) 0px,rgba(255,255,255,0.03) 1px,transparent 1px,transparent 22px)',
          }}
          aria-hidden
        />
        <Turnstile3D />
        <div
          className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1 font-bungee text-[12px] uppercase tracking-[0.18em] text-[#FFD600]"
          style={{ background: '#000', border: '2px solid #FFD600', boxShadow: '3px 3px 0 #d11a2a' }}
        >
          ▶ INSERT METROCARD ▶
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSwipe}
          disabled={quarters < 1}
          className="px-5 py-2.5 font-bungee text-[18px] uppercase tracking-[0.06em] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          style={{ background: '#FFD600', color: '#000', boxShadow: '5px 5px 0 #d11a2a', border: '3px solid #000' }}
        >
          ★ SWIPE ★ <span className="inline-block align-middle mx-1"><QuarterIcon size={18} /></span> 1 QUARTER
        </button>
        <span className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65">
          you have {quarters} · {quarters < 1 ? 'find a quarter on the lounge' : 'one fare gets you anywhere'}
        </span>
      </div>

      <ul className="mt-8 space-y-1 font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/55">
        <li>★ pick your origin and destination on a real subway map</li>
        <li>★ stations come straight from mta open data</li>
        <li>★ the door window across the aisle = closest nyc dot cam</li>
      </ul>
    </div>
  );
}

function Turnstile3D() {
  return (
    <svg viewBox="0 0 280 220" width="240" height="200" aria-hidden>
      <ellipse cx="140" cy="195" rx="120" ry="10" fill="rgba(0,0,0,0.6)" />
      <rect x="80" y="120" width="120" height="68" rx="2" fill="#2a2c33" stroke="#0a0b0f" strokeWidth="2" />
      <rect x="84" y="124" width="112" height="60" fill="url(#turnBox)" />
      <rect x="130" y="146" width="20" height="3" fill="#000" />
      <text x="140" y="160" textAnchor="middle" fontSize="6" fontFamily="Anton, Impact, sans-serif" fill="#FFD600" letterSpacing="0.4">SWIPE</text>
      <rect x="132" y="60" width="16" height="64" rx="2" fill="#9aa0aa" stroke="#0a0b0f" />
      <g stroke="#cbd0d8" strokeWidth="6" strokeLinecap="round" fill="none">
        <line x1="140" y1="80" x2="40" y2="80" />
        <line x1="140" y1="80" x2="240" y2="80" />
        <line x1="140" y1="80" x2="140" y2="20" />
      </g>
      <g fill="#5a5e66">
        <circle cx="40" cy="80" r="5" />
        <circle cx="240" cy="80" r="5" />
        <circle cx="140" cy="20" r="5" />
      </g>
      <rect x="80" y="120" width="120" height="6" fill="#FFD600" />
      <defs>
        <linearGradient id="turnBox" x1="0" x2="1">
          <stop offset="0%" stopColor="#1a1c22" />
          <stop offset="100%" stopColor="#3a3d45" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/* ──────────────────────────────────────── stage 2: line + map picker */

function Boarding({
  line,
  setLine,
  lineStations,
  stationsLoaded,
  originIdx,
  destIdx,
  setOriginIdx,
  setDestIdx,
  ridePlan,
  onBoard,
  onCancel,
}: {
  line: Line;
  setLine: (l: Line) => void;
  lineStations: Station[];
  stationsLoaded: boolean;
  originIdx: number | null;
  destIdx: number | null;
  setOriginIdx: (i: number | null) => void;
  setDestIdx: (i: number | null) => void;
  ridePlan: Station[];
  onBoard: () => void;
  onCancel: () => void;
}) {
  const onMapPick = (stationIdx: number) => {
    if (originIdx == null) {
      setOriginIdx(stationIdx);
    } else if (destIdx == null && stationIdx !== originIdx) {
      setDestIdx(stationIdx);
    } else {
      // Reset and start a new origin selection
      setOriginIdx(stationIdx);
      setDestIdx(null);
    }
  };

  const origin = originIdx != null ? lineStations[originIdx] : null;
  const dest = destIdx != null ? lineStations[destIdx] : null;
  const ready = origin && dest;

  return (
    <div className="max-w-[1100px] mx-auto">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-bungee text-[32px] sm:text-[44px] leading-none uppercase">★ Pick a Line</div>
        <button
          onClick={onCancel}
          className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65 hover:text-[#FFD600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        >
          ← back
        </button>
      </div>
      <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mb-5">
        every nyc subway line · click stops on the map to set your boarding + destination
      </div>

      {/* line bullets */}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {ALL_LINES.map((l) => {
          const active = line === l;
          return (
            <button
              key={l}
              type="button"
              onClick={() => setLine(l)}
              className="font-bungee text-[18px] sm:text-[22px] leading-none w-11 h-11 sm:w-12 sm:h-12 grid place-items-center transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              style={{
                background: active ? LINE_COLOR[l] : '#0a0b10',
                color: active ? lineTextColor(l) : LINE_COLOR[l],
                border: `2px solid ${LINE_COLOR[l]}`,
                borderRadius: '50%',
                boxShadow: active ? `3px 3px 0 #d11a2a` : `2px 2px 0 rgba(0,0,0,0.6)`,
              }}
              aria-pressed={active}
              aria-label={`${l} train`}
            >
              {l}
            </button>
          );
        })}
      </div>

      <MtaLineStatus line={line} />

      {/* the map */}
      <div className="mt-3 mb-3 font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65 flex items-center gap-3 flex-wrap">
        <span>★ pick your stops</span>
        <span className="inline-flex items-center gap-1">
          <span className="block w-3 h-3 rounded-full" style={{ background: '#6CBE45', border: '2px solid #fff' }} />
          <span>origin</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="block w-3 h-3 rounded-full" style={{ background: '#FF5582', border: '2px solid #fff' }} />
          <span>destination</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="block w-2 h-2 rounded-full" style={{ background: LINE_COLOR[line] }} />
          <span>{line} line stops</span>
        </span>
        {(origin || dest) && (
          <button
            type="button"
            onClick={() => { setOriginIdx(null); setDestIdx(null); }}
            className="ml-auto px-2 py-0.5 border border-white/30 text-white/75 hover:border-[#FFD600] hover:text-[#FFD600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          >
            reset
          </button>
        )}
      </div>

      <SubwayLineMap
        line={line}
        lineStations={lineStations}
        stationsLoaded={stationsLoaded}
        originIdx={originIdx}
        destIdx={destIdx}
        onPick={onMapPick}
      />

      {/* selection summary */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <SelectedStop label="ORIGIN" station={origin} dotColor="#6CBE45" line={line} />
        <SelectedStop label="DESTINATION" station={dest} dotColor="#FF5582" line={line} />
      </div>

      {ready && (
        <>
          <div className="mt-5 mb-2">
            <RollSign line={line} destination={dest!.name} />
          </div>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/55 mb-4">
            ride: {ridePlan.map((s) => s.name).join(' → ')} · {ridePlan.length} stop{ridePlan.length === 1 ? '' : 's'}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onBoard}
        disabled={!ready}
        className="px-5 py-2.5 font-bungee text-[18px] uppercase tracking-[0.06em] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        style={{
          background: LINE_COLOR[line],
          color: lineTextColor(line),
          boxShadow: '5px 5px 0 #000',
          border: '3px solid #000',
        }}
      >
        ★ BOARD THE {line} ★
      </button>
    </div>
  );
}

function SelectedStop({
  label,
  station,
  dotColor,
  line,
}: {
  label: string;
  station: Station | null;
  dotColor: string;
  line: Line;
}) {
  return (
    <div
      className="px-3 py-2 border-2 flex items-center gap-3 font-typewriter text-[11px] uppercase tracking-[0.18em]"
      style={{
        background: '#0e0f14',
        borderColor: station ? dotColor : 'rgba(255,255,255,0.18)',
      }}
    >
      <span
        className="block w-3.5 h-3.5 rounded-full shrink-0"
        style={{ background: station ? dotColor : 'transparent', border: `2px solid ${dotColor}` }}
        aria-hidden
      />
      <span className="text-white/55 tracking-[0.22em]">{label}</span>
      <span className="text-white truncate">
        {station ? station.name : '— click a stop on the map —'}
      </span>
      {station && (
        <span
          className="ml-auto subway-bullet text-[10px] shrink-0"
          style={{ background: LINE_COLOR[line], color: lineTextColor(line) }}
        >
          {line}
        </span>
      )}
    </div>
  );
}

/* The interactive subway-line map: shows every stop on the chosen
   line as a bullet-styled marker, plus a polyline connecting them. */
function SubwayLineMap({
  line,
  lineStations,
  stationsLoaded,
  originIdx,
  destIdx,
  onPick,
}: {
  line: Line;
  lineStations: Station[];
  stationsLoaded: boolean;
  originIdx: number | null;
  destIdx: number | null;
  onPick: (i: number) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Resize trigger so MapLibre paints reliably
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
    return () => { ids.forEach(clearTimeout); ro?.disconnect(); };
  }, []);

  // Fit the line into view when stations or line change
  useEffect(() => {
    if (!lineStations.length) return;
    const m = mapRef.current?.getMap?.();
    if (!m) return;
    let minLat = lineStations[0].lat, maxLat = minLat, minLng = lineStations[0].lng, maxLng = minLng;
    for (const s of lineStations) {
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lng < minLng) minLng = s.lng;
      if (s.lng > maxLng) maxLng = s.lng;
    }
    try {
      m.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 50, duration: 600 });
    } catch { /* noop */ }
  }, [line, lineStations]);

  // Don't draw the full-line connector — lat-sort zigzags for E-W
  // segments and looks like spaghetti. Draw a clean STRAIGHT line just
  // between origin and destination once both are picked.
  const rideGeo = (() => {
    if (originIdx == null || destIdx == null) return null;
    const o = lineStations[originIdx];
    const d = lineStations[destIdx];
    if (!o || !d) return null;
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        geometry: {
          type: 'LineString' as const,
          coordinates: [[o.lng, o.lat], [d.lng, d.lat]],
        },
        properties: {},
      }],
    };
  })();

  return (
    <div
      ref={containerRef}
      className="relative bg-[#0a0a14] border-2 border-white/15 overflow-hidden h-[420px] sm:h-[480px] lg:h-[540px]"
    >
      {!stationsLoaded ? (
        <div className="absolute inset-0 grid place-items-center font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/55">
          loading mta stations…
        </div>
      ) : lineStations.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#ff8a9a]">
          no daytime stops found for {line}
        </div>
      ) : (
        <MapLibre
          ref={mapRef}
          initialViewState={{ longitude: -73.97, latitude: 40.74, zoom: 10.4 }}
          mapStyle={SUBWAY_MAP_STYLE}
          attributionControl={false}
          style={{ position: 'absolute', inset: 0 }}
          onLoad={() => {
            const m = mapRef.current?.getMap?.();
            try { m?.resize(); m?.triggerRepaint(); } catch { /* noop */ }
          }}
        >
          {rideGeo && (
            <Source id="ride-route" type="geojson" data={rideGeo}>
              <Layer
                id="ride-route-layer"
                type="line"
                paint={{
                  'line-color': LINE_COLOR[line],
                  'line-width': 5,
                  'line-opacity': 0.85,
                  'line-dasharray': [2, 2],
                }}
              />
            </Source>
          )}
          {lineStations.map((s, i) => {
            const isOrigin = i === originIdx;
            const isDest = i === destIdx;
            return (
              <Marker
                key={`${s.name}-${i}`}
                longitude={s.lng}
                latitude={s.lat}
                anchor="center"
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPick(i);
                  }}
                  className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
                  title={s.name}
                  aria-label={`${s.name} on the ${line} line`}
                  style={{
                    width: isOrigin || isDest ? 22 : 12,
                    height: isOrigin || isDest ? 22 : 12,
                    borderRadius: '50%',
                    background: isOrigin ? '#6CBE45' : isDest ? '#FF5582' : LINE_COLOR[line],
                    border: isOrigin || isDest ? '3px solid #fff' : '2px solid #000',
                    boxShadow: isOrigin || isDest ? `0 0 0 3px ${isOrigin ? '#6CBE45' : '#FF5582'}55, 0 0 12px rgba(0,0,0,0.7)` : '0 0 4px rgba(0,0,0,0.7)',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              </Marker>
            );
          })}
        </MapLibre>
      )}
      <div
        className="absolute top-2 left-2 px-2 py-1 bg-black/85 border border-[#FFD600] font-bungee text-[10px] uppercase tracking-[0.16em] text-[#FFD600] pointer-events-none"
      >
        ★ {line} line · {lineStations.length} stops
      </div>
    </div>
  );
}

function MtaLineStatus({ line }: { line: Line }) {
  const [status, setStatus] = useState<string>('checking…');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const r = await fetch('https://api.subwaynow.app/routes');
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        if (stop) return;
        const route = (j.routes ?? {})[line];
        setStatus(route?.status ? String(route.status).toLowerCase() : 'good service');
      } catch {
        if (!stop) setStatus('feed unavailable');
      } finally {
        if (!stop) setLoaded(true);
      }
    })();
    return () => { stop = true; };
  }, [line]);
  const ok = status.includes('good');
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 border-2 font-typewriter text-[11px] uppercase tracking-[0.18em]"
      style={{ background: '#0e0f14', borderColor: ok ? '#6CBE45' : '#ff5582', color: ok ? '#9be08a' : '#ffb3c4' }}
      role="status"
      aria-live="polite"
    >
      <span className="subway-bullet text-[12px]" style={{ background: LINE_COLOR[line], color: lineTextColor(line) }}>
        {line}
      </span>
      <span>· {loaded ? status : 'checking mta feed…'}</span>
      <span className="ml-auto text-white/40 text-[9px]">via subwaynow.app</span>
    </div>
  );
}

/* ──────────────────────────────────────── stage 3: side-view POV */

function SubwayCarPOV({
  line,
  ridePlan,
  stationIdx,
  arrived,
  cam,
  nextStationName,
  currentStation,
  onExit,
}: {
  line: Line;
  ridePlan: Station[];
  stationIdx: number;
  arrived: boolean;
  cam: Camera | null;
  nextStationName: string;
  currentStation: Station | undefined;
  onExit: () => void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 1500);
    return () => clearInterval(i);
  }, []);

  const isLast = stationIdx >= ridePlan.length - 1;
  const finalStation = ridePlan[ridePlan.length - 1];

  return (
    <div className="max-w-[1200px] mx-auto">
      {/* roll-sign banner above the car */}
      <RollSign line={line} destination={finalStation?.name ?? ''} />

      {/* progress tracker — segmented bar with stop names */}
      <ProgressTracker
        line={line}
        ridePlan={ridePlan}
        stationIdx={stationIdx}
        arrived={arrived}
      />

      {/* the car interior — side view */}
      <SideViewCar
        line={line}
        cam={cam}
        tick={tick}
        currentStation={currentStation}
        nextStationName={nextStationName}
        arrived={arrived}
        isLast={isLast}
        riding={!arrived}
      />

      {/* status + exit */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {arrived ? (
          <>
            <button
              type="button"
              onClick={onExit}
              className="px-4 py-2 font-bungee text-[16px] uppercase tracking-[0.04em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              style={{ background: '#FFD600', color: '#000', boxShadow: '5px 5px 0 #d11a2a', border: '3px solid #000' }}
            >
              ★ EXIT TO STREET ★
            </button>
            <span className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/85">
              you have arrived · {finalStation?.name}
            </span>
          </>
        ) : (
          <>
            <span className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#FFD600]" aria-live="polite">
              ⚙ in motion · stop {stationIdx + 1} of {ridePlan.length}
            </span>
            <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55 ml-auto">
              please stand clear of the closing doors
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* The horizontal stop-by-stop progress tracker. Big stations, current
   one bright + glowing, train icon parked on the current dot. */
function ProgressTracker({
  line,
  ridePlan,
  stationIdx,
  arrived,
}: {
  line: Line;
  ridePlan: Station[];
  stationIdx: number;
  arrived: boolean;
}) {
  if (ridePlan.length === 0) return null;
  const total = ridePlan.length;
  const progress = total > 1 ? stationIdx / (total - 1) : 1;
  return (
    <div className="mt-3 mb-3 px-3 py-3 bg-black border-2 border-[#FFD600]/45" style={{ boxShadow: '4px 4px 0 #d11a2a' }}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600]">
          ★ Progress · stop {Math.min(stationIdx + 1, total)} / {total}
        </span>
        <span className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/65">
          {arrived ? 'arrived' : `next: ${ridePlan[Math.min(stationIdx + 1, total - 1)]?.name ?? '—'}`}
        </span>
      </div>
      <div className="relative pt-2 pb-7">
        {/* base track */}
        <div className="absolute left-2 right-2 top-[14px] h-1.5" style={{ background: 'rgba(255,255,255,0.12)' }} />
        {/* travelled track */}
        <div
          className="absolute left-2 top-[14px] h-1.5 transition-[width] duration-700 ease-out"
          style={{
            background: LINE_COLOR[line],
            width: `calc(${progress * 100}% * (1 - 16px / 100%))`,
            boxShadow: `0 0 10px ${LINE_COLOR[line]}88`,
          }}
        />
        {/* dots + names */}
        <div className="relative flex items-center justify-between px-2">
          {ridePlan.map((s, i) => {
            const passed = i < stationIdx || (i === stationIdx && arrived);
            const here = i === stationIdx && !arrived;
            return (
              <div key={`${s.name}-${i}`} className="flex flex-col items-center w-0">
                <span
                  className="block rounded-full"
                  style={{
                    width: here ? 16 : 12,
                    height: here ? 16 : 12,
                    background: passed || here ? LINE_COLOR[line] : '#1a1a1a',
                    border: `2px solid ${passed || here ? '#fff' : LINE_COLOR[line]}`,
                    boxShadow: here ? `0 0 14px ${LINE_COLOR[line]}, 0 0 0 4px rgba(255,255,255,0.18)` : 'none',
                    transition: 'all 0.4s ease',
                  }}
                />
                <div
                  className="absolute top-[28px] text-[8.5px] font-typewriter uppercase tracking-[0.1em] whitespace-nowrap"
                  style={{
                    color: here ? '#fff' : passed ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)',
                    transform: 'rotate(-22deg)',
                    transformOrigin: 'top left',
                  }}
                >
                  {s.name}
                </div>
              </div>
            );
          })}
        </div>
        {/* the train icon, parked on the current stop */}
        <div
          className="absolute -top-1 transition-[left] duration-700 ease-out"
          style={{ left: `calc(8px + ${progress * 100}% - 12px)` }}
          aria-hidden
        >
          <span
            className="block w-6 h-6 rounded grid place-items-center font-bungee text-[10px] leading-none"
            style={{
              background: LINE_COLOR[line],
              color: lineTextColor(line),
              border: '2px solid #fff',
              boxShadow: `0 0 12px ${LINE_COLOR[line]}cc`,
            }}
          >
            {line}
          </span>
        </div>
      </div>
    </div>
  );
}

/* The big visual: side view of the subway car. Top half = the wall
   across from your seat — ad rail, hand strap row, stainless panels,
   and the door window with the live cam. Bottom half = your bench
   (foreground orange sliver) + dark floor with safety strip + a yellow
   grab pole on the right edge selling the "I'm sitting on the bench"
   POV from the reference photo. */
function SideViewCar({
  line,
  cam,
  tick,
  currentStation,
  nextStationName,
  arrived,
  isLast,
  riding,
}: {
  line: Line;
  cam: Camera | null;
  tick: number;
  currentStation: Station | undefined;
  nextStationName: string;
  arrived: boolean;
  isLast: boolean;
  riding: boolean;
}) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        // stainless steel walls + dark floor split horizontally
        background: 'linear-gradient(180deg,#9da3ac 0%,#bcc1c8 8%,#cdd2d8 18%,#a8aeb6 58%,#1a1a1a 58%,#0a0a0a 100%)',
        border: '6px solid #0a0a0a',
        borderRadius: 12,
        boxShadow: 'inset 0 0 80px rgba(0,0,0,0.55), 0 18px 30px rgba(0,0,0,0.55)',
        minHeight: 420,
      }}
    >
      {/* ceiling fluorescents */}
      <div className="absolute top-0 inset-x-0 h-[10px] flex justify-around" aria-hidden>
        {Array.from({ length: 22 }).map((_, i) => (
          <span
            key={i}
            className="block h-full"
            style={{
              width: 38,
              background: 'linear-gradient(180deg,#fff7d0,#ffe69a 60%,transparent)',
              opacity: 0.9,
              margin: '0 4px',
            }}
          />
        ))}
      </div>

      {/* upper ad rail */}
      <div
        className="px-3 py-1.5 mt-2 flex items-center gap-2 text-[10px] font-typewriter uppercase tracking-[0.18em] border-y border-[#8a8a82]"
        style={{ background: '#fffae6', color: '#1a1410' }}
      >
        <span className="font-bungee text-[12px] text-[#0039A6]">★ Dr. Zizmor</span>
        <span className="text-[#1a1410]/70">— clear skin · fresh start</span>
        <span className="ml-auto subway-bullet text-[12px]" style={{ background: LINE_COLOR[line], color: lineTextColor(line) }}>
          {line}
        </span>
        <span className="text-[#d11a2a] font-bungee text-[12px]">if you see something</span>
        <span className="text-[#1a1410]/70">say something</span>
      </div>

      {/* hand-strap row */}
      <div
        className="h-7 flex items-start justify-around overflow-hidden"
        style={{ background: 'linear-gradient(180deg,#cdd2d8,#a8aeb6)' }}
        aria-hidden
      >
        {Array.from({ length: 28 }).map((_, i) => (
          <span
            key={i}
            className="block"
            style={{
              width: 2,
              height: 18,
              background: '#5a3820',
              marginTop: -2,
              animation: `strap-sway ${1.4 + (i % 5) * 0.18}s ease-in-out infinite alternate`,
              animationDelay: `${i * 0.06}s`,
            }}
          />
        ))}
      </div>

      {/* the door + window strip — the cam frame is the WINDOW */}
      <div className="relative px-2 sm:px-4 pt-1">
        {/* "next stop" dot-matrix above the doors */}
        <div
          className="mx-auto mb-2 px-3 py-0.5 text-center font-mono text-[11px] tracking-[0.18em] uppercase max-w-[640px]"
          style={{
            background: '#000',
            color: '#ff8a3a',
            textShadow: '0 0 6px #ff8a3a, 0 0 14px #ff8a3a55',
            border: '1px solid #1a1a1a',
          }}
        >
          {arrived
            ? `★ NOW ARRIVING · ${currentStation?.name ?? ''} ★`
            : isLast
            ? `★ NEXT STOP · ${currentStation?.name ?? ''} ★`
            : `★ NEXT STOP · ${nextStationName} ★`}
        </div>

        {/* the door wall — flanked by stainless panels, with a vent
            up top and the window cutout containing the cam */}
        <div
          className="grid grid-cols-[60px_minmax(0,1fr)_60px] sm:grid-cols-[110px_minmax(0,1fr)_110px] gap-0"
        >
          {/* left stainless wall panel — vent + ad sliver */}
          <StainlessWall side="left" />

          {/* THE WINDOW — the cam goes here. Yellow door edges, dark
              window frame, the live cam image, motion-blur edge masks
              that pulse during the ride to sell the "passing by" feel. */}
          <div className="relative">
            {/* yellow door edges (the sliding doors of the car) */}
            <div
              className="absolute top-0 bottom-0 w-3"
              style={{ left: 0, background: 'linear-gradient(180deg,#FFD600,#E5C200)', borderRight: '2px solid #1a1a1a' }}
              aria-hidden
            />
            <div
              className="absolute top-0 bottom-0 w-3"
              style={{ right: 0, background: 'linear-gradient(180deg,#FFD600,#E5C200)', borderLeft: '2px solid #1a1a1a' }}
              aria-hidden
            />

            {/* the window itself — recessed, dark frame, rounded corners
                like an actual subway window */}
            <div
              className="relative mx-3"
              style={{
                aspectRatio: '16 / 9',
                minHeight: 220,
                background: '#000',
                border: '4px solid #1a1a1a',
                borderRadius: '14px / 10px',
                overflow: 'hidden',
                boxShadow:
                  'inset 0 0 0 4px rgba(255,255,255,0.06), inset 0 0 60px rgba(0,0,0,0.7), 0 6px 14px rgba(0,0,0,0.6)',
              }}
            >
              {/* tunnel scroll — visible behind the cam */}
              <div className="absolute inset-0 tunnel-scroll" />
              {/* the live camera image */}
              {cam ? (
                <img
                  key={cam.id}
                  src={NYCTMC_IMG(cam.id, tick)}
                  alt={`Traffic camera near ${currentStation?.name ?? 'stop'}`}
                  referrerPolicy="no-referrer"
                  decoding="async"
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{
                    filter: arrived ? 'none' : 'contrast(1.05) saturate(0.92)',
                  }}
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-[#FFD600]/65 font-typewriter text-[10px] uppercase tracking-[0.22em]">
                  — tunnel —
                </div>
              )}
              {/* MOTION BLUR edges — fade dark on left + right; pulses
                  while riding so it reads as "passing by", static on
                  arrival when the train has stopped */}
              {riding && <MotionEdges />}
              {/* glass reflection */}
              <div
                className="absolute inset-x-0 top-0 h-1/3 pointer-events-none"
                style={{ background: 'linear-gradient(180deg,rgba(255,255,255,0.16),rgba(255,255,255,0))' }}
                aria-hidden
              />
              {/* station whoosh banner */}
              <div key={`${currentStation?.name}-${tick}`} className="absolute top-2 left-2 station-whoosh">
                <div
                  className="bg-[#FFD600] text-black px-3 py-1 font-bungee uppercase tracking-[0.06em] text-[15px] inline-block"
                  style={{ boxShadow: '3px 3px 0 #d11a2a' }}
                >
                  {currentStation?.name}
                </div>
              </div>
            </div>

            {/* tiny "DO NOT HOLD DOORS" sticker, positioned over the door
                between the window and the floor */}
            <div className="absolute bottom-1 left-6 right-6 px-2 py-0.5 flex items-center gap-2 bg-[#1a1a1a] z-10">
              <span className="text-[#FFD600] font-bungee text-[9px] uppercase tracking-[0.18em]">★ DO NOT HOLD DOORS</span>
              <span className="text-white/55 font-typewriter text-[8px] uppercase tracking-[0.22em]">car #{4400 + (line.charCodeAt(0) % 50)}</span>
            </div>
          </div>

          {/* right stainless wall panel */}
          <StainlessWall side="right" />
        </div>
      </div>

      {/* opposite bench — orange R32-ish vinyl, runs the width of the car */}
      <div className="absolute bottom-[42%] inset-x-2 sm:inset-x-4" style={{ pointerEvents: 'none' }}>
        {/* hidden, just for spacing reference; bench is rendered below */}
      </div>

      {/* aisle floor — perspective tile lines and yellow safety strip */}
      <div
        className="relative mt-1"
        style={{ height: 60, background: 'linear-gradient(180deg,#3a3a3e 0%,#0e0e10 100%)' }}
        aria-hidden
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              'repeating-linear-gradient(90deg,rgba(255,255,255,0.04) 0px,rgba(255,255,255,0.04) 1px,transparent 1px,transparent 28px)',
            transform: 'perspective(220px) rotateX(48deg)',
            transformOrigin: 'center top',
          }}
        />
        {/* yellow safety strip at the door */}
        <div className="absolute top-0 inset-x-[18%] h-1.5" style={{ background: '#FFD600', boxShadow: '0 0 6px #FFD60088' }} />
      </div>

      {/* foreground bench — your bench, just a sliver visible at the
          bottom of the frame so the POV reads as seated */}
      <ForegroundBench />

      {/* yellow grab pole on the right side, foreground; from the
          reference image that pole is unmistakable */}
      <ForegroundPole side="right" />
      {/* a quieter chrome pole on the left */}
      <ForegroundPole side="left" chrome />
    </div>
  );
}

function StainlessWall({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      className="hidden sm:flex flex-col self-stretch"
      style={{
        background:
          'linear-gradient(180deg,#cdd2d8 0%,#a8aeb6 60%,#7e8189 100%)',
        borderLeft: side === 'right' ? '1px solid #6a6e76' : 'none',
        borderRight: side === 'left' ? '1px solid #6a6e76' : 'none',
        position: 'relative',
      }}
      aria-hidden
    >
      {/* rivet line + thin window slits (suggestive only) */}
      <div className="absolute top-2 bottom-2 w-1 rounded-full" style={{ left: side === 'left' ? '8px' : 'auto', right: side === 'right' ? '8px' : 'auto', background: 'repeating-linear-gradient(180deg,#5a5e66 0px,#5a5e66 2px,transparent 2px,transparent 6px)' }} />
      {/* ad placard */}
      <div
        className="m-auto w-[80%] aspect-[3/4] flex items-center justify-center text-center px-1"
        style={{ background: '#0e0f14', border: '1px solid #1a1a1a' }}
      >
        <div>
          <div className="font-bungee text-[10px] sm:text-[12px] text-[#ff5582] neon">RX</div>
          <div className="font-typewriter text-[7px] sm:text-[8px] uppercase tracking-[0.2em] text-white/65 mt-1 leading-tight">
            See A<br/>Doctor<br/>About It
          </div>
        </div>
      </div>
    </div>
  );
}

function MotionEdges() {
  // Two side gradients that fade dark in from the edges, plus a
  // "speed-line" overlay that animates horizontally — sells the feeling
  // that the camera is being seen through a moving subway window.
  return (
    <>
      <div
        className="absolute inset-y-0 left-0 w-12 motion-fade-l pointer-events-none"
        aria-hidden
      />
      <div
        className="absolute inset-y-0 right-0 w-12 motion-fade-r pointer-events-none"
        aria-hidden
      />
      <div className="absolute inset-0 motion-streaks pointer-events-none" aria-hidden />
    </>
  );
}

function ForegroundBench() {
  // Two-tone orange — the bucket-seat row at the very bottom, with a
  // chrome rim. Just a sliver so it reads as foreground, not the focus.
  return (
    <div
      className="absolute bottom-0 inset-x-0 z-10 h-[40px] sm:h-[52px]"
      style={{
        background:
          'linear-gradient(180deg,#FF8A3A 0%,#E5641F 32%,#9c3f10 70%,#1a1a1a 100%)',
        borderTop: '2px solid #1a1410',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 -3px 8px rgba(0,0,0,0.65)',
      }}
      aria-hidden
    >
      {/* bucket dividers — vertical creases */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(90deg,transparent 0px,transparent 78px,rgba(0,0,0,0.4) 78px,rgba(0,0,0,0.4) 80px)',
        }}
      />
      {/* a hint of chrome edge along the front of the bench */}
      <div
        className="absolute top-[2px] inset-x-0 h-0.5"
        style={{ background: 'linear-gradient(90deg,#9aa0a8 0%,#e8ecef 50%,#7a808a 100%)' }}
      />
    </div>
  );
}

function ForegroundPole({ side, chrome = false }: { side: 'left' | 'right'; chrome?: boolean }) {
  return (
    <span
      className="absolute top-2 bottom-[58px] z-20 hidden sm:block"
      style={{
        [side]: '4%',
        width: 8,
        background: chrome
          ? 'linear-gradient(90deg,#9aa0a8 0%,#e8ecef 50%,#7a808a 100%)'
          : 'linear-gradient(90deg,#c8a000 0%,#FFD600 35%,#fff8a0 50%,#FFD600 65%,#c8a000 100%)',
        boxShadow: chrome
          ? '0 0 8px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4)'
          : '0 0 12px rgba(255,214,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.4)',
      } as React.CSSProperties}
      aria-hidden
    />
  );
}

/* ──────────────────────────────────────── shared parts */

function RollSign({ line, destination }: { line: Line; destination: string }) {
  const text = `${line} TO ${(destination || '—').toUpperCase()}`;
  return (
    <div
      className="relative px-3 py-2 flex items-center gap-3"
      style={{ background: '#000', border: '3px solid #1a1a1a', boxShadow: 'inset 0 0 24px rgba(0,0,0,0.95), 0 4px 0 rgba(0,0,0,0.7)' }}
    >
      <span
        className="subway-bullet text-[18px]"
        style={{ background: LINE_COLOR[line], color: lineTextColor(line), minWidth: 38, height: 38 }}
      >
        {line}
      </span>
      <span
        className="font-mono uppercase tracking-[0.12em] text-[16px] sm:text-[20px]"
        style={{
          color: '#ff8a3a',
          textShadow: '0 0 6px #ff8a3a, 0 0 14px #ff8a3a55, 0 0 28px #ff8a3a33',
          fontFamily: '"VT323","Press Start 2P","Courier New",monospace',
        }}
      >
        ★ {text} ★
      </span>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.22em] text-[#ff8a3a]/55">
        NYCTA · LOCAL
      </span>
    </div>
  );
}

/* ──────────────────────────────────────── audio: train rumble */

function useTrainRumble(active: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!active) {
      stopRef.current?.();
      stopRef.current = null;
      return;
    }
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!ctxRef.current) ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 240;
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      src.connect(lp).connect(gain).connect(ctx.destination);
      src.start();

      const clackTimer = setInterval(() => {
        try {
          const t = ctx.currentTime;
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = 'square';
          o.frequency.setValueAtTime(480, t);
          o.frequency.exponentialRampToValueAtTime(80, t + 0.06);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
          o.connect(g).connect(ctx.destination);
          o.start(t);
          o.stop(t + 0.08);
        } catch { /* noop */ }
      }, 420);

      stopRef.current = () => {
        try { src.stop(); } catch { /* noop */ }
        clearInterval(clackTimer);
      };
    } catch { /* noop */ }
    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [active]);
}

/* ──────────────────────────────────────── animations */

const TRAIN_KEYFRAMES = `
@keyframes strap-sway {
  from { transform: rotate(-2deg); }
  to   { transform: rotate(2deg); }
}
@keyframes tunnel-pan {
  from { background-position: 0 0; }
  to   { background-position: -800px 0; }
}
.tunnel-scroll {
  background:
    repeating-linear-gradient(90deg, #0a0a0e 0px, #0a0a0e 60px, #1a1820 60px, #1a1820 64px, #0a0a0e 64px, #0a0a0e 120px, #2a2218 120px, #2a2218 124px),
    radial-gradient(ellipse at 30% 50%, rgba(255,150,40,0.05), transparent 60%);
  animation: tunnel-pan 1.6s linear infinite;
}
@keyframes station-whoosh {
  0%   { transform: translateX(110%); opacity: 0; }
  20%  { transform: translateX(0); opacity: 1; }
  85%  { transform: translateX(0); opacity: 1; }
  100% { transform: translateX(-120%); opacity: 0; }
}
.station-whoosh {
  animation: station-whoosh 6s ease-in-out 1;
  padding: 6px 8px;
}
/* motion blur on left + right edges of the cam window */
.motion-fade-l {
  background: linear-gradient(90deg, rgba(0,0,0,0.85), rgba(0,0,0,0.0));
  animation: motion-pulse-l 0.65s ease-in-out infinite;
}
.motion-fade-r {
  background: linear-gradient(270deg, rgba(0,0,0,0.85), rgba(0,0,0,0.0));
  animation: motion-pulse-r 0.65s ease-in-out infinite;
}
@keyframes motion-pulse-l {
  from { opacity: 0.55; transform: translateX(-2px); }
  to   { opacity: 0.85; transform: translateX(0); }
}
@keyframes motion-pulse-r {
  from { opacity: 0.55; transform: translateX(2px); }
  to   { opacity: 0.85; transform: translateX(0); }
}
/* horizontal speed-streaks layered over the cam to sell motion */
.motion-streaks {
  background-image:
    linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.04) 8%, transparent 14%),
    linear-gradient(90deg, transparent 30%, rgba(255,255,255,0.05) 38%, transparent 44%),
    linear-gradient(90deg, transparent 60%, rgba(255,255,255,0.04) 68%, transparent 74%);
  background-size: 240px 2px, 240px 1px, 240px 2px;
  background-position: 0 30%, 0 55%, 0 80%;
  animation: motion-streaks 0.45s linear infinite;
  mix-blend-mode: screen;
}
@keyframes motion-streaks {
  from { background-position: 0 30%, 0 55%, 0 80%; }
  to   { background-position: -300px 30%, -340px 55%, -260px 80%; }
}
`;
