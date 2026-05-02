/* /rewind — past ↔ present mashup at the deli.

   For every WPA tax photo we have, we precomputed the closest live
   NYC DOT traffic cam (server/rewind_pairs.py → public/rewind-pairs-1940s.json).
   This page surfs through those pairs cassette-style: a 1940 still next
   to a refreshing live frame, with a VHS-tape transport.

   Layouts:
     SIDE  — 1940 next to live cam
     STACK — same, vertical
     GHOST — 1940 base + live cam at adjustable opacity (whole-frame screen blend)
     PORTAL — 1940 base + a draggable / resizable rectangle that shows the
              live cam pixels through clip-path. Drag, resize, and pick a
              shape preset (RECT / OVAL / FIGURE) to drop a 2026 silhouette
              onto the 1940 sidewalk. Zero ML, zero CORS pain — ships now.

   Phase-2 path documented at the bottom of this file: real person/car
   isolation needs a CF Pages function proxy in front of the cam image
   (so we can read pixels without tainting the canvas), then we can run
   coco-ssd via dynamic import on /rewind only.
*/
import { useEffect, useMemo, useRef, useState } from 'react';

interface CamRef {
  id: string;
  name: string;
  lat: number;
  lng: number;
  borough: string;
}
interface CamValidation {
  usable: boolean;
  confidence: number;
  scene_kind: string;
  has_pedestrians: boolean;
  has_vehicles: boolean;
  what_we_see: string;
  name: string;
  borough: string;
}
interface CamUsabilityFile {
  version: number;
  generated_at: number;
  model: string;
  summary: { total: number; usable: number; unusable: number };
  cams: Record<string, CamValidation>;
}
interface RewindPair {
  bin: string;
  lot: number;
  block: number;
  boro: number;
  photo_url: string;
  centroid: [number, number];
  cam: CamRef;
  distance_m: number;
  validation?: CamValidation;     // populated client-side from CAM_USABILITY_URL
  rank?: number;                   // present on visual-match pairs
  similarity?: number;             // CLIP cosine similarity (0..1)
}
interface PairsFile {
  version: number;
  generated_at: number;
  count?: number;
  pairs: RewindPair[];
  summary?: { cams_lit?: number; total_matches?: number };
}

// CLIP-based visual matches (best WPA per cam) — preferred when present.
// See server/embed_visual.py + server/export_visual_matches.py.
const VISUAL_PAIRS_URL = '/rewind-pairs-visual.json';
// Per-cam usability verdict (one entry per unique cam). Joined with the
// geographic pairs as a fallback when the visual file isn't available.
const CAM_USABILITY_URL = '/cam-rewind-usability.json';
const PAIRS_URL = '/rewind-pairs-1940s.json';
// Below this confidence we drop the cam even if usable=true.
const MIN_USABLE_CONFIDENCE = 0.5;
// Below this CLIP similarity we drop visual matches as too weak.
const MIN_VISUAL_SIMILARITY = 0.30;
const CAM_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;
const AUTO_ADVANCE_MS = 9000;
const CAM_REFRESH_MS = 4000;

type Layout = 'side-by-side' | 'stacked' | 'overlay' | 'portal' | 'mash';

// Where the foreground PNGs live — written by server/extract_foreground.py.
const FOREGROUND_URL = (camId: string) => `/cam_foreground/${camId}.png`;
type PortalShape = 'rect' | 'oval' | 'figure';

