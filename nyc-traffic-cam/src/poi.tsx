import { useEffect, useMemo, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, HiddenCoin } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';
import rawPOI from './cam-pois.json';
import rawHealth from './cam-health.json';
import { usePoisByTime } from './usePoisByTime';

// Default-import the day file so the page paints instantly with the
// bundled data — zero network on first render. The usePoisByTime
// hook may override this with cam-pois-night.json after mount when
// the local clock is past sunset+20min in NYC.
type PoiPayloadShape = { generated_at: number | null; cameras: Record<string, PoiEntry> };
const DAY_POI = rawPOI as unknown as PoiPayloadShape;

// cam-health.json is the server's frame-diff health probe — it lists
// cameras whose feeds are frozen (returning the same JPEG forever).
// The vision model can't distinguish a frozen frame from a live one
// (both look like valid images), so we union this set into the dud
// rail. Result: frozen cams correctly land in "💤 Boring & Broken"
// instead of being mis-tagged as a clear, uneventful intersection.
const FROZEN_CAMS = new Set<string>(
  (rawHealth as { frozen?: string[] }).frozen ?? [],
);

/* ──────────────────────────────────────────────────────────────────────
   /poi — multi-cam POI feed with tag pivot.

   Reads the baked classification JSON shipped at src/cam-pois.json.
   Each camera record is pre-tagged with:
     - quality   ∈ {good, boring, broken, dirty, empty}
     - scene     (single dominant)
     - tags[]    (multi-label visual elements: bridge, people, road,
                  tree, corner_house, traffic_lights, bodega, water…)
     - interest  (0-100 ranking score)
   plus the legacy poi/category/description for backward compat.

   The page surfaces three pivots:
     1. Most Interesting — top-N by interest score
     2. By Tag          — pick a visual element, see every cam with it
     3. Boring & Broken — the cams nobody asked for, presented as a joke

   Cameras with quality=empty (no feed) and quality=broken are hidden
   from the default views so the user never lands on a black box.
   ──────────────────────────────────────────────────────────────────── */

type PoiEntry = {
  poi: string | null;
  category: string | null;
  description: string | null;
  confidence: number;
  interest?: number;
  quality?: 'good' | 'boring' | 'broken' | 'dirty' | 'empty' | null;
  tags?: string[];
  scene?: string | null;
  weather?: string | null;
  time_of_day?: string | null;
  congestion?: string | null;
  crowd_or_event?: boolean;
  event_description?: string | null;
  landmark_name?: string | null;
  skyline_visible?: boolean;
  image_usable?: boolean;
  _lat?: number;
  _lng?: number;
  // Set by /poi merge step when cam-health.json flags this cam as
  // frozen — surfaces a "FROZEN" badge on the dud tile.
  _frozen?: boolean;
};

const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

