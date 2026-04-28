import { useEffect, useState } from 'react';

/**
 * usePoisByTime — Load day or night POI JSON based on current hour.
 * 
 * Rules:
 *   6am–8pm (6–20)  → cam-pois-day.json
 *   8pm–6am (20–6)  → cam-pois-night.json
 * 
 * Falls back to standard cam-pois.json if time-specific files don't exist.
 * Re-evaluates once per hour as the hour changes.
 */

export type PoiPayload = {
  generated_at: number | null;
  backend: string;
  model: string;
  cameras: Record<string, any>;
};

export function usePoisByTime(): {
  data: PoiPayload | null;
  isLoading: boolean;
  mode: 'day' | 'night';
  error: Error | null;
} {
  const [data, setData] = useState<PoiPayload | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mode, setMode] = useState<'day' | 'night'>('day');
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const loadPois = async () => {
      setIsLoading(true);
      const now = new Date();
      const hour = now.getHours();

      // 6am–8pm = day; otherwise night
      const isDay = hour >= 6 && hour < 20;
      const nextMode: 'day' | 'night' = isDay ? 'day' : 'night';
      setMode(nextMode);

      // Try to load time-specific file first, fall back to standard
      const filename = nextMode === 'day' ? 'cam-pois-day.json' : 'cam-pois-night.json';
      const fallbackFilename = 'cam-pois.json';

      try {
        let response = await fetch(`/${filename}`);
        if (!response.ok && filename !== fallbackFilename) {
          // Fall back to standard file if time-specific doesn't exist
          response = await fetch(`/${fallbackFilename}`);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} loading POI data`);
        }

        const payload = (await response.json()) as PoiPayload;
        setData(payload);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setData(null);
      } finally {
        setIsLoading(false);
      }
    };

    loadPois();

    // Re-check once per hour when hour changes
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const delayMs = nextHour.getTime() - Date.now();

    const timer = setTimeout(loadPois, delayMs);
    return () => clearTimeout(timer);
  }, []);

  return { data, isLoading, mode, error };
}
