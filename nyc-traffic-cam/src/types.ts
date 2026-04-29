export type Camera = {
  id: string;
  name: string | null;
  lat: number;
  lng: number;
  is_online: number;
  last_polled_at: number | null;
  last_image_at: number | null;
  consecutive_failures: number;
  last_diff: number | null;
  active_severity: number | null;
  // Baked into src/cameras.json by server/sync_boroughs.py — uses
  // NYC's official borough polygon for an exact GPS-driven check
  // instead of the old bounding-box hack that mis-classified the
  // East River seam (Queens Plaza, LIC, Greenpoint, Astoria).
  borough?: 'MANHATTAN' | 'BRONX' | 'BROOKLYN' | 'QUEENS' | 'STATEN ISLAND' | null;
};

export type AlertKind = 'sudden_change' | 'static_feed' | 'camera_offline' | 'high_activity';

export type Alert = {
  id: number;
  camera_id: string;
  camera_name: string | null;
  lat: number;
  lng: number;
  kind: AlertKind;
  severity: number;
  message: string;
  details?: Record<string, unknown> | null;
  thumbnail_b64: string | null;
  has_image: boolean;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  occurrence_count: number;
};

export type Stats = {
  cameras_online: number;
  cameras_polled: number;
  metrics: {
    polls_total: number;
    polls_failed: number;
    alerts_opened: number;
    alerts_resolved: number;
    last_tick_at: number;
  };
};

export type WsEvent =
  | { type: 'hello'; metrics: Stats['metrics'] }
  | {
      type: 'alert_opened' | 'alert_updated';
      id: number;
      camera_id: string;
      camera_name: string | null;
      lat: number;
      lng: number;
      kind: AlertKind;
      severity: number;
      message: string;
      created_at?: number;
      updated_at: number;
      occurrence_count: number;
      has_image: boolean;
    }
  | {
      type: 'alert_resolved';
      alert_id: number;
      camera_id: string;
      kind: AlertKind;
    };
