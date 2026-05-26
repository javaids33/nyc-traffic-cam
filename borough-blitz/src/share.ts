/* Challenge sharing — mint a pinned 5-camera run on the server (CF KV via a
 * Pages Function) and resolve one back. A shared `?h=<hash>` link replays the
 * exact same cameras for 24h; the seed in the URL is the offline fallback. */

import type { Mode } from './cams';

export type Modifiers = {
  grayscale: boolean;
  timerSec: 0 | 30 | 60;
  noZoom: boolean;
};

export const DEFAULT_MODIFIERS: Modifiers = { grayscale: false, timerSec: 0, noZoom: false };

export type FetchedChallenge = {
  hash: string;
  cameras: string[];
  score: number | null;
  grade: string | null;
  difficulty: Mode | null;
  modifiers: Modifiers | null;
  expires_at: number;
};

export async function mintChallenge(input: {
  cameras: string[];
  score: number;
  grade: string;
  difficulty: Mode;
  modifiers: Modifiers;
}): Promise<string> {
  const r = await fetch('/api/challenges', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const detail = (await r.json().catch(() => null))?.detail ?? `${r.status}`;
    throw new Error(String(detail));
  }
  const j = (await r.json()) as { hash: string };
  return j.hash;
}

export async function fetchChallenge(hash: string): Promise<FetchedChallenge> {
  const r = await fetch(`/api/challenges/${hash}`);
  if (!r.ok) {
    throw new Error(r.status === 404 ? 'expired' : `http ${r.status}`);
  }
  return (await r.json()) as FetchedChallenge;
}
