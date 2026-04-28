import { useEffect, useMemo, useState } from 'react';
import { BodegaAwning } from './bodega-tv';
import { fetchCameras } from './api';
import type { Camera } from './types';
import bakedDay from './cam-pois.json';

/* ──────────────────────────────────────────────────────────────────────
   /curator — human review + approval of model classifications.

   Three-panel UI:
   1. Model output (POI name, category, confidence, interest score)
   2. Live image (6s refresh from NYCTMC)
   3. Quality checklist (sun glare, lens obstruction, landmarks, etc.)

   Curator can yay/nay each classification and add notes. Approvals
   are saved to curator_approved.json via /api/curator/approve.

   Gallery view shows all useable cams side-by-side with model vs.
   curator approval status.
   ──────────────────────────────────────────────────────────────────── */

type PoiEntry = {
  poi: string | null;
  category: string | null;
  description: string | null;
  confidence: number;
  interest?: number;
  scene?: string | null;
  weather?: string | null;
  time_of_day?: string | null;
  congestion?: string | null;
  crowd_or_event?: boolean;
  event_description?: string | null;
  landmark_name?: string | null;
  skyline_visible?: boolean;
  image_usable?: boolean;
  sun_glare?: boolean;
  lens_obstruction?: boolean;
  _lat?: number;
  _lng?: number;
};

type PoiPayload = {
  generated_at: number | null;
  cameras: Record<string, PoiEntry>;
};

type CuratorRecord = {
  cam_id: string;
  approved: boolean | null;
  image_usable_override?: boolean;
  notes?: string;
  curator_timestamp?: number;
};

const POI = bakedDay as PoiPayload;

const NYCTMC_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;

const sceneColors: Record<string, string> = {
  skyline: '#B5F500',
  bridge: '#FF6319',
  tunnel: '#1a1a1a',
  intersection: '#FF8A3A',
  boulevard: '#d11a2a',
  residential: '#0039A6',
  highway: '#6CBE45',
  other: '#999',
};

