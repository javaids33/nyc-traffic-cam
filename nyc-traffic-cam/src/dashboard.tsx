import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapLibre, NavigationControl } from 'react-map-gl/maplibre';
import { DeckGL } from '@deck.gl/react';
import { FlyToInterpolator } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { HeatmapLayer } from '@deck.gl/aggregation-layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Tv, X } from 'lucide-react';

import { apiUrl, fetchAlerts, fetchCameras, fetchStats, openAlertSocket } from './api';
import type { Alert, Camera, Stats } from './types';

const NYC_VIEW = { longitude: -73.97, latitude: 40.74, zoom: 10.8, pitch: 0, bearing: 0 };

// Severity ramp tuned for phosphor + warning + alarm + crit + hi
const SEVERITY_COLOR: Record<number, [number, number, number]> = {
  1: [110, 148, 0],
  2: [148, 184, 0],
  3: [181, 245, 0],
  4: [255, 204, 34],
  5: [255, 168, 28],
  6: [255, 138, 31],
  7: [255, 90, 70],
  8: [255, 58, 108],
  9: [221, 32, 160],
  10: [233, 31, 255],
};

function severityColor(sev: number | null | undefined): [number, number, number, number] {
  if (!sev) return [80, 100, 120, 110];
  const c = SEVERITY_COLOR[Math.max(1, Math.min(10, sev))];
  return [c[0], c[1], c[2], 235];
}

