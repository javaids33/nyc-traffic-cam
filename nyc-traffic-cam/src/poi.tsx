import { useEffect, useMemo, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, HiddenCoin } from './quarter';
import { fetchCameras } from './api';
import type { Camera } from './types';
import rawPOI from './cam-pois.json';
import rawHealth from './cam-health.json';
import { usePoisByTime } from './usePoisByTime';

// Baked-in committed overrides. Anything in localStorage wins over
// this baseline, so an in-progress edit is visible immediately while
// also being safe to commit later via the "Export overrides.json"
// button on the edit panel.
import rawOverrides from './cam-pois-overrides.json';

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
  // Free-form tags the VLM proposed because nothing in the
  // controlled vocab fit. Sanitised lowercase snake_case, max 5
  // per cam. Surfaced separately so we can spot common ones to
  // promote into TAG_VALUES on the next prompt revision.
  proposed_tags?: string[];
  scene?: string | null;
  // Higher-level neighborhood character — commercial, residential,
  // downtown, transit, waterfront, mixed. Drives interest scoring
  // and an upcoming "by area type" pivot on /poi.
  area_type?: 'commercial' | 'residential' | 'downtown' | 'transit' | 'waterfront' | 'mixed' | null;
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
  taxi:          { label: 'Taxis',         emoji: '🚖', color: '#FFD600' },
  bicycle:       { label: 'Bikes',         emoji: '🚲', color: '#16a085' },
  subway:        { label: 'Subway',        emoji: '🚉', color: '#0039A6' },
  subway_entrance:{ label: 'Subway Stops', emoji: '🪜', color: '#0039A6' },
  food_cart:     { label: 'Food Carts',    emoji: '🌮', color: '#FF8A3A' },
  garbage_bin:   { label: 'Trash Cans',    emoji: '🗑️', color: '#7f8c8d' },
  traffic_cone:  { label: 'Cones',         emoji: '🚧', color: '#FF6319' },
  harbor:        { label: 'Harbor',        emoji: '⚓', color: '#0039A6' },
  rain:          { label: 'Rain',          emoji: '🌧️', color: '#3498db' },
  fog:           { label: 'Fog',           emoji: '🌫️', color: '#95a5a6' },
  sun_glare:     { label: 'Sun Glare',     emoji: '☀️', color: '#f1c40f' },
  night_lights:  { label: 'Night Lights',  emoji: '🌃', color: '#9b59b6' },
  landmark:      { label: 'Landmarks',     emoji: '🗽', color: '#FFD600' },
  statue:        { label: 'Statues',       emoji: '🗿', color: '#7f8c8d' },
  monument:      { label: 'Monuments',     emoji: '🏛️', color: '#c0392b' },
  mural:         { label: 'Murals',        emoji: '🎨', color: '#ff5582' },
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

// ── Manual override layer ───────────────────────────────────────────
// Lets a human correct the AI-baked tags directly in /poi without
// touching the classifier or rerunning a multi-hour sweep. Two
// sources, layered:
//   1. src/cam-pois-overrides.json — committed, ships with the build
//   2. localStorage[OVERRIDES_KEY]  — in-progress edits, win over (1)
// Both flow through the same applyOverride() merge so the rest of
// the page treats overridden cams identically to AI-tagged ones.
type Quality = 'good' | 'boring' | 'broken' | 'dirty';
type Override = {
  quality?: Quality;
  scene?: string | null;
  landmark_name?: string | null;
  tags?: string[];
  _editedAt?: number;
};
type OverridesShape = { overrides?: Record<string, Override> };

const OVERRIDES_KEY = 'nyc-poi-overrides';
const BAKED_OVERRIDES: Record<string, Override> =
  (rawOverrides as OverridesShape).overrides ?? {};

// Editing UI is strictly local-only — hostname check, no URL
// param tricks, no localStorage opt-ins, no "edit=1" sneak path.
// In production users see the same /poi but with no editing entry
// points; BAKED_OVERRIDES from cam-pois-overrides.json still apply,
// which is the whole point: deploy-time corrections ride along.
// Workflow: `npm run dev` → edit → "📥 Export overrides.json" →
// commit the file → deploy.
const IS_LOCAL = typeof window !== 'undefined' && (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname === '::1' ||
  window.location.hostname.endsWith('.local')
);

