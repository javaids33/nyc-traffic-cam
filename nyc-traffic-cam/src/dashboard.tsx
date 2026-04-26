import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibre, NavigationControl, AttributionControl } from 'react-map-gl/maplibre';
import { DeckGL } from '@deck.gl/react';
import { FlyToInterpolator } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Activity, AlertTriangle, RadioTower, RefreshCw, Tv, X } from 'lucide-react';

import { fetchAlerts, fetchCameras, fetchStats, openAlertSocket } from './api';
import type { Alert, Camera, Stats } from './types';

const NYC_VIEW = { longitude: -73.97, latitude: 40.74, zoom: 10.8, pitch: 0, bearing: 0 };

const SEVERITY_COLOR: Record<number, [number, number, number]> = {
  1: [80, 200, 120],
  2: [120, 200, 80],
  3: [200, 200, 80],
  4: [240, 180, 60],
  5: [240, 150, 60],
  6: [240, 120, 60],
  7: [240, 90, 60],
  8: [240, 60, 60],
  9: [220, 40, 80],
  10: [200, 30, 110],
};

function severityColor(sev: number | null | undefined): [number, number, number, number] {
  if (!sev) return [80, 100, 130, 160];
  const c = SEVERITY_COLOR[Math.max(1, Math.min(10, sev))];
  return [c[0], c[1], c[2], 220];
}