function fmtAge(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const ALERT_LABELS: Record<string, string> = {
  sudden_change: 'CHG',
  static_feed: 'FRZN',
  camera_offline: 'OFFL',
  high_activity: 'ACTV',
};
const ALERT_LABELS_LONG: Record<string, string> = {
  sudden_change: 'SUDDEN CHANGE',
  static_feed: 'FROZEN FEED',
  camera_offline: 'CAMERA OFFLINE',
  high_activity: 'HIGH ACTIVITY',
};

function useClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(i);
  }, []);
  return t;
}

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

  useEffect(() => {
    fetchCameras().then(setCameras).catch(() => {});
    fetchAlerts({ sinceSeconds: 6 * 3600 }).then(setAlerts).catch(() => {});
    fetchStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    const tick = () => {
      fetchStats().then(setStats).catch(() => {});
      fetchCameras().then(setCameras).catch(() => {});
    };
    const i = setInterval(tick, 5000);
    return () => clearInterval(i);
  }, []);

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
  }, [flyTo]);

  const activeAlerts = useMemo(() => alerts.filter((a) => !a.resolved_at), [alerts]);
  const clock = useClock();

  const handleAlertClick = (alert: Alert) => {
    setSelectedAlert(alert);
    flyTo(alert.lng, alert.lat, 14);
  };

  const camerasLayer = useMemo(
    () =>
      new ScatterplotLayer<Camera>({
        id: 'cameras',
        data: cameras,
        getPosition: (d) => [d.lng, d.lat],
        getFillColor: (d) => severityColor(d.active_severity),
        getLineColor: (d) => (d.active_severity ? [255, 255, 255, 200] : [120, 140, 160, 100]),
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        stroked: true,
        getRadius: (d) => (d.active_severity ? 70 + d.active_severity * 22 : 30),
        radiusMinPixels: 3,
        radiusMaxPixels: 22,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 220],
        opacity: 0.9,
        onClick: (info) => {
          if (info.object) {
            const cam = info.object as Camera;
            setSelectedCamera(cam);
            flyTo(cam.lng, cam.lat, 14);
          }
        },
        updateTriggers: { getFillColor: cameras, getRadius: cameras, getLineColor: cameras },
      }),
    [cameras, flyTo],
  );

  const heatLayer = useMemo(
    () =>
      new HeatmapLayer<Alert>({
        id: 'severity-heat',
        data: activeAlerts,
        getPosition: (d) => [d.lng, d.lat],
        getWeight: (d) => d.severity,
        radiusPixels: 70,
        intensity: 1.6,
        threshold: 0.04,
        colorRange: [
          [76, 175, 80, 0],
          [181, 245, 0, 100],
          [255, 204, 34, 160],
          [255, 138, 31, 200],
          [255, 58, 108, 230],
          [233, 31, 255, 255],
        ],
      }),
    [activeAlerts],
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-ink-950 text-[var(--c-text)] overflow-hidden font-mono">
      <Header
        clock={clock}
        cameras={cameras}
        stats={stats}
        activeAlertCount={activeAlerts.length}
        lofiMode={lofiMode}
        toggleLofi={() => {
          setLofiMode((v) => {
            const next = !v;
            if (next) {
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
      />

      <div className="flex-1 relative">
        <DeckGL
          viewState={viewState}
          controller
          layers={[heatLayer, camerasLayer]}
          onViewStateChange={(p) => {
            viewRef.current = p.viewState as typeof NYC_VIEW;
            setViewState(p.viewState as typeof NYC_VIEW);
          }}
          getTooltip={({ object }) => {
            if (!object) return null;
            const cam = object as Camera;
            return {
              text:
                `${cam.name ?? cam.id}\n` +
                `SEV ${cam.active_severity ?? '—'}  Δ ${cam.last_diff?.toFixed(2) ?? '—'}\n` +
                `LAST POLL ${fmtAge(cam.last_polled_at)} ago`,
              style: {
                background: '#0B0F14',
                color: '#E5EBF0',
                fontFamily: '"IBM Plex Mono", monospace',
                fontSize: '11px',
                padding: '6px 8px',
                border: '1px solid rgba(255,255,255,0.16)',
                borderRadius: '0',
              },
            };
          }}
        >
          <MapLibre
            mapStyle="https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
            attributionControl={false}
          >
            <NavigationControl position="bottom-right" />
          </MapLibre>
        </DeckGL>

        <Legend />
      </div>

      <AlertsRail alerts={alerts} onPick={handleAlertClick} />

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
        <AlertModal alert={selectedAlert} onClose={() => setSelectedAlert(null)} />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────── header */

function Header({
  clock,
  cameras,
  stats,
  activeAlertCount,
  lofiMode,
  toggleLofi,
}: {
  clock: Date;
  cameras: Camera[];
  stats: Stats | null;
  activeAlertCount: number;
  lofiMode: boolean;
  toggleLofi: () => void;
}) {
  const hh = String(clock.getUTCHours()).padStart(2, '0');
  const mm = String(clock.getUTCMinutes()).padStart(2, '0');
  const ss = String(clock.getUTCSeconds()).padStart(2, '0');
  const polled = stats?.cameras_polled ?? 0;
  const total = stats?.cameras_online ?? cameras.length;

  return (
    <header className="border-b border-[var(--c-border-strong)] bg-[var(--c-surface)]/95 backdrop-blur">
      {/* row 1 — station ID + wordmark + clock */}
      <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-[var(--c-text-mid)]">
            <span className="w-2 h-2 bg-[var(--c-crit)] rec-dot" />
            <span>STATION NYC-01</span>
            <span className="text-[var(--c-text-dim)]">/ CHANNEL 0</span>
          </div>
          <div className="display text-[28px] leading-none uppercase pl-3 ml-3 border-l border-[var(--c-border-strong)]">
            Traffic <span className="text-[var(--c-signal)]">Cam</span> Monitor
          </div>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-[var(--c-text-mid)] tabular">
          <span className="uppercase tracking-widest">UTC</span>
          <span className="display text-[26px] leading-none text-[var(--c-text)]">
            {hh}<span className="text-[var(--c-text-dim)]">:</span>{mm}<span className="text-[var(--c-text-dim)]">:</span>{ss}
          </span>
          <button
            onClick={toggleLofi}
            className={`group ml-2 inline-flex items-center gap-1.5 px-2.5 py-1 border text-[11px] uppercase tracking-[0.14em] transition-all ${
              lofiMode
                ? 'border-[var(--c-hi)] text-[var(--c-hi)] shadow-glow-hi bg-[rgba(233,31,255,0.08)]'
                : 'border-[var(--c-border-strong)] text-[var(--c-text-mid)] hover:text-[var(--c-text)] hover:border-[var(--c-text-mid)]'
            }`}
            title="Auto-flip the map to each new alert as it fires"
          >
            <Tv className="w-3.5 h-3.5" />
            LO-FI
            <span className={`tabular ${lofiMode ? 'text-[var(--c-hi)]' : 'text-[var(--c-text-dim)]'}`}>
              {lofiMode ? 'ON' : 'OFF'}
            </span>
          </button>
        </div>
      </div>

      {/* row 2 — broadcast lower-third stats strip */}
      <div className="grid grid-cols-12 gap-px bg-[var(--c-border)] border-t border-[var(--c-border)]">
        <Metric label="POLLS" value={(stats?.metrics.polls_total ?? 0).toLocaleString()} className="col-span-2" />
        <Metric label="FAIL" value={stats?.metrics.polls_failed ?? 0} tone={stats?.metrics.polls_failed ? 'crit' : 'mid'} className="col-span-1" />
        <Metric label="OPENED" value={stats?.metrics.alerts_opened ?? 0} className="col-span-1" />
        <Metric label="RESOLVED" value={stats?.metrics.alerts_resolved ?? 0} tone="signal" className="col-span-1" />
        <Metric label="ACTIVE" value={activeAlertCount} tone={activeAlertCount ? 'crit' : 'signal'} accent={activeAlertCount > 0} className="col-span-2" />
        <Metric label="CHANNELS" value={`${polled}/${total}`} className="col-span-3" />
        <Metric label="Δ TICK" value={`${fmtAge(stats?.metrics.last_tick_at)} ago`} className="col-span-2" />
      </div>
    </header>
  );
}

function Metric({
  label,
  value,
  tone,
  accent,
  className,
}: {
  label: string;
  value: string | number;
  tone?: 'signal' | 'crit' | 'warn' | 'mid';
  accent?: boolean;
  className?: string;
}) {
  const toneCls =
    tone === 'crit'
      ? 'text-[var(--c-crit)]'
      : tone === 'signal'
        ? 'text-[var(--c-signal)]'
        : tone === 'warn'
          ? 'text-[var(--c-warn)]'
          : tone === 'mid'
            ? 'text-[var(--c-text-mid)]'
            : 'text-[var(--c-text)]';
  return (
    <div className={`bg-[var(--c-surface)] px-3 py-1.5 flex items-baseline gap-2 ${className ?? ''}`}>
      <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--c-text-dim)]">{label}</span>
      <span className={`display text-[22px] leading-none tabular ${toneCls} ${accent ? 'animate-pulse' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── alerts rail */

function AlertsRail({ alerts, onPick }: { alerts: Alert[]; onPick: (a: Alert) => void }) {
  const active = alerts.filter((a) => !a.resolved_at);
  return (
    <aside className="absolute right-0 top-[88px] bottom-0 w-[380px] bg-[var(--c-surface)]/95 backdrop-blur border-l border-[var(--c-border-strong)] flex flex-col">
      <div className="px-3 py-2 border-b border-[var(--c-border)] flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--c-text-dim)]">FEED</span>
          <span className="display text-[20px] leading-none">ALERTS</span>
        </div>
        <div className="text-[10px] text-[var(--c-text-mid)] tabular">
          <span className="text-[var(--c-crit)]">{active.length}</span>
          <span className="text-[var(--c-text-dim)]"> · </span>
          {alerts.length} TOTAL
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {alerts.length === 0 && (
          <div className="px-4 py-12 text-[11px] text-[var(--c-text-dim)] text-center leading-relaxed">
            STANDBY
            <br />
            <span className="text-[var(--c-text-mid)]">Detector calibrating per-camera baselines.</span>
            <br />
            New anomalies will appear here.
          </div>
        )}
        <ul>
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} onPick={onPick} />
          ))}
        </ul>
      </div>
    </aside>
  );
}

function AlertRow({ alert: a, onPick }: { alert: Alert; onPick: (a: Alert) => void }) {
  const sev = Math.max(1, Math.min(10, a.severity));
  const c = SEVERITY_COLOR[sev];
  const sevRgb = `rgb(${c.join(',')})`;
  return (
    <li
      onClick={() => onPick(a)}
      className={`relative cursor-pointer border-b border-[var(--c-border)] transition-colors hover:bg-[var(--c-surface-2)] ${
        a.resolved_at ? 'opacity-45' : ''
      }`}
    >
      {/* severity strip on the left */}
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: sevRgb }} />
      <div className="flex gap-2.5 pl-3 pr-2 py-2">
        {a.has_image ? (
          <div className="relative w-[88px] h-[58px] flex-shrink-0 bg-black brackets crt-overlay" style={{ '--bracket': sevRgb } as React.CSSProperties}>
            <img
              src={apiUrl(`/api/alerts/${a.id}/image.jpg?v=${a.updated_at}`)}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <span className="br-bl" />
            <span className="br-br" />
          </div>
        ) : (
          <div className="w-[88px] h-[58px] flex-shrink-0 bg-[var(--c-surface-2)] flex items-center justify-center text-[9px] text-[var(--c-text-dim)] uppercase tracking-wider border border-[var(--c-border)]">
            no signal
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] tabular">
            <span
              className="display text-[13px] leading-none px-1 -my-0.5 text-black"
              style={{ background: sevRgb }}
            >
              {ALERT_LABELS[a.kind] ?? a.kind.slice(0, 4).toUpperCase()}
            </span>
            <span className="text-[var(--c-text-mid)]">SEV</span>
            <span className="display text-[14px] leading-none" style={{ color: sevRgb }}>{a.severity}</span>
            {a.occurrence_count > 1 && (
              <span className="text-[var(--c-text-dim)]">×{a.occurrence_count}</span>
            )}
            <span className="ml-auto text-[var(--c-text-dim)]">{fmtAge(a.updated_at)}</span>
          </div>
          <div className="text-[11px] text-[var(--c-text)] leading-snug mt-1 line-clamp-2">
            {a.message}
          </div>
          {a.resolved_at && (
            <div className="text-[9px] text-[var(--c-signal-dim)] mt-0.5 uppercase tracking-wider">resolved</div>
          )}
        </div>
      </div>
    </li>
  );
}

/* ────────────────────────────────────────────────────────── legend */

function Legend() {
  return (
    <div className="absolute left-3 bottom-3 bg-[var(--c-surface)]/95 backdrop-blur border border-[var(--c-border-strong)] px-3 py-2.5 text-[10px] tabular">
      <div className="flex items-baseline justify-between mb-1.5 gap-6">
        <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--c-text-dim)]">SEVERITY</span>
        <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--c-text-dim)]">PHOSPHOR → CRIT</span>
      </div>
      <div className="flex items-center">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((s) => (
          <div key={s} className="flex flex-col items-center" style={{ width: 22 }}>
            <div className="h-3 w-full" style={{ background: `rgb(${SEVERITY_COLOR[s].join(',')})` }} />
            <span className="text-[9px] text-[var(--c-text-mid)] mt-0.5">{s}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 pt-2 border-t border-[var(--c-border)] text-[9px] uppercase tracking-[0.14em] text-[var(--c-text-dim)]">
        Click any camera dot to view live feed
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────── lofi PIP */

function LofiPip({ focus, onClose }: { focus: Alert | null; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const [flashKey, setFlashKey] = useState(0);
  const clock = useClock();

  useEffect(() => {
    if (focus) setFlashKey((k) => k + 1);
  }, [focus?.id]);

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 3000);
    return () => clearInterval(i);
  }, []);

  const hh = String(clock.getUTCHours()).padStart(2, '0');
  const mm = String(clock.getUTCMinutes()).padStart(2, '0');
  const ss = String(clock.getUTCSeconds()).padStart(2, '0');

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-[680px] z-40 pointer-events-none">
      <div
        key={flashKey}
        className="bg-black border border-[var(--c-hi)]/70 shadow-glow-hi pointer-events-auto"
        style={{ animation: 'channel-flip 0.5s ease-out' }}
      >
        {/* top bar: REC + station + alert badge */}
        <div className="flex items-center gap-3 px-3 py-1.5 bg-[var(--c-surface-2)] border-b border-[var(--c-hi)]/40 text-[10px] uppercase tracking-[0.16em]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-[var(--c-crit)] rec-dot" />
            <span className="text-[var(--c-crit)] font-semibold">REC</span>
          </span>
          <span className="text-[var(--c-text-mid)]">STATION NYC-01</span>
          <span className="text-[var(--c-text-dim)]">/</span>
          <span className="text-[var(--c-hi)]">LO-FI LIVE</span>
          {focus && (
            <>
              <span className="text-[var(--c-text-dim)]">/</span>
              <span className="text-[var(--c-text)]">
                {ALERT_LABELS_LONG[focus.kind] ?? focus.kind} · SEV {focus.severity}
              </span>
            </>
          )}
          <span className="ml-auto tabular text-[var(--c-text-mid)]">
            {hh}:{mm}:{ss} UTC
          </span>
          <button onClick={onClose} className="ml-2 hover:text-[var(--c-crit)] transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {focus ? (
          <div className="relative crt-overlay">
            <img
              key={`lofi-${focus.camera_id}-${tick}`}
              src={apiUrl(`/api/cameras/${focus.camera_id}/snapshot.jpg?t=${tick}`)}
              alt="lofi feed"
              className="w-full bg-black block"
              style={{ minHeight: 280 }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = '0.2';
              }}
            />
            {/* corner crosshair guides */}
            <CornerGuides />
            {/* bottom information panel */}
            <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black via-black/85 to-transparent p-3 text-white">
              <div className="flex items-end gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-hi)]">NOW WATCHING</div>
                  <div className="display text-[24px] leading-tight uppercase mt-0.5 truncate">
                    {focus.camera_name ?? focus.camera_id}
                  </div>
                  <div className="text-[10px] text-gray-300 mt-1 line-clamp-2 max-w-[480px]">{focus.message}</div>
                </div>
                <div className="text-right text-[9px] tabular text-gray-400 uppercase tracking-wider leading-relaxed shrink-0">
                  <div><span className="text-[var(--c-text-dim)]">CAM</span> {focus.camera_id.slice(0, 8)}</div>
                  <div><span className="text-[var(--c-text-dim)]">LAT</span> {focus.lat.toFixed(4)}</div>
                  <div><span className="text-[var(--c-text-dim)]">LNG</span> {focus.lng.toFixed(4)}</div>
                  <div><span className="text-[var(--c-text-dim)]">×</span> {focus.occurrence_count} · {fmtAge(focus.created_at)} ago</div>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-12 text-center text-[var(--c-hi)]/80 text-[12px] uppercase tracking-[0.22em]">
            Standby · awaiting next alert
          </div>
        )}
      </div>
    </div>
  );
}

function CornerGuides() {
  return (
    <>
      {/* top-left */}
      <span className="absolute top-2 left-2 w-4 h-4 border-t border-l border-[var(--c-hi)]" />
      {/* top-right */}
      <span className="absolute top-2 right-2 w-4 h-4 border-t border-r border-[var(--c-hi)]" />
      {/* bottom-left */}
      <span className="absolute bottom-2 left-2 w-4 h-4 border-b border-l border-[var(--c-hi)]" />
      {/* bottom-right */}
      <span className="absolute bottom-2 right-2 w-4 h-4 border-b border-r border-[var(--c-hi)]" />
      {/* center crosshair */}
      <span className="absolute top-1/2 left-1/2 w-px h-3 -translate-x-1/2 -translate-y-1/2 bg-[var(--c-hi)]/60" />
      <span className="absolute top-1/2 left-1/2 w-3 h-px -translate-x-1/2 -translate-y-1/2 bg-[var(--c-hi)]/60" />
    </>
  );
}

/* ────────────────────────────────────────────────────────── camera panel */

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
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(i);
  }, []);

  const activeAlerts = alerts.filter((a) => !a.resolved_at);
  const sev = camera.active_severity ?? 0;
  const c = SEVERITY_COLOR[Math.max(1, Math.min(10, sev || 1))];

  return (
    <div className="absolute left-1/2 top-[100px] -translate-x-1/2 w-[540px] max-h-[80vh] overflow-y-auto bg-[var(--c-surface)] border border-[var(--c-border-strong)] z-30 shadow-2xl">
      <div className="flex items-center justify-between p-3 border-b border-[var(--c-border-strong)] sticky top-0 bg-[var(--c-surface)] z-10">
        <div className="min-w-0 pr-2">
          <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)]">CAMERA FEED</div>
          <div className="display text-[22px] leading-none truncate uppercase mt-0.5">
            {camera.name ?? camera.id}
          </div>
          <div className="text-[10px] text-[var(--c-text-mid)] mt-1 tabular flex items-center gap-2 flex-wrap">
            <span><span className="text-[var(--c-text-dim)]">LAT</span> {camera.lat.toFixed(4)}</span>
            <span><span className="text-[var(--c-text-dim)]">LNG</span> {camera.lng.toFixed(4)}</span>
            <span><span className="text-[var(--c-text-dim)]">LAST</span> {fmtAge(camera.last_polled_at)} ago</span>
            {sev > 0 ? (
              <span
                className="display px-1 text-black"
                style={{ background: `rgb(${c.join(',')})` }}
              >
                ALERT SEV {sev}
              </span>
            ) : (
              <span className="text-[var(--c-signal)] text-[9px] uppercase tracking-wider">· nominal</span>
            )}
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:text-[var(--c-crit)] transition-colors">
          <X className="w-4 h-4 text-[var(--c-text-mid)]" />
        </button>
      </div>

      <div className="p-3 space-y-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)] mb-1 flex items-center justify-between">
            <span>LIVE SNAPSHOT</span>
            <span className="text-[var(--c-text-dim)]">↻ 5s</span>
          </div>
          <div className="brackets crt-overlay relative bg-black">
            <img
              key={`live-${camera.id}-${tick}`}
              src={apiUrl(`/api/cameras/${camera.id}/snapshot.jpg?t=${tick}`)}
              alt={`live ${camera.id}`}
              className="w-full bg-black block"
              onError={(e) => {
                const el = e.currentTarget as HTMLImageElement;
                el.style.display = 'none';
                if (el.nextElementSibling) (el.nextElementSibling as HTMLElement).style.display = 'block';
              }}
            />
            <div className="hidden text-center text-[var(--c-text-dim)] py-12 text-[11px] uppercase tracking-wider">
              No snapshot yet — waiting for first poll.
            </div>
            <span className="br-bl" />
            <span className="br-br" />
          </div>
        </div>

        <div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)] mb-1">
            ALERT HISTORY <span className="text-[var(--c-text-mid)]">({alerts.length}{activeAlerts.length ? ` · ${activeAlerts.length} active` : ''})</span>
          </div>
          {alerts.length === 0 ? (
            <div className="text-[var(--c-text-dim)] text-center py-3 text-[11px] uppercase tracking-wider">No alerts on record.</div>
          ) : (
            <ul className="border border-[var(--c-border)]">
              {alerts.slice(0, 10).map((a) => {
                const ac = SEVERITY_COLOR[Math.max(1, Math.min(10, a.severity))];
                return (
                  <li
                    key={a.id}
                    onClick={() => onPickAlert(a)}
                    className={`relative py-1.5 pl-3 pr-2 cursor-pointer hover:bg-[var(--c-surface-2)] border-b border-[var(--c-border)] last:border-b-0 ${a.resolved_at ? 'opacity-50' : ''}`}
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: `rgb(${ac.join(',')})` }} />
                    <div className="flex items-center gap-2 text-[10px] tabular">
                      <span className="display text-[12px] leading-none px-1 text-black" style={{ background: `rgb(${ac.join(',')})` }}>
                        {ALERT_LABELS[a.kind] ?? a.kind.slice(0, 4).toUpperCase()}
                      </span>
                      <span className="text-[var(--c-text-mid)]">SEV</span>
                      <span className="display text-[12px] leading-none" style={{ color: `rgb(${ac.join(',')})` }}>{a.severity}</span>
                      <span className="text-[var(--c-text-dim)] ml-auto">{fmtAge(a.updated_at)} ago</span>
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

/* ────────────────────────────────────────────────────────── alert modal */

function AlertModal({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const sev = Math.max(1, Math.min(10, alert.severity));
  const c = SEVERITY_COLOR[sev];
  return (
    <div className="absolute left-1/2 top-[100px] -translate-x-1/2 w-[540px] max-h-[80vh] overflow-y-auto bg-[var(--c-surface)] border border-[var(--c-border-strong)] z-30 shadow-2xl">
      <div className="flex items-center justify-between p-3 border-b border-[var(--c-border-strong)] sticky top-0 bg-[var(--c-surface)] z-10">
        <div className="min-w-0 pr-2">
          <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)]">
            <span className="display text-[12px] px-1 text-black" style={{ background: `rgb(${c.join(',')})` }}>
              {ALERT_LABELS[alert.kind] ?? alert.kind.slice(0, 4).toUpperCase()}
            </span>
            <span>{ALERT_LABELS_LONG[alert.kind] ?? alert.kind}</span>
            <span className="text-[var(--c-text-mid)]">· SEV {alert.severity}</span>
          </div>
          <div className="display text-[22px] leading-none mt-0.5 truncate uppercase">
            {alert.camera_name ?? alert.camera_id}
          </div>
        </div>
        <button onClick={onClose} className="p-1 hover:text-[var(--c-crit)]">
          <X className="w-4 h-4 text-[var(--c-text-mid)]" />
        </button>
      </div>
      <div className="p-3 space-y-3">
        {alert.has_image && (
          <div>
            <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)] mb-1">FRAME AT TRIGGER</div>
            <div className="brackets crt-overlay bg-black">
              <img
                src={apiUrl(`/api/alerts/${alert.id}/image.jpg?v=${alert.updated_at}`)}
                alt={`alert ${alert.id} frame`}
                className="w-full bg-black block"
              />
              <span className="br-bl" />
              <span className="br-br" />
            </div>
          </div>
        )}
        <div>
          <div className="text-[9px] uppercase tracking-[0.22em] text-[var(--c-text-dim)] mb-1 flex items-center justify-between">
            <span>LIVE NOW</span>
            <span className="text-[var(--c-text-dim)]">↻ 5s</span>
          </div>
          <div className="brackets bg-black">
            <img
              key={`live-${alert.camera_id}-${Math.floor(Date.now() / 5000)}`}
              src={apiUrl(`/api/cameras/${alert.camera_id}/snapshot.jpg?t=${Math.floor(Date.now() / 5000)}`)}
              alt={`live ${alert.camera_id}`}
              className="w-full bg-black block"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <span className="br-bl" />
            <span className="br-br" />
          </div>
        </div>
        <div className="text-[11px] text-[var(--c-text)] leading-relaxed">{alert.message}</div>
        <div className="grid grid-cols-[80px_1fr] gap-y-1 text-[10px] tabular text-[var(--c-text-mid)] uppercase tracking-wider border-t border-[var(--c-border)] pt-2">
          <span className="text-[var(--c-text-dim)]">OPENED</span><span>{fmtAge(alert.created_at)} ago</span>
          <span className="text-[var(--c-text-dim)]">UPDATED</span><span>{fmtAge(alert.updated_at)} ago</span>
          <span className="text-[var(--c-text-dim)]">×</span><span>{alert.occurrence_count}</span>
          <span className="text-[var(--c-text-dim)]">CAM</span><span className="font-mono normal-case">{alert.camera_id}</span>
        </div>
      </div>
    </div>
  );
}
