import { useEffect, useMemo, useRef, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, QuarterIcon, useQuarters } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';

/* ──────────────────────────────────────────────────────────────────────
   /turnstile — Hop the Turnstile.
   Real station data from NYC Open Data (MTA Subway Stations dataset).
   Pick any line, pick a station to ride to, then sit inside an R32-ish
   subway car (POV from the bench) while the train rolls through 5
   stops. The "door window" across the aisle frames the NYC TMC traffic
   cam closest to each stop.
   ──────────────────────────────────────────────────────────────────── */

type Station = {
  name: string;
  lat: number;
  lng: number;
  lines: string[]; // e.g. ['A','C','E']
};

const MTA_STATIONS_URL =
  'https://data.ny.gov/resource/39hk-dx4f.json' +
  '?$select=stop_name,gtfs_latitude,gtfs_longitude,daytime_routes,borough' +
  '&$limit=600';

// Canonical NYC subway line set (north–south + crosstown). Express
// variants share the same trunk so we keep them as their own pickable
// "trains" — just like the bullets riders see.
const ALL_LINES = [
  '1','2','3','4','5','6','7',
  'A','B','C','D','E','F','G','J','L','M','N','Q','R','W','Z',
  'SI', // Staten Island Railway
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
  // Yellow lines need black text; everything else white.
  return line === 'N' || line === 'Q' || line === 'R' || line === 'W' || line === 'L' ? '#000' : '#fff';
}

const STATION_DWELL_MS = 5800;
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

/* Use the MTA Open Data subway stations endpoint to enumerate every
   stop (lat/lng + the lines that serve it). Cached to localStorage
   for a day so reloads don't keep refetching ~470 stations. */
type RawStation = {
  stop_name: string;
  gtfs_latitude: string;
  gtfs_longitude: string;
  daytime_routes: string;
};
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
  const [error, setError] = useState<string | null>(null);

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
            lines: (row.daytime_routes ?? '')
              .split(/\s+/)
              .map((s) => s.trim())
              .filter(Boolean),
          }))
          .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.name && s.lines.length > 0);
        // Dedupe by name+lines fingerprint (some stops repeat per platform)
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
      } catch (e) {
        if (!stop) {
          setError(String(e));
          setLoaded(true);
        }
      }
    })();
    return () => { stop = true; };
  }, [loaded]);

  return { stations, loaded, error };
}

type Stage = 'idle' | 'boarding' | 'riding' | 'arrived';

export default function Turnstile() {
  const [stage, setStage] = useState<Stage>('idle');
  const [line, setLine] = useState<Line>('F');
  const [destIdx, setDestIdx] = useState<number>(0);
  const [stationIdx, setStationIdx] = useState(0);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const { count: quarters, spend } = useQuarters();

  const { stations, loaded: stationsLoaded } = useMtaStations();

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);

  // Stations on the picked line, ordered roughly north → south by lat.
  const lineStations = useMemo(() => {
    const onLine = stations.filter((s) => s.lines.includes(line));
    // Sort north-south so the strip-map reads geographically. Manhattan
    // bias: most lines run roughly N→S; for E-W trunks (G, L, 7) this
    // still produces a reasonable ordering by lat.
    return onLine.slice().sort((a, b) => b.lat - a.lat);
  }, [stations, line]);

  // The 5-station ride window leading to destination
  const ridePlan = useMemo(() => {
    if (!lineStations.length) return [];
    const dest = Math.min(destIdx, lineStations.length - 1);
    const start = Math.max(0, dest - 4);
    return lineStations.slice(start, dest + 1);
  }, [lineStations, destIdx]);

  // Auto-advance through stations during the ride
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
  };

  const currentStation = ridePlan[Math.min(stationIdx, ridePlan.length - 1)];
  const nextStation = ridePlan[Math.min(stationIdx + 1, ridePlan.length - 1)];
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
            destIdx={destIdx}
            setDestIdx={setDestIdx}
            lineStations={lineStations}
            stationsLoaded={stationsLoaded}
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
        ride any nyc line · 5 stops · door window = the cam nearest your stop
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
        <li>★ pick any of the 24 lines (1–7, a–z, sir)</li>
        <li>★ stations pulled live from mta open data</li>
        <li>★ each stop's door window shows the closest nyc dot cam</li>
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

/* ──────────────────────────────────────── stage 2: line + destination */

