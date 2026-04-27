import type { Camera } from './types';
import baked from './cameras.json';

/* Pick the API base.
   - If VITE_BACKEND_URL was provided at build time, always honor it.
   - On localhost (Vite dev server), fall back to "" so requests go through
     the dev proxy (`/api → http://127.0.0.1:8000`).
   - On any other host, fall back to the production Fly backend so the
     deployed Pages site is never broken just because the build env var
     wasn't piped through.

   Most of the site doesn't need this anymore — see the hybrid migration
   notes in CLAUDE.md. fetchCameras() reads from a build-time JSON,
   challenges live in CF KV via Pages Functions. The Fly backend is
   only on the request path for fallbacks. */
const FLY_BACKEND = 'https://nyc-cam-monitor.fly.dev';
const ENV_BASE = (import.meta.env.VITE_BACKEND_URL ?? '').replace(/\/$/, '');
const isLocal = typeof window !== 'undefined'
  && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname);
const BACKEND_BASE: string = ENV_BASE || (isLocal ? '' : FLY_BACKEND);

export const apiUrl = (path: string): string => `${BACKEND_BASE}${path}`;

/* Camera list — baked into the bundle by `python -m server.sync_cameras`.
   The JSON ships at build time so the page renders instantly with the
   full list, no spinner. Run the sync script weekly (or via the GH
   Actions cron at .github/workflows/sync-cameras.yml) to keep it fresh
   when NYC DOT adds/removes cameras. */
type BakedCamera = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  is_online: boolean;
};
type BakedPayload = {
  generated_at: number;
  count: number;
  cameras: BakedCamera[];
};
const BAKED = baked as BakedPayload;

export async function fetchCameras(): Promise<Camera[]> {
  // Async signature kept for API stability — callers already use
  // .then() / await. The actual lookup is synchronous from the import.
  return BAKED.cameras.map((c) => ({
    id: c.id,
    name: c.name || null,
    lat: c.lat,
    lng: c.lng,
    // Camera type uses number-as-bool (legacy from the SQLite schema)
    is_online: c.is_online ? 1 : 0,
    last_polled_at: null,
    last_image_at: null,
    consecutive_failures: 0,
    last_diff: null,
    active_severity: null,
  }));
}

/* When the cameras bundle was generated. Useful in About / Footer for
   "list as of YYYY-MM-DD" attribution. */
export function camerasGeneratedAt(): Date {
  return new Date(BAKED.generated_at * 1000);
}
