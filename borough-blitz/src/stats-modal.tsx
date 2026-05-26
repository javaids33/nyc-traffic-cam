import { MAX_SCORE } from './scoring';
import type { DailyView } from './stats';

function Sparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) {
    return (
      <div className="grid h-[60px] place-items-center font-mono text-[10px] uppercase tracking-[0.2em] text-white/35">
        play a few dailies to chart your form
      </div>
    );
  }
  const w = 280;
  const h = 60;
  const pts = scores.map((s, i) => {
    const x = (i / (scores.length - 1)) * w;
    const y = h - (Math.max(0, Math.min(MAX_SCORE, s)) / MAX_SCORE) * h;
    return [x, y] as const;
  });
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[60px] w-full" preserveAspectRatio="none" aria-hidden>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="rgba(255,212,0,0.12)" />
      <path d={d} fill="none" stroke="#FFD400" strokeWidth="2" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill="#FF4D2E" />
    </svg>
  );
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="bg-night-800/70 px-2 py-3 text-center">
      <div
        className="font-tabloid text-[28px] leading-none tabular"
        style={{ color: accent ? '#FF4D2E' : '#FFD400' }}
      >
        {value}
      </div>
      <div className="mt-1 font-mono text-[8px] uppercase tracking-[0.16em] text-white/45">{label}</div>
    </div>
  );
}

export function StatsModal({ view, onClose }: { view: DailyView; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[420px] border-2 border-taxi bg-night-900 p-5 shadow-hard-blitz animate-panel-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-bungee text-[20px] uppercase tracking-[0.04em] text-taxi">★ your stats</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center border border-white/20 font-mono text-white/70 hover:border-taxi hover:text-taxi"
          >
            ✕
          </button>
        </div>

        <div className="mb-4 grid grid-cols-4 gap-1.5">
          <Stat label="played" value={view.played} />
          <Stat label="streak" value={view.streak} accent={view.streak > 0} />
          <Stat label="max streak" value={view.maxStreak} />
          <Stat label="best" value={view.bestEver} />
        </div>
        <div className="mb-4 grid grid-cols-2 gap-1.5">
          <Stat label="avg daily" value={view.avg} />
          <Stat label="today" value={view.todayScore ?? '—'} />
        </div>

        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.24em] text-white/45">
          recent dailies
        </div>
        <Sparkline scores={view.history.map((h) => h.score)} />

        <button
          type="button"
          onClick={onClose}
          className="btn-blitz mt-4 w-full px-3 py-2.5 font-bungee text-[14px] uppercase tracking-[0.04em]"
        >
          back
        </button>
      </div>
    </div>
  );
}
