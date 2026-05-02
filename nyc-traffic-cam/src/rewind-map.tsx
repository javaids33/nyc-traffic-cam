/* /rewind-map — visual map of every cam + every WPA photo with the
   CLIP-matched links between them. Lets you SEE what's connected to
   what.

   Marker types:
     • Green circle  — usable cam with at least 1 CLIP visual match
     • Yellow circle — usable cam with no visual matches yet
     • Red circle    — highway / unusable / unverified cam
     • Blue dot      — WPA tax photo (footprint centroid)

   Lines: yellow strokes between each cam and its top-3 CLIP matches.
   Click a cam → details panel + lines for that cam highlight.
   Toggle filters in the legend. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MapLibre,
  Source,
  Layer,
  type MapRef,
  type MapMouseEvent,
} from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const MAP_DATA_URL = '/cam-map-data.json';

interface CamPoint {
  id: string;
  name: string;
  lat: number;
  lng: number;
  borough: string;
  usable: boolean | null;
  scene_kind: string;
  confidence: number | null;
  has_pedestrians: boolean | null;
  has_vehicles: boolean | null;
  what_we_see: string;
  match_count: number;
  best_similarity: number | null;
  best_bin: string | null;
}
interface WpaPoint {
  bin: string;
  lat: number;
  lng: number;
  boro: number;
  block: number;
  lot: number;
  has_photo: boolean;
  matched_by: string[];
}
interface Link {
  cam_id: string;
  bin: string;
  similarity: number | null;
  rank: number;
  distance_m: number | null;
}
interface MapData {
  cams: CamPoint[];
  wpa: WpaPoint[];
  links: Link[];
  summary: {
    cams: number; wpa: number; links: number;
    cams_with_matches: number; validated_usable: number;
    scene_kinds: Record<string, number>;
  };
}

const CARTO_STYLE: StyleSpecification = {
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
      paint: { 'raster-saturation': -0.1, 'raster-contrast': 0.05 },
    },
  ],
};

const NYC_CENTER: [number, number] = [-73.95, 40.73];

type Filters = {
  showUsable: boolean;
  showUnusable: boolean;
  showWpa: boolean;
  showLinks: boolean;
};

export default function RewindMap() {
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedCam, setSelectedCam] = useState<CamPoint | null>(null);
  const [hoveredCam, setHoveredCam] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    showUsable: true,
    showUnusable: false,
    showWpa: true,
    showLinks: true,
  });
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(MAP_DATA_URL)
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then((d: MapData) => setData(d))
      .catch(e => setError(String(e)));
  }, []);

  // Maplibre needs an explicit resize() + triggerRepaint() any time its
  // parent dimensions change — without these the canvas exists but the
  // tile loader never wakes up. Same kicks geoguessr.tsx uses.
  useEffect(() => {
    const fire = () => {
      const m = mapRef.current?.getMap?.();
      try { m?.resize(); m?.triggerRepaint(); } catch { /* noop */ }
    };
    const ids = [80, 240, 600, 1400].map(d => window.setTimeout(fire, d));
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

  // Pre-build maps for fast lookup.
  const camById = useMemo(() => {
    const m = new Map<string, CamPoint>();
    data?.cams.forEach(c => m.set(c.id, c));
    return m;
  }, [data]);
  const wpaByBin = useMemo(() => {
    const m = new Map<string, WpaPoint>();
    data?.wpa.forEach(w => m.set(w.bin, w));
    return m;
  }, [data]);

  // GeoJSON for the cam markers — color-coded.
  const camFeatures = useMemo(() => {
    if (!data) return [];
    return data.cams
      .filter(c => {
        const isUsable = c.usable === true && (c.confidence ?? 0) >= 0.5;
        if (isUsable && !filters.showUsable) return false;
        if (!isUsable && !filters.showUnusable) return false;
        return true;
      })
      .map(c => {
        const isUsable = c.usable === true && (c.confidence ?? 0) >= 0.5;
        const hasMatch = c.match_count > 0;
        let color = '#e34c4c';   // red — unusable / highway
        let radius = 4;
        if (isUsable) {
          color = hasMatch ? '#2dd163' : '#FFD600';
          radius = hasMatch ? 7 : 5;
        }
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [c.lng, c.lat] },
          properties: {
            id: c.id, name: c.name, color, radius,
            scene_kind: c.scene_kind,
            match_count: c.match_count,
            best_similarity: c.best_similarity ?? 0,
            isHovered: hoveredCam === c.id || selectedCam?.id === c.id,
          },
        };
      });
  }, [data, filters, hoveredCam, selectedCam]);

  // GeoJSON for WPA markers.
  const wpaFeatures = useMemo(() => {
    if (!data || !filters.showWpa) return [];
    return data.wpa.map(w => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [w.lng, w.lat] },
      properties: {
        bin: w.bin,
        block: w.block, lot: w.lot,
        matched: w.matched_by.length > 0,
      },
    }));
  }, [data, filters]);

  // GeoJSON for the CLIP links — lines from cam → bin.
  const linkFeatures = useMemo(() => {
    if (!data || !filters.showLinks) return [];
    return data.links
      .map(l => {
        const cam = camById.get(l.cam_id);
        const wpa = wpaByBin.get(l.bin);
        if (!cam || !wpa) return null;
        const highlight = !!(selectedCam && selectedCam.id === l.cam_id) || hoveredCam === l.cam_id;
        return {
          type: 'Feature' as const,
          geometry: {
            type: 'LineString' as const,
            coordinates: [[cam.lng, cam.lat], [wpa.lng, wpa.lat]],
          },
          properties: {
            similarity: l.similarity ?? 0,
            rank: l.rank,
            highlight,
          },
        };
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);
  }, [data, filters, camById, wpaByBin, hoveredCam, selectedCam]);

  const camGeoJson = useMemo(() => ({
    type: 'FeatureCollection' as const, features: camFeatures,
  }), [camFeatures]);
  const wpaGeoJson = useMemo(() => ({
    type: 'FeatureCollection' as const, features: wpaFeatures,
  }), [wpaFeatures]);
  const linkGeoJson = useMemo(() => ({
    type: 'FeatureCollection' as const, features: linkFeatures,
  }), [linkFeatures]);

  const onMapClick = (e: MapMouseEvent & { features?: any[] }) => {
    const f = (e as any).features?.[0];
    if (!f) {
      setSelectedCam(null);
      return;
    }
    if (f.layer.id === 'cams') {
      const cam = camById.get(f.properties.id);
      if (cam) setSelectedCam(cam);
    }
  };

  const onMapMouseMove = (e: MapMouseEvent & { features?: any[] }) => {
    const f = (e as any).features?.[0];
    if (f && f.layer.id === 'cams') {
      setHoveredCam(f.properties.id);
    } else if (hoveredCam) {
      setHoveredCam(null);
    }
  };

  if (error) {
    return <Shell><div style={{ color: '#fa6', padding: 24 }}>Failed to load: {error}</div></Shell>;
  }
  if (!data) {
    return <Shell><div style={{ color: '#bba', padding: 24 }}>Loading map…</div></Shell>;
  }

  return (
    <Shell>
      <Header summary={data.summary} />

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div ref={containerRef} style={{ flex: 1, position: 'relative' }}>
          <MapLibre
            ref={mapRef}
            mapStyle={CARTO_STYLE}
            initialViewState={{ longitude: NYC_CENTER[0], latitude: NYC_CENTER[1], zoom: 11 }}
            interactiveLayerIds={['cams']}
            onClick={onMapClick as any}
            onMouseMove={onMapMouseMove as any}
            onLoad={() => {
              const m = mapRef.current?.getMap?.();
              try { m?.resize(); m?.triggerRepaint(); } catch { /* noop */ }
            }}
            cursor={hoveredCam ? 'pointer' : 'grab'}
            style={{ position: 'absolute', inset: 0 }}
          >
            {filters.showLinks && (
              <Source id="links-src" type="geojson" data={linkGeoJson as any}>
                <Layer
                  id="links"
                  type="line"
                  paint={{
                    'line-color': '#FFD600',
                    'line-width': [
                      'case',
                      ['boolean', ['get', 'highlight'], false], 3,
                      1.2,
                    ],
                    'line-opacity': [
                      'case',
                      ['boolean', ['get', 'highlight'], false], 0.95,
                      ['interpolate', ['linear'], ['get', 'similarity'], 0.3, 0.18, 0.7, 0.55],
                    ],
                  }}
                />
              </Source>
            )}

            {filters.showWpa && (
              <Source id="wpa-src" type="geojson" data={wpaGeoJson as any}>
                <Layer
                  id="wpa"
                  type="circle"
                  paint={{
                    'circle-radius': [
                      'case',
                      ['boolean', ['get', 'matched'], false], 4,
                      2.5,
                    ],
                    'circle-color': [
                      'case',
                      ['boolean', ['get', 'matched'], false], '#3b82f6',
                      '#7da6e0',
                    ],
                    'circle-opacity': 0.85,
                    'circle-stroke-color': '#0a0a14',
                    'circle-stroke-width': 0.5,
                  }}
                />
              </Source>
            )}

            <Source id="cams-src" type="geojson" data={camGeoJson as any}>
              <Layer
                id="cams"
                type="circle"
                paint={{
                  'circle-radius': [
                    'case',
                    ['boolean', ['get', 'isHovered'], false],
                    ['+', ['get', 'radius'], 3],
                    ['get', 'radius'],
                  ],
                  'circle-color': ['get', 'color'],
                  'circle-opacity': 0.9,
                  'circle-stroke-color': '#0a0a14',
                  'circle-stroke-width': 1.5,
                }}
              />
            </Source>
          </MapLibre>

          <Legend filters={filters} setFilters={setFilters} summary={data.summary} />
        </div>

        <Sidebar
          selectedCam={selectedCam}
          links={data.links}
          wpaByBin={wpaByBin}
          onClear={() => setSelectedCam(null)}
        />
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
      background: '#0a0a14', color: '#f6e9d6',
    }}>{children}</div>
  );
}