function fmtAge(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const ALERT_LABELS: Record<string, string> = {
  sudden_change: 'Sudden change',
  static_feed: 'Frozen feed',
  camera_offline: 'Offline',
  high_activity: 'High activity',
};

export default function Dashboard() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<Camera | null>(null);
  const [lofiMode, setLofiMode] = useState(false);
  const [lofiFocus, setLofiFocus] = useState<Alert | null>(null);
  const lofiModeRef = useRef(lofiMode);
  useEffect(() => {
    lofiModeRef.current = lofiMode;
  }, [lofiMode]);
  const viewRef = useRef(NYC_VIEW);
  const [viewState, setViewState] = useState<typeof NYC_VIEW & {
    transitionDuration?: number;
    transitionInterpolator?: FlyToInterpolator;
  }>(NYC_VIEW);

  const flyTo = useCallback((lng: number, lat: number, zoom = 15.5) => {
    const next = {
      longitude: lng,
      latitude: lat,
      zoom,
      pitch: 35,
      bearing: 0,
      transitionDuration: 2200,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.5, curve: 1.4 }),
    };
    viewRef.current = { longitude: lng, latitude: lat, zoom, pitch: 35, bearing: 0 };
    setViewState(next);
  }, []);

  // Initial loads.
  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
    fetchAlerts({ sinceSeconds: 6 * 3600, activeOnly: false }).then(setAlerts).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
  }, []);

  // Periodic stats + camera-status refresh.
  useEffect(() => {
    const tick = () => {
      fetchStats().then(setStats).catch(() => {});
      fetchCameras().then(setCameras).catch(() => {});
    };
    const i = setInterval(tick, 5000);
    return () => clearInterval(i);
  }, []);

  // Live alert stream.
  useEffect(() => {
    const close = openAlertSocket((evt) => {
      if (evt.type === 'alert_opened' || evt.type === 'alert_updated') {
        setAlerts((prev) => {
          const idx = prev.findIndex((a) => a.id === evt.id);
          const merged: Alert = {
            id: evt.id,
            camera_id: evt.camera_id,
            camera_name: evt.camera_name,
            lat: evt.lat,
            lng: evt.lng,
            kind: evt.kind,
            severity: evt.severity,
            message: evt.message,
            details: null,
            thumbnail_b64: idx >= 0 ? prev[idx].thumbnail_b64 : null,
            has_image: evt.has_image ?? (idx >= 0 ? prev[idx].has_image : false),
            created_at: idx >= 0 ? prev[idx].created_at : evt.created_at ?? evt.updated_at,
            updated_at: evt.updated_at,
            resolved_at: null,
            occurrence_count: evt.occurrence_count,
          };
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = merged;
            return next;
          }
          // Lo-fi mode: only NEW alerts (not updates) trigger a channel flip.
          if (evt.type === 'alert_opened' && lofiModeRef.current) {
            setLofiFocus(merged);
            flyTo(evt.lng, evt.lat, 16);
          }
          return [merged, ...prev].slice(0, 500);
        });
      } else if (evt.type === 'alert_resolved') {
        setAlerts((prev) =>
          prev.map((a) => (a.id === evt.alert_id ? { ...a, resolved_at: Math.floor(Date.now() / 1000) } : a)),
        );
      }
    });
    return close;
  }, []);

  const activeAlerts = useMemo(() => alerts.filter((a) => !a.resolved_at), [alerts]);

  const camerasLayer = useMemo(
    () =>
      new ScatterplotLayer<Camera>({
        id: 'cameras',
        data: cameras,
        getPosition: (d) => [d.lng, d.lat],
        getFillColor: (d) => severityColor(d.active_severity),
        getRadius: (d) => (d.active_severity ? 60 + d.active_severity * 18 : 30),
        radiusMinPixels: 3,
        radiusMaxPixels: 18,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 200],
        opacity: 0.85,
        onClick: (info) => {
          if (info.object) {
            const cam = info.object as Camera;
            setSelectedCamera(cam);
            flyTo(cam.lng, cam.lat, 14);
          }
        },
        updateTriggers: { getFillColor: cameras, getRadius: cameras },
      }),
    [cameras],
  );

  const heatLayer = useMemo(
    () =>
      new HeatmapLayer<Alert>({
        id: 'severity-heat',
        data: activeAlerts,
        getPosition: (d) => [d.lng, d.lat],
        getWeight: (d) => d.severity,
        radiusPixels: 60,
        intensity: 1.4,
        threshold: 0.04,
      }),
    [activeAlerts],
  );

  const onCamHover = useCallback(() => {}, []);

  const handleAlertClick = (alert: Alert) => {
    setSelectedAlert(alert);
    flyTo(alert.lng, alert.lat, 14);
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-950 text-white overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <RadioTower className="w-6 h-6 text-blue-400" />
          <div>
            <h1 className="text-base font-semibold tracking-tight">NYC Traffic Cam Monitor</h1>
            <p className="text-[11px] text-gray-400">
              Anomaly detection across all online cameras
            </p>
          </div>
        </div>
        <div className="flex items-center gap-6 text-xs">
          <Stat label="Cameras" value={`${stats?.cameras_polled ?? 0} / ${stats?.cameras_online ?? cameras.length}`} />
          <Stat label="Polls" value={stats?.metrics.polls_total ?? 0} />
          <Stat label="Failed" value={stats?.metrics.polls_failed ?? 0} tone={stats?.metrics.polls_failed ? 'warn' : undefined} />
          <Stat label="Active alerts" value={activeAlerts.length} tone={activeAlerts.length ? 'warn' : undefined} />
          <Stat label="Last tick" value={fmtAge(stats?.metrics.last_tick_at)} />
          <button
            onClick={() => {
              setLofiMode((v) => {
                const next = !v;
                if (next) {
                  // When flipping ON, focus the most recent active alert immediately.
                  const seed = activeAlerts[0] ?? alerts[0] ?? null;
                  if (seed) {
                    setLofiFocus(seed);
                    flyTo(seed.lng, seed.lat, 16);
                  }
                } else {
                  setLofiFocus(null);
                }
                return next;
              });
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-semibold border transition-colors ${
              lofiMode
                ? 'bg-fuchsia-600/30 border-fuchsia-400 text-fuchsia-200 shadow-[0_0_12px_rgba(217,70,239,0.5)]'
                : 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
            }`}
            title="Auto-flip the map to each new alert as it fires"
          >
            <Tv className="w-3.5 h-3.5" />
            LO-FI {lofiMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </header>

      <div className="flex-1 relative">
        <DeckGL
          viewState={viewState}
          controller
          layers={[heatLayer, camerasLayer]}
          onViewStateChange={(p) => {
            viewRef.current = p.viewState as typeof NYC_VIEW;
            setViewState(p.viewState as typeof NYC_VIEW);
          }}
          onClick={onCamHover}
          getTooltip={({ object }) => {
            if (!object) return null;
            const cam = object as Camera;
            return {
              text:
                `${cam.name ?? cam.id}\n` +
                `severity: ${cam.active_severity ?? '—'}\n` +
                `last poll: ${fmtAge(cam.last_polled_at)}\n` +
                `last diff: ${cam.last_diff?.toFixed(2) ?? '—'}`,
            };
          }}
        >
          <MapLibre
            mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
            attributionControl={false}
          >
            <NavigationControl position="bottom-right" />
            <AttributionControl compact position="bottom-left" />
          </MapLibre>
        </DeckGL>

        <div className="absolute left-3 bottom-3 bg-gray-900/90 backdrop-blur rounded-lg p-3 text-xs">
          <div className="font-semibold mb-2 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Severity
          </div>
          <div className="flex items-center gap-2">
            {[1, 3, 5, 7, 9, 10].map((s) => (
              <div key={s} className="flex flex-col items-center gap-1">
                <div
                  className="w-5 h-5 rounded-full"
                  style={{ background: `rgb(${SEVERITY_COLOR[s].join(',')})` }}
                />
                <span className="text-[10px] text-gray-400">{s}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-gray-800 text-[10px] text-gray-500">
            Click any camera dot to view live feed
          </div>
        </div>
      </div>

      <aside className="absolute right-0 top-12 bottom-0 w-[360px] bg-gray-900/95 backdrop-blur border-l border-gray-800 overflow-y-auto" data-testid="alerts-panel">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <h2 className="text-sm font-semibold">Live alerts</h2>
            <span className="text-xs text-gray-400" data-testid="alert-count">{alerts.length}</span>
          </div>
          <button
            onClick={() => fetchAlerts({ sinceSeconds: 6 * 3600 }).then(setAlerts)}
            className="p-1 hover:bg-gray-800 rounded"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>

        {alerts.length === 0 && (
          <div className="px-4 py-8 text-xs text-gray-500 text-center">
            No alerts yet. The detector needs a few minutes per camera to learn the baseline,
            then anomalies will appear here.
          </div>
        )}

        <ul className="divide-y divide-gray-800">
          {alerts.map((a) => {
            const sevColor = SEVERITY_COLOR[Math.max(1, Math.min(10, a.severity))];
            return (
              <li
                key={a.id}
                onClick={() => handleAlertClick(a)}
                className={`px-3 py-2 cursor-pointer hover:bg-gray-800/60 transition-colors ${
                  a.resolved_at ? 'opacity-50' : ''
                }`}
              >
                <div className="flex gap-2.5">
                  {a.has_image ? (
                    <img
                      src={`/api/alerts/${a.id}/image.jpg?v=${a.updated_at}`}
                      alt=""
                      loading="lazy"
                      className="w-24 h-16 object-cover rounded bg-black flex-shrink-0 border"
                      style={{ borderColor: `rgb(${sevColor.join(',')})` }}
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : (
                    <div className="w-24 h-16 rounded bg-gray-800 flex-shrink-0 flex items-center justify-center">
                      <span className="text-[10px] text-gray-500">no image</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <div
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: `rgb(${sevColor.join(',')})` }}
                      />
                      <span className="font-semibold uppercase text-gray-300 tracking-wide">
                        {ALERT_LABELS[a.kind] ?? a.kind}
                      </span>
                      <span className="text-gray-500">sev {a.severity}</span>
                      {a.occurrence_count > 1 && (
                        <span className="text-gray-500">×{a.occurrence_count}</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-200 line-clamp-2 mt-0.5">{a.message}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {fmtAge(a.updated_at)}
                      {a.resolved_at && ' · resolved'}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>

      {lofiMode && <LofiPip focus={lofiFocus} onClose={() => { setLofiMode(false); setLofiFocus(null); }} />}

      {selectedCamera && (
        <CameraPanel
          camera={selectedCamera}
          alerts={alerts.filter((a) => a.camera_id === selectedCamera.id)}
          onClose={() => setSelectedCamera(null)}
          onPickAlert={(a) => {
            setSelectedCamera(null);
            handleAlertClick(a);
          }}
        />
      )}

      {selectedAlert && (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 w-[520px] max-h-[85vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-2xl z-30">
          <div className="flex items-center justify-between p-3 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
            <div className="min-w-0 pr-2">
              <div className="text-xs text-gray-400">
                {ALERT_LABELS[selectedAlert.kind] ?? selectedAlert.kind} · severity {selectedAlert.severity}
              </div>
              <div className="text-sm font-semibold mt-0.5 truncate">
                {selectedAlert.camera_name ?? selectedAlert.camera_id}
              </div>
            </div>
            <button onClick={() => setSelectedAlert(null)} className="p-1 hover:bg-gray-800 rounded">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>
          <div className="p-3 text-xs space-y-3">
            {selectedAlert.has_image && (
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Frame at trigger</div>
                <img
                  src={`/api/alerts/${selectedAlert.id}/image.jpg?v=${selectedAlert.updated_at}`}
                  alt={`alert ${selectedAlert.id} frame`}
                  className="w-full bg-black rounded"
                />
              </div>
            )}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">
                <span>Live now</span>
                <span className="text-gray-600">auto-refresh 5s</span>
              </div>
              <img
                key={`live-${selectedAlert.camera_id}-${Math.floor(Date.now() / 5000)}`}
                src={`/api/cameras/${selectedAlert.camera_id}/snapshot.jpg?t=${Math.floor(Date.now() / 5000)}`}
                alt={`live ${selectedAlert.camera_id}`}
                className="w-full bg-black rounded"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
            <div className="text-gray-300">{selectedAlert.message}</div>
            <div className="text-gray-500 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <span>opened</span><span>{fmtAge(selectedAlert.created_at)}</span>
              <span>last update</span><span>{fmtAge(selectedAlert.updated_at)}</span>
              <span>occurrences</span><span>{selectedAlert.occurrence_count}</span>
              <span>camera id</span><span className="font-mono text-[10px]">{selectedAlert.camera_id}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="flex flex-col items-end">
      <div className={`font-semibold tabular-nums ${tone === 'warn' ? 'text-amber-400' : 'text-white'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    </div>
  );
}

function LofiPip({ focus, onClose }: { focus: Alert | null; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const [flashKey, setFlashKey] = useState(0);

  // Trigger a quick "channel flip" flash when the focus changes.
  useEffect(() => {
    if (focus) setFlashKey((k) => k + 1);
  }, [focus?.id]);

  // Refresh the live image every 3s.
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[640px] z-40 pointer-events-none">
      <div
        key={flashKey}
        className="rounded-xl overflow-hidden shadow-[0_0_40px_rgba(217,70,239,0.55)] border-2 border-fuchsia-400/70 bg-black pointer-events-auto animate-[lofiFlash_0.4s_ease-out]"
      >
        <div className="flex items-center justify-between px-3 py-1.5 bg-gradient-to-r from-fuchsia-900/80 via-purple-900/60 to-rose-900/80 text-[11px]">
          <div className="flex items-center gap-2 font-mono uppercase tracking-wider">
            <span className="w-2 h-2 rounded-full bg-fuchsia-400 animate-pulse" />
            LO-FI · LIVE
            {focus && (
              <span className="ml-2 text-fuchsia-200">
                {ALERT_LABELS[focus.kind] ?? focus.kind} · sev {focus.severity}
              </span>
            )}
          </div>
          <button onClick={onClose} className="hover:bg-black/30 p-0.5 rounded">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {focus ? (
          <div className="relative">
            <img
              key={`lofi-${focus.camera_id}-${tick}`}
              src={`/api/cameras/${focus.camera_id}/snapshot.jpg?t=${tick}`}
              alt="lofi feed"
              className="w-full bg-black"
              style={{ minHeight: 240 }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = '0.2';
              }}
            />
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/95 via-black/60 to-transparent p-3 text-white">
              <div className="text-[10px] uppercase tracking-wider text-fuchsia-300/90 font-mono">
                NOW WATCHING
              </div>
              <div className="text-base font-semibold leading-tight mt-0.5">
                {focus.camera_name ?? focus.camera_id}
              </div>
              <div className="text-xs text-gray-300 mt-1 line-clamp-2">{focus.message}</div>
              <div className="text-[10px] text-gray-400 mt-1 font-mono">
                {focus.lat.toFixed(4)}, {focus.lng.toFixed(4)} · alert opened {fmtAge(focus.created_at)} ·
                {' '}occurrences ×{focus.occurrence_count}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-10 text-center text-fuchsia-200/70 text-sm font-mono">
            Waiting for the next live alert to flip to&hellip;
          </div>
        )}
      </div>
      <style>{`
        @keyframes lofiFlash {
          0% { opacity: 0.2; transform: scale(0.97); filter: hue-rotate(60deg) brightness(1.4); }
          60% { opacity: 1; transform: scale(1.01); filter: hue-rotate(0deg) brightness(1.1); }
          100% { opacity: 1; transform: scale(1); filter: none; }
        }
      `}</style>
    </div>
  );
}

function CameraPanel({
  camera,
  alerts,
  onClose,
  onPickAlert,
}: {
  camera: Camera;
  alerts: Alert[];
  onClose: () => void;
  onPickAlert: (a: Alert) => void;
}) {
  // Force the <img> to refresh every 5s so a watcher sees a near-live feed.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(i);
  }, []);

  const activeAlerts = alerts.filter((a) => !a.resolved_at);
  const sevColor = SEVERITY_COLOR[Math.max(1, Math.min(10, camera.active_severity ?? 1))];

  return (
    <div className="absolute left-1/2 top-16 -translate-x-1/2 w-[520px] max-h-[85vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-2xl z-30">
      <div className="flex items-center justify-between p-3 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
        <div className="min-w-0 pr-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Camera feed</div>
          <div className="text-sm font-semibold mt-0.5 truncate">{camera.name ?? camera.id}</div>
          <div className="text-[10px] text-gray-500 mt-0.5">
            {camera.lat.toFixed(4)}, {camera.lng.toFixed(4)} · last poll {fmtAge(camera.last_polled_at)}
            {camera.active_severity ? (
              <span
                className="ml-2 px-1.5 py-0.5 rounded text-white text-[10px] font-semibold"
                style={{ background: `rgb(${sevColor.join(',')})` }}
              >
                ALERT sev {camera.active_severity}
              </span>
            ) : (
              <span className="ml-2 text-emerald-400">· no active alerts</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-gray-800 rounded">
          <X className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      <div className="p-3 space-y-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1 flex items-center justify-between">
            <span>Live snapshot</span>
            <span className="text-gray-600">refresh 5s</span>
          </div>
          <img
            key={`live-${camera.id}-${tick}`}
            src={`/api/cameras/${camera.id}/snapshot.jpg?t=${tick}`}
            alt={`live ${camera.id}`}
            className="w-full bg-black rounded"
            onError={(e) => {
              const el = e.currentTarget as HTMLImageElement;
              el.style.display = 'none';
              if (el.nextElementSibling) (el.nextElementSibling as HTMLElement).style.display = 'block';
            }}
          />
          <div className="hidden text-center text-gray-500 py-8 text-xs bg-gray-800 rounded">
            No snapshot yet — waiting for first poll.
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Alert history ({alerts.length}{activeAlerts.length ? `, ${activeAlerts.length} active` : ''})
          </div>
          {alerts.length === 0 ? (
            <div className="text-gray-500 text-center py-3">No alerts on record for this camera.</div>
          ) : (
            <ul className="divide-y divide-gray-800">
              {alerts.slice(0, 10).map((a) => {
                const c = SEVERITY_COLOR[Math.max(1, Math.min(10, a.severity))];
                return (
                  <li
                    key={a.id}
                    onClick={() => onPickAlert(a)}
                    className={`py-1.5 cursor-pointer hover:bg-gray-800/60 px-1 ${a.resolved_at ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full" style={{ background: `rgb(${c.join(',')})` }} />
                      <span className="font-semibold uppercase text-[10px] text-gray-300">{a.kind.replace('_', ' ')}</span>
                      <span className="text-gray-500 text-[10px]">sev {a.severity}</span>
                      <span className="text-gray-500 text-[10px] ml-auto">{fmtAge(a.updated_at)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
