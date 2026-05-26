import { useEffect, useMemo, useState } from 'react';
import { ALL_CAMS, CAMERA_LIST_DATE, NYCTMC_IMG, TIER_COUNTS, type Tier } from './cams';
import { DEFAULT_MODIFIERS, type Modifiers } from './share';
import { ROUNDS } from './scoring';
import { AdSlot } from './ads';

const TIERS: { id: Tier; sub: string; color: string }[] = [
  { id: 'easy', sub: 'landmarks & the core · you know these', color: '#37c46b' },
  { id: 'medium', sub: 'bridges, arterials, commercial corners', color: '#FFD400' },
  { id: 'hard', sub: 'anonymous blocks · could be anywhere', color: '#FF4D2E' },
];

type DailyStatus = { playedDate: string | null; best: number | null };

export function Start({
  onStart,
  onDaily,
  daily,
}: {
  onStart: (tier: Tier, mods: Modifiers) => void;
  onDaily: () => void;
  daily: DailyStatus;
}) {
  const [tier, setTier] = useState<Tier>('medium');
  const [mods, setMods] = useState<Modifiers>(DEFAULT_MODIFIERS);

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

  return (
    <div className="scroll-area h-full w-full">
      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col px-4 py-6 safe-t safe-b">
        {/* checker bar + wordmark */}
        <header className="mb-5">
          <div
            className="mb-3 h-3 w-full"
            style={{
              backgroundImage:
                'repeating-linear-gradient(90deg,#FFD400 0 18px,#070809 18px 36px)',
            }}
          />
          <h1 className="font-bungee text-[42px] leading-[0.9] tracking-tight text-taxi sm:text-[58px]">
            BOROUGH
            <br />
            <span className="text-blitz">BLITZ</span>
          </h1>
          <p className="mt-2 font-mono text-[12px] uppercase tracking-[0.18em] text-white/70">
            spot the nyc traffic cam · {ROUNDS} rounds · drop a pin · closer = more points
          </p>
        </header>

        {/* hero feed teaser */}
        <div className="relative mb-6 aspect-video w-full overflow-hidden border-2 border-taxi/35 bg-black cctv-scanlines cctv-vignette cctv-corners grain">
          {hero && (
            <img
              key={hero.id + beat}
              src={NYCTMC_IMG(hero.id, beat)}
              alt="live NYC traffic camera"
              referrerPolicy="no-referrer"
              decoding="async"
              className="h-full w-full object-cover opacity-90"
              style={{ filter: 'contrast(1.05) saturate(1.05)' }}
            />
          )}
          <div className="absolute left-3 top-3 z-10 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white">
            <span className="h-2 w-2 animate-rec-blink rounded-full bg-blitz" />
            <span className="text-blitz">rec</span>
            <span className="text-white/70">· live nyc dot feed</span>
          </div>
          <div className="absolute bottom-3 left-3 z-10 bg-black/80 px-2 py-1 font-bungee text-[13px] uppercase tracking-[0.08em] text-taxi">
            ★ where in nyc is this?
          </div>
          <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
            <div className="scan-beam absolute inset-x-0 top-0 animate-scan" />
          </div>
        </div>

        {/* difficulty bullets */}
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/55">
          choose your line
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

        {/* modifiers */}
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.28em] text-white/55">
          modifiers
        </div>
        <div className="mb-6 flex flex-wrap gap-2">
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

        {/* play */}
        <button
          type="button"
          onClick={() => onStart(tier, mods)}
          className="btn-blitz mb-3 w-full px-4 py-4 font-bungee text-[22px] uppercase tracking-[0.04em]"
        >
          ▶ play {tier}
        </button>

        {/* daily */}
        <button
          type="button"
          onClick={onDaily}
          className="btn-ghost mb-6 flex w-full items-center justify-between px-4 py-3 font-bungee text-[14px] uppercase tracking-[0.06em]"
        >
          <span>★ daily challenge</span>
          <span className="font-mono text-[10px] tracking-[0.12em] text-white/55">
            {daily.playedDate
              ? `played · best ${daily.best ?? 0}`
              : 'same 5 cams citywide · today'}
          </span>
        </button>

        <AdSlot name="start" className="mb-6" />

        <footer className="mt-auto border-t border-white/10 pt-4 font-mono text-[10px] uppercase leading-relaxed tracking-[0.12em] text-white/35">
          <p>
            live frames © nyc dot traffic management center · public feed · camera list as of{' '}
            {CAMERA_LIST_DATE.toISOString().slice(0, 10)}
          </p>
          <p className="mt-1">
            a borough blitz joint · made in nyc · not affiliated with nyc dot or geoguessr
          </p>
        </footer>
      </div>
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
