import { useEffect, useMemo, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, HiddenCoin } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';
import baked from './cam-pois.json';

/* ──────────────────────────────────────────────────────────────────────
   /poi — multi-cam POI feed.

   Reads the baked classification JSON shipped at src/cam-pois.json
   (populated by `python -m server.poi_classify`). Camera locations
   don't move and POIs don't change, so this is a one-time-then-static
   data file — no backend roundtrip needed for the classification.

   The cam frames themselves still come direct from
   webcams.nyctmc.org/api/cameras/{id}/image — also no backend.

   This page is the prototype for the hybrid architecture: every part
   of it can run on edge / static. The Python service is not on the
   request path.
   ──────────────────────────────────────────────────────────────────── */

type PoiEntry = {
  poi: string | null;
  category: string | null;
  description: string | null;
  confidence: number;
  _lat?: number;
  _lng?: number;
};

type PoiPayload = {
  generated_at: number | null;
  cameras: Record<string, PoiEntry>;
};

const POI = baked as PoiPayload;

const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

const CATEGORIES: { id: string; label: string; emoji: string; color: string; blurb: string }[] = [
  { id: 'bridge',       label: 'Bridges',       emoji: '🌉', color: '#FF6319', blurb: 'spans across the rivers' },
  { id: 'landmark',     label: 'Landmarks',     emoji: '🗽', color: '#FFD600', blurb: 'the postcards' },
  { id: 'park',         label: 'Parks',         emoji: '🌳', color: '#6CBE45', blurb: 'green space, gravel paths' },
  { id: 'waterway',     label: 'Waterways',     emoji: '🌊', color: '#0039A6', blurb: 'rivers + harbor + kills' },
  { id: 'tunnel',       label: 'Tunnels',       emoji: '🚇', color: '#1a1a1a', blurb: 'under the rivers' },
  { id: 'iconic',       label: 'Iconic NYC',    emoji: '🏙️', color: '#d11a2a', blurb: 'unmistakably new york' },
  { id: 'skyline',      label: 'Skyline',       emoji: '🌆', color: '#B5F500', blurb: 'cityscape views' },
  { id: 'intersection', label: 'Intersections', emoji: '🚦', color: '#FF8A3A', blurb: 'famous crossings' },
];

const MIN_CONFIDENCE = 55; // hide low-confidence guesses

export default function Poi() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 6_000);
    return () => clearInterval(i);
  }, []);

  // Merge baked POI data with live camera list. Cameras without a
  // confident classification are skipped.
  const tagged = useMemo(() => {
    const out: { cam: Camera; poi: PoiEntry }[] = [];
    for (const c of cameras) {
      const p = POI.cameras[c.id];
      if (!p || !p.category || (p.confidence ?? 0) < MIN_CONFIDENCE) continue;
      out.push({ cam: c, poi: p });
    }
    return out;
  }, [cameras]);

  const byCategory = useMemo(() => {
    const m = new Map<string, { cam: Camera; poi: PoiEntry }[]>();
    for (const e of tagged) {
      const k = e.poi.category ?? 'other';
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(e);
    }
    return m;
  }, [tagged]);

  const visible =
    activeCategory === 'all' ? tagged : (byCategory.get(activeCategory) ?? []);

  // Featured POI: rotates among the highest-confidence picks every minute
  const featured = useMemo(() => {
    const top = [...tagged].sort((a, b) => b.poi.confidence - a.poi.confidence).slice(0, 12);
    if (top.length === 0) return null;
    const idx = Math.floor(Date.now() / 60_000) % top.length;
    return top[idx];
  }, [tagged]);

  const hasData = POI.generated_at !== null && Object.keys(POI.cameras).length > 0;

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

      <HiddenCoin spotId="poi-corner-l" size={16} hint="behind the bridge feed" style={{ left: 22, top: 220 }} />
      <HiddenCoin spotId="poi-corner-r" size={16} payout={2} hint="under the skyline column" style={{ right: 24, top: 280 }} />

      <main className="flex-1 px-3 py-5 z-10 max-w-[1500px] mx-auto w-full">
        <div className="font-bungee text-[36px] sm:text-[52px] leading-[0.95] uppercase">
          ★ POI <span className="text-[#FFD600]">Feed</span>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-5">
          {hasData
            ? <>cameras with something worth looking at · {tagged.length} of {cameras.length} tagged · classified once, ships in the bundle</>
            : <>poi data not yet generated · run <span className="text-[#FFD600]">python -m server.poi_classify</span> to populate</>}
        </div>

        {/* Category pills */}
        {hasData && (
          <div className="flex flex-wrap gap-1.5 mb-4">
            <CategoryPill
              active={activeCategory === 'all'}
              label={`ALL · ${tagged.length}`}
              color="#fff"
              onClick={() => setActiveCategory('all')}
            />
            {CATEGORIES.map((c) => {
              const n = byCategory.get(c.id)?.length ?? 0;
              if (n === 0) return null;
              return (
                <CategoryPill
                  key={c.id}
                  active={activeCategory === c.id}
                  label={`${c.emoji} ${c.label} · ${n}`}
                  color={c.color}
                  onClick={() => setActiveCategory(c.id)}
                />
              );
            })}
          </div>
        )}

        {/* Featured cam */}
        {featured && activeCategory === 'all' && (
          <div
            className="mb-4 px-3 py-3 border-2"
            style={{
              background: '#0a0a14',
              borderColor: colorFor(featured.poi.category) ?? '#FFD600',
              boxShadow: `5px 5px 0 ${(colorFor(featured.poi.category) ?? '#FFD600') + '88'}`,
            }}
          >
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <span className="font-bungee text-[16px] uppercase tracking-[0.06em]" style={{ color: colorFor(featured.poi.category) ?? '#FFD600' }}>
                ★ Featured · {featured.poi.poi}
              </span>
              <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65">
                {emojiFor(featured.poi.category)} {featured.poi.category} · {featured.poi.confidence}% confidence · rotates every min
              </span>
            </div>
            <div className="grid lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-3">
              <div className="relative bg-black border border-white/15" style={{ aspectRatio: '16 / 9', minHeight: 280 }}>
                <img
                  key={featured.cam.id}
                  src={NYCTMC_IMG(featured.cam.id, tick)}
                  alt={featured.poi.poi ?? 'featured cam'}
                  referrerPolicy="no-referrer"
                  decoding="async"
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/85 border border-[#FFD600] text-[#FFD600] font-bungee text-[10px] uppercase tracking-[0.16em]">
                  {emojiFor(featured.poi.category)} {featured.poi.poi}
                </div>
              </div>
              <div>
                <div className="font-bungee text-[14px] uppercase text-white">{featured.cam.name ?? featured.cam.id}</div>
                <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 mt-2 leading-snug">
                  {featured.poi.description}
                </div>
                <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-3 tabular">
                  {featured.cam.lat.toFixed(4)}, {featured.cam.lng.toFixed(4)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Grid of POI cams */}
        {!hasData ? (
          <EmptyState />
        ) : (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map(({ cam, poi }) => (
              <PoiTile key={cam.id} cam={cam} poi={poi} tick={tick} />
            ))}
          </div>
        )}
      </main>

      <StreetFauna />
    </div>
  );
}

