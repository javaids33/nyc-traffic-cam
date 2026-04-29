import { useEffect, useMemo, useState } from 'react';
import { BodegaAwning } from './bodega-tv';
import { QuarterStash, RollingQuarter } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';

/* /cab — "Take a Yellow Cab" mode.

   The premise: the user hails a yellow cab and rides through NYC,
   but the windows show a mix of LIVE Manhattan traffic cams AND
   archival photos / DOT records from the city's past. UX mirrors
   /turnstile: pick a starting destination, ride between stops, the
   "window" alternates between today's cam and a same-spot historical
   record.

   Data sources to wire later (free, key-less):
     - https://nyc.gov/site/records/index/page  (Municipal Library photo collection)
     - https://nycrecords.access.preservica.com  (Preservica archive — search-by-cross-street)
     - DOT capital plan history via Socrata (nf3p-x4iu) — promised projects vs delivered
     - LiON crash + parking history via 311

   For now this page renders the chrome + a placeholder reel so the
   /cab link from the lounge mode rack resolves to something real.
   The data fetcher is a follow-up build. */

const CAB_STOPS = [
  { id: 'tsq',  label: 'Times Square',           hint: '42 St & Broadway' },
  { id: 'wsm',  label: 'Washington Square',      hint: '5 Av & Waverly Pl' },
  { id: 'soho', label: 'SoHo',                   hint: 'Spring & Wooster' },
  { id: 'fidi', label: 'Financial District',     hint: 'Wall & Broad' },
  { id: 'lic',  label: 'Long Island City',       hint: '50 Av & 5 St' },
  { id: 'wmsb', label: 'Williamsburg',           hint: 'Bedford & N 7' },
  { id: 'park', label: 'Central Park South',     hint: '59 St & 5 Av' },
  { id: 'harl', label: 'Harlem',                 hint: '125 St & Lenox Av' },
];

export default function Cab() {
  const [cams, setCams] = useState<Camera[]>([]);
  const [stopIdx, setStopIdx] = useState(0);
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    fetchCameras()
      .then((cs) => setCams(cs.filter((c) => (c.borough ?? null) === 'MANHATTAN')))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 4000);
    return () => clearInterval(i);
  }, []);

  // Pick a deterministic Manhattan cam per stop so each ride feels
  // intentional, not random.
  const cam = useMemo(() => {
    if (!cams.length) return null;
    const seed = stopIdx * 7919;
    return cams[seed % cams.length];
  }, [cams, stopIdx]);

  const stop = CAB_STOPS[stopIdx];
  const next = () => setStopIdx((i) => (i + 1) % CAB_STOPS.length);

  return (
    <div
      className="min-h-screen w-screen flex flex-col text-white"
      style={{
        background: 'radial-gradient(ellipse at 50% 25%, #2a1a08 0%, #1a1208 55%, #060406 100%)',
      }}
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

      <main className="flex-1 px-3 py-6 z-10 max-w-[1400px] mx-auto w-full">
        <div className="flex items-baseline justify-between mb-2">
          <h1 className="font-bungee text-[36px] sm:text-[52px] leading-[0.95] uppercase">
            🚖 Take a <span className="text-[#FFD600]">Yellow Cab</span>
          </h1>
          <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55">
            then & now · vintage photos + live cams
          </span>
        </div>
        <p className="font-typewriter text-[12px] uppercase tracking-[0.16em] text-white/75 mb-5 max-w-2xl">
          Hop in. The window alternates between today's traffic cam at this
          intersection and a vintage photo of the same corner from the
          NYC Municipal Library + DOT records archive.
        </p>

        <div className="grid lg:grid-cols-[1fr_320px] gap-4">
          {/* The "cab window" — left big pane */}
          <div
            className="relative bg-black border-4 border-[#FFD600]"
            style={{
              aspectRatio: '16 / 10',
              minHeight: 360,
              boxShadow: '6px 6px 0 #d11a2a',
            }}
          >
            {cam ? (
              <img
                key={cam.id}
                src={`https://webcams.nyctmc.org/api/cameras/${cam.id}/image?t=${tick}`}
                alt={cam.name ?? cam.id}
                referrerPolicy="no-referrer"
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center font-bungee text-[22px] text-[#FFD600]/60">
                hailing…
              </div>
            )}
            {/* Cab window frame — vinyl stripe up top, OFF DUTY light */}
            <div className="absolute top-0 inset-x-0 h-2 bg-[#FFD600]" />
            <div className="absolute top-3 left-3 px-2 py-1 bg-black/85 border border-[#FFD600] text-[#FFD600] font-bungee text-[12px] uppercase tracking-[0.14em]">
              ▣ {stop.label} · {stop.hint}
            </div>
            <div className="absolute top-3 right-3 px-2 py-1 bg-[#FFD600] text-black font-bungee text-[11px] uppercase tracking-[0.18em]">
              FARE · 25¢ · METER ON
            </div>
            <div className="absolute bottom-3 left-3 right-3 flex items-baseline justify-between">
              <span className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/85">
                {cam?.name ?? '—'}
              </span>
              <button
                type="button"
                onClick={next}
                title="Next stop — drive on"
                className="px-3 py-1.5 bg-[#FFD600] text-black font-bungee text-[12px] uppercase tracking-[0.14em] hover:bg-[#FFE94d] transition-colors"
                style={{ boxShadow: '2px 2px 0 #000' }}
              >
                NEXT STOP ▶
              </button>
            </div>
          </div>

          {/* Side rail: stop list + future archive panel */}
          <div className="space-y-3">
            <div className="bg-black border-2 border-[#FFD600]/50 p-3">
              <div className="font-bungee text-[14px] uppercase tracking-[0.06em] text-[#FFD600] mb-2">
                ▦ Cab Route
              </div>
              <ul className="space-y-1">
                {CAB_STOPS.map((s, i) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setStopIdx(i)}
                      className={`w-full text-left px-2 py-1 font-typewriter text-[11px] uppercase tracking-[0.14em] flex items-baseline justify-between transition-colors ${
                        i === stopIdx
                          ? 'bg-[#FFD600] text-black'
                          : 'text-white/85 hover:bg-white/10 hover:text-[#FFD600]'
                      }`}
                      title={`${s.label} · ${s.hint}`}
                    >
                      <span>{i + 1}. {s.label}</span>
                      <span className={`text-[9px] tracking-[0.16em] ${i === stopIdx ? 'text-black/65' : 'text-white/45'} normal-case lowercase`}>
                        {s.hint}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-black/55 border border-white/15 p-3 font-typewriter text-[10px] uppercase tracking-[0.16em] text-white/65 leading-relaxed">
              <div className="font-bungee text-[12px] text-[#FFD600] tracking-[0.06em] mb-1">
                ▣ NEXT BUILD: ARCHIVE LAYER
              </div>
              The historical-photo rail fetches images of this same cross-street
              from the NYC Municipal Library photo collection and DOT records
              archive. Sources:
              <ul className="mt-2 space-y-1 normal-case lowercase text-white/75">
                <li>· nyc.gov/site/records/index/page</li>
                <li>· nycrecords.access.preservica.com</li>
                <li>· data.cityofnewyork.us — capital plan history</li>
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