function loadLocalOverrides(): Record<string, Override> {
  try {
    const raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(OVERRIDES_KEY)
      : null;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalOverrides(o: Record<string, Override>) {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
  } catch {
    /* quota or private mode — silent */
  }
}

// Merge an override on top of an AI-baked POI entry. Each override
// field is independent so a user who only edits tags doesn't blow
// away the model's other signals (weather, congestion, etc.).
function applyOverride(poi: PoiEntry, ov?: Override): PoiEntry {
  if (!ov) return poi;
  const out: PoiEntry = { ...poi };
  if (ov.quality !== undefined) {
    out.quality = ov.quality;
    // image_usable is a derived legacy flag — keep it consistent so
    // the legacy /poi code paths bucket the cam correctly.
    out.image_usable = ov.quality !== 'broken';
  }
  if (ov.scene !== undefined) out.scene = ov.scene;
  if (ov.landmark_name !== undefined) out.landmark_name = ov.landmark_name;
  if (ov.tags !== undefined) out.tags = ov.tags;
  return out;
}

export default function Poi() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [mode, setMode] = useState<Mode>('hot');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedScene, setSelectedScene] = useState<string | null>(null);
  const [tick, setTick] = useState(() => Date.now());

  // Manual override layer — see the OVERRIDES_KEY block above.
  // Initialised from localStorage so a refresh doesn't lose edits.
  const [localOverrides, setLocalOverrides] = useState<Record<string, Override>>(loadLocalOverrides);
  const [editMode, setEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Click any tile (outside edit mode) to expand it full-screen with
  // the live cam image and full metadata — the command-center "zoom
  // in on this feed" gesture.
  const [expandingId, setExpandingId] = useState<string | null>(null);
  // Persist every change immediately — there's no save step, the
  // panel just edits the in-memory state and flushes here.
  useEffect(() => { saveLocalOverrides(localOverrides); }, [localOverrides]);
  // Final overrides = baked from JSON, then localStorage on top so a
  // local edit always wins over the committed file (the "Export"
  // button is the bridge between the two).
  const overrides = useMemo<Record<string, Override>>(
    () => ({ ...BAKED_OVERRIDES, ...localOverrides }),
    [localOverrides],
  );

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
      const baked = POI.cameras[c.id];
      if (!baked) continue;
      // Apply manual override on top of the baked classification.
      // A user override is the source of truth — if they marked a
      // cam as `good`, treat it as good even when the AI said
      // boring/broken (and vice versa).
      const ov = overrides[c.id];
      const p = applyOverride(baked, ov);

      // Frozen-cam health probe still wins over the AI verdict, but
      // a manual override beats both — if the user can see the cam is
      // actually live, respect that.
      const isFrozen = FROZEN_CAMS.has(c.id);
      const userQualityOverride = ov?.quality;
      const quality: PoiEntry['quality'] = userQualityOverride
        ? userQualityOverride
        : (isFrozen
            ? 'broken'
            : (p.quality ?? (p.image_usable === false ? 'broken' : 'good')));
      // The dud rail is labeled "Boring & Broken" — route all three
      // unwatchable buckets there: empty (no feed), broken (frozen
      // / mispointed / signal loss), and boring (clear frame but
      // nothing happening). v3 returns ~5% boring; without this
      // route they bleed into the LIVE rail and clutter the hot
      // picks with quiet residential corners.
      if (quality === 'empty' || quality === 'broken' || quality === 'boring') {
        dud.push({ cam: c, poi: { ...p, quality, _frozen: isFrozen && !userQualityOverride } as PoiEntry });
        continue;
      }
      // Skip the confidence floor for cams the user has manually
      // touched — they already vouched for it.
      if (!ov && (p.confidence ?? 0) < MIN_CONFIDENCE) continue;
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
    // bundled day file across the dusk transition. Overrides are in
    // the deps too so an edit re-bucketing is instant.
  }, [cameras, POI, overrides]);

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

      {/* Full-bleed command-center layout: no centered column. The
          page fills the viewport edge-to-edge so the grid can carry
          as many cams as the screen allows. Padding is minimal and
          uniform — the chrome is the cams themselves. */}
      <main className="flex-1 px-2 sm:px-3 py-3 z-10 w-full">
        <div className="font-bungee text-[28px] sm:text-[40px] leading-[0.95] uppercase">
          ★ POI <span className="text-[#FFD600]">Feed</span>
          <span className="ml-3 font-typewriter text-[10px] tracking-[0.22em] text-white/45 uppercase">
            ▣ command center · {Object.keys(POI.cameras).length} cams indexed
          </span>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-3 flex flex-wrap items-baseline gap-2">
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
            <ModeTab active={mode === 'hot'} label={`🔥 Most Interesting · ${hotNow.length}`} color="#FF5582" onClick={() => setMode('hot')} hint="Top-ranked cameras right now — events, weather, crowds, landmarks" />
            <ModeTab active={mode === 'tag'} label={`🏷️ By Tag · ${sortedTags.length}`} color="#FFD600" onClick={() => setMode('tag')} hint="Pick a visual element (bridge, taxi, brownstone…) and see every camera showing it" />
            <ModeTab active={mode === 'boring'} label={`💤 Boring & Broken · ${dud.length}`} color="#7f8c8d" onClick={() => setMode('boring')} hint="Frozen, broken, or visually uneventful cameras — the cams nobody asked for" />
            {IS_LOCAL && (
              <ModeTab
                active={editMode}
                label={editMode ? '✏️ Editing — click any cam' : `✏️ Edit Tags${Object.keys(localOverrides).length ? ` · ${Object.keys(localOverrides).length}` : ''}`}
                color="#B5F500"
                onClick={() => setEditMode((v) => !v)}
                hint={editMode ? 'Click any tile to edit its tags · click again to exit edit mode' : 'Manually correct mistagged cams — clicks tiles to edit, exports a JSON for committing'}
              />
            )}
          </div>
        )}

        {/* Edit-mode action bar — export + clear local overrides */}
        {hasData && editMode && (
          <EditActionBar
            count={Object.keys(localOverrides).length}
            onExport={() => downloadOverrides(localOverrides)}
            onClear={() => {
              if (Object.keys(localOverrides).length === 0) return;
              if (confirm(`Clear ${Object.keys(localOverrides).length} local override(s)? Baked overrides from cam-pois-overrides.json are kept.`)) {
                setLocalOverrides({});
              }
            }}
          />
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
                const boring = dud.filter((d) => d.poi.quality === 'boring').length;
                const broken = dud.length - frozen - boring;
                const parts: React.ReactNode[] = [];
                if (frozen > 0) parts.push(<span key="f" className="text-[#FF5582]">{frozen} frozen</span>);
                if (boring > 0) parts.push(<span key="bo" className="text-white/65">{boring} boring</span>);
                if (broken > 0) parts.push(<span key="br">{broken} broken/empty</span>);
                return (
                  <>
                    {parts.map((p, i) => (
                      <span key={i}>
                        {i > 0 && <> · </>}
                        {p}
                      </span>
                    ))}
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
          <div className="grid gap-1 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 2xl:grid-cols-10">
            {visible.map(({ cam, poi }) => (
              <PoiTile
                key={cam.id}
                cam={cam}
                poi={poi}
                tick={tick}
                mode={mode}
                editMode={editMode}
                hasOverride={!!localOverrides[cam.id] || !!BAKED_OVERRIDES[cam.id]}
                onEdit={() => setEditingId(cam.id)}
                onExpand={() => setExpandingId(cam.id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Expand-tile modal — clicking a tile outside edit mode opens
          the cam fullscreen with all metadata. Closes on click-out
          or Escape. */}
      {expandingId && (() => {
        const cam = cameras.find((c) => c.id === expandingId);
        const baked = POI.cameras[expandingId];
        if (!cam || !baked) return null;
        const ov = localOverrides[expandingId] ?? BAKED_OVERRIDES[expandingId];
        return (
          <ExpandPanel
            cam={cam}
            poi={applyOverride(baked, ov)}
            tick={tick}
            canEdit={IS_LOCAL}
            onClose={() => setExpandingId(null)}
            onEdit={() => { setExpandingId(null); setEditMode(true); setEditingId(expandingId); }}
            onPivotTag={(t) => { setExpandingId(null); setMode('tag'); setSelectedTag(t); setSelectedScene(null); }}
          />
        );
      })()}

      {/* Editor modal — opens when a tile is clicked in edit mode */}
      {editingId && (() => {
        const cam = cameras.find((c) => c.id === editingId);
        const baked = POI.cameras[editingId];
        if (!cam || !baked) return null;
        const ov = localOverrides[editingId] ?? BAKED_OVERRIDES[editingId];
        return (
          <EditPanel
            cam={cam}
            baked={baked}
            override={ov}
            onClose={() => setEditingId(null)}
            onSave={(next) => {
              setLocalOverrides((prev) => {
                const updated = { ...prev };
                if (Object.keys(next).length === 0) {
                  delete updated[editingId];
                } else {
                  updated[editingId] = { ...next, _editedAt: Date.now() };
                }
                return updated;
              });
              setEditingId(null);
            }}
            onResetToAi={() => {
              setLocalOverrides((prev) => {
                const updated = { ...prev };
                delete updated[editingId];
                return updated;
              });
              setEditingId(null);
            }}
          />
        );
      })()}

      <StreetFauna />
    </div>
  );
}

function ModeTab({ active, label, color, onClick, hint }: { active: boolean; label: string; color: string; onClick: () => void; hint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint ?? label}
      aria-pressed={active}
      className="px-3 py-1.5 font-bungee text-[13px] uppercase tracking-[0.10em] transition-colors"
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

function PoiTile({ cam, poi, tick, mode, editMode, hasOverride, onEdit, onExpand }: {
  cam: Camera;
  poi: PoiEntry;
  tick: number;
  mode: Mode;
  editMode: boolean;
  hasOverride: boolean;
  onEdit: () => void;
  onExpand: () => void;
}) {
  // Frozen cams get a magenta frame so the user can spot stale feeds
  // at a glance; other duds use neutral grey.
  const isFrozen = poi._frozen;
  const accent = mode === 'boring'
    ? (isFrozen ? '#FF5582' : '#7f8c8d')
    : (tagMeta(poi.tags?.[0] ?? '').color);
  const score = poi.interest ?? 0;
  const headline = poi.poi ?? poi.landmark_name ?? cam.name ?? cam.id;

  // Tiles are always clickable now: edit mode → editor panel,
  // otherwise → fullscreen expand panel. Either action makes the
  // whole tile a button so a casual user doesn't have to aim at a
  // tiny icon.
  return (
    <button
      type="button"
      onClick={editMode ? onEdit : onExpand}
      className="relative bg-black border block w-full text-left hover:brightness-110 transition-[filter]"
      style={{
        borderColor: editMode
          ? (hasOverride ? '#B5F500' : '#B5F50055')
          : accent + '55',
        aspectRatio: '16 / 11',
        minHeight: 90,
        cursor: 'pointer',
        boxShadow: editMode && hasOverride ? '0 0 0 2px #B5F50066' : undefined,
      }}
      title={editMode ? `Edit tags · ${cam.name ?? cam.id}` : `Expand · ${cam.name ?? cam.id}`}
    >
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
          className="absolute top-1 left-1 px-1.5 py-0.5 font-bungee text-[10px] uppercase tracking-[0.14em]"
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
        className="absolute top-1 right-1 px-1.5 py-0.5 font-bungee text-[10px] uppercase tracking-[0.12em] truncate max-w-[70%]"
        style={{ background: '#000', color: accent, border: `1px solid ${accent}` }}
      >
        {tagMeta(poi.tags?.[0] ?? '').emoji} {headline}
      </div>
      {hasOverride && (
        <div
          className="absolute bottom-5 right-1 px-1 py-0.5 font-bungee text-[7px] uppercase tracking-[0.14em]"
          style={{ background: '#B5F500', color: '#000' }}
          title="Manually edited"
        >
          ✓ EDITED
        </div>
      )}
      {(poi.proposed_tags?.length ?? 0) > 0 && !hasOverride && (
        <div
          className="absolute bottom-5 right-1 px-1 py-0.5 font-bungee text-[7px] uppercase tracking-[0.14em]"
          style={{ background: 'transparent', color: '#B5F500', border: '1px dashed #B5F500' }}
          title={`AI proposed: ${poi.proposed_tags!.join(', ')}`}
        >
          ★ {poi.proposed_tags!.length}
        </div>
      )}
      {editMode && (
        <div
          className="absolute bottom-5 left-1 px-1 py-0.5 font-bungee text-[7px] uppercase tracking-[0.14em]"
          style={{ background: '#000', color: '#B5F500', border: '1px solid #B5F500' }}
        >
          ✏️ EDIT
        </div>
      )}
      <div
        className="absolute bottom-0 inset-x-0 px-1.5 py-1 font-typewriter text-[10px] uppercase tracking-[0.10em] text-white line-clamp-1"
        style={{ background: 'rgba(0,0,0,0.85)' }}
      >
        {cam.name ?? cam.id}
      </div>
    </button>
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
        className="absolute top-1 left-1 px-1.5 py-0.5 font-bungee text-[10px] uppercase tracking-[0.14em] tabular"
        style={{ background: accent, color: '#000' }}
        title={`Interest score ${score}/100`}
      >
        {score}
      </div>
      {reason && (
        <div
          className="absolute top-1 right-1 px-1.5 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.1em] truncate max-w-[70%]"
          style={{ background: '#000', color: accent, border: `1px solid ${accent}` }}
        >
          {reason}
        </div>
      )}
      <div
        className="absolute bottom-0 inset-x-0 px-1.5 py-1 font-typewriter text-[10px] uppercase tracking-[0.1em] text-white line-clamp-1"
        style={{ background: 'rgba(0,0,0,0.85)' }}
      >
        {cam.name ?? cam.id}
      </div>
    </div>
  );
}

// ── Override editor UI ──────────────────────────────────────────────

const QUALITY_OPTIONS: { id: Quality; label: string; emoji: string; color: string; hint: string }[] = [
  { id: 'good',   label: 'Good',   emoji: '✅', color: '#B5F500', hint: 'Clear, worth looking at' },
  { id: 'boring', label: 'Boring', emoji: '😴', color: '#7f8c8d', hint: 'Clear but uneventful' },
  { id: 'broken', label: 'Broken', emoji: '💀', color: '#FF5582', hint: 'Frozen / mispointed / dead' },
  { id: 'dirty',  label: 'Dirty',  emoji: '💧', color: '#3498db', hint: 'Lens covered / smudged' },
];

const SCENE_OPTIONS: { id: string; label: string; emoji: string }[] = [
  { id: 'highway',      label: 'Highway',       emoji: '🛣️' },
  { id: 'bridge',       label: 'Bridge',        emoji: '🌉' },
  { id: 'tunnel',       label: 'Tunnel',        emoji: '🚇' },
  { id: 'intersection', label: 'Intersection',  emoji: '🚦' },
  { id: 'boulevard',    label: 'Boulevard',     emoji: '🏬' },
  { id: 'residential',  label: 'Residential',   emoji: '🏘️' },
  { id: 'skyline',      label: 'Skyline',       emoji: '🌆' },
  { id: 'other',        label: 'Other',         emoji: '★' },
];

// All controlled-vocabulary tags from server/poi_taxonomy.py — keep
// this in lockstep with TAG_VALUES on the backend so a manual
// override never adds a tag the classifier wouldn't have.
const ALL_TAGS: string[] = [
  'bridge', 'tunnel', 'highway', 'road', 'intersection', 'crosswalk',
  'traffic_lights', 'street_signs', 'lamppost',
  'skyline', 'skyscraper', 'brownstone', 'corner_house', 'storefront',
  'bodega', 'billboard', 'scaffolding', 'construction', 'traffic_cone',
  'tree', 'park', 'water', 'river', 'harbor', 'snow',
  'people', 'crowd', 'vehicles', 'bus', 'truck', 'taxi', 'bicycle', 'subway',
  'food_cart', 'garbage_bin', 'subway_entrance',
  'rain', 'fog', 'sun_glare', 'night_lights',
  'landmark', 'statue', 'monument', 'mural',
];

// Fullscreen "expand this cam" panel — what you get when you click
// any tile outside edit mode. Designed as a NASA command-center
// inspect view: the live image dominates, metadata + clickable tag
// pivots run alongside.
function ExpandPanel({ cam, poi, tick, onClose, onEdit, onPivotTag, canEdit }: {
  cam: Camera;
  poi: PoiEntry;
  tick: number;
  onClose: () => void;
  onEdit: () => void;
  onPivotTag: (tag: string) => void;
  canEdit: boolean;
}) {
  // Esc to close, refresh image every 6s while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const accent = tagMeta(poi.tags?.[0] ?? 'landmark').color;
  const score = poi.interest ?? 0;
  const tags = poi.tags ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch"
      style={{ background: 'rgba(0,0,0,0.92)' }}
      onClick={onClose}
    >
      <div
        className="m-2 sm:m-4 flex-1 grid lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] gap-2 sm:gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image pane */}
        <div className="relative bg-black border-2" style={{ borderColor: accent, minHeight: 0 }}>
          <img
            src={NYCTMC_IMG(cam.id, tick)}
            alt={cam.name ?? cam.id}
            referrerPolicy="no-referrer"
            decoding="async"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
          <div className="absolute top-2 left-2 px-2 py-1 font-bungee text-[14px] uppercase tracking-[0.10em] tabular bg-black/85" style={{ color: accent, border: `1px solid ${accent}` }}>
            ▣ {score}/100 · {poi.poi ?? cam.name ?? cam.id}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="absolute top-2 right-2 px-2 py-1 font-typewriter text-[11px] uppercase tracking-[0.18em] bg-black/85 text-white border border-white/40 hover:border-white"
            title="Close (esc)"
          >
            ✕ close
          </button>
        </div>

        {/* Side panel */}
        <div className="bg-[#0a0a14] border border-white/15 p-3 overflow-y-auto font-typewriter text-[11px] uppercase tracking-[0.16em] text-white/85">
          <div className="font-bungee text-[14px] text-[#FFD600] tracking-[0.10em] mb-1 break-words">
            {cam.name ?? cam.id}
          </div>
          <div className="text-white/45 text-[10px] mb-3 tabular">
            {cam.lat.toFixed(4)}, {cam.lng.toFixed(4)}
            {cam.borough && <> · {cam.borough}</>}
          </div>

          <PanelKV k="quality" v={(poi.quality ?? '?') + (poi._frozen ? ' · frozen' : '')} />
          <PanelKV k="scene" v={poi.scene ?? '—'} />
          <PanelKV k="area" v={poi.area_type ?? '—'} />
          <PanelKV k="time" v={poi.time_of_day ?? '—'} />
          <PanelKV k="weather" v={poi.weather ?? '—'} />
          <PanelKV k="congestion" v={poi.congestion ?? '—'} />
          {poi.landmark_name && <PanelKV k="landmark" v={poi.landmark_name} />}
          {poi.event_description && <PanelKV k="event" v={poi.event_description} />}
          <PanelKV k="confidence" v={`${poi.confidence ?? 0}%`} />
          <PanelKV k="interest" v={`${score}/100`} />

          {tags.length > 0 && (
            <div className="mt-3">
              <div className="text-white/55 text-[10px] mb-1">tags · click to pivot</div>
              <div className="flex flex-wrap gap-1">
                {tags.map((t) => {
                  const m = tagMeta(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => onPivotTag(t)}
                      className="px-1.5 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.12em]"
                      style={{ background: '#0a0a14', color: m.color, border: `1px solid ${m.color}` }}
                    >
                      {m.emoji} {m.label || t}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {(poi.proposed_tags ?? []).length > 0 && (
            <div className="mt-3">
              <div className="text-white/55 text-[10px] mb-1">
                ★ proposed by AI · not in controlled vocab yet
              </div>
              <div className="flex flex-wrap gap-1">
                {(poi.proposed_tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="px-1.5 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.12em]"
                    style={{
                      background: '#0a0a14',
                      color: '#B5F500',
                      border: '1px dashed #B5F500',
                    }}
                    title="Free-form tag the model invented because nothing in the controlled list fit"
                  >
                    ★ {t.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            {canEdit && (
              <button
                type="button"
                onClick={onEdit}
                className="px-2 py-1 font-typewriter text-[10px] uppercase tracking-[0.16em] border border-[#B5F500] text-[#B5F500] hover:bg-[#B5F500] hover:text-black"
              >
                ✏️ edit tags
              </button>
            )}
            <a
              href={NYCTMC_IMG(cam.id, tick)}
              target="_blank"
              rel="noreferrer"
              className="px-2 py-1 font-typewriter text-[10px] uppercase tracking-[0.16em] border border-white/40 text-white/80 hover:border-white hover:text-white"
            >
              ↗ open frame
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelKV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2 border-b border-white/10 py-1">
      <span className="text-white/55">{k}</span>
      <span className="text-white text-right break-all">{v}</span>
    </div>
  );
}

function downloadOverrides(local: Record<string, Override>) {
  // Merge baked + local so the export is a complete, drop-in
  // replacement for src/cam-pois-overrides.json — no manual merging
  // needed before commit.
  const merged: Record<string, Override> = { ...BAKED_OVERRIDES, ...local };
  const payload = {
    _comment: 'Manual corrections for /poi tagging — wins over the AI-baked cam-pois.json. Edit in the /poi \'Edit Tags\' mode and click \'Export overrides.json\' to refresh this file.',
    generated_at: Math.floor(Date.now() / 1000),
    overrides: merged,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cam-pois-overrides.json';
  a.click();
  URL.revokeObjectURL(url);
}

function EditActionBar({ count, onExport, onClear }: {
  count: number;
  onExport: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 px-2 py-2 border border-[#B5F500]/40 bg-[#0a0a14]">
      <span className="font-bungee text-[11px] uppercase tracking-[0.16em] text-[#B5F500]">
        Edit mode
      </span>
      <span className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/65">
        {count === 0
          ? 'click any cam tile · changes save instantly to localStorage'
          : `${count} local override${count === 1 ? '' : 's'} pending`}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onExport}
        className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.14em] border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors"
        title="Download current overrides as cam-pois-overrides.json — drop into src/ to commit"
      >
        📥 Export JSON
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={count === 0}
        className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.14em] border border-[#FF5582] text-[#FF5582] hover:bg-[#FF5582] hover:text-black transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        title="Clear all local overrides (baked overrides from cam-pois-overrides.json are kept)"
      >
        🗑️ Clear local
      </button>
    </div>
  );
}

function EditPanel({ cam, baked, override, onClose, onSave, onResetToAi }: {
  cam: Camera;
  baked: PoiEntry;
  override: Override | undefined;
  onClose: () => void;
  onSave: (next: Override) => void;
  onResetToAi: () => void;
}) {
  // Initialise the form from the override-on-top-of-baked merge so
  // the user sees what they'd see in the live page, not the raw AI
  // output.
  const initial = applyOverride(baked, override);
  const [quality, setQuality] = useState<Quality>(
    (initial.quality && initial.quality !== 'empty' ? initial.quality : 'good') as Quality,
  );
  const [scene, setScene] = useState<string>(initial.scene ?? 'other');
  const [landmark, setLandmark] = useState<string>(initial.landmark_name ?? '');
  const [tags, setTags] = useState<Set<string>>(new Set(initial.tags ?? []));

  const toggleTag = (t: string) => {
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  };

  // Build the override delta — only fields that differ from the baked
  // entry are saved, so the JSON stays minimal and we don't pin
  // values the AI got right.
  const buildDelta = (): Override => {
    const delta: Override = {};
    if (quality !== (baked.quality ?? 'good')) delta.quality = quality;
    const bakedScene = baked.scene ?? 'other';
    if (scene !== bakedScene) delta.scene = scene;
    const trimmedLandmark = landmark.trim() || null;
    if (trimmedLandmark !== (baked.landmark_name ?? null)) delta.landmark_name = trimmedLandmark;
    const tagArr = Array.from(tags);
    const bakedTags = baked.tags ?? [];
    const tagsDiffer = tagArr.length !== bakedTags.length
      || tagArr.some((t) => !bakedTags.includes(t))
      || bakedTags.some((t) => !tagArr.includes(t));
    if (tagsDiffer) delta.tags = tagArr;
    return delta;
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.78)' }}
      onClick={onClose}
    >
      <div
        className="bg-[#0a0a14] border-2 border-[#B5F500] max-w-[920px] w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between px-3 py-2 border-b border-[#B5F500]/40">
          <span className="font-bungee text-[14px] uppercase tracking-[0.10em] text-[#B5F500]">
            ✏️ Edit · {cam.name ?? cam.id}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="font-typewriter text-[12px] uppercase tracking-[0.18em] text-white/65 hover:text-white"
            title="Close (changes are saved on Apply)"
          >
            ✕ close
          </button>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-3 p-3">
          {/* Live image preview */}
          <div className="relative bg-black border border-white/15" style={{ aspectRatio: '16 / 11' }}>
            <img
              src={NYCTMC_IMG(cam.id, Date.now())}
              alt={cam.name ?? cam.id}
              referrerPolicy="no-referrer"
              decoding="async"
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute bottom-1 left-1 right-1 px-1 py-0.5 font-typewriter text-[9px] uppercase tracking-[0.12em] text-white/75 bg-black/75">
              AI baked: {baked.quality ?? 'good'} · {baked.scene ?? 'other'} · {(baked.tags ?? []).slice(0, 5).join(', ') || '—'}
            </div>
          </div>

          {/* Controls */}
          <div className="space-y-3">
            <div>
              <div className="font-bungee text-[10px] uppercase tracking-[0.14em] text-white/65 mb-1">Quality</div>
              <div className="flex flex-wrap gap-1">
                {QUALITY_OPTIONS.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => setQuality(q.id)}
                    title={q.hint}
                    className="px-2 py-1 font-bungee text-[10px] uppercase tracking-[0.10em] transition-colors"
                    style={{
                      background: quality === q.id ? q.color : '#0a0a14',
                      color: quality === q.id ? '#000' : q.color,
                      border: `1px solid ${q.color}`,
                    }}
                  >
                    {q.emoji} {q.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="font-bungee text-[10px] uppercase tracking-[0.14em] text-white/65 mb-1">Scene</div>
              <div className="flex flex-wrap gap-1">
                {SCENE_OPTIONS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setScene(s.id)}
                    className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.12em] transition-colors"
                    style={{
                      background: scene === s.id ? '#FFD600' : '#0a0a14',
                      color: scene === s.id ? '#000' : '#FFD600',
                      border: '1px solid #FFD600',
                    }}
                  >
                    {s.emoji} {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="font-bungee text-[10px] uppercase tracking-[0.14em] text-white/65 mb-1">
                Landmark name <span className="text-white/40 normal-case">(optional)</span>
              </div>
              <input
                type="text"
                value={landmark}
                onChange={(e) => setLandmark(e.target.value)}
                placeholder="e.g. Brooklyn Bridge, Empire State"
                className="w-full px-2 py-1 bg-black border border-white/30 text-white font-typewriter text-[12px] focus:outline-none focus:border-[#FFD600]"
              />
            </div>

            <div>
              <div className="font-bungee text-[10px] uppercase tracking-[0.14em] text-white/65 mb-1">
                Tags <span className="text-white/40 normal-case">({tags.size} selected)</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {ALL_TAGS.map((t) => {
                  const m = tagMeta(t);
                  const on = tags.has(t);
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleTag(t)}
                      className="px-1.5 py-0.5 font-typewriter text-[9px] uppercase tracking-[0.12em] transition-colors"
                      style={{
                        background: on ? m.color : '#0a0a14',
                        color: on ? '#000' : m.color,
                        border: `1px solid ${m.color}${on ? '' : '77'}`,
                      }}
                    >
                      {m.emoji} {m.label || t}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-[#B5F500]/40 bg-black/55">
          <button
            type="button"
            onClick={onResetToAi}
            className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.14em] border border-white/40 text-white/70 hover:border-white hover:text-white"
            title="Drop the override and revert to the AI's verdict"
          >
            ↺ reset to AI
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 font-typewriter text-[10px] uppercase tracking-[0.14em] border border-white/40 text-white/70 hover:border-white hover:text-white"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(buildDelta())}
            className="px-3 py-1 font-bungee text-[12px] uppercase tracking-[0.10em] bg-[#B5F500] text-black border-2 border-[#B5F500] hover:bg-[#a3e000]"
          >
            ✓ apply
          </button>
        </div>
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
