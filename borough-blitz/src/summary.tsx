import { useEffect, useState } from 'react';
import confetti from 'canvas-confetti';
import type { Cam, Mode } from './cams';
import type { RoundState } from './game-types';
import { bandFor, fmtDist, gradeFor, MAX_SCORE } from './scoring';
import { mintChallenge, type FetchedChallenge, type Modifiers } from './share';
import { AdSlot } from './ads';

function fireConfetti(big: boolean) {
  const opts = {
    particleCount: big ? 160 : 80,
    spread: 78,
    startVelocity: big ? 55 : 42,
    origin: { y: 0.55 },
    colors: ['#FFD400', '#FF4D2E', '#39FF6A', '#37a0ff', '#ffffff'],
  };
  try {
    confetti(opts);
    if (big) {
      setTimeout(() => confetti({ ...opts, angle: 60, origin: { x: 0, y: 0.65 } }), 200);
      setTimeout(() => confetti({ ...opts, angle: 120, origin: { x: 1, y: 0.65 } }), 250);
    }
  } catch {
    /* noop */
  }
}

function modifierBlurb(m: Modifiers): string {
  const parts: string[] = [];
  if (m.grayscale) parts.push('grayscale');
  if (m.timerSec > 0) parts.push(`${m.timerSec}s timer`);
  if (m.noZoom) parts.push('no zoom');
  return parts.length ? ` · ${parts.join(' + ')}` : '';
}

