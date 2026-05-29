import { useEffect, useRef, useState } from 'react';
import { GuessMap } from './components/guess-map';
import { ZoomableCam } from './components/zoomable-cam';
import { NYCTMC_IMG, type Cam, type Mode } from './cams';
import { bandFor, fmtDist, ROUNDS } from './scoring';
import type { LngLat, RoundState } from './game-types';
import type { Modifiers } from './share';

const MODE_COLOR: Record<Mode, string> = {
  easy: '#37c46b',
  medium: '#FFD400',
  hard: '#FF4D2E',
  daily: '#37a0ff',
};

export function RoundView({
  roundIdx,
  cam,
  tick,
  round,
  rounds,
  revealed,
  totalScore,
  mode,
  mods,
  banner,
  onGuess,
  onLock,
  onForceLock,
  onNext,
  onHome,
}: {
  roundIdx: number;
  cam: Cam | undefined;
  tick: number;
  round: RoundState | undefined;
  rounds: RoundState[];
  revealed: boolean;
  totalScore: number;
  mode: Mode;
  mods: Modifiers;
  banner: string | null;
  onGuess: (g: LngLat) => void;
  onLock: () => void;
  onForceLock: () => void;
  onNext: () => void;
  onHome: () => void;
}) {
  const guess = round?.guess ?? null;
  const [open, setOpen] = useState(false);
  const canHover = useRef(false);
  useEffect(() => {
    canHover.current = window.matchMedia?.('(hover:hover) and (pointer:fine)').matches ?? false;
  }, []);

  // On phones the full-bleed cam + corner-map overlay is unusable: a wide
  // (≈3:2) cam scaled to cover a tall portrait viewport gets sliced to a
  // zoomed-in centre strip. Below 640px we switch to a stacked layout —
  // the cam in its own landscape strip up top (shown whole, not cropped)
  // and the map filling the space beneath it.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Mobile keeps the map permanently expanded (it owns the bottom half);
  // desktop preserves the hover/tap-to-expand corner behaviour.
  const isOpen = isMobile ? true : open || revealed;

  // collapse the map at the start of each fresh round
  useEffect(() => {
    setOpen(false);
  }, [roundIdx]);

  // ── per-round countdown (timer modifier) ─────────────────────────────
  const timed = mods.timerSec > 0;
  const [remain, setRemain] = useState<number>(mods.timerSec);
  useEffect(() => {
    setRemain(mods.timerSec);
  }, [roundIdx, mods.timerSec]);
  useEffect(() => {
    if (!timed || revealed || !cam) return;
    if (remain <= 0) {
      onForceLock();
      return;
    }
    const id = window.setTimeout(() => setRemain((r) => r - 1), 1000);
    return () => clearTimeout(id);
  }, [timed, revealed, cam, remain, onForceLock]);

  const band = round?.distance != null && Number.isFinite(round.distance) ? bandFor(round.distance) : null;

  return (
    <div className={`absolute inset-0 overflow-hidden bg-black ${isMobile ? 'flex flex-col' : ''}`}>
      {/* CAM REGION — on mobile a fixed landscape strip up top; on desktop
          `contents` dissolves the wrapper so the cam + overlays fill the
          whole screen exactly as before. */}
      <div
        className={isMobile ? 'relative w-full shrink-0 bg-black' : 'contents'}
        style={isMobile ? { aspectRatio: '22 / 15' } : undefined}
      >
        {/* live feed */}
        {cam ? (
          <ZoomableCam
            src={NYCTMC_IMG(cam.id, tick)}
            alt="guess where this NYC camera is"
            grayscale={mods.grayscale}
            noZoom={mods.noZoom}
            resetKey={cam.id}
            fit={isMobile ? 'contain' : 'cover'}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <span className="animate-pulse font-mono text-[12px] uppercase tracking-[0.3em] text-taxi/60">
              loading camera pool…
            </span>
          </div>
        )}

        {/* surveillance overlay (purely decorative, never blocks input) */}
        <div className="pointer-events-none absolute inset-0 z-10 cctv-scanlines cctv-vignette cctv-corners grain">
          <div className="scan-beam absolute inset-x-0 top-0 animate-scan" />
        </div>

        {/* ── top HUD ──────────────────────────────────────────────────── */}
        <div className="safe-t absolute inset-x-0 top-0 z-30 flex items-start justify-between gap-2 px-3 pt-3">
          <div className="flex items-center gap-2">
            <span className="grid h-7 w-7 place-items-center bg-taxi font-bungee text-[12px] text-night-950">
              BB
            </span>
            <div className="leading-none">
              <div className="font-bungee text-[13px] uppercase tracking-[0.04em] text-taxi sm:text-[15px]">
                borough blitz
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/55">
                <span className="h-2 w-2 rounded-full" style={{ background: MODE_COLOR[mode] }} />
                {mode}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {timed && !revealed && (
              <div
                className="bg-black/75 px-2 py-1 font-mono text-[14px] tabular"
                style={{ color: remain <= 10 ? '#FF4D2E' : '#FFD400' }}
              >
                {String(remain).padStart(2, '0')}s
              </div>
            )}
            <div className="bg-black/75 px-2.5 py-1 text-right leading-none">
              <div className="font-bungee text-[16px] text-taxi tabular sm:text-[18px]">{totalScore}</div>
              <div className="font-mono text-[8px] uppercase tracking-[0.2em] text-white/45">score</div>
            </div>
            <button
              type="button"
              onClick={onHome}
              title="back to menu"
              className="grid h-8 w-8 place-items-center border border-white/20 bg-black/60 font-mono text-[14px] text-white/70 hover:border-taxi hover:text-taxi"
            >
              ✕
            </button>
          </div>
        </div>

        {/* round dots */}
        <div className="absolute left-1/2 top-[58px] z-30 flex -translate-x-1/2 items-center gap-1.5">
          {rounds.map((r, i) => {
            const done = r.score != null;
            const here = i === roundIdx;
            return (
              <span
                key={i}
                className="block rounded-full transition-all"
                style={{
                  width: here ? 11 : 7,
                  height: here ? 11 : 7,
                  background: done ? '#FFD400' : here ? '#fff' : 'rgba(255,255,255,0.22)',
                  boxShadow: here ? '0 0 8px #FFD400' : 'none',
                }}
                title={done ? `round ${i + 1}: +${r.score}` : `round ${i + 1}`}
              />
            );
          })}
        </div>

        {/* banner (challenge / fallback notice) */}
        {banner && !revealed && (
          <div className="absolute left-1/2 top-[86px] z-30 max-w-[92vw] -translate-x-1/2 border border-taxi bg-black/85 px-3 py-1.5 text-center font-mono text-[10px] uppercase tracking-[0.12em] text-taxi">
            ★ {banner}
          </div>
        )}

        {/* ── cam OSD (bottom-left) ────────────────────────────────────── */}
        <div className="safe-b pointer-events-none absolute bottom-0 left-0 z-20 max-w-[60vw] p-3">
          <div className="inline-flex items-center gap-2 bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em]">
            <span className="h-2 w-2 animate-rec-blink rounded-full bg-blitz" />
            <span className="text-blitz">rec</span>
            <span className="text-white/65 tabular">{new Date(tick).toLocaleTimeString('en-US', { hour12: false })}</span>
          </div>
          <div className="mt-1.5 font-bungee text-[15px] uppercase leading-tight tracking-[0.04em] text-taxi sm:text-[18px]">
            round {roundIdx + 1}/{ROUNDS} · where in nyc?
          </div>
          {revealed && cam && (
            <div className="mt-1 max-w-full truncate bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.1em] text-white">
              ✓ {cam.name ?? cam.id}
            </div>
          )}
          {!revealed && !mods.noZoom && cam && (
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
              {isMobile ? 'double-tap or pinch to zoom the feed' : 'scroll / double-tap to zoom the feed'}
            </div>
          )}
        </div>
      </div>
      {/* ── END cam region ───────────────────────────────────────────── */}

      {/* ── map panel — bottom half on mobile, expandable corner on desktop ── */}
      <div
        className={isMobile ? 'relative z-40 min-h-0 flex-1' : 'safe-b absolute bottom-0 right-0 z-40 p-3'}
        onMouseEnter={() => canHover.current && !revealed && setOpen(true)}
        onMouseLeave={() => {
          if (canHover.current && !guess && !revealed) setOpen(false);
        }}
      >
        <div
          className={`relative overflow-hidden border-taxi bg-night-900 ${
            isMobile
              ? 'h-full w-full border-t-2'
              : 'border-2 shadow-hard transition-[width,height] duration-300 ease-out'
          }`}
          style={
            isMobile
              ? undefined
              : isOpen
                ? { width: 'min(560px, calc(100vw - 24px))', height: 'min(62vh, 440px)' }
                : { width: 'clamp(128px, 40vw, 220px)', height: 'clamp(94px, 28vw, 150px)' }
          }
        >
          <GuessMap guess={guess} cam={cam} revealed={revealed} onGuess={onGuess} />

          {/* collapsed launcher */}
          {!isOpen && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="absolute inset-0 z-10 grid place-items-center bg-night-950/45"
            >
              <span className="bg-taxi px-2 py-1 font-bungee text-[12px] uppercase tracking-[0.06em] text-night-950 shadow-hard">
                {guess ? '✎ edit pin' : '▸ drop pin'}
              </span>
            </button>
          )}

          {/* open header strip */}
          {isOpen && !revealed && (
            <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between bg-black/70 px-2 py-1">
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-taxi">
                {guess ? 'drag-free · tap to move pin' : 'tap the map to drop a pin'}
              </span>
              {!isMobile && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  title="peek at the feed"
                  className="font-mono text-[11px] text-white/60 hover:text-taxi"
                >
                  ⤡
                </button>
              )}
            </div>
          )}

          {/* reveal result strip */}
          {revealed && band && round?.distance != null && (
            <div className="absolute inset-x-0 top-0 z-10 bg-black/82 px-2.5 py-2 animate-panel-in">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="px-2 py-0.5 font-bungee text-[12px] uppercase tracking-[0.04em]"
                  style={{ background: band.color, color: '#070809', boxShadow: '2px 2px 0 #070809' }}
                >
                  {band.emoji} {band.label}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-white/80 tabular">
                  off · <span className="text-taxi">{fmtDist(round.distance)}</span>
                </span>
                <span className="font-tabloid text-[26px] leading-none text-taxi tabular">
                  +{round.score}
                </span>
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.12em] text-white/55">
                {round.timedOut ? "⏱ time's up — " : ''}
                {band.blurb}
              </div>
            </div>
          )}

          {/* footer action */}
          {isOpen && (
            <div className={`absolute inset-x-0 bottom-0 z-10 p-2 ${isMobile ? 'safe-b' : ''}`}>
              {!revealed ? (
                <button
                  type="button"
                  onClick={onLock}
                  disabled={!guess}
                  className="btn-blitz w-full px-3 py-2.5 font-bungee text-[15px] uppercase tracking-[0.04em]"
                >
                  {guess ? '★ lock it in ★' : 'drop a pin first'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onNext}
                  className="w-full border-2 border-night-950 bg-blitz px-3 py-2.5 font-bungee text-[15px] uppercase tracking-[0.04em] text-white shadow-hard"
                >
                  {roundIdx >= ROUNDS - 1 ? '★ see final score ★' : 'next round →'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
