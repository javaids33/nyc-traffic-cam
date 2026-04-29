import { useEffect, useState } from 'react';

/**
 * usePoisByTime — Switch the loaded POI dataset between day and night
 * based on actual NYC sunrise/sunset, not a hardcoded clock.
 *
 * Behavior:
 *   - Fetches today's NYC sunset from sunrise-sunset.org once per day
 *     (no auth, free, ~5KB response). Result cached in localStorage
 *     so a refresh inside the same calendar day is offline-friendly.
 *   - Switches to `cam-pois-night.json` 20 min after sunset.
 *   - Switches back to `cam-pois.json` (the day file) at sunrise.
 *   - Falls back to the standard `cam-pois.json` whenever the night
 *     file is missing — works fine before any night sweep has run.
 *   - Re-evaluates every 5 min so the dusk transition catches up.
 *
 * `mode` is 'day' or 'night' so the UI can decorate accordingly.
 */

export type PoiPayload = {
  generated_at: number | null;
  backend?: string;
  model?: string;
  cameras: Record<string, unknown>;
};

const NYC_LAT = 40.7128;
const NYC_LNG = -74.006;
const NIGHT_OFFSET_MIN = 20;          // 20 min after sunset = night
const RECHECK_INTERVAL_MS = 5 * 60_000;

type SunTimes = { sunriseMs: number; sunsetMs: number; isoDate: string };

async function fetchTodaysSun(): Promise<SunTimes> {
  // localStorage cache scoped per day so we hit the API at most once
  // per browser per 24h.
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `nyc-sun-${today}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch { /* ignore quota / parse errors */ }

  const url = `https://api.sunrise-sunset.org/json?lat=${NYC_LAT}&lng=${NYC_LNG}&date=${today}&formatted=0`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sunrise-sunset.org HTTP ${r.status}`);
  const json = (await r.json()) as { results: { sunrise: string; sunset: string } };
  const out: SunTimes = {
    sunriseMs: new Date(json.results.sunrise).getTime(),
    sunsetMs: new Date(json.results.sunset).getTime(),
    isoDate: today,
  };
  try { localStorage.setItem(cacheKey, JSON.stringify(out)); } catch { /* ignore */ }
  return out;
}

function decideMode(now: number, sun: SunTimes | null): 'day' | 'night' {
  if (!sun) {
    // Conservative fallback if the API is unreachable — clock window
    // 6am-8pm = day, otherwise night.
    const h = new Date(now).getHours();
    return h >= 6 && h < 20 ? 'day' : 'night';
  }
  const nightStart = sun.sunsetMs + NIGHT_OFFSET_MIN * 60_000;
  return now >= sun.sunriseMs && now < nightStart ? 'day' : 'night';
}

export function usePoisByTime(): {
  data: PoiPayload | null;
  isLoading: boolean;
  mode: 'day' | 'night';
  sunset: Date | null;
  error: Error | null;
} {
  const [data, setData] = useState<PoiPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mode, setMode] = useState<'day' | 'night'>('day');
  const [sunset, setSunset] = useState<Date | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let sun: SunTimes | null = null;

    const evaluate = async () => {
      const m = decideMode(Date.now(), sun);
      if (cancelled) return;
      setMode(m);

      // Try the time-specific file first. Fall back to the day file
      // if the night sweep hasn't been run yet — UX > strictness.
      const primary = m === 'night' ? '/src/cam-pois-night.json' : '/src/cam-pois.json';
      const fallback = '/src/cam-pois.json';
      try {
        let r = await fetch(primary);
        if (!r.ok && primary !== fallback) r = await fetch(fallback);
        if (!r.ok) throw new Error(`HTTP ${r.status} loading ${primary}`);
        const payload = (await r.json()) as PoiPayload;
        if (cancelled) return;
        setData(payload);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setData(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    (async () => {
      try {
        sun = await fetchTodaysSun();
        if (!cancelled) setSunset(new Date(sun.sunsetMs));
      } catch {
        // Leave sun=null — decideMode falls back to clock window.
      }
      await evaluate();
    })();

    const id = setInterval(evaluate, RECHECK_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return { data, isLoading, mode, sunset, error };
}
