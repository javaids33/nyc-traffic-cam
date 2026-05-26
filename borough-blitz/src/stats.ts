/* Daily engagement: streaks, stats, and Wordle-style shareable results.
 *
 * Fully anonymous — everything lives in localStorage. The "daily" is the same
 * 5 cameras for everyone on a given NYC day (see dailySeed in cams.ts), so a
 * shared result + the ?daily=1 link lets a friend play the identical run and
 * compare. Streak = consecutive NYC days the daily was completed. */

import { nycDateStr } from './cams';
import { MAX_SCORE } from './scoring';

const STATS_KEY = 'bb-daily-v2';
// #1 = launch day. dailyNumber is days-since-epoch + 1.
const DAILY_EPOCH = '2026-05-26';
const HISTORY_CAP = 90;

export type DailyEntry = { date: string; score: number; rounds: number[] };
export type Stats = {
  played: number;
  streak: number;
  maxStreak: number;
  lastPlayed: string | null; // YYYY-MM-DD (NYC)
  history: DailyEntry[];
};

const EMPTY: Stats = { played: 0, streak: 0, maxStreak: 0, lastPlayed: null, history: [] };

// Whole-day difference between two YYYY-MM-DD strings (b - a), tz-agnostic.
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function dailyNumber(date = nycDateStr()): number {
  return Math.max(1, dayDiff(DAILY_EPOCH, date) + 1);
}

export function loadStats(): Stats {
  try {
    const j = JSON.parse(localStorage.getItem(STATS_KEY) ?? 'null') as Stats | null;
    if (j && Array.isArray(j.history)) return { ...EMPTY, ...j };
  } catch {
    /* ignore */
  }
  return { ...EMPTY };
}

function saveStats(s: Stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/* Record a completed daily run. First completion of the day extends the
 * streak and counts toward "played"; replaying only keeps the best score. */
export function recordDailyResult(total: number, rounds: number[], today = nycDateStr()): Stats {
  const s = loadStats();
  const entry = s.history.find((h) => h.date === today);
  if (entry) {
    if (total > entry.score) {
      entry.score = total;
      entry.rounds = rounds;
    }
  } else {
    s.streak = s.lastPlayed && dayDiff(s.lastPlayed, today) === 1 ? s.streak + 1 : 1;
    s.lastPlayed = today;
    s.played += 1;
    s.maxStreak = Math.max(s.maxStreak, s.streak);
    s.history.push({ date: today, score: total, rounds });
    if (s.history.length > HISTORY_CAP) s.history = s.history.slice(-HISTORY_CAP);
  }
  saveStats(s);
  return s;
}

export type DailyView = {
  number: number;
  streak: number; // 0 if broken (missed a day)
  maxStreak: number;
  played: number;
  avg: number;
  bestEver: number;
  todayScore: number | null;
  todayRounds: number[] | null;
  history: DailyEntry[];
};

export function dailyView(s: Stats, today = nycDateStr()): DailyView {
  const todayEntry = s.history.find((h) => h.date === today) ?? null;
  // Streak is "alive" only if the last play was today or yesterday.
  const alive = s.lastPlayed != null && dayDiff(s.lastPlayed, today) <= 1;
  const scores = s.history.map((h) => h.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return {
    number: dailyNumber(today),
    streak: alive ? s.streak : 0,
    maxStreak: s.maxStreak,
    played: s.played,
    avg,
    bestEver: scores.length ? Math.max(...scores) : 0,
    todayScore: todayEntry?.score ?? null,
    todayRounds: todayEntry?.rounds ?? null,
    history: s.history.slice(-30),
  };
}

// Per-round score → colored square for the share grid.
export function squareFor(score: number): string {
  if (score >= 82) return '🟩';
  if (score >= 42) return '🟨';
  if (score >= 22) return '🟧';
  return '🟥';
}

export function squaresFor(rounds: number[]): string {
  return rounds.map(squareFor).join('');
}

export function buildDailyShare(opts: {
  number: number;
  total: number;
  streak: number;
  rounds: number[];
  url: string;
}): string {
  const streakLine = opts.streak > 1 ? ` · 🔥 ${opts.streak}` : '';
  return `BOROUGH BLITZ #${opts.number}\n${opts.total}/${MAX_SCORE}${streakLine}\n${squaresFor(opts.rounds)}\n${opts.url}`;
}