export default function Curator() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [approvals, setApprovals] = useState<Map<string, CuratorRecord>>(new Map());
  const [currentIdx, setCurrentIdx] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [view, setView] = useState<'review' | 'gallery'>('review');
  const [notes, setNotes] = useState('');
  const [showOnlyUsable, setShowOnlyUsable] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
  }, []);

  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 6_000);
    return () => clearInterval(i);
  }, []);

  // Build reviewable list — filter by scene + usability
  const reviewList = useMemo(() => {
    const out: { cam: Camera; poi: PoiEntry }[] = [];
    for (const c of cameras) {
      const p = POI.cameras[c.id];
      if (!p) continue;
      if (showOnlyUsable && p.image_usable === false) continue;
      out.push({ cam: c, poi: p });
    }
    // Sort by interest score descending
    out.sort((a, b) => (b.poi.interest ?? 0) - (a.poi.interest ?? 0));
    return out;
  }, [cameras, showOnlyUsable]);

  const current = reviewList[currentIdx];

  const handleApprove = async (approved: boolean) => {
    if (!current) return;
    const rec: CuratorRecord = {
      cam_id: current.cam.id,
      approved,
      notes,
      curator_timestamp: Date.now(),
    };
    setApprovals((prev) => {
      const next = new Map(prev);
      next.set(current.cam.id, rec);
      return next;
    });
    setSaving(true);
    try {
      const res = await fetch('/api/curator/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rec),
      });
      if (!res.ok) console.warn('Save failed:', await res.text());
    } catch (e) {
      console.error('Save error:', e);
    } finally {
      setSaving(false);
    }
    setNotes('');
    setCurrentIdx((prev) => Math.min(prev + 1, reviewList.length - 1));
  };

  const handleNext = () => {
    setNotes('');
    setCurrentIdx((prev) => Math.min(prev + 1, reviewList.length - 1));
  };

  const handlePrev = () => {
    setNotes('');
    setCurrentIdx((prev) => Math.max(prev - 1, 0));
  };

  const hasData = POI.generated_at !== null && Object.keys(POI.cameras).length > 0;

  if (!hasData) {
    return (
      <div className="min-h-screen w-screen flex flex-col text-white bg-black">
        <BodegaAwning
          rightSlot={
            <a
              href="/"
              className="ml-2 px-2 py-0.5 border border-white text-white hover:bg-white hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
            >
              ← HOME
            </a>
          }
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xl mb-2">POI data not generated yet</div>
            <div className="text-sm text-white/60">
              Run: <code className="bg-white/10 px-2 py-1">python -m server.poi_classify_local</code>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'gallery') {
    return <CuratorGallery cameras={cameras} onBack={() => setView('review')} />;
  }

  return (
    <div className="min-h-screen w-screen flex flex-col text-white bg-black">
      <BodegaAwning
        rightSlot={
          <a
            href="/"
            className="ml-2 px-2 py-0.5 border border-white text-white hover:bg-white hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
          >
            ← HOME
          </a>
        }
      />

      <main className="flex-1 flex flex-col gap-3 p-4 max-h-[calc(100vh-60px)] overflow-hidden">
        {/* Header */}
        <div>
          <div className="font-bungee text-[28px] uppercase">
            🎬 Curator <span className="text-[#FFD600]">Review</span>
          </div>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/60 mt-1">
            {currentIdx + 1} / {reviewList.length} · {approvals.size} approved ·{' '}
            {saving && <span className="text-yellow-400">saving...</span>}
          </div>
        </div>

        {/* Controls */}
        <div className="flex gap-2 flex-wrap items-center">
          <button
            onClick={() => setShowOnlyUsable(!showOnlyUsable)}
            className={`px-2 py-1 border text-[9px] uppercase font-typewriter tracking-[0.16em] ${
              showOnlyUsable
                ? 'bg-[#FFD600] text-black border-[#FFD600]'
                : 'bg-transparent border-white/30 text-white/60 hover:border-white'
            }`}
          >
            {showOnlyUsable ? '✓ Usable Only' : 'Show All'}
          </button>
          <button
            onClick={() => setView('gallery')}
            className="px-2 py-1 border border-white/30 text-white/60 text-[9px] uppercase font-typewriter tracking-[0.16em] hover:border-white hover:text-white"
          >
            📋 Gallery
          </button>
          <span className="text-[9px] text-white/40">
            Scene: <span style={{ color: sceneColors[current?.poi.scene ?? 'other'] }}>
              {current?.poi.scene ?? 'unknown'}
            </span>
            {current?.poi.landmark_name && ` · Landmark: ${current.poi.landmark_name}`}
            {current?.poi.crowd_or_event && ` · 🚨 EVENT`}
          </span>
        </div>

        {/* Three-panel layout */}
        <div className="flex-1 grid grid-cols-3 gap-3 min-h-0">
          {/* Panel 1: Model Output */}
          <div className="border border-white/20 bg-white/5 p-3 overflow-y-auto">
            <div className="font-bungee text-[12px] uppercase mb-2 text-[#FFD600]">Model Output</div>
            {current ? (
              <div className="space-y-2 text-[10px] font-typewriter">
                <div>
                  <span className="text-white/60">POI:</span>
                  <div className="text-[11px] font-bungee mt-0.5">{current.poi.poi ?? '(none)'}</div>
                </div>
                <div>
                  <span className="text-white/60">Category:</span>
                  <div>{current.poi.category ?? '(none)'}</div>
                </div>
                <div>
                  <span className="text-white/60">Confidence:</span>
                  <div>
                    <span className="font-bungee">{current.poi.confidence ?? 0}%</span>
                  </div>
                </div>
                <div>
                  <span className="text-white/60">Interest Score:</span>
                  <div>
                    <span className="font-bungee">{current.poi.interest ?? 0} / 100</span>
                  </div>
                </div>
                <div>
                  <span className="text-white/60">Time of Day:</span>
                  <div>{current.poi.time_of_day ?? '?'}</div>
                </div>
                <div>
                  <span className="text-white/60">Weather:</span>
                  <div>{current.poi.weather ?? '?'}</div>
                </div>
                <div>
                  <span className="text-white/60">Congestion:</span>
                  <div>{current.poi.congestion ?? '?'}</div>
                </div>
                <div>
                  <span className="text-white/60">Image Usable:</span>
                  <div>{current.poi.image_usable === false ? '❌ No' : '✓ Yes'}</div>
                </div>
              </div>
            ) : (
              <div className="text-white/40">No cameras to review</div>
            )}
          </div>

          {/* Panel 2: Live Image */}
          <div className="border border-white/20 bg-black p-3 flex flex-col gap-2">
            <div className="font-bungee text-[12px] uppercase text-[#FFD600]">Live Image (6s refresh)</div>
            {current ? (
              <>
                <div className="flex-1 relative bg-black border border-white/10" style={{ minHeight: 200 }}>
                  <img
                    key={current.cam.id}
                    src={NYCTMC_IMG(current.cam.id, tick)}
                    alt={current.cam.name}
                    referrerPolicy="no-referrer"
                    decoding="async"
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                </div>
                <div className="text-[9px] font-typewriter text-white/70">
                  {current.cam.name}
                </div>
                <div className="text-[8px] font-typewriter text-white/50">
                  {current.cam.lat.toFixed(4)}, {current.cam.lng.toFixed(4)}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-white/40">No image</div>
            )}
          </div>

          {/* Panel 3: Quality Checklist */}
          <div className="border border-white/20 bg-white/5 p-3 overflow-y-auto">
            <div className="font-bungee text-[12px] uppercase mb-2 text-[#FFD600]">Quality Flags</div>
            {current ? (
              <div className="space-y-1 text-[10px] font-typewriter">
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={current.poi.sun_glare ?? false} readOnly className="mt-0.5" />
                  <span className="text-white/70">Sun Glare</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={current.poi.lens_obstruction ?? false} readOnly className="mt-0.5" />
                  <span className="text-white/70">Lens Obstruction</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={current.poi.skyline_visible ?? false} readOnly className="mt-0.5" />
                  <span className="text-white/70">Skyline Visible</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={current.poi.crowd_or_event ?? false} readOnly className="mt-0.5" />
                  <span className="text-white/70">Crowd / Event</span>
                </label>

                <div className="border-t border-white/10 pt-2 mt-2">
                  <div className="text-white/60 mb-1">Your Notes:</div>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Add comments..."
                    className="w-full bg-white/5 border border-white/10 p-1 text-[9px] h-16 text-white placeholder-white/30 focus:outline-none focus:border-white/30"
                  />
                </div>
              </div>
            ) : (
              <div className="text-white/40">No flags</div>
            )}
          </div>
        </div>

        {/* Approval Buttons */}
        <div className="flex gap-2 justify-between items-center">
          <div className="flex gap-2">
            <button
              onClick={handlePrev}
              disabled={currentIdx === 0}
              className="px-3 py-1 border border-white/30 bg-transparent text-white/70 disabled:text-white/20 font-typewriter text-[10px] uppercase tracking-[0.16em] hover:border-white disabled:border-white/10"
            >
              ← Prev
            </button>
            <button
              onClick={handleNext}
              disabled={currentIdx >= reviewList.length - 1}
              className="px-3 py-1 border border-white/30 bg-transparent text-white/70 disabled:text-white/20 font-typewriter text-[10px] uppercase tracking-[0.16em] hover:border-white disabled:border-white/10"
            >
              Next →
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => handleApprove(false)}
              disabled={!current || saving}
              className="px-4 py-1 border border-red-500/50 bg-red-500/10 text-red-400 hover:bg-red-500/20 font-typewriter text-[10px] uppercase tracking-[0.16em] disabled:opacity-50"
            >
              ❌ Reject
            </button>
            <button
              onClick={() => handleApprove(true)}
              disabled={!current || saving}
              className="px-4 py-1 border border-green-500/50 bg-green-500/10 text-green-400 hover:bg-green-500/20 font-typewriter text-[10px] uppercase tracking-[0.16em] disabled:opacity-50"
            >
              ✓ Approve
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ──── Gallery View ──── */

function CuratorGallery({ cameras, onBack }: { cameras: Camera[]; onBack: () => void }) {
  const [tick, setTick] = useState(() => Date.now());
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const i = setInterval(() => setTick(Date.now()), 6_000);
    return () => clearInterval(i);
  }, []);

  const items = useMemo(() => {
    const out: { cam: Camera; poi: PoiEntry }[] = [];
    for (const c of cameras) {
      const p = POI.cameras[c.id];
      if (!p || p.image_usable === false) continue;
      if (filter !== 'all' && p.scene !== filter) continue;
      out.push({ cam: c, poi: p });
    }
    out.sort((a, b) => (b.poi.interest ?? 0) - (a.poi.interest ?? 0));
    return out;
  }, [cameras, filter]);

  const scenes = useMemo(() => {
    const s = new Set<string>();
    for (const c of cameras) {
      const p = POI.cameras[c.id];
      if (p?.scene) s.add(p.scene);
    }
    return Array.from(s).sort();
  }, [cameras]);

  return (
    <div className="min-h-screen w-screen flex flex-col text-white bg-black p-4">
      <div className="flex justify-between items-baseline mb-4">
        <div className="font-bungee text-[24px] uppercase">
          📋 Usable <span className="text-[#FFD600]">Gallery</span>
        </div>
        <button
          onClick={onBack}
          className="px-2 py-1 border border-white text-white hover:bg-white hover:text-black font-typewriter text-[9px] uppercase"
        >
          ← Back
        </button>
      </div>

      <div className="flex gap-1 mb-4 flex-wrap">
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-1 text-[9px] uppercase font-typewriter ${
            filter === 'all' ? 'bg-[#FFD600] text-black' : 'border border-white/30 text-white/70 hover:border-white'
          }`}
        >
          All ({items.length})
        </button>
        {scenes.map((s) => {
          const n = cameras.filter((c) => POI.cameras[c.id]?.scene === s && POI.cameras[c.id]?.image_usable !== false)
            .length;
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-2 py-1 text-[9px] uppercase font-typewriter ${
                filter === s ? 'text-black' : 'border border-white/30 text-white/70 hover:border-white'
              }`}
              style={{ backgroundColor: filter === s ? sceneColors[s] : 'transparent' }}
            >
              {s} ({n})
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2 overflow-y-auto flex-1 pb-4">
        {items.map(({ cam, poi }) => (
          <div key={cam.id} className="border border-white/20 bg-white/5 p-1">
            <div className="relative bg-black border border-white/10 mb-1" style={{ aspectRatio: '1', minHeight: 80 }}>
              <img
                src={NYCTMC_IMG(cam.id, tick)}
                alt={cam.name}
                referrerPolicy="no-referrer"
                decoding="async"
                className="absolute inset-0 w-full h-full object-cover"
              />
              <div
                className="absolute top-0 right-0 px-1 py-0.5 text-[7px] uppercase font-bungee"
                style={{ backgroundColor: sceneColors[poi.scene ?? 'other'], color: 'black' }}
              >
                {poi.interest}
              </div>
            </div>
            <div className="text-[7px] font-typewriter text-white/80 truncate">{cam.name}</div>
            <div className="text-[6px] text-white/50">{poi.poi ?? poi.scene}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
