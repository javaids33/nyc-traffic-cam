/* /rewind — past ↔ present mashup at the deli.

   For every WPA tax photo we have, we precomputed the closest live
   NYC DOT traffic cam (server/rewind_pairs.py → public/rewind-pairs-1940s.json).
   This page surfs through those pairs cassette-style: a 1940 still next
   to a refreshing live frame, with a VHS-tape transport.

   Phase 1 (here): side-by-side display, auto-advance, manual prev/next,
   click to swap layout.
   Phase 2 (later): segment people + cars from the live frame and
   composite onto the 1940 photo so 2026 commuters walk through the
   1940 sidewalk.
*/
import { useEffect, useRef, useState } from 'react';

interface CamRef {
  id: string;
  name: string;
  lat: number;
  lng: number;
  borough: string;
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
}
interface PairsFile {
  version: number;
  generated_at: number;
  count: number;
  pairs: RewindPair[];
}

const PAIRS_URL = '/rewind-pairs-1940s.json';
const CAM_IMG = (id: string, t: number) =>
  `https://webcams.nyctmc.org/api/cameras/${id}/image?t=${t}`;
const AUTO_ADVANCE_MS = 9000;
const CAM_REFRESH_MS = 4000;

type Layout = 'side-by-side' | 'stacked' | 'overlay';

export default function Rewind() {
  const [pairs, setPairs] = useState<RewindPair[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [layout, setLayout] = useState<Layout>('side-by-side');
  const [paused, setPaused] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [tick, setTick] = useState(() => Date.now());

  // Load pairs once.
  useEffect(() => {
    let cancelled = false;
    fetch(PAIRS_URL)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((data: PairsFile) => {
        if (cancelled) return;
        // Tighter slice: only the closest 80 — the long tail of 800m
        // matches isn't really "this corner then vs now", it's "same
        // neighborhood-ish".
        const close = data.pairs.slice().sort((a, b) => a.distance_m - b.distance_m).slice(0, 80);
        setPairs(close);
      })
      .catch(e => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, []);

  // Auto-advance.
  useEffect(() => {
    if (paused || !pairs || pairs.length < 2) return;
    const id = window.setInterval(() => {
      setIdx(i => (i + 1) % pairs.length);
    }, AUTO_ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [paused, pairs]);

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
  return (
    <div style={{
      padding: '8px 16px',
      background: '#0a0a14',
      borderTop: '1px solid #2a2024',
      fontFamily: 'ui-monospace, monospace', fontSize: 11,
      color: '#8a7a6a', display: 'flex', gap: 16, flexWrap: 'wrap',
    }}>
      <span>BBL {pair.boro}-{pair.block}-{pair.lot} · BIN {pair.bin}</span>
      <span>cam {pair.cam.id.slice(0, 8)} · {pair.cam.borough}</span>
      <span>{pair.centroid[1].toFixed(5)}, {pair.centroid[0].toFixed(5)}</span>
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