// Pretty labels + colors for each tag. Anything not listed falls back
// to a neutral pill — adding a tag here is opt-in flair, not required.
const TAG_META: Record<string, { label: string; emoji: string; color: string }> = {
  bridge:        { label: 'Bridges',       emoji: '🌉', color: '#FF6319' },
  tunnel:        { label: 'Tunnels',       emoji: '🚇', color: '#9b59b6' },
  highway:       { label: 'Highways',      emoji: '🛣️', color: '#7f8c8d' },
  road:          { label: 'Roads',         emoji: '🚗', color: '#bdc3c7' },
  intersection: { label: 'Intersections', emoji: '🚦', color: '#FF8A3A' },
  crosswalk:     { label: 'Crosswalks',    emoji: '🚷', color: '#ecf0f1' },
  traffic_lights:{ label: 'Traffic Lights',emoji: '🚥', color: '#e74c3c' },
  street_signs:  { label: 'Street Signs',  emoji: '🪧', color: '#16a085' },
  lamppost:      { label: 'Lampposts',     emoji: '💡', color: '#f1c40f' },
  skyline:       { label: 'Skyline',       emoji: '🌆', color: '#B5F500' },
  skyscraper:    { label: 'Skyscrapers',   emoji: '🏢', color: '#3498db' },
  brownstone:    { label: 'Brownstones',   emoji: '🏘️', color: '#a0522d' },
  corner_house:  { label: 'Corner Houses', emoji: '🏠', color: '#d35400' },
  storefront:    { label: 'Storefronts',   emoji: '🏬', color: '#e67e22' },
  bodega:        { label: 'Bodegas',       emoji: '🏪', color: '#FFD600' },
  billboard:     { label: 'Billboards',    emoji: '📺', color: '#ff5582' },
  scaffolding:   { label: 'Scaffolding',   emoji: '🚧', color: '#f39c12' },
  construction:  { label: 'Construction',  emoji: '🏗️', color: '#e67e22' },
  tree:          { label: 'Trees',         emoji: '🌳', color: '#6CBE45' },
  park:          { label: 'Parks',         emoji: '🌲', color: '#27ae60' },
  water:         { label: 'Water',         emoji: '💧', color: '#0039A6' },
  river:         { label: 'Rivers',        emoji: '🌊', color: '#2980b9' },
  snow:          { label: 'Snow',          emoji: '❄️', color: '#ecf0f1' },
  people:        { label: 'People',        emoji: '🚶', color: '#FFD600' },
  crowd:         { label: 'Crowds',        emoji: '👥', color: '#FF5582' },
  vehicles:      { label: 'Vehicles',      emoji: '🚙', color: '#95a5a6' },
  bus:           { label: 'Buses',         emoji: '🚌', color: '#1abc9c' },
  truck:         { label: 'Trucks',        emoji: '🚚', color: '#34495e' },
  bicycle:       { label: 'Bikes',         emoji: '🚲', color: '#16a085' },
  subway:        { label: 'Subway',        emoji: '🚉', color: '#0039A6' },
  rain:          { label: 'Rain',          emoji: '🌧️', color: '#3498db' },
  fog:           { label: 'Fog',           emoji: '🌫️', color: '#95a5a6' },
  sun_glare:     { label: 'Sun Glare',     emoji: '☀️', color: '#f1c40f' },
  night_lights:  { label: 'Night Lights',  emoji: '🌃', color: '#9b59b6' },
  landmark:      { label: 'Landmarks',     emoji: '🗽', color: '#FFD600' },
  statue:        { label: 'Statues',       emoji: '🗿', color: '#7f8c8d' },
  monument:      { label: 'Monuments',     emoji: '🏛️', color: '#c0392b' },
};

const FALLBACK_TAG_META = { label: '', emoji: '★', color: '#bbb' };
const tagMeta = (t: string) => TAG_META[t] ?? { ...FALLBACK_TAG_META, label: t };

// Categories the legacy /poi page rendered before the tag pivot. We
// keep them as a "Themes" rail at the top — clicking one is a shortcut
// for "every cam whose dominant scene maps to this theme".
const SCENE_PILLS: { id: string; label: string; emoji: string; color: string }[] = [
  { id: 'bridge',       label: 'Bridges',       emoji: '🌉', color: '#FF6319' },
  { id: 'skyline',      label: 'Skyline',       emoji: '🌆', color: '#B5F500' },
  { id: 'tunnel',       label: 'Tunnels',       emoji: '🚇', color: '#9b59b6' },
  { id: 'intersection', label: 'Intersections', emoji: '🚦', color: '#FF8A3A' },
  { id: 'boulevard',    label: 'Boulevards',    emoji: '🏬', color: '#e67e22' },
  { id: 'residential',  label: 'Residential',   emoji: '🏘️', color: '#a0522d' },
  { id: 'highway',      label: 'Highways',      emoji: '🛣️', color: '#7f8c8d' },
];

type Mode = 'hot' | 'tag' | 'boring';

const MIN_CONFIDENCE = 30; // hide low-confidence guesses

