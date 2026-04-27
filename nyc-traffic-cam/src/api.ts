import type { Alert, Camera, Stats, WsEvent } from './types';

/* Pick the API base.
   - If VITE_BACKEND_URL was provided at build time, always honor it.
   - On localhost (Vite dev server), fall back to "" so requests go through
     the dev proxy (`/api → http://127.0.0.1:8000`).
   - On any other host, fall back to the production Fly backend so the
     deployed Pages site is never broken just because the build env var
     wasn't piped through. */
const FLY_BACKEND = 'https://nyc-cam-monitor.fly.dev';
const ENV_BASE = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '');
const isLocal = typeof window !== 'undefined'
  && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname);
const BACKEND_BASE: string = ENV_BASE || (isLocal ? '' : FLY_BACKEND);

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
