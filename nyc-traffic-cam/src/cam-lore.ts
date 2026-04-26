/* Tiny per-camera memory in localStorage. Tracks how many alerts each
   camera has fired (according to this browser session's view of things)
   and the last time we tuned to it. Used to surface lore in the chyron:
   "× 4 alerts this week · last tuned 2h ago". */

const STORE_KEY = 'nyc-cam-lore-v1';

type LoreEntry = {
  alerts: number;       // total alerts seen
  lastAlertAt: number;  // ms since epoch
  tunes: number;        // times the channel-surf landed here
  lastTunedAt: number;  // ms
  alertsThisWeek: number;
  weekKey: string;      // ISO week key for resetting alertsThisWeek
};
type LoreMap = Record<string, LoreEntry>;

function isoWeekKey(d = new Date()): string {
  // Lazy: YYYY-Www approx; doesn't need to be calendar-precise, just
  // to roll over once a week.
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const days = Math.floor((d.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
  const w = Math.floor((days + start.getUTCDay()) / 7);
  return `${d.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}

function read(): LoreMap {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}
function write(m: LoreMap) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(m)); } catch { /* noop */ }
}

function ensure(m: LoreMap, id: string): LoreEntry {
  const wk = isoWeekKey();
  let e = m[id];
  if (!e) {
    e = { alerts: 0, lastAlertAt: 0, tunes: 0, lastTunedAt: 0, alertsThisWeek: 0, weekKey: wk };
    m[id] = e;
  } else if (e.weekKey !== wk) {
    e.weekKey = wk;
    e.alertsThisWeek = 0;
  }
  return e;
}

export function recordAlert(cameraId: string) {
  if (!cameraId) return;
  const m = read();
  const e = ensure(m, cameraId);
  e.alerts += 1;
  e.alertsThisWeek += 1;
  e.lastAlertAt = Date.now();
  write(m);
}

export function recordTune(cameraId: string) {
  if (!cameraId) return;
  const m = read();
  const e = ensure(m, cameraId);
  e.tunes += 1;
  e.lastTunedAt = Date.now();
  write(m);
}

export function loreLine(cameraId: string | null | undefined): string | null {
  if (!cameraId) return null;
  const m = read();
  const e = m[cameraId];
  if (!e) return null;
  const bits: string[] = [];
  if (e.alertsThisWeek >= 5)      bits.push(`spicy block · ${e.alertsThisWeek} alerts this week`);
  else if (e.alertsThisWeek >= 2) bits.push(`× ${e.alertsThisWeek} alerts this week`);
  else if (e.tunes >= 5)          bits.push(`you’ve been here ${e.tunes} times`);
  else if (e.tunes >= 2)          bits.push(`back again`);
  if (!bits.length) return null;
  return bits.join(' · ');
}