function Boarding({
  line,
  setLine,
  destIdx,
  setDestIdx,
  lineStations,
  stationsLoaded,
  onBoard,
  onCancel,
}: {
  line: Line;
  setLine: (l: Line) => void;
  destIdx: number;
  setDestIdx: (i: number) => void;
  lineStations: Station[];
  stationsLoaded: boolean;
  onBoard: () => void;
  onCancel: () => void;
}) {
  // Reset destination when the line switches
  useEffect(() => {
    setDestIdx(Math.min(destIdx, Math.max(0, lineStations.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, lineStations.length]);

  const dest = Math.min(destIdx, Math.max(0, lineStations.length - 1));
  const start = Math.max(0, dest - 4);
  const ride = lineStations.slice(start, dest + 1);
  const destStation = lineStations[dest];

  return (
    <div className="max-w-[920px] mx-auto">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-bungee text-[32px] sm:text-[44px] leading-none uppercase">
          ★ Pick a Line
        </div>
        <button onClick={onCancel} className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65 hover:text-[#FFD600] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]">
          ← back
        </button>
      </div>
      <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mb-5">
        every nyc subway line · stations live from mta open data · pick a destination
      </div>

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

      <div className="mt-3 mb-2 font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65">
        ★ destinations on the {line} ({lineStations.length} stops)
      </div>
      <div
        className="bg-[#0a0a14] border-2 border-white/15 px-2 py-3 max-h-[260px] overflow-y-auto"
        role="listbox"
        aria-label="Destinations"
      >
        {!stationsLoaded ? (
          <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/55 px-2 py-4">
            loading mta stations…
          </div>
        ) : lineStations.length === 0 ? (
          <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#ff8a9a] px-2 py-4">
            no daytime stops found for {line}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {lineStations.map((s, i) => {
              const isDest = i === dest;
              const inRide = i >= start && i <= dest;
              return (
                <li key={`${s.name}-${i}`}>
                  <button
                    type="button"
                    onClick={() => setDestIdx(i)}
                    className={`w-full text-left px-2 py-1 flex items-center gap-2 font-typewriter text-[11px] uppercase tracking-[0.12em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600] ${
                      isDest ? 'bg-[#FFD600]/15 text-[#FFD600]' : inRide ? 'text-white/85 hover:bg-white/5' : 'text-white/65 hover:bg-white/5'
                    }`}
                    aria-selected={isDest}
                    role="option"
                  >
                    <span
                      className="block rounded-full shrink-0"
                      style={{
                        width: isDest ? 12 : 8,
                        height: isDest ? 12 : 8,
                        background: isDest ? '#fff' : inRide ? LINE_COLOR[line] : '#3a3a3a',
                        border: `2px solid ${LINE_COLOR[line]}`,
                        boxShadow: isDest ? `0 0 10px ${LINE_COLOR[line]}` : 'none',
                      }}
                    />
                    <span className="truncate flex-1">{s.name}</span>
                    {inRide && <span className="text-[8px] tracking-[0.3em] text-white/45">in ride</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {destStation && (
        <>
          <div className="mt-5 mb-3">
            <RollSign line={line} destination={destStation.name} />
          </div>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/55 mb-5">
            ride: {ride.map((s) => s.name).join(' → ')}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onBoard}
        disabled={!destStation}
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

/* ──────────────────────────────────────── stage 3: POV from the seat
   Real R32-ish car interior, drawn from the perspective of someone
   sitting on the bench. The opposite wall (with doors and the strip
   map) is in the upper half; floor + your-bench-edge in the lower.
   The "door window" between the doors frames the live traffic cam
   for the current stop. */

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
      {/* roll sign + strip map sits above the POV — like the destination
          sign you'd see on the platform end of the car */}
      <RollSign line={line} destination={finalStation?.name ?? ''} />
      <div className="mt-2 mb-4 px-2 py-2 bg-[#0e0f14] border-2 border-white/15">
        <StripMap
          line={line}
          stations={ridePlan}
          highlighted={stationIdx}
          rideStart={0}
          rideEnd={Math.max(0, ridePlan.length - 1)}
          riding
        />
      </div>

      <div
        className="relative overflow-hidden"
        style={{
          // the car interior — silver-aluminum walls, ceiling lights
          background:
            'linear-gradient(180deg,#9ea4ad 0%,#bcc1c8 8%,#cdd2d8 16%,#cdd2d8 60%,#1a1a1a 60%,#1a1a1a 100%)',
          border: '6px solid #2a2a2a',
          borderRadius: 12,
          boxShadow: 'inset 0 0 80px rgba(0,0,0,0.55), 0 18px 30px rgba(0,0,0,0.55)',
        }}
      >
        {/* ceiling fluorescents */}
        <CeilingLights />

        {/* upper rail of ad placards across the OPPOSITE side of the car */}
        <UpperAdRail line={line} />

        {/* hand-strap row */}
        <HandStraps />

        {/* the wall across from you: doors with windows + bench beneath +
            two end-panels. We place this as a centered strip with the
            two side benches flanking it. */}
        <div className="relative grid grid-cols-[110px_minmax(0,1fr)_110px] gap-0 px-2 pt-1">
          {/* left end-of-car panel: route map placard */}
          <SidePanelMap line={line} />

          {/* middle: the doors and the live cam framed by them */}
          <DoorWall
            line={line}
            cam={cam}
            tick={tick}
            currentStation={currentStation}
            nextStationName={nextStationName}
            arrived={arrived}
            isLast={isLast}
          />

          {/* right end-of-car panel: ad poster */}
          <SidePanelAd />
        </div>

        {/* opposite bench — orange R32 plastic, in front of the doors */}
        <OppositeBench />

        {/* floor — perspective tiles vanishing forward; this gives the
            POV its "I'm sitting and looking across" feel */}
        <PerspectiveFloor />

        {/* the very bottom edge: a sliver of YOUR bench (foreground) */}
        <ForegroundBench />

        {/* center grab pole, foreground (between you and the doors) */}
        <FrontPoles />
      </div>

      {/* below-car: status / exit */}
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

/* ──────────────────────────────────────── POV parts */

function CeilingLights() {
  return (
    <div className="absolute top-0 inset-x-0 h-2 flex justify-around overflow-hidden" aria-hidden>
      {Array.from({ length: 18 }).map((_, i) => (
        <span
          key={i}
          className="block h-full"
          style={{
            width: 36,
            background: 'linear-gradient(180deg,#fff7d0,#ffe69a 60%,transparent)',
            opacity: 0.85,
            margin: '0 4px',
          }}
        />
      ))}
    </div>
  );
}

function UpperAdRail({ line }: { line: Line }) {
  return (
    <div
      className="px-3 py-1.5 flex items-center gap-2 text-[10px] font-typewriter uppercase tracking-[0.18em] border-y border-[#8a8a82]"
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
  );
}

function HandStraps() {
  return (
    <div
      className="h-7 flex items-start justify-around overflow-hidden"
      style={{ background: 'linear-gradient(180deg,#cdd2d8,#a8aeb6)' }}
      aria-hidden
    >
      {Array.from({ length: 22 }).map((_, i) => (
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
  );
}

function SidePanelMap({ line }: { line: Line }) {
  return (
    <div
      className="hidden md:block self-stretch border-y border-[#8a8a82]"
      style={{ background: '#0e0f14' }}
      aria-label="Subway route map placard"
    >
      <div className="h-full flex flex-col items-center justify-center px-2 py-2">
        <div className="font-bungee text-[10px] tracking-[0.18em] text-[#FFD600] uppercase mb-1">★ ROUTE</div>
        <div className="subway-bullet text-[16px] mb-1.5" style={{ background: LINE_COLOR[line], color: lineTextColor(line), width: 36, height: 36 }}>
          {line}
        </div>
        <div className="text-[8px] uppercase tracking-[0.22em] font-typewriter text-white/55 text-center leading-tight">
          IND/IRT/BMT<br/>NEW YORK CITY<br/>TRANSIT
        </div>
      </div>
    </div>
  );
}

function SidePanelAd() {
  return (
    <div
      className="hidden md:block self-stretch border-y border-[#8a8a82]"
      style={{ background: '#0e0f14' }}
      aria-hidden
    >
      <div className="h-full flex flex-col items-center justify-center px-2 py-2">
        <div className="font-bungee text-[14px] text-[#ff5582] neon">RX</div>
        <div className="text-[8px] uppercase tracking-[0.18em] font-typewriter text-white/65 text-center leading-tight mt-1">
          SEE A<br/>DOCTOR<br/>ABOUT IT
        </div>
        <div className="text-[7px] uppercase tracking-[0.22em] font-typewriter text-white/35 mt-2">★ poets ad ★</div>
      </div>
    </div>
  );
}

function DoorWall({
  line,
  cam,
  tick,
  currentStation,
  nextStationName,
  arrived,
  isLast,
}: {
  line: Line;
  cam: Camera | null;
  tick: number;
  currentStation: Station | undefined;
  nextStationName: string;
  arrived: boolean;
  isLast: boolean;
}) {
  return (
    <div className="relative" style={{ background: 'linear-gradient(180deg,#cdd2d8,#a8aeb6)' }}>
      {/* "next stop" dot-matrix marquee above the doors */}
      <div
        className="absolute -top-7 left-2 right-2 z-10 px-2 py-0.5 text-center font-mono text-[11px] tracking-[0.18em] uppercase"
        style={{ background: '#000', color: '#ff8a3a', textShadow: '0 0 6px #ff8a3a, 0 0 14px #ff8a3a55', border: '1px solid #1a1a1a' }}
      >
        {arrived
          ? `★ NOW ARRIVING · ${currentStation?.name ?? ''} ★`
          : isLast
          ? `★ NEXT STOP · ${currentStation?.name ?? ''} ★`
          : `★ NEXT STOP · ${nextStationName} ★`}
      </div>

      <div className="grid grid-cols-[16px_minmax(0,1fr)_16px] gap-0 pt-1">
        <DoorEdge side="left" />

        {/* between the doors: the cam window */}
        <div
          className="relative"
          style={{
            background: '#0a0a0a',
            border: '6px solid #2a2a2a',
            borderTop: '6px solid #FFD600',
            borderBottom: '6px solid #FFD600',
          }}
        >
          <div
            className="relative"
            style={{ aspectRatio: '16 / 9', minHeight: 240, background: '#000', overflow: 'hidden' }}
          >
            <div className="absolute inset-0 tunnel-scroll" />
            {cam ? (
              <img
                key={cam.id}
                src={NYCTMC_IMG(cam.id, tick)}
                alt={`Traffic camera near ${currentStation?.name ?? 'stop'}`}
                referrerPolicy="no-referrer"
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover"
                style={{ filter: arrived ? 'none' : 'contrast(1.05) saturate(0.92)' }}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-[#FFD600]/65 font-typewriter text-[10px] uppercase tracking-[0.22em]">
                — tunnel —
              </div>
            )}
            {/* whoosh banner when the station appears */}
            <div key={`${currentStation?.name}-${tick}`} className="absolute top-0 left-0 right-0 station-whoosh">
              <div
                className="bg-[#FFD600] text-black px-3 py-1 font-bungee uppercase tracking-[0.06em] text-[15px] inline-block"
                style={{ boxShadow: '3px 3px 0 #d11a2a' }}
              >
                {currentStation?.name}
              </div>
            </div>
            {/* glass reflection */}
            <div className="absolute inset-x-0 top-0 h-1/3" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0))' }} />
          </div>
          <div className="px-2 py-1 flex items-center gap-2 bg-[#1a1a1a]">
            <span className="text-[#FFD600] font-bungee text-[10px] uppercase tracking-[0.18em]">★ DO NOT HOLD DOORS</span>
            <span className="text-white/55 font-typewriter text-[8px] uppercase tracking-[0.22em]">car #{4400 + (line.charCodeAt(0) % 50)}</span>
          </div>
        </div>

        <DoorEdge side="right" />
      </div>
    </div>
  );
}

function DoorEdge({ side }: { side: 'left' | 'right' }) {
  return (
    <div
      className="relative h-full"
      style={{
        background: 'linear-gradient(90deg,#FFD600 0%,#E5C200 100%)',
        borderLeft: side === 'right' ? '2px solid #1a1a1a' : 'none',
        borderRight: side === 'left' ? '2px solid #1a1a1a' : 'none',
      }}
      aria-hidden
    />
  );
}

function OppositeBench() {
  return (
    <div className="relative px-3" aria-hidden>
      <svg viewBox="0 0 1100 88" preserveAspectRatio="none" width="100%" height="88">
        <defs>
          <linearGradient id="benchGrad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#FF8A3A" />
            <stop offset="60%" stopColor="#E5641F" />
            <stop offset="100%" stopColor="#9c3f10" />
          </linearGradient>
        </defs>
        {/* the bench seat row across the car */}
        <rect x="0" y="2" width="1100" height="46" fill="url(#benchGrad)" stroke="#1a1410" strokeWidth="1" />
        {/* individual buckets */}
        {Array.from({ length: 14 }).map((_, i) => (
          <g key={i} transform={`translate(${i * 78 + 6} 48)`}>
            <path d="M 0 0 H 70 V 32 Q 35 36 0 32 Z" fill="url(#benchGrad)" stroke="#1a1410" strokeWidth="1" />
            <path d="M 6 32 Q 35 36 64 32" stroke="#1a1410" strokeWidth="0.6" fill="none" opacity="0.5" />
          </g>
        ))}
      </svg>
    </div>
  );
}

function PerspectiveFloor() {
  return (
    <div
      className="relative overflow-hidden"
      style={{ height: 60, background: 'linear-gradient(180deg,#5a5a5a 0%,#1a1a1a 100%)' }}
      aria-hidden
    >
      {/* perspective tile lines vanishing toward the doors */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(90deg,rgba(255,255,255,0.05) 0px,rgba(255,255,255,0.05) 1px,transparent 1px,transparent 28px)',
          transform: 'perspective(220px) rotateX(48deg)',
          transformOrigin: 'center top',
        }}
      />
      {/* yellow safety strip at the door */}
      <div className="absolute top-0 inset-x-[12%] h-1.5" style={{ background: '#FFD600', boxShadow: '0 0 6px #FFD60088' }} />
    </div>
  );
}

function ForegroundBench() {
  // The very bottom of the screen: a sliver of orange vinyl + chrome
  // edge, "your" bench. Sells the seated POV.
  return (
    <div
      className="relative h-3"
      style={{
        background:
          'linear-gradient(180deg,#FF8A3A 0%,#E5641F 60%,#9c3f10 100%)',
        borderTop: '1px solid #1a1410',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 -2px 6px rgba(0,0,0,0.55)',
      }}
      aria-hidden
    />
  );
}

function FrontPoles() {
  // Two vertical chrome poles in the foreground, between the seated
  // viewer and the door wall. Layered above floor/bench.
  return (
    <>
      <span
        className="absolute left-[14%] top-2 bottom-3 z-20 hidden sm:block"
        style={{
          width: 6,
          background: 'linear-gradient(90deg,#9aa0a8 0%,#e8ecef 50%,#7a808a 100%)',
          boxShadow: '0 0 10px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4)',
        }}
        aria-hidden
      />
      <span
        className="absolute right-[14%] top-2 bottom-3 z-20 hidden sm:block"
        style={{
          width: 6,
          background: 'linear-gradient(90deg,#9aa0a8 0%,#e8ecef 50%,#7a808a 100%)',
          boxShadow: '0 0 10px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4)',
        }}
        aria-hidden
      />
    </>
  );
}

/* ──────────────────────────────────────── shared parts */

function StripMap({
  line,
  stations,
  highlighted,
  rideStart,
  rideEnd,
  riding = false,
}: {
  line: Line;
  stations: Station[];
  highlighted: number;
  onPick?: (i: number) => void;
  rideStart: number;
  rideEnd: number;
  riding?: boolean;
}) {
  if (stations.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <div className="relative pt-4 pb-7 min-w-[640px]">
        <div className="absolute left-3 right-3 top-1/2 -translate-y-1/2 h-1.5" style={{ background: LINE_COLOR[line], opacity: 0.3 }} />
        <div
          className="absolute h-1.5 top-1/2 -translate-y-1/2"
          style={{
            background: LINE_COLOR[line],
            left: `calc(12px + ${(rideStart / Math.max(1, stations.length - 1)) * 100}% - 0px)`,
            width: `${((rideEnd - rideStart) / Math.max(1, stations.length - 1)) * 100}%`,
            boxShadow: `0 0 12px ${LINE_COLOR[line]}88`,
          }}
        />
        <div className="relative flex items-center justify-between px-3">
          {stations.map((s, i) => {
            const isHi = i === highlighted;
            const isRide = i >= rideStart && i <= rideEnd;
            return (
              <div key={`${s.name}-${i}`} className="flex flex-col items-center w-0">
                <span
                  className="block rounded-full"
                  style={{
                    width: isHi ? 18 : 11,
                    height: isHi ? 18 : 11,
                    background: isHi ? '#fff' : isRide ? LINE_COLOR[line] : '#1a1a1a',
                    border: `2px solid ${isHi ? LINE_COLOR[line] : '#000'}`,
                    boxShadow: isHi ? `0 0 14px ${LINE_COLOR[line]}, 0 0 0 3px rgba(255,255,255,0.15)` : 'none',
                  }}
                />
                <div
                  className="absolute top-full mt-1.5 text-[8px] font-typewriter uppercase tracking-[0.12em] whitespace-nowrap"
                  style={{
                    color: isHi ? '#fff' : isRide ? '#fff' : 'rgba(255,255,255,0.45)',
                    transform: 'rotate(-30deg)',
                    transformOrigin: 'top left',
                  }}
                  aria-hidden={!isHi && !riding}
                >
                  {s.name}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

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
  animation: station-whoosh 5.6s ease-in-out 1;
  padding: 6px 8px;
}
`;