function Header({ summary }: { summary: MapData['summary'] }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '12px 16px',
      background: 'linear-gradient(180deg,#1a141a 0%,#0a0a14 100%)',
      borderBottom: '1px solid #2a2024',
      fontFamily: 'ui-monospace, monospace', color: '#f6e9d6',
    }}>
      <span style={{
        fontFamily: 'Bungee, Impact, sans-serif',
        fontSize: 22, color: '#FFD600', letterSpacing: 2,
      }}>REWIND · MAP</span>
      <span style={{ color: '#8a7a6a', fontSize: 12 }}>
        {summary.cams} cams · {summary.validated_usable} usable ·{' '}
        {summary.cams_with_matches} CLIP-matched · {summary.wpa} WPA · {summary.links} links
      </span>
      <div style={{ flex: 1 }} />
      <a href="/rewind" style={{
        background: 'rgba(20,15,10,0.78)', padding: '6px 12px', borderRadius: 6,
        color: '#FFD600', fontSize: 12, textDecoration: 'none',
      }}>◀◀ rewind</a>
      <a href="/" style={{
        background: 'rgba(20,15,10,0.78)', padding: '6px 12px', borderRadius: 6,
        color: '#f6e9d6', fontSize: 12, textDecoration: 'none',
      }}>← back</a>
    </div>
  );
}

