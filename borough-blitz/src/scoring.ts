/* Scoring — distance → points, the way a New Yorker thinks about space.
 *
 * 100 points per round, 5 rounds, 500 max. Each band has a score floor so
 * landing in it always feels rewarding, plus a smooth falloff inside the
 * band. Adjacent bands are continuous: a band's floor at its upper edge
 * equals the next band's ceiling at the same distance. Tuned for "friendly
 * yet competitive" — close calls feel great, a wrong borough keeps a dignity
 * floor, and a great run beats a mediocre one decisively. */

export const ROUNDS = 5;
export const MAX_PER_ROUND = 100;
export const MAX_SCORE = ROUNDS * MAX_PER_ROUND;

// NYC map centroid + a comfortable starting zoom for the guess map.
export const NYC_CENTER: [number, number] = [-73.95, 40.73];
export const NYC_START_ZOOM = 9.4;

export type Band = {
  id: string;
  label: string;
  blurb: string;
  color: string;
  upTo: number; // meters, inclusive upper bound
  floor: number; // min score at upTo
  ceiling: number; // max score at the band's lower edge
  emoji: string;
};

export const SCORE_BANDS: Band[] = [
  { id: 'bullseye', label: 'BULLSEYE',          blurb: "on the dot · you've actually been there", color: '#39FF6A', upTo: 75,      floor: 95, ceiling: 100, emoji: '🎯' },
  { id: 'block',    label: 'SAME BLOCK',        blurb: 'one corner over · u smell the halal cart', color: '#9bdb2a', upTo: 250,     floor: 82, ceiling: 95,  emoji: '🚏' },
  { id: 'nbhd',     label: 'SAME NEIGHBORHOOD', blurb: 'right zip · wrong avenue',                 color: '#FFD400', upTo: 1200,    floor: 65, ceiling: 82,  emoji: '🏘️' },
  { id: 'district', label: 'SAME DISTRICT',     blurb: 'a couple stops off · take the local',      color: '#FFA21F', upTo: 3500,    floor: 42, ceiling: 65,  emoji: '🚇' },
  { id: 'borough',  label: 'SAME BOROUGH',      blurb: 'roughly · catch the bus',                  color: '#FF7A1F', upTo: 9000,    floor: 22, ceiling: 42,  emoji: '🗽' },
  { id: 'wrong',    label: 'WRONG BOROUGH',     blurb: "that's a whole different vibe",            color: '#FF4D2E', upTo: 25_000,  floor: 6,  ceiling: 22,  emoji: '🌉' },
  { id: 'lost',     label: 'JERSEY?',           blurb: 'are u even on the map?',                   color: '#b23bd6', upTo: Infinity, floor: 0, ceiling: 6,  emoji: '😬' },
];

// Haversine — meters between two lat/lng points.
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bandFor(distanceMeters: number): Band {
  for (const b of SCORE_BANDS) if (distanceMeters <= b.upTo) return b;
  return SCORE_BANDS[SCORE_BANDS.length - 1];
}

export function scoreFor(distanceMeters: number): number {
  const idx = SCORE_BANDS.findIndex((b) => distanceMeters <= b.upTo);
  if (idx < 0) return 0;
  const band = SCORE_BANDS[idx];
  const lower = idx === 0 ? 0 : SCORE_BANDS[idx - 1].upTo;
  if (!Number.isFinite(band.upTo)) return band.floor;
  const t = Math.min(1, Math.max(0, (distanceMeters - lower) / (band.upTo - lower)));
  return Math.round(band.ceiling - (band.ceiling - band.floor) * t);
}

export function fmtDist(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

export type Grade = { label: string; color: string };

// Final grade from total score percentage.
export function gradeFor(total: number): Grade {
  const pct = total / MAX_SCORE;
  if (pct >= 0.85) return { label: 'NATIVE NEW YORKER', color: '#39FF6A' };
  if (pct >= 0.65) return { label: 'KNOWS THE CITY', color: '#FFD400' };
  if (pct >= 0.4) return { label: 'TOURIST WITH POTENTIAL', color: '#FFA21F' };
  if (pct >= 0.2) return { label: 'BRIDGE & TUNNEL', color: '#FF7A1F' };
  return { label: 'JUST GOT OFF THE BUS', color: '#FF4D2E' };
}