export default function Rewind() {
  const [pairs, setPairs] = useState<RewindPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [layout, setLayout] = useState<Layout>('side-by-side');
  const [paused, setPaused] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [tick, setTick] = useState(() => Date.now());

  // Load pairs — preference order:
  //   1. CLIP visual-match pairs (best WPA per cam, geographic + visual)
  //   2. Geographic + per-cam llava usability join
  //   3. Geographic-only (last-ditch fallback so the page never breaks)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // (1) Try the visual-match file. If it has any pairs, use it.
      try {
        const vis = await fetch(VISUAL_PAIRS_URL);
        if (vis.ok) {
          const data: PairsFile = await vis.json();
          if (cancelled) return;
          // Keep only rank-1 pairs above similarity floor — show ONE
          // best match per cam in the rotation. Other ranks are still
          // in the JSON for future "alternates" UI.
          const top = data.pairs.filter(p =>
            p.rank === 1 && (p.similarity ?? 0) >= MIN_VISUAL_SIMILARITY
          );
          if (top.length > 0) {
            top.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
            setPairs(top);
            return;
          }
        }
      } catch { /* fall through */ }

      // (2) + (3) — original geographic + llava-validation path.
      try {
        const [pairsResp, usabResp] = await Promise.all([
          fetch(PAIRS_URL),
          fetch(CAM_USABILITY_URL).catch(() => null),
        ]);
        if (!pairsResp.ok) throw new Error(`pairs HTTP ${pairsResp.status}`);
        const pairsData: PairsFile = await pairsResp.json();
        if (cancelled) return;

        let usability: CamUsabilityFile | null = null;
        if (usabResp && usabResp.ok) {
          try { usability = await usabResp.json(); } catch { /* ignore */ }
        }
        if (cancelled) return;

        let filtered = pairsData.pairs.slice();
        if (usability && Object.keys(usability.cams).length > 0) {
          filtered = filtered
            .map(p => ({ ...p, validation: usability!.cams[p.cam.id] }))
            .filter(p =>
              p.validation?.usable && (p.validation.confidence ?? 0) >= MIN_USABLE_CONFIDENCE
            );
        }
        filtered.sort((a, b) => {
          const ca = a.validation?.confidence ?? 0;
          const cb = b.validation?.confidence ?? 0;
          if (ca !== cb) return cb - ca;
          return a.distance_m - b.distance_m;
        });
        setPairs(filtered.slice(0, 80));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-advance — paused while the user is fiddling with the portal
  // (they want to look, not be yanked to the next pair mid-drag).
  useEffect(() => {
    if (paused || !pairs || pairs.length < 2 || layout === 'portal') return;
    const id = window.setInterval(() => {
      setIdx(i => (i + 1) % pairs.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, pairs, layout]);

  // Cam image refresh — every CAM_REFRESH_MS bump the cache-busting tick.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), CAM_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  // Reset cam tick when the pair changes so we get a fresh frame on jump.
  useEffect(() => { setTick(Date.now()); }, [idx]);

  if (error) {
    return <Shell><div style={{ color: '#fa6', padding: 24 }}>Failed to load: {error}</div></Shell>;
  }
  if (!pairs) {
    return <Shell><div style={{ color: '#bba', padding: 24 }}>Threading the tape…</div></Shell>;
  }
  if (pairs.length === 0) {
    return <Shell><div style={{ color: '#bba', padding: 24 }}>No pairs available.</div></Shell>;
  }

  const pair = pairs[idx];

  return (
    <Shell>
      <Header
        idx={idx}
        total={pairs.length}
        pair={pair}
        paused={paused}
        layout={layout}
        onPrev={() => setIdx(i => (i - 1 + pairs.length) % pairs.length)}
        onNext={() => setIdx(i => (i + 1) % pairs.length)}
        onTogglePause={() => setPaused(p => !p)}
        onLayout={setLayout}
      />

      <div style={{ flex: 1, display: 'flex', minHeight: 0, padding: 12, gap: 12 }}>
        {layout === 'side-by-side' && (
          <>
            <Pane label="1940 · WPA tax photo" cornerColor="#9a8b6a">
              <img src={pair.photo_url} alt={`WPA photo BIN ${pair.bin}`} style={imgStyle} />
            </Pane>
            <Pane label={`LIVE · ${pair.cam.name}`} cornerColor="#e34c4c">
              <CamFrame cam={pair.cam} tick={tick} />
            </Pane>
          </>
        )}
        {layout === 'stacked' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Pane label="1940 · WPA tax photo" cornerColor="#9a8b6a">
              <img src={pair.photo_url} alt={`WPA photo BIN ${pair.bin}`} style={imgStyle} />
            </Pane>
            <Pane label={`LIVE · ${pair.cam.name}`} cornerColor="#e34c4c">
              <CamFrame cam={pair.cam} tick={tick} />
            </Pane>
          </div>
        )}
        {layout === 'overlay' && (
          <Pane label="OVERLAY · 1940 base + live cam ghost" cornerColor="#c8a04a">
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <img src={pair.photo_url} alt={`WPA photo BIN ${pair.bin}`} style={imgStyle} />
              <div style={{
                position: 'absolute', inset: 0,
                opacity: overlayOpacity,
                mixBlendMode: 'screen',
                pointerEvents: 'none',
              }}>
                <CamFrame cam={pair.cam} tick={tick} />
              </div>
            </div>
            <div style={{
              position: 'absolute', left: 14, bottom: 12, right: 14,
              display: 'flex', gap: 12, alignItems: 'center',
              fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#cdbfa6',
            }}>
              <span style={{ width: 60 }}>ghost</span>
              <input
                type="range" min={0} max={1} step={0.01}
                value={overlayOpacity}
                onChange={e => setOverlayOpacity(parseFloat(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ width: 36, textAlign: 'right' }}>{Math.round(overlayOpacity * 100)}%</span>
            </div>
          </Pane>
        )}
        {layout === 'portal' && (
          <Pane label="PORTAL · drag a 2026 cutout onto 1940" cornerColor="#FFD600">
            <PortalCanvas pair={pair} tick={tick} />
          </Pane>
        )}
        {layout === 'mash' && (
          <Pane label="MASH · 1940 background + 2026 moving foreground" cornerColor="#FFD600">
            <MashCanvas pair={pair} />
          </Pane>
        )}
      </div>

      <Footer pair={pair} />
    </Shell>
  );
}

const imgStyle: React.CSSProperties = {
  width: '100%', height: '100%', objectFit: 'contain', display: 'block',
};

function CamFrame({ cam, tick }: { cam: CamRef; tick: number }) {
  const [errored, setErrored] = useState(false);
  // Reset error state when the cam changes.
  const camIdRef = useRef(cam.id);
  if (camIdRef.current !== cam.id) {
    camIdRef.current = cam.id;
    if (errored) setErrored(false);
  }
  if (errored) {
    return (
      <div style={{
        width: '100%', height: '100%', display: 'grid', placeItems: 'center',
        color: '#cdbfa6', fontFamily: 'ui-monospace, monospace', fontSize: 12,
        background: '#0a0a14',
      }}>
        cam offline · {cam.name}
      </div>
    );
  }
  return (
    <img
      src={CAM_IMG(cam.id, tick)}
      alt={`live cam ${cam.name}`}
      style={imgStyle}
      onError={() => setErrored(true)}
    />
  );
}

/* --- PORTAL mode -----------------------------------------------------------

   The 1940 photo is the base. On top of it we paint the live cam image
   covering the full pane, but pass it through clip-path so only a small
   shape is visible — a draggable / resizable rectangle, oval, or
   figure-shaped silhouette. The user moves and resizes the portal to
   "drop" 2026 pedestrians and traffic onto the 1940 street.

   Why CSS instead of pixel reads: the NYCTMC cam endpoint serves no CORS
   headers, so any canvas we draw the cam onto is tainted and we can't
   getImageData. Clip-path needs no pixel access, so it sails through.

   Phase 2 (when we have a CF Pages function proxy that re-emits the cam
   image with `Access-Control-Allow-Origin: *`):
     - dynamic-import @tensorflow-models/coco-ssd
     - run detection every ~2s on the live frame
     - replace the manual portal shape with a polygon clip-path built from
       the union of detected person/car bounding boxes
     - keep this PORTAL mode as the manual fallback
*/

interface PortalRect {
  /* All values are fractions of the pane (0..1) so the portal stays put
     when the pane resizes. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/* MASH layout — background-subtracted foreground from the live cam
   composited on top of the 1940 WPA photo background. The foreground
   PNG is RGBA with alpha, written by server/extract_foreground.py. We
   show it scaled to fit + positioned in the lower-half of the WPA
   photo (where the street is) so cars/people land on the sidewalk-ish
   area instead of the building facades. Opacity slider lets the user
   crossfade. Refreshes every 30s by bumping the cache-busting tick. */
function MashCanvas({ pair }: { pair: RewindPair }) {
  const [tick, setTick] = useState(() => Date.now());
  const [opacity, setOpacity] = useState(0.85);
  const [errored, setErrored] = useState(false);
  const [bottomBias, setBottomBias] = useState(0.15);
  // Refresh the foreground every 30s — server-side script will have
  // re-extracted by then if it's running on a cron.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // Reset error when the pair changes.
  const camIdRef = useRef(pair.cam.id);
  if (camIdRef.current !== pair.cam.id) {
    camIdRef.current = pair.cam.id;
    if (errored) setErrored(false);
  }
  const fgUrl = `${FOREGROUND_URL(pair.cam.id)}?t=${tick}`;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <img src={pair.photo_url} alt="WPA background" style={imgStyle} />
      {!errored && (
        <img
          src={fgUrl}
          alt="2026 foreground"
          onError={() => setErrored(true)}
          style={{
            position: 'absolute',
            left: '5%', right: '5%', bottom: `${bottomBias * 100}%`,
            width: '90%',
            objectFit: 'contain',
            opacity,
            // Subtle drop shadow so cutouts feel grounded, not floating.
            filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.55))',
            pointerEvents: 'none',
          }}
        />
      )}
      {errored && (
        <div style={{
          position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'rgba(20,15,10,0.78)',
          padding: '12px 16px', borderRadius: 6,
          fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#cdbfa6',
          textAlign: 'center', maxWidth: 320,
        }}>
          No foreground extract for this cam yet.<br />
          Run on the server:<br />
          <code style={{ color: '#FFD600' }}>python -m server.extract_foreground --cam-id {pair.cam.id.slice(0,8)} --capture-pair</code>
        </div>
      )}
      <div style={{
        position: 'absolute', left: 14, bottom: 12, right: 14,
        display: 'flex', gap: 12, alignItems: 'center',
        fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#cdbfa6',
      }}>
        <span style={{ width: 56 }}>foreground</span>
        <input
          type="range" min={0} max={1} step={0.01}
          value={opacity}
          onChange={e => setOpacity(parseFloat(e.target.value))}
          style={{ flex: 1 }}
        />
        <span style={{ width: 36, textAlign: 'right' }}>{Math.round(opacity * 100)}%</span>
        <span style={{ width: 36 }}>↕ pos</span>
        <input
          type="range" min={0} max={0.5} step={0.01}
          value={bottomBias}
          onChange={e => setBottomBias(parseFloat(e.target.value))}
          style={{ width: 80 }}
        />
      </div>
    </div>
  );
}

function PortalCanvas({ pair, tick }: { pair: RewindPair; tick: number }) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const [shape, setShape] = useState<PortalShape>('figure');
  const [rect, setRect] = useState<PortalRect>({ x: 0.42, y: 0.36, w: 0.16, h: 0.5 });
  // Pointer-drag state. We track what the user grabbed so we can move or
  // resize from the right anchor.
  const dragRef = useRef<{
    mode: 'move' | 'resize';
    startX: number;
    startY: number;
    startRect: PortalRect;
    paneW: number;
    paneH: number;
  } | null>(null);

  // Reset portal position on pair change so each new corner gets a fresh
  // sensible starting point.
  useEffect(() => {
    setRect({ x: 0.42, y: 0.36, w: 0.16, h: 0.5 });
  }, [pair.bin]);

  const onPointerDown = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!paneRef.current) return;
    const b = paneRef.current.getBoundingClientRect();
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startRect: rect,
      paneW: b.width,
      paneH: b.height,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.paneW;
    const dy = (e.clientY - d.startY) / d.paneH;
    if (d.mode === 'move') {
      setRect({
        x: clamp(d.startRect.x + dx, 0, 1 - d.startRect.w),
        y: clamp(d.startRect.y + dy, 0, 1 - d.startRect.h),
        w: d.startRect.w,
        h: d.startRect.h,
      });
    } else {
      // Resize from bottom-right corner.
      const minW = 0.04;
      const minH = 0.06;
      setRect({
        x: d.startRect.x,
        y: d.startRect.y,
        w: clamp(d.startRect.w + dx, minW, 1 - d.startRect.x),
        h: clamp(d.startRect.h + dy, minH, 1 - d.startRect.y),
      });
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  // Build the clip-path that the live cam layer is rendered through.
  // All units percentages of the pane so it scales with the layout.
  const clipPath = useMemo(() => {
    const xPct = rect.x * 100;
    const yPct = rect.y * 100;
    const wPct = rect.w * 100;
    const hPct = rect.h * 100;
    const rightPct = 100 - xPct - wPct;
    const bottomPct = 100 - yPct - hPct;

    if (shape === 'rect') {
      return `inset(${yPct}% ${rightPct}% ${bottomPct}% ${xPct}%)`;
    }
    if (shape === 'oval') {
      const cx = xPct + wPct / 2;
      const cy = yPct + hPct / 2;
      return `ellipse(${wPct / 2}% ${hPct / 2}% at ${cx}% ${cy}%)`;
    }
    // 'figure' — a rough person silhouette: round head on top of a
    // tapered torso. Built as a polygon whose points are interpolated
    // across the rect so resizing scales the figure.
    // Coordinates are fraction-of-rect (0..1) in (col, row) form.
    const figure: Array<[number, number]> = [
      [0.50, 0.00], // top of head
      [0.62, 0.04],
      [0.68, 0.12],
      [0.66, 0.20], // jaw
      [0.78, 0.24], // shoulder R
      [0.86, 0.36],
      [0.84, 0.52],
      [0.74, 0.50], // arm R
      [0.70, 0.62],
      [0.74, 0.86],
      [0.68, 1.00], // foot R
      [0.54, 1.00],
      [0.52, 0.78],
      [0.48, 0.78],
      [0.46, 1.00],
      [0.32, 1.00], // foot L
      [0.26, 0.86],
      [0.30, 0.62],
      [0.26, 0.50], // arm L
      [0.16, 0.52],
      [0.14, 0.36],
      [0.22, 0.24], // shoulder L
      [0.34, 0.20], // jaw
      [0.32, 0.12],
      [0.38, 0.04],
    ];
    const pts = figure.map(([fx, fy]) => {
      const px = (xPct + fx * wPct).toFixed(2);
      const py = (yPct + fy * hPct).toFixed(2);
      return `${px}% ${py}%`;
    }).join(', ');
    return `polygon(${pts})`;
  }, [rect, shape]);

  return (
    <div
      ref={paneRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'relative', width: '100%', height: '100%',
        userSelect: 'none', touchAction: 'none',
      }}
    >
      {/* Base: the 1940 photo */}
      <img src={pair.photo_url} alt={`WPA photo BIN ${pair.bin}`} style={imgStyle} draggable={false} />

      {/* Live cam layer, clipped to the portal shape. Cover so the live
          frame fills the pane and the visible slice is real geography,
          not letterboxed. */}
      <div style={{
        position: 'absolute', inset: 0,
        clipPath, WebkitClipPath: clipPath,
        pointerEvents: 'none',
        // soft drop-shadow so the cutout feels grounded in the photo
        filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.55))',
      }}>
        <img
          src={CAM_IMG(pair.cam.id, tick)}
          alt={`live cam ${pair.cam.name}`}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          draggable={false}
        />
      </div>

      {/* Move-handle: invisible rect over the portal area for dragging the
          whole portal. Sits above the clipped layer; not over the resize
          handle. */}
      <div
        onPointerDown={onPointerDown('move')}
        style={{
          position: 'absolute',
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
          cursor: 'grab',
          // dashed yellow outline so the user can see what they're grabbing
          outline: '2px dashed rgba(255,214,0,0.55)',
          outlineOffset: -2,
        }}
      />

      {/* Resize handle: bottom-right corner of the portal. */}
      <div
        onPointerDown={onPointerDown('resize')}
        style={{
          position: 'absolute',
          left: `calc(${(rect.x + rect.w) * 100}% - 14px)`,
          top: `calc(${(rect.y + rect.h) * 100}% - 14px)`,
          width: 18, height: 18,
          background: '#FFD600',
          border: '2px solid #0a0a14',
          borderRadius: 2,
          cursor: 'nwse-resize',
          boxShadow: '0 1px 4px rgba(0,0,0,0.7)',
        }}
      />

      {/* Shape picker, bottom-left of the pane */}
      <div style={{
        position: 'absolute', left: 14, bottom: 12,
        display: 'flex', gap: 4,
        background: 'rgba(8,5,2,0.78)',
        border: '1px solid #FFD60055',
        borderRadius: 4,
        padding: 3,
      }}>
        <ShapeBtn active={shape === 'rect'} onClick={() => setShape('rect')}>RECT</ShapeBtn>
        <ShapeBtn active={shape === 'oval'} onClick={() => setShape('oval')}>OVAL</ShapeBtn>
        <ShapeBtn active={shape === 'figure'} onClick={() => setShape('figure')}>FIGURE</ShapeBtn>
      </div>

      {/* Hint */}
      <div style={{
        position: 'absolute', right: 14, bottom: 12,
        background: 'rgba(8,5,2,0.78)',
        border: '1px solid #FFD60033',
        borderRadius: 4,
        padding: '4px 8px',
        fontFamily: 'ui-monospace, monospace', fontSize: 10, color: '#cdbfa6',
        letterSpacing: 1,
      }}>
        drag the dashed box · grab the yellow corner to resize
      </div>
    </div>
  );
}

function ShapeBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? '#FFD600' : 'transparent',
        color: active ? '#000' : '#f6e9d6',
        border: '1px solid #FFD60055',
        borderRadius: 2,
        padding: '3px 8px',
        fontFamily: 'Bungee, Impact, sans-serif',
        fontSize: 10, letterSpacing: 1.4,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function Pane({ label, cornerColor, children }: {
  label: string;
  cornerColor: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      flex: 1, position: 'relative', minHeight: 0,
      background: '#0a0a14',
      border: `1px solid ${cornerColor}55`,
      borderRadius: 6,
      overflow: 'hidden',
    }}>
      {children}
      {/* Scanline overlay — VHS tape feel */}
      <div aria-hidden style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.06) 0 1px, transparent 1px 3px)',
        mixBlendMode: 'multiply',
      }} />
      {/* Corner label */}
      <div style={{
        position: 'absolute', left: 10, top: 10,
        background: 'rgba(8,5,2,0.78)',
        border: `1px solid ${cornerColor}`,
        color: cornerColor,
        padding: '4px 8px',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 11, letterSpacing: 1.4,
        textTransform: 'uppercase',
        borderRadius: 3,
      }}>
        {label}
      </div>
    </div>
  );
}

function Header({ idx, total, pair, paused, layout, onPrev, onNext, onTogglePause, onLayout }: {
  idx: number;
  total: number;
  pair: RewindPair;
  paused: boolean;
  layout: Layout;
  onPrev: () => void;
  onNext: () => void;
  onTogglePause: () => void;
  onLayout: (l: Layout) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 16px',
      background: 'linear-gradient(180deg,#1a141a 0%,#0a0a14 100%)',
      borderBottom: '1px solid #2a2024',
      fontFamily: 'ui-monospace, monospace', color: '#f6e9d6',
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{
          fontFamily: 'Bungee, Impact, sans-serif',
          fontSize: 22, color: '#FFD600', letterSpacing: 2,
        }}>REWIND</span>
        <span style={{ color: '#8a7a6a', fontSize: 12 }}>◀◀ tape · 1940 ↔ now</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 4 }}>
        <Btn onClick={onPrev} title="Previous pair">◀</Btn>
        <Btn onClick={onTogglePause} title={paused ? 'Resume auto-advance' : 'Pause auto-advance'} active={paused}>
          {paused ? '▶' : '❚❚'}
        </Btn>
        <Btn onClick={onNext} title="Next pair">▶</Btn>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <Btn onClick={() => onLayout('side-by-side')} active={layout === 'side-by-side'}>SIDE</Btn>
        <Btn onClick={() => onLayout('stacked')} active={layout === 'stacked'}>STACK</Btn>
        <Btn onClick={() => onLayout('overlay')} active={layout === 'overlay'}>GHOST</Btn>
        <Btn onClick={() => onLayout('portal')} active={layout === 'portal'}>PORTAL</Btn>
        <Btn onClick={() => onLayout('mash')} active={layout === 'mash'}>MASH</Btn>
      </div>
      <div style={{ color: '#8a7a6a', fontSize: 11, minWidth: 80, textAlign: 'right' }}>
        {idx + 1} / {total} · {pair.distance_m.toFixed(0)}m apart
      </div>
      <a href="/" style={{
        background: 'rgba(20,15,10,0.78)', padding: '6px 12px', borderRadius: 6,
        color: '#f6e9d6', fontSize: 12, textDecoration: 'none',
      }}>← back</a>
    </div>
  );
}