function CategoryPill({
  active,
  label,
  color,
  onClick,
}: {
  active: boolean;
  label: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.18em] transition-colors"
      style={{
        background: active ? color : '#0a0a14',
        color: active ? (color === '#FFD600' || color === '#fff' || color === '#B5F500' ? '#000' : '#fff') : color,
        border: `1px solid ${color}`,
      }}
    >
      {label}
    </button>
  );
}

function PoiTile({ cam, poi, tick }: { cam: Camera; poi: PoiEntry; tick: number }) {
  const accent = colorFor(poi.category) ?? '#FFD600';
  return (
    <div className="relative bg-black border" style={{ borderColor: accent + '55', aspectRatio: '16 / 11', minHeight: 110 }}>
      <img
        src={NYCTMC_IMG(cam.id, tick)}
        alt={poi.poi ?? cam.name ?? cam.id}
        referrerPolicy="no-referrer"
        decoding="async"
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div
        className="absolute top-1 left-1 px-1.5 py-0.5 font-bungee text-[9px] uppercase tracking-[0.14em] truncate max-w-[calc(100%-12px)]"
        style={{ background: '#000', color: accent, border: `1px solid ${accent}` }}
      >
        {emojiFor(poi.category)} {poi.poi}
      </div>
      <div className="absolute bottom-0 inset-x-0 px-1.5 py-0.5 font-typewriter text-[8.5px] uppercase tracking-[0.12em] text-white/85 line-clamp-1" style={{ background: 'rgba(0,0,0,0.65)' }}>
        {cam.name ?? cam.id}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="px-4 py-6 bg-black/55 border-2 border-[#FFD600]/40 font-typewriter text-[12px] uppercase tracking-[0.18em] leading-relaxed">
      <div className="font-bungee text-[16px] text-[#FFD600] mb-2">★ ready when you are</div>
      <div className="text-white/85 mb-2">
        cam-pois.json is empty. running the classification once is a ~$10-30 one-time cost (claude haiku vision over ~960 camera frames). after that the file ships with the bundle and the page is fully static.
      </div>
      <pre className="bg-[#0e0f14] text-[#FFD600]/85 px-3 py-2 mt-2 text-[11px] tracking-[0.06em] overflow-x-auto">
        export ANTHROPIC_API_KEY=sk-ant-...{'\n'}
        python -m server.poi_classify --resume
      </pre>
      <div className="text-white/65 mt-2">
        --resume picks up where you left off · --limit 30 for a smoke test first.
      </div>
    </div>
  );
}

function colorFor(category: string | null): string | null {
  return CATEGORIES.find((c) => c.id === category)?.color ?? null;
}
function emojiFor(category: string | null): string {
  return CATEGORIES.find((c) => c.id === category)?.emoji ?? '★';
}