function Legend({ filters, setFilters, summary }: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  summary: MapData['summary'];
}) {
  return (
    <div style={{
      position: 'absolute', top: 12, left: 12,
      background: 'rgba(10,10,18,0.92)', backdropFilter: 'blur(6px)',
      padding: '10px 12px', borderRadius: 6,
      fontFamily: 'ui-monospace, monospace', fontSize: 11,
      color: '#f6e9d6', minWidth: 220,
      border: '1px solid #2a2024',
    }}>
      <div style={{ marginBottom: 8, color: '#FFD600', letterSpacing: 1.4, textTransform: 'uppercase' }}>
        Legend / Filters
      </div>
      <FilterRow
        checked={filters.showUsable}
        onChange={v => setFilters({ ...filters, showUsable: v })}
        color="#2dd163"
        label={`usable cams (${summary.validated_usable})`}
      />
      <FilterRow
        checked={filters.showUnusable}
        onChange={v => setFilters({ ...filters, showUnusable: v })}
        color="#e34c4c"
        label={`unusable / unverified (${summary.cams - summary.validated_usable})`}
      />
      <FilterRow
        checked={filters.showWpa}
        onChange={v => setFilters({ ...filters, showWpa: v })}
        color="#3b82f6"
        label={`WPA photos (${summary.wpa})`}
      />
      <FilterRow
        checked={filters.showLinks}
        onChange={v => setFilters({ ...filters, showLinks: v })}
        color="#FFD600"
        label={`CLIP links (${summary.links})`}
      />
      <div style={{ marginTop: 8, color: '#8a7a6a', fontSize: 10, lineHeight: 1.4 }}>
        Click a cam to inspect its matches. Larger green dots = cams with at least one CLIP match.
      </div>
    </div>
  );
}

function FilterRow({ checked, onChange, color, label }: {
  checked: boolean; onChange: (v: boolean) => void; color: string; label: string;
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 0', cursor: 'pointer',
    }}>
      <input
        type="checkbox" checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ accentColor: color }}
      />
      <span style={{
        width: 12, height: 12, borderRadius: '50%',
        background: color, border: '1px solid #0a0a14',
      }} />
      <span>{label}</span>
    </label>
  );
}

