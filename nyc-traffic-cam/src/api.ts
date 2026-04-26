import type { Alert, Camera, Stats, WsEvent } from './types';

// In dev (npm run dev) BACKEND_BASE is "" → requests go through the Vite proxy.
// In production (Pages build) BACKEND_BASE = VITE_BACKEND_URL → absolute Fly URL.
const BACKEND_BASE: string = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '');

export const apiUrl = (path: string): string => `${BACKEND_BASE}${path}`;

export async function fetchCameras(): Promise<Camera[]> {
  const r = await fetch(apiUrl('/api/cameras'));
  if (!r.ok) throw new Error(`cameras: ${r.status}`);
  return r.json();
}

export async function fetchAlerts(opts?: { activeOnly?: boolean; sinceSeconds?: number }): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (opts?.activeOnly) params.set('active_only', 'true');
  if (opts?.sinceSeconds) params.set('since', String(Math.floor(Date.now() / 1000) - opts.sinceSeconds));
  const r = await fetch(apiUrl('/api/alerts?' + params.toString()));
  if (!r.ok) throw new Error(`alerts: ${r.status}`);
  return r.json();
}

export async function fetchStats(): Promise<Stats> {
  const r = await fetch(apiUrl('/api/stats'));
  if (!r.ok) throw new Error(`stats: ${r.status}`);
  return r.json();
}

export function openAlertSocket(onEvent: (e: WsEvent) => void): () => void {
  // If BACKEND_BASE is set (production), build the absolute ws(s) URL from it.
  // Otherwise use the current page host (Vite proxy in dev).
  let url: string;
  if (BACKEND_BASE) {
    url = BACKEND_BASE.replace(/^http/, 'ws') + '/ws/alerts';
  } else {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    url = `${proto}//${window.location.host}/ws/alerts`;
  }

  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = 1000;

  const connect = () => {
    if (stopped) return;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 1000;
    };
    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data) as WsEvent;
        onEvent(data);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (!stopped) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 15000);
      }
    };
    ws.onerror = () => ws?.close();
  };
  connect();

  return () => {
    stopped = true;
    ws?.close();
  };
}
