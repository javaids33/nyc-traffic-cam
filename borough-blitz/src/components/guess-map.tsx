import { useEffect, useRef } from 'react';
import {
  Map as MapLibre,
  Marker,
  Source,
  Layer,
  type MapRef,
} from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { NYC_CENTER, NYC_START_ZOOM } from '../scoring';
import type { LngLat } from '../game-types';

/* CartoDB "dark matter" raster — reads like a radar / dispatch console on
 * the near-black UI, with the major streets, parks and water that a city-
 * scale guess actually relies on. A small brightness lift keeps the labels
 * legible. */
const MAP_STYLE: StyleSpecification = {
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
      attribution: '© OpenStreetMap © CARTO',
      maxzoom: 20,
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d10' } },
    {
      id: 'carto',
      type: 'raster',
      source: 'carto',
      paint: { 'raster-brightness-min': 0.06, 'raster-contrast': 0.12, 'raster-saturation': -0.1 },
    },
  ],
};

function Pin({ color, label }: { color: string; label: string }) {
  return (
    <div className="relative" style={{ transform: 'translateY(2px)' }}>
      <svg viewBox="0 0 28 38" width="26" height="36" aria-hidden>
        <path
          d="M 14 1 C 6 1 1 7 1 14 C 1 22 14 36 14 36 C 14 36 27 22 27 14 C 27 7 22 1 14 1 Z"
          fill={color}
          stroke="#070809"
          strokeWidth="1.6"
        />
        <circle cx="14" cy="14" r="4.6" fill="#070809" />
      </svg>
      <div
        className="absolute -top-1 left-full ml-1 whitespace-nowrap px-1.5 py-0.5 font-bungee text-[8px] uppercase tracking-[0.12em]"
        style={{ background: color, color: '#070809', boxShadow: '2px 2px 0 #070809' }}
      >
        {label}
      </div>
    </div>
  );
}

export function GuessMap({
  guess,
  cam,
  revealed,
  onGuess,
}: {
  guess: LngLat | null;
  cam: { lat: number; lng: number } | undefined;
  revealed: boolean;
  onGuess: (g: LngLat) => void;
}) {
  const mapRef = useRef<MapRef | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // MapLibre must be told to resize() whenever its container changes size —
  // which here happens constantly as the mini-map expands/collapses. A
  // ResizeObserver plus a few timed kicks paints the first frame reliably
  // and keeps the canvas glued to the box afterwards.
  useEffect(() => {
    const fire = () => {
      const m = mapRef.current?.getMap?.();
      try {
        m?.resize();
        m?.triggerRepaint();
      } catch {
        /* map not ready */
      }
    };
    const ids = [60, 220, 520, 1100].map((d) => window.setTimeout(fire, d));
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

  // On reveal, fly to frame the guess + the real camera together.
  useEffect(() => {
    if (!revealed || !cam || !guess || !mapRef.current) return;
    const id = window.setTimeout(() => {
      mapRef.current?.fitBounds(
        [
          [Math.min(cam.lng, guess.lng), Math.min(cam.lat, guess.lat)],
          [Math.max(cam.lng, guess.lng), Math.max(cam.lat, guess.lat)],
        ],
        { padding: 56, duration: 850, maxZoom: 15 },
      );
    }, 120);
    return () => clearTimeout(id);
  }, [revealed, cam, guess]);

  const lineGeo =
    revealed && guess && cam
      ? {
          type: 'FeatureCollection' as const,
          features: [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'LineString' as const,
                coordinates: [
                  [guess.lng, guess.lat],
                  [cam.lng, cam.lat],
                ],
              },
            },
          ],
        }
      : null;

  return (
    <div ref={containerRef} className="absolute inset-0">
      <MapLibre
        ref={mapRef}
        initialViewState={{ longitude: NYC_CENTER[0], latitude: NYC_CENTER[1], zoom: NYC_START_ZOOM }}
        mapStyle={MAP_STYLE}
        attributionControl={false}
        dragRotate={false}
        touchPitch={false}
        cursor={revealed ? 'default' : 'crosshair'}
        style={{ position: 'absolute', inset: 0 }}
        onLoad={() => {
          const m = mapRef.current?.getMap?.();
          try {
            m?.resize();
            m?.triggerRepaint();
          } catch {
            /* noop */
          }
        }}
        onClick={(e) => {
          if (revealed) return;
          onGuess({ lng: e.lngLat.lng, lat: e.lngLat.lat });
        }}
      >
        {guess && (
          <Marker longitude={guess.lng} latitude={guess.lat} anchor="bottom">
            <Pin color="#FFD400" label="you" />
          </Marker>
        )}
        {revealed && cam && (
          <Marker longitude={cam.lng} latitude={cam.lat} anchor="bottom">
            <Pin color="#FF4D2E" label="cam" />
          </Marker>
        )}
        {lineGeo && (
          <Source id="guess-line" type="geojson" data={lineGeo}>
            <Layer
              id="guess-line-layer"
              type="line"
              paint={{
                'line-color': '#ffffff',
                'line-width': 2.5,
                'line-dasharray': [2, 2],
                'line-opacity': 0.9,
              }}
            />
          </Source>
        )}
      </MapLibre>
    </div>
  );
}