function Footer({ pair }: { pair: RewindPair }) {
  const v = pair.validation;
  return (
    <div style={{
      padding: '8px 16px',
      background: '#0a0a14',
      borderTop: '1px solid #2a2024',
      fontFamily: 'ui-monospace, monospace', fontSize: 11,
      color: '#8a7a6a', display: 'flex', gap: 16, flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      <span>BBL {pair.boro}-{pair.block}-{pair.lot} · BIN {pair.bin}</span>
      <span>cam {pair.cam.id.slice(0, 8)} · {pair.cam.borough}</span>
      <span>{pair.centroid[1].toFixed(5)}, {pair.centroid[0].toFixed(5)}</span>
      {v && (
        <span
          title={v.what_we_see}
          style={{
            padding: '2px 8px',
            border: `1px solid ${v.confidence > 0.8 ? '#9ad48f' : v.confidence > 0.5 ? '#d4c98f' : '#d49a8f'}55`,
            color: v.confidence > 0.8 ? '#9ad48f' : v.confidence > 0.5 ? '#d4c98f' : '#d49a8f',
            borderRadius: 3,
          }}
        >
          ✓ {v.scene_kind.replace(/_/g, ' ')}
          {v.has_pedestrians ? ' · 👤' : ''}
          {v.has_vehicles ? ' · 🚗' : ''}
          {' · '}llava {Math.round(v.confidence * 100)}%
        </span>
      )}
      {pair.similarity !== undefined && (
        <span
          title={`CLIP cosine similarity between this WPA photo and the live cam frame`}
          style={{
            padding: '2px 8px',
            border: `1px solid ${pair.similarity > 0.5 ? '#9ad48f' : pair.similarity > 0.4 ? '#d4c98f' : '#d49a8f'}55`,
            color: pair.similarity > 0.5 ? '#9ad48f' : pair.similarity > 0.4 ? '#d4c98f' : '#d49a8f',
            borderRadius: 3,
          }}
        >
          CLIP {Math.round(pair.similarity * 100)}%
        </span>
      )}
      <a href={`/world1940`} style={{ color: '#FFD600', textDecoration: 'none', marginLeft: 'auto' }}>
        walk this block in 1940 →
      </a>
    </div>
  );
}

function Btn({ onClick, active, title, children }: {
  onClick: () => void;
  active?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        background: active ? '#FFD600' : 'transparent',
        color: active ? '#000' : '#f6e9d6',
        border: '1px solid #FFD60055',
        borderRadius: 3,
        padding: '4px 10px',
        fontFamily: 'Bungee, Impact, sans-serif',
        fontSize: 11, letterSpacing: 1.4,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: '#0a0a14', color: '#f6e9d6',
    }}>
      {children}
    </div>
  );
}
