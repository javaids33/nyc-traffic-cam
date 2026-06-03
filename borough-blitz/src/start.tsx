import { useEffect, useMemo, useState } from 'react';
import { ALL_CAMS, CAMERA_LIST_DATE, NYCTMC_IMG, TIER_COUNTS, type Tier } from './cams';
import { DEFAULT_MODIFIERS, type Modifiers } from './share';
import { ROUNDS, MAX_SCORE } from './scoring';
import { AdSlot } from './ads';
import { StatsModal } from './stats-modal';
import { dateLabel, type DailyView } from './stats';

const TIERS: { id: Tier; sub: string; color: string }[] = [
  { id: 'easy', sub: 'landmarks & the core · you know these', color: '#37c46b' },
  { id: 'medium', sub: 'bridges, arterials, commercial corners', color: '#FFD400' },
  { id: 'hard', sub: 'anonymous blocks · could be anywhere', color: '#FF4D2E' },
];

export function Start({
  onStart,
  onDaily,
  daily,
}: {
  onStart: (tier: Tier, mods: Modifiers) => void;
  onDaily: () => void;
  daily: DailyView;
}) {
  const [tier, setTier] = useState<Tier>('medium');
  const [mods, setMods] = useState<Modifiers>(DEFAULT_MODIFIERS);
  const [showStats, setShowStats] = useState(false);

  // Rotating hero teaser — a recognizable cam frame under the CCTV overlay.
  const heroPool = useMemo(() => ALL_CAMS.filter((c) => c.tier === 'easy'), []);
  const [heroIdx, setHeroIdx] = useState(() => Math.floor(Math.random() * Math.max(1, heroPool.length)));
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const i = setInterval(() => {
      setHeroIdx((p) => (p + 1) % Math.max(1, heroPool.length));
      setBeat(Date.now());
    }, 4200);
    return () => clearInterval(i);
  }, [heroPool.length]);
  const hero = heroPool[heroIdx];

  const cycleTimer = () =>
    setMods((m) => ({ ...m, timerSec: m.timerSec === 0 ? 60 : m.timerSec === 60 ? 30 : 0 }));

  const playedToday = daily.todayScore != null;

  return (
    <div className="scroll-area h-full w-full">
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-4 py-6 safe-t safe-b">
        {/* checker bar + wordmark + stats */}
        <header className="mb-5">
          <div
            className="mb-3 h-3 w-full"
            style={{ backgroundImage: 'repeating-linear-gradient(90deg,#FFD400 0 18px,#070809 18px 36px)' }}
          />
          <div className="flex items-end justify-between gap-3">
            <h1 className="font-bungee text-[42px] leading-[0.9] tracking-tight text-taxi sm:text-[58px]">
              BOROUGH
              <br />
              <span className="text-blitz">BLITZ</span>
            </h1>
            <button
              type="button"
              onClick={() => setShowStats(true)}
              className="btn-ghost mb-1 shrink-0 px-3 py-1.5 font-bungee text-[12px] uppercase tracking-[0.08em]"
            >
              {daily.streak > 0 ? `🔥 ${daily.streak}` : '★'} stats
            </button>
          </div>
          <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.18em] text-white/70">
            spot the nyc traffic cam · drop a pin · closer = more points
          </p>
        </header>

        {/* ── TODAY'S BLITZ — the daily, front and center ───────────────── */}
        <section className="relative mb-6 overflow-hidden border-2 border-taxi shadow-hard-blitz">
          <div className="relative aspect-[16/7] w-full bg-black cctv-scanlines grain">
            {hero && (
              <img
                key={hero.id + beat}
                src={NYCTMC_IMG(hero.id, beat)}
                alt="live NYC traffic camera"
                referrerPolicy="no-referrer"
                decoding="async"
                className="h-full w-full object-cover opacity-70"
              />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-night-950 via-night-950/55 to-transparent" />
            <div className="absolute left-3 top-3 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em]">
              <span className="h-2 w-2 animate-rec-blink rounded-full bg-blitz" />
              <span className="text-blitz">live</span>
            </div>
            <div className="absolute inset-x-0 bottom-0 p-4">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-white/60">
                    today's blitz
                  </div>
                  <div className="font-bungee text-[26px] uppercase leading-none text-taxi sm:text-[32px]">
                    daily · {dateLabel(daily.date)}
                  </div>
                  <div className="mt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-white/75">
                    {daily.streak > 0 ? (
                      <span className="text-blitz">🔥 {daily.streak}-day streak</span>
                    ) : (
                      'start your streak today'
                    )}
                    {playedToday && (
                      <span className="text-white/55">
                        {' · '}✓ best {daily.todayScore}/{MAX_SCORE}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={onDaily}
                className="btn-blitz mt-3 w-full px-4 py-3 font-bungee text-[18px] uppercase tracking-[0.04em]"
              >
                {playedToday ? '↻ replay today' : "▶ play today's 5"}
              </button>
            </div>
          </div>
        </section>

        {/* ── FREE PLAY ─────────────────────────────────────────────────── */}
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/55">
          or free play · pick a line
        </div>
        <div className="mb-5 grid gap-2">
          {TIERS.map((t) => {
            const active = tier === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTier(t.id)}
                className="flex items-center gap-3 border-2 px-3 py-3 text-left transition-colors"
                style={{
                  borderColor: active ? t.color : 'rgba(255,255,255,0.12)',
                  background: active ? 'rgba(255,255,255,0.04)' : 'transparent',
                  boxShadow: active ? `inset 4px 0 0 ${t.color}` : 'none',
                }}
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full font-bungee text-[15px]"
                  style={{ background: t.color, color: '#070809' }}
                >
                  {t.id[0].toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-bungee text-[16px] uppercase tracking-[0.04em] text-white">
                    {t.id}
                  </span>
                  <span className="block truncate font-mono text-[10px] uppercase tracking-[0.12em] text-white/55">
                    {t.sub}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-white/40 tabular">
                  {TIER_COUNTS[t.id]} cams
                </span>
              </button>
            );
          })}
        </div>

        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/55">modifiers</div>
        <div className="mb-5 flex flex-wrap gap-2">
          <Chip on={mods.grayscale} onClick={() => setMods((m) => ({ ...m, grayscale: !m.grayscale }))}>
            ◐ grayscale
          </Chip>
          <Chip on={mods.timerSec > 0} onClick={cycleTimer}>
            ⏱ timer{mods.timerSec > 0 ? ` · ${mods.timerSec}s` : ' · off'}
          </Chip>
          <Chip on={mods.noZoom} onClick={() => setMods((m) => ({ ...m, noZoom: !m.noZoom }))}>
            ⊘ no zoom
          </Chip>
        </div>

        <button
          type="button"
          onClick={() => onStart(tier, mods)}
          className="btn-ghost mb-6 w-full px-4 py-3 font-bungee text-[16px] uppercase tracking-[0.04em]"
        >
          ▶ free play · {tier} · {ROUNDS} rounds
        </button>

        <AdSlot name="start" className="mb-6" />

        <footer className="mt-auto border-t border-white/10 pt-4 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/35">
          <p>
            live frames © nyc dot traffic management center · public feed · camera list as of{' '}
            {CAMERA_LIST_DATE.toISOString().slice(0, 10)}
          </p>
          <p className="mt-1">a borough blitz joint · made in nyc · not affiliated with nyc dot or geoguessr</p>
        </footer>
      </div>

      {showStats && <StatsModal view={daily} onClose={() => setShowStats(false)} />}
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="border-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.1em] transition-colors"
      style={{
        borderColor: on ? '#FFD400' : 'rgba(255,255,255,0.14)',
        background: on ? 'rgba(255,212,0,0.12)' : 'transparent',
        color: on ? '#FFD400' : 'rgba(255,255,255,0.6)',
      }}
    >
      {children}
    </button>
  );
}