export default function Poi() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [mode, setMode] = useState<Mode>('hot');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  // Auto-switch to the night classification 20min after NYC sunset.
  // Initial render uses the bundled day file so first paint is instant
  // and offline-friendly; after mount the hook may swap to
  // cam-pois-night.json (or stay on day if it's still daylight or
  // no night file exists yet).
  const sun = usePoisByTime();
  const POI: PoiPayloadShape = (sun.data ?? DAY_POI) as PoiPayloadShape;

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);
  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 6_000);
    return () => clearInterval(i);
  }, []);

  // Build the universe of tagged cams once, joined with the live cam
  // list. Anything with quality=empty/broken is dropped from "live"
  // and routed to the boring rail instead — those cams have no
  // useful feed and shouldn't appear when a user clicks a tag.
  const { live, dud, byTag, tagCounts, byScene } = useMemo(() => {
    const live: { cam: Camera; poi: PoiEntry }[] = [];
    const dud: { cam: Camera; poi: PoiEntry }[] = [];
    const byTag = new Map<string, { cam: Camera; poi: PoiEntry }[]>();
    const tagCounts = new Map<string, number>();
    const byScene = new Map<string, { cam: Camera; poi: PoiEntry }[]>();

    for (const c of cameras) {
      const p = POI.cameras[c.id];
      if (!p) continue;
      // Force frozen cams into the dud bucket. The vision model
      // cannot tell a stale frame from a live one, so we override
      // its verdict with the server's health probe.
      const isFrozen = FROZEN_CAMS.has(c.id);
      const quality = isFrozen
        ? 'broken'
        : (p.quality ?? (p.image_usable === false ? 'broken' : 'good'));
      if (quality === 'empty' || quality === 'broken') {
        // Annotate the entry so the dud tile can show *why* it's down.
        dud.push({ cam: c, poi: { ...p, quality, _frozen: isFrozen } as PoiEntry });
        continue;
      }
      if ((p.confidence ?? 0) < MIN_CONFIDENCE) continue;
      live.push({ cam: c, poi: p });

      const tags = p.tags ?? [];
      for (const t of tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t)!.push({ cam: c, poi: p });
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
      const sc = p.scene ?? 'other';
      if (!byScene.has(sc)) byScene.set(sc, []);
      byScene.get(sc)!.push({ cam: c, poi: p });
    }

    // Sort each tag bucket by interest so any tag-pivot view is
    // already ranked best-first.
    const byInterest = (a: { poi: PoiEntry }, b: { poi: PoiEntry }) =>
      (b.poi.interest ?? 0) - (a.poi.interest ?? 0);
    live.sort(byInterest);
    dud.sort(byInterest);
    for (const arr of byTag.values()) arr.sort(byInterest);
    for (const arr of byScene.values()) arr.sort(byInterest);

    return { live, dud, byTag, tagCounts, byScene };
    // POI changes when usePoisByTime swaps in the night dataset, so
    // it MUST be in the dep list — otherwise the page stays on the
    // bundled day file across the dusk transition.
  }, [cameras, POI]);

  const sortedTags = useMemo(() => {
    return Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));
  }, [tagCounts]);

  // What the grid actually renders, given the selected mode/filter.
  const visible = useMemo(() => {
    if (mode === 'boring') return dud;
    if (mode === 'tag') {
      if (selectedTag) return byTag.get(selectedTag) ?? [];
      if (selectedScene) return byScene.get(selectedScene) ?? [];
      return live;
    }
    return live; // hot
  }, [mode, selectedTag, selectedScene, byTag, byScene, live, dud]);

  // "Hot Right Now" rail — top-8 by interest, regardless of tag.
  const hotNow = useMemo(() => {
    return live.filter((e) => (e.poi.interest ?? 0) > 0).slice(0, 8);
  }, [live]);

  // Featured: rotates through the top picks once a minute.
  const featured = useMemo(() => {
    const top = live.slice(0, 12);
    if (top.length === 0) return null;
    const idx = Math.floor(Date.now() / 60_000) % top.length;
    return top[idx];
  }, [live]);

  const hasData = POI.generated_at !== null && Object.keys(POI.cameras).length > 0;

  // Whenever the user switches mode away from tag-pivot, blank the
  // selection so coming back lands on the picker, not a stale tag.
  useEffect(() => {
    if (mode !== 'tag') {
      setSelectedTag(null);
      setSelectedScene(null);
    }
  }, [mode]);

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
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-5 flex flex-wrap items-baseline gap-2">
          {hasData ? (
            <>
              <span>{live.length} live · {dud.length} dud · pre-tagged with ollama vision · pivot by tag below</span>
              <span
                className="px-2 py-0.5 border font-bungee text-[10px] tracking-[0.16em]"
                style={{
                  borderColor: sun.mode === 'night' ? '#9b59b6' : '#FFD600',
                  color: sun.mode === 'night' ? '#9b59b6' : '#FFD600',
                  background: '#0a0a14',
                }}
                title={
                  sun.sunset
                    ? `NYC sunset today: ${sun.sunset.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}; switches to night feed 20 min after`
                    : 'sunset time unavailable, falling back to clock window'
                }
              >
                {sun.mode === 'night' ? '🌙 NIGHT FEED' : '☀️ DAY FEED'}
              </span>
            </>
          ) : (
            <>poi data not yet generated · run <span className="text-[#FFD600]">python -m server.poi_classify_local --resume</span> to populate</>
          )}
        </div>

        {/* Mode tabs */}
        {hasData && (
          <div className="flex flex-wrap gap-1.5 mb-3 items-center">
            <ModeTab active={mode === 'hot'} label={`🔥 Most Interesting · ${hotNow.length}`} color="#FF5582" onClick={() => setMode('hot')} />
            <ModeTab active={mode === 'tag'} label={`🏷️ By Tag · ${sortedTags.length}`} color="#FFD600" onClick={() => setMode('tag')} />
            <ModeTab active={mode === 'boring'} label={`💤 Boring & Broken · ${dud.length}`} color="#7f8c8d" onClick={() => setMode('boring')} />
          </div>
        )}

        {/* Tag picker — only in tag mode */}
        {hasData && mode === 'tag' && (
          <div className="mb-4">
            <div className="font-bungee text-[11px] uppercase tracking-[0.16em] text-white/65 mb-1.5">
              Click a tag to see every camera showing it
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              <TagPill
                active={selectedTag === null && selectedScene === null}
                label={`ALL · ${live.length}`}
                color="#fff"
                emoji="★"
                onClick={() => { setSelectedTag(null); setSelectedScene(null); }}
              />
              {sortedTags.map(({ tag, count }) => {
                const meta = tagMeta(tag);
                return (
                  <TagPill
                    key={tag}
                    active={selectedTag === tag}
                    label={`${meta.label || tag} · ${count}`}
                    emoji={meta.emoji}
                    color={meta.color}
                    onClick={() => { setSelectedTag(tag); setSelectedScene(null); }}
                  />
                );
              })}
            </div>
            <div className="font-bungee text-[10px] uppercase tracking-[0.16em] text-white/50 mb-1">
              · or pick a theme ·
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SCENE_PILLS.map((s) => {
                const n = byScene.get(s.id)?.length ?? 0;
                if (n === 0) return null;
                return (
                  <TagPill
                    key={s.id}
                    active={selectedScene === s.id}
                    label={`${s.label} · ${n}`}
                    emoji={s.emoji}
                    color={s.color}
                    onClick={() => { setSelectedScene(s.id); setSelectedTag(null); }}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Featured cam — only on hot mode for top-of-page punch */}
        {hasData && mode === 'hot' && featured && (
          <div
            className="mb-4 px-3 py-3 border-2"
            style={{
              background: '#0a0a14',
              borderColor: tagMeta(featured.poi.tags?.[0] ?? 'landmark').color,
              boxShadow: `5px 5px 0 ${tagMeta(featured.poi.tags?.[0] ?? 'landmark').color}88`,
            }}
          >
            <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
              <span className="font-bungee text-[16px] uppercase tracking-[0.06em]" style={{ color: '#FFD600' }}>
                ★ Featured · {featured.poi.poi ?? featured.cam.name ?? 'Live cam'}
              </span>
              <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65">
                interest {featured.poi.interest ?? 0} · conf {featured.poi.confidence}% · rotates every min
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
                  ★ {featured.poi.poi ?? featured.cam.name}
                </div>
              </div>
              <div>
                <div className="font-bungee text-[14px] uppercase text-white">{featured.cam.name ?? featured.cam.id}</div>
                <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 mt-2 leading-snug">
                  {featured.poi.description}
                </div>
                {featured.poi.tags && featured.poi.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-3">
                    {featured.poi.tags.slice(0, 8).map((t) => {
                      const m = tagMeta(t);
                      return (
                        <button
                          key={t}
                          onClick={() => { setMode('tag'); setSelectedTag(t); }}
                          className="px-1.5 py-0.5 font-typewriter text-[9px] uppercase tracking-[0.14em]"
                          style={{ background: '#0a0a14', color: m.color, border: `1px solid ${m.color}77` }}
                          title={`See every cam tagged "${t}"`}
                        >
                          {m.emoji} {m.label || t}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-3 tabular">
                  {featured.cam.lat.toFixed(4)}, {featured.cam.lng.toFixed(4)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Hottest right now rail — hot mode */}
        {hasData && mode === 'hot' && hotNow.length > 0 && (
          <div className="mb-5">
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-bungee text-[15px] uppercase tracking-[0.06em] text-[#FF5582]">
                🔥 Hot Right Now
              </span>
              <span className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/50">
                ranked by interest · events · landmarks · rare weather
              </span>
            </div>
            <div className="grid gap-2 grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
              {hotNow.map(({ cam, poi }) => (
                <HotTile key={cam.id} cam={cam} poi={poi} tick={tick} />
              ))}
            </div>
          </div>
        )}

        {/* Selection header (in tag mode) */}
        {mode === 'tag' && (selectedTag || selectedScene) && (
          <div className="flex items-baseline gap-2 mb-2">
            <span className="font-bungee text-[15px] uppercase tracking-[0.06em] text-[#FFD600]">
              {selectedTag ? `${tagMeta(selectedTag).emoji} ${tagMeta(selectedTag).label || selectedTag}` :
                selectedScene ? `${SCENE_PILLS.find(s => s.id === selectedScene)?.emoji ?? '★'} ${SCENE_PILLS.find(s => s.id === selectedScene)?.label ?? selectedScene}` : ''}
            </span>
            <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/50">
              · {visible.length} cams · sorted by interest
            </span>
          </div>
        )}

        {/* Boring & Broken header */}
        {mode === 'boring' && (
          <div className="mb-2">
            <span className="font-bungee text-[15px] uppercase tracking-[0.06em] text-white/65">
              💤 the cams nobody asked for
            </span>
            <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/45 mt-1">
              {(() => {
                const frozen = dud.filter((d) => d.poi._frozen).length;
                const other = dud.length - frozen;
                return (
                  <>
                    {frozen > 0 && <span className="text-[#FF5582]">{frozen} frozen</span>}
                    {frozen > 0 && other > 0 && <> · </>}
                    {other > 0 && <>{other} broken/empty</>}
                    {' · '}
                    {dud.length} total
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Grid */}
        {!hasData ? (
          <EmptyState />
        ) : visible.length === 0 ? (
          <div className="px-4 py-8 text-center font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/45">
            no cams match this filter · try another tag
          </div>
        ) : (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {visible.map(({ cam, poi }) => (
              <PoiTile key={cam.id} cam={cam} poi={poi} tick={tick} mode={mode} />
            ))}
          </div>
        )}
      </main>

      <StreetFauna />
    </div>
  );
}

function ModeTab({ active, label, color, onClick }: { active: boolean; label: string; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-1 font-bungee text-[12px] uppercase tracking-[0.10em] transition-colors"
      style={{
        background: active ? color : '#0a0a14',
        color: active ? '#000' : color,
        border: `2px solid ${color}`,
        boxShadow: active ? `3px 3px 0 ${color}77` : 'none',
      }}
    >
      {label}
    </button>
  );
}

function TagPill({ active, label, emoji, color, onClick }: {
  active: boolean;
  label: string;
  emoji: string;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.14em] transition-colors"
      style={{
        background: active ? color : '#0a0a14',
        color: active ? '#000' : color,
        border: `1px solid ${color}`,
      }}
    >
      {emoji} {label}
    </button>
  );
}

function PoiTile({ cam, poi, tick, mode }: { cam: Camera; poi: PoiEntry; tick: number; mode: Mode }) {
  // Frozen cams get a magenta frame so the user can spot stale feeds
  // at a glance; other duds use neutral grey.
  const isFrozen = poi._frozen;
  const accent = mode === 'boring'
    ? (isFrozen ? '#FF5582' : '#7f8c8d')
    : (tagMeta(poi.tags?.[0] ?? '').color);
  const score = poi.interest ?? 0;
  const headline = poi.poi ?? poi.landmark_name ?? cam.name ?? cam.id;

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
      {mode === 'boring' && isFrozen ? (
        <div
          className="absolute top-1 left-1 px-1 py-0.5 font-bungee text-[8px] uppercase tracking-[0.14em]"
          style={{ background: '#FF5582', color: '#000' }}
          title="cam-health.json flagged this feed as frozen"
        >
          ❄ FROZEN
        </div>
      ) : mode !== 'boring' ? (
        <div
          className="absolute top-1 left-1 px-1 py-0.5 font-bungee text-[8px] uppercase tracking-[0.14em] tabular"
          style={{ background: accent, color: '#000' }}
          title={`Interest score ${score}/100`}
        >
          {score}
        </div>
      ) : null}
      <div
        className="absolute top-1 right-1 px-1.5 py-0.5 font-bungee text-[9px] uppercase tracking-[0.12em] truncate max-w-[70%]"
        style={{ background: '#000', color: accent, border: `1px solid ${accent}` }}
      >
        {tagMeta(poi.tags?.[0] ?? '').emoji} {headline}
      </div>
      <div
        className="absolute bottom-0 inset-x-0 px-1 py-0.5 font-typewriter text-[8px] uppercase tracking-[0.10em] text-white/85 line-clamp-1"
        style={{ background: 'rgba(0,0,0,0.7)' }}
      >
        {cam.name ?? cam.id}
      </div>
    </div>
  );
}

function HotTile({ cam, poi, tick }: { cam: Camera; poi: PoiEntry; tick: number }) {
  const score = poi.interest ?? 0;
  const accent = score >= 50 ? '#FF5582' : tagMeta(poi.tags?.[0] ?? '').color;
  const reason =
    (poi.crowd_or_event && (poi.event_description || 'event')) ||
    poi.landmark_name ||
    (poi.weather && poi.weather !== 'clear' && poi.weather) ||
    (poi.congestion === 'jammed' && 'jammed') ||
    (poi.skyline_visible && 'skyline') ||
    poi.tags?.[0] ||
    poi.poi ||
    null;
  return (
    <div
      className="relative bg-black border"
      style={{ borderColor: accent, aspectRatio: '16 / 11', minHeight: 90, boxShadow: `2px 2px 0 ${accent}44` }}
    >
      <img
        src={NYCTMC_IMG(cam.id, tick)}
        alt={cam.name ?? cam.id}
        referrerPolicy="no-referrer"
        decoding="async"
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover"
      />
      <div
        className="absolute top-1 left-1 px-1 py-0.5 font-bungee text-[8px] uppercase tracking-[0.14em] tabular"
        style={{ background: accent, color: '#000' }}
      >
        {score}
      </div>
      {reason && (
        <div
          className="absolute top-1 right-1 px-1 py-0.5 font-typewriter text-[8px] uppercase tracking-[0.1em] truncate max-w-[70%]"
          style={{ background: '#000', color: accent, border: `1px solid ${accent}` }}
        >
          {reason}
        </div>
      )}
      <div
        className="absolute bottom-0 inset-x-0 px-1 py-0.5 font-typewriter text-[8px] uppercase tracking-[0.1em] text-white/85 line-clamp-1"
        style={{ background: 'rgba(0,0,0,0.7)' }}
      >
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
        cam-pois.json is empty. classify the corpus once locally with ollama —
        no api key, no cloud bill. a 7b vision model takes ~1-2 hours to
        sweep all ~960 cams; after that the file ships in the bundle and
        the page is fully static.
      </div>
      <pre className="bg-[#0e0f14] text-[#FFD600]/85 px-3 py-2 mt-2 text-[11px] tracking-[0.06em] overflow-x-auto">
        ollama pull qwen2.5vl:7b{'\n'}
        python -m server.poi_classify_local --resume
      </pre>
      <div className="text-white/65 mt-2">
        --resume picks up where you left off · --limit 30 --dry-run for a smoke test first.
      </div>
    </div>
  );
}