export function Summary({
  rounds,
  roundCameras,
  totalScore,
  mode,
  mods,
  seed,
  challenge,
  friendScore,
  onNewGame,
  onHome,
}: {
  rounds: RoundState[];
  roundCameras: Cam[];
  totalScore: number;
  mode: Mode;
  mods: Modifiers;
  seed: string;
  challenge: FetchedChallenge | null;
  friendScore: number | null;
  onNewGame: () => void;
  onHome: () => void;
}) {
  const grade = gradeFor(totalScore);
  const [shareHash, setShareHash] = useState<string | null>(challenge?.hash ?? null);
  const [minting, setMinting] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'text' | null>(null);

  useEffect(() => {
    const pct = totalScore / MAX_SCORE;
    if (pct >= 0.65) fireConfetti(true);
    else if (pct >= 0.4) fireConfetti(false);
  }, [totalScore]);

  // Lazily mint a server-pinned challenge the first time the player shares,
  // so casual players never touch the backend. Falls back to the seed link.
  const ensureHash = async (): Promise<string | null> => {
    if (shareHash) return shareHash;
    if (minting) return null;
    setMinting(true);
    setShareError(null);
    try {
      const hash = await mintChallenge({
        cameras: roundCameras.map((c) => c.id),
        score: totalScore,
        grade: grade.label,
        difficulty: mode,
        modifiers: mods,
      });
      setShareHash(hash);
      return hash;
    } catch (e) {
      setShareError(`couldn't mint link · ${e instanceof Error ? e.message : 'error'} · using seed link`);
      return null;
    } finally {
      setMinting(false);
    }
  };

  const buildUrl = (hash: string | null): string => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://borough-blitz.pages.dev';
    const u = new URL(origin + '/');
    if (hash) {
      u.searchParams.set('h', hash);
    } else {
      // Seed fallback — reproduces the same cams deterministically.
      u.searchParams.set('seed', seed);
      u.searchParams.set('d', mode);
      u.searchParams.set('score', String(totalScore));
      if (mods.grayscale) u.searchParams.set('g', '1');
      if (mods.timerSec) u.searchParams.set('t', String(mods.timerSec));
      if (mods.noZoom) u.searchParams.set('nz', '1');
    }
    return u.toString();
  };

  const liveUrl = buildUrl(shareHash);

  const doCopy = async (kind: 'url' | 'text') => {
    const hash = await ensureHash();
    const url = buildUrl(hash);
    const text = `★ BOROUGH BLITZ\nI scored ${totalScore}/${MAX_SCORE} — ${grade.label} (${mode}${modifierBlurb(mods)}).\nPlay the same 5 cams: ${url}`;
    try {
      await navigator.clipboard.writeText(kind === 'url' ? url : text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1700);
    } catch {
      /* clipboard blocked */
    }
  };

  const doShare = async () => {
    const hash = await ensureHash();
    const url = buildUrl(hash);
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await (navigator as Navigator & { share: (d: { title: string; text: string; url: string }) => Promise<void> }).share({
          title: 'Borough Blitz',
          text: `I scored ${totalScore}/${MAX_SCORE} — ${grade.label}. Beat me:`,
          url,
        });
        return;
      } catch {
        /* cancelled */
      }
    }
    doCopy('text');
  };

  const beatFriend =
    friendScore != null
      ? totalScore > friendScore
        ? 'you beat them ★'
        : totalScore === friendScore
          ? 'dead tie'
          : 'they got you'
      : null;

  return (
    <div className="scroll-area h-full w-full">
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-4 py-6 safe-t safe-b">
        {/* final score */}
        <div className="mb-6 text-center">
          <div className="font-bungee text-[26px] uppercase tracking-[0.12em] text-white/80">
            <span className="relative inline-block">
              ★ final ★
              <span className="absolute -bottom-1 left-0 h-[3px] w-full bg-blitz" />
            </span>
          </div>
          <div
            className="mt-3 font-tabloid text-[90px] leading-none tabular animate-count-up sm:text-[110px]"
            style={{ color: grade.color }}
          >
            {totalScore}
            <span className="text-[40px] text-white/40"> / {MAX_SCORE}</span>
          </div>
          <div className="mt-2 font-bungee text-[18px] uppercase tracking-[0.04em]" style={{ color: grade.color }}>
            ★ {grade.label} ★
          </div>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-white/45">
            {mode}
            {modifierBlurb(mods)}
          </div>
          {friendScore != null && (
            <div className="mt-3 inline-block border border-white/15 bg-night-800/70 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-white/80">
              friend · {friendScore} · <span className="text-taxi">{beatFriend}</span>
            </div>
          )}
        </div>

        {/* round breakdown */}
        <div className="mb-6 grid grid-cols-5 gap-1.5">
          {rounds.map((r, i) => {
            const cam = roundCameras[i];
            const band = r.distance != null && Number.isFinite(r.distance) ? bandFor(r.distance) : null;
            return (
              <div
                key={i}
                className="bg-night-800/70 p-1.5"
                style={{ borderTop: `3px solid ${band ? band.color : 'rgba(255,212,0,0.3)'}` }}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-bungee text-[10px] uppercase text-taxi">R{i + 1}</span>
                  <span className="font-tabloid text-[16px] tabular text-white">+{r.score ?? 0}</span>
                </div>
                {band && (
                  <div className="mt-1 text-[13px] leading-none" title={band.label}>
                    {band.emoji}
                  </div>
                )}
                <div className="mt-1 line-clamp-2 font-mono text-[8px] uppercase leading-tight tracking-[0.08em] text-white/50">
                  {cam?.name ?? '—'}
                </div>
                {r.distance != null && Number.isFinite(r.distance) && (
                  <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.08em] text-white/35 tabular">
                    {fmtDist(r.distance)}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* share */}
        <div className="mb-5 border-2 border-taxi bg-night-900 p-4 shadow-hard-blitz">
          <div className="font-bungee text-[16px] uppercase tracking-[0.04em] text-taxi">★ challenge a friend</div>
          <div className="mb-3 mt-1 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/60">
            send this link — they play the exact same 5 cameras and try to beat your score
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            <button onClick={doShare} className="btn-blitz px-3 py-2 font-bungee text-[13px] uppercase tracking-[0.04em]">
              ★ share
            </button>
            <button onClick={() => doCopy('url')} className="btn-ghost px-3 py-2 font-bungee text-[13px] uppercase tracking-[0.04em]">
              {copied === 'url' ? '✓ copied' : 'copy link'}
            </button>
            <button onClick={() => doCopy('text')} className="btn-ghost px-3 py-2 font-bungee text-[13px] uppercase tracking-[0.04em]">
              {copied === 'text' ? '✓ copied' : 'copy brag'}
            </button>
          </div>
          <input
            readOnly
            value={liveUrl}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full border border-white/15 bg-night-950 px-2 py-1.5 font-mono text-[11px] text-white/85"
          />
          <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
            {minting
              ? '⚙ minting share link…'
              : shareHash
                ? <>challenge · <span className="text-taxi">{shareHash}</span> · same 5 cams pinned 24h</>
                : 'a real challenge link is minted the moment you share or copy'}
          </div>
          {shareError && (
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-blitz">★ {shareError}</div>
          )}
        </div>

        {/* actions */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={onNewGame}
            className="flex-1 border-2 border-night-950 bg-blitz px-3 py-3 font-bungee text-[15px] uppercase tracking-[0.04em] text-white shadow-hard"
          >
            ↻ new game
          </button>
          <button onClick={onHome} className="btn-ghost px-4 py-3 font-bungee text-[15px] uppercase tracking-[0.04em]">
            ⌂ menu
          </button>
        </div>

        <AdSlot name="summary" className="mb-4" />

        <footer className="mt-auto border-t border-white/10 pt-4 font-mono text-[9px] uppercase tracking-[0.12em] text-white/30">
          borough blitz · live frames © nyc dot · not affiliated with nyc dot or geoguessr
        </footer>
      </div>
    </div>
  );
}