function Sidebar({ selectedCam, links, wpaByBin, onClear }: {
  selectedCam: CamPoint | null;
  links: Link[];
  wpaByBin: Map<string, WpaPoint>;
  onClear: () => void;
}) {
  const camLinks = useMemo(() => {
    if (!selectedCam) return [];
    return links
      .filter(l => l.cam_id === selectedCam.id)
      .sort((a, b) => a.rank - b.rank);
  }, [selectedCam, links]);

  if (!selectedCam) {
    return (
      <div style={{
        width: 320, padding: 16, background: '#0e0e1a',
        borderLeft: '1px solid #2a2024',
        fontFamily: 'ui-monospace, monospace', color: '#cdbfa6', fontSize: 12,
        overflow: 'auto',
      }}>
        <div style={{ color: '#8a7a6a' }}>
          Click a cam on the map to inspect it.
        </div>
        <div style={{ marginTop: 12, lineHeight: 1.6 }}>
          <strong style={{ color: '#FFD600' }}>Color key</strong><br/>
          🟢 usable + has CLIP visual match<br/>
          🟡 usable, no match yet (no nearby WPA)<br/>
          🔴 highway / unverified / unusable<br/>
          🔵 WPA tax photo (1940 building)<br/>
        </div>
      </div>
    );
  }

  return (
    <div style={{
      width: 320, padding: 16, background: '#0e0e1a',
      borderLeft: '1px solid #2a2024',
      fontFamily: 'ui-monospace, monospace', color: '#f6e9d6', fontSize: 12,
      overflow: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong style={{ color: '#FFD600' }}>{selectedCam.name}</strong>
        <button onClick={onClear} style={{
          background: 'none', border: 'none', color: '#8a7a6a', cursor: 'pointer',
        }}>×</button>
      </div>
      <div style={{ color: '#8a7a6a', marginBottom: 10 }}>
        {selectedCam.borough} · {selectedCam.lat.toFixed(5)}, {selectedCam.lng.toFixed(5)}
      </div>
      {selectedCam.usable !== null && (
        <div style={{
          marginBottom: 10, padding: '6px 8px',
          border: `1px solid ${selectedCam.usable ? '#9ad48f' : '#d49a8f'}55`,
          color: selectedCam.usable ? '#9ad48f' : '#d49a8f',
          borderRadius: 3,
        }}>
          <strong>llava verdict:</strong> {selectedCam.usable ? 'usable' : 'unusable'}
          {selectedCam.confidence !== null && ` · conf ${Math.round(selectedCam.confidence * 100)}%`}
          <br/>
          scene_kind: {selectedCam.scene_kind}
          {selectedCam.has_pedestrians ? ' · 👤' : ''}
          {selectedCam.has_vehicles ? ' · 🚗' : ''}
          {selectedCam.what_we_see && (
            <div style={{ color: '#cdbfa6', marginTop: 4, fontSize: 11 }}>
              "{selectedCam.what_we_see}"
            </div>
          )}
        </div>
      )}
      <img
        src={`https://webcams.nyctmc.org/api/cameras/${selectedCam.id}/image?t=${Date.now()}`}
        alt="cam preview"
        style={{ width: '100%', borderRadius: 4, marginBottom: 10 }}
      />
      <div style={{ marginBottom: 6, color: '#FFD600', textTransform: 'uppercase', letterSpacing: 1 }}>
        CLIP visual matches ({camLinks.length})
      </div>
      {camLinks.length === 0 && (
        <div style={{ color: '#8a7a6a', fontSize: 11 }}>
          No matches — either no WPA photos within 500m, or no embeddings yet.
        </div>
      )}
      {camLinks.map(l => {
        const wpa = wpaByBin.get(l.bin);
        if (!wpa) return null;
        const photoUrl = `/photos_1940s/nynyma_rec0040_${wpa.boro}_${String(wpa.block).padStart(5, '0')}_${String(wpa.lot).padStart(4, '0')}.jpg`;
        return (
          <div key={l.bin} style={{
            display: 'flex', gap: 8, marginBottom: 8,
            padding: 6, background: 'rgba(20,20,30,0.5)', borderRadius: 3,
          }}>
            <img src={photoUrl} alt="" style={{
              width: 60, height: 80, objectFit: 'cover', borderRadius: 2,
              background: '#1a1a2a',
            }} />
            <div style={{ flex: 1, fontSize: 11 }}>
              <div>rank {l.rank} · sim {((l.similarity ?? 0) * 100).toFixed(0)}%</div>
              <div style={{ color: '#8a7a6a' }}>
                BBL {wpa.boro}-{wpa.block}-{wpa.lot}
              </div>
              <div style={{ color: '#8a7a6a' }}>
                {(l.distance_m ?? 0).toFixed(0)}m away
              </div>
            </div>
          </div>
        );
      })}
      <a
        href={`/rewind`}
        style={{
          display: 'block', marginTop: 12, padding: '8px 12px',
          background: '#FFD600', color: '#000', textDecoration: 'none',
          textAlign: 'center', borderRadius: 3, fontWeight: 'bold',
        }}
      >
        view in /rewind →
      </a>
    </div>
  );
}
