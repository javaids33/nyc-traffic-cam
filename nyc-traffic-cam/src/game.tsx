import { useCallback, useEffect, useRef, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterIcon, QuarterStash, RollingQuarter, useQuarters } from './quarter';

/* NYC slang typing game — gated by quarters, picks a difficulty mode. */

type Word = { word: string; gloss: string };

const SHORT_WORDS: Word[] = [
  { word: 'deadass', gloss: 'for real' },
  { word: 'mad', gloss: 'very' },
  { word: 'brick', gloss: 'cold' },
  { word: 'wylin', gloss: 'acting wild' },
  { word: 'lit', gloss: 'amazing' },
  { word: 'son', gloss: 'dude' },
  { word: 'bet', gloss: 'a done deal' },
  { word: 'tight', gloss: 'angry' },
  { word: 'salty', gloss: 'bitter' },
  { word: 'bodega', gloss: 'corner store' },
  { word: 'stoop', gloss: 'front steps' },
  { word: 'schlep', gloss: 'long trek' },
  { word: 'crib', gloss: 'home' },
  { word: 'whip', gloss: 'car' },
  { word: 'guap', gloss: 'money' },
  { word: 'jawn', gloss: 'a thing' },
  { word: 'shorty', gloss: 'a person' },
  { word: 'word', gloss: 'agreed' },
  { word: 'OD', gloss: 'overdoing it' },
  { word: 'no cap', gloss: 'no lie' },
  { word: 'Bk', gloss: 'Brooklyn' },
  { word: 'Bx', gloss: 'the Bronx' },
  { word: 'Qns', gloss: 'Queens' },
];

const MEDIUM_WORDS: Word[] = [
  { word: 'schmear', gloss: 'cream cheese' },
  { word: 'pork roll', gloss: 'NJ + NYC staple' },
  { word: 'pizza rat', gloss: 'icon' },
  { word: 'cabbie', gloss: 'taxi driver' },
  { word: 'subway', gloss: 'how you get around' },
  { word: 'metrocard', gloss: 'how you pay' },
  { word: 'L train', gloss: 'Brooklyn lifeline' },
  { word: 'the city', gloss: 'Manhattan' },
  { word: 'uptown', gloss: 'above 59th' },
  { word: 'downtown', gloss: 'below 14th' },
  { word: 'midtown', gloss: 'where the offices are' },
  { word: 'the rock', gloss: 'Staten Island' },
  { word: 'the Garden', gloss: 'MSG' },
  { word: 'the Belt', gloss: 'Belt Parkway' },
  { word: 'the BQE', gloss: 'Brooklyn-Queens Expwy' },
  { word: 'the FDR', gloss: 'east-side highway' },
  { word: 'the GW', gloss: 'George Washington Bridge' },
  { word: 'Yankees', gloss: 'the Bronx team' },
  { word: 'Mets', gloss: 'the Queens team' },
  { word: 'Knicks', gloss: 'MSG basketball' },
  { word: 'fronting', gloss: 'faking' },
  { word: 'dollar slice', gloss: 'cheap pizza' },
  { word: 'halal cart', gloss: 'street food' },
  { word: 'egg cream', gloss: 'no egg, no cream' },
  { word: 'good lookin', gloss: 'thanks' },
  { word: 'you good', gloss: 'are you ok' },
  { word: 'spilling tea', gloss: 'gossip' },
];

const HARD_WORDS: Word[] = [
  { word: 'fuhgeddaboudit', gloss: 'forget about it' },
  { word: 'chopped cheese', gloss: 'bodega sandwich' },
  { word: 'bacon egg cheese', gloss: 'BEC' },
  { word: 'Coney Island', gloss: 'south Brooklyn beach' },
  { word: 'Times Square', gloss: 'tourist trap' },
  { word: 'Empire State', gloss: 'the building' },
  { word: 'the Verrazzano', gloss: 'SI bridge' },
  { word: 'the boogie down', gloss: 'the Bronx' },
  { word: 'bridge and tunnel', gloss: 'not from the city' },
  { word: 'pork roll egg cheese', gloss: 'breakfast hero' },
  { word: 'Strivers Row', gloss: 'historic Harlem block' },
  { word: 'Fuhgeddaboudit', gloss: 'capitalized' },
  { word: 'Williamsburg Bridge', gloss: 'WBBR' },
  { word: 'Manhattan Bridge', gloss: 'Q & B trains' },
];

type Difficulty = 'easy' | 'medium' | 'hard';
type Status = 'idle' | 'playing' | 'over';

const DIFFICULTY_CFG: Record<Difficulty, { seconds: number; pool: Word[]; mult: number; label: string; color: string }> = {
  easy:   { seconds: 60, pool: [...SHORT_WORDS, ...MEDIUM_WORDS], mult: 1, label: 'EASY · 60s · 1×',   color: '#B5F500' },
  medium: { seconds: 45, pool: [...MEDIUM_WORDS, ...HARD_WORDS], mult: 1.5, label: 'MEDIUM · 45s · 1.5×', color: '#FFCC22' },
  hard:   { seconds: 30, pool: HARD_WORDS, mult: 2.5, label: 'HARD · 30s · 2.5×',   color: '#FF3A6C' },
};

export default function Game() {
  const [status, setStatus] = useState<Status>('idle');
  const [diff, setDiff] = useState<Difficulty>('easy');
  const [target, setTarget] = useState<Word>(SHORT_WORDS[0]);
  const [typed, setTyped] = useState('');
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [misses, setMisses] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(60);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { count: quarters, spend } = useQuarters();
  const [highScore, setHighScore] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return parseInt(localStorage.getItem('nyc-game-high') || '0', 10);
  });

  const newWord = useCallback((d: Difficulty = diff) => {
    const pool = DIFFICULTY_CFG[d].pool;
    let next = pool[Math.floor(Math.random() * pool.length)];
    if (next.word === target.word && pool.length > 1) {
      next = pool[(pool.indexOf(next) + 1) % pool.length];
    }
    setTarget(next);
    setTyped('');
  }, [diff, target.word]);

  const start = (d: Difficulty) => {
    if (!spend(1)) return;
    setDiff(d);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setMisses(0);
    setTyped('');
    setSecondsLeft(DIFFICULTY_CFG[d].seconds);
    const pool = DIFFICULTY_CFG[d].pool;
    setTarget(pool[Math.floor(Math.random() * pool.length)]);
    setStatus('playing');
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const finish = useCallback(() => {
    setStatus('over');
    setHighScore((prev) => {
      const next = Math.max(prev, score);
      try { localStorage.setItem('nyc-game-high', String(next)); } catch { /* noop */ }
      return next;
    });
  }, [score]);

  useEffect(() => {
    if (status !== 'playing') return;
    const i = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) { finish(); return 0; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(i);
  }, [status, finish]);

  useEffect(() => {
    if (status !== 'playing') return;
    if (typed.toLowerCase() === target.word.toLowerCase()) {
      const points = Math.round(target.word.length * DIFFICULTY_CFG[diff].mult);
      setScore((s) => s + points);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((b) => Math.max(b, next));
        return next;
      });
      newWord();
    }
  }, [typed, target.word, status, newWord, diff]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      setStreak(0);
      setMisses((m) => m + 1);
      newWord();
    }
  };

  return (
    <div className="min-h-screen w-screen flex flex-col text-white" style={{
      background: 'radial-gradient(ellipse at 50% 25%, #1a1530 0%, #0a0a18 55%, #06060c 100%)',
    }}>
      <BodegaAwning
        rightSlot={
          <a href="/" className="ml-2 px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]">
            ← LOUNGE
          </a>
        }
      />
      <QuarterStash />
      <RollingQuarter />

      <main className="flex-1 max-w-[760px] mx-auto px-6 py-8 z-10 w-full">
        <div className="font-bungee text-[44px] leading-[0.95] uppercase mb-2">
          JIMMY'S <span className="text-[#FFD600]">★</span> ARCADE
        </div>
        <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/65 mb-6">
          type the slang · TAB to skip · find quarters on the lounge
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
          <Hud label="TIME" value={`${secondsLeft}s`} tone={secondsLeft <= 10 ? 'crit' : 'phosphor'} />
          <Hud label="SCORE" value={score} />
          <Hud label="STREAK" value={`${streak} (best ${bestStreak})`} />
          <Hud label="QUARTERS" value={quarters} tone={quarters > 0 ? 'phosphor' : 'crit'} />
        </div>

        {status === 'idle' && (
          <div className="border border-[#FFD600]/40 p-6 bg-black/40">
            <p className="font-typewriter text-[14px] leading-relaxed text-white/85 mb-5">
              <span className="font-bungee text-[#FFD600] text-[18px]">★ INSERT COIN</span> — pick a difficulty.
              One quarter per round. Quarters roll across the lounge once in a while —
              click to grab them. Personal best stays in your browser.
            </p>

            {quarters > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {(Object.keys(DIFFICULTY_CFG) as Difficulty[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => start(d)}
                    className="group bg-black/60 border-2 hover:bg-black/80 transition-all p-4 text-left"
                    style={{ borderColor: DIFFICULTY_CFG[d].color, boxShadow: `4px 4px 0 #d11a2a` }}
                  >
                    <div className="flex items-center gap-2">
                      <QuarterIcon size={20} />
                      <span className="font-bungee text-[16px] uppercase" style={{ color: DIFFICULTY_CFG[d].color }}>
                        {d}
                      </span>
                    </div>
                    <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/65 mt-2">
                      {DIFFICULTY_CFG[d].label}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-center font-typewriter text-[12px] uppercase tracking-[0.22em] text-[#ff5582] py-4">
                ★ OUT OF QUARTERS ★<br/>
                <span className="text-white/65 normal-case tracking-normal">find one rolling across the <a href="/" className="text-[#FFD600] underline">lounge</a>.</span>
              </div>
            )}

            <div className="mt-5 font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/45">
              high score · {highScore} · longer rounds = more points · harder mode multiplies score
            </div>
          </div>
        )}

        {status === 'playing' && (
          <div className="border-2 p-6 bg-black/60" style={{ borderColor: DIFFICULTY_CFG[diff].color }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-[0.3em] font-typewriter text-[#FFD600]">
                type this
              </div>
              <div className="text-[10px] uppercase tracking-[0.22em] font-typewriter" style={{ color: DIFFICULTY_CFG[diff].color }}>
                {DIFFICULTY_CFG[diff].label}
              </div>
            </div>
            <div className="font-bungee text-center uppercase leading-none" style={{ fontSize: 'clamp(40px, 9vw, 96px)', color: DIFFICULTY_CFG[diff].color }}>
              {target.word}
            </div>
            <div className="text-center font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/55 mt-2">
              · {target.gloss} ·
            </div>
            <div className="mt-6">
              <input
                ref={inputRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={onKey}
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="type here…"
                className="w-full bg-black/50 border-2 border-[#FFD600]/60 focus:border-[#FFD600] outline-none px-4 py-3 font-tabloid text-[28px] uppercase tracking-wide text-white text-center"
              />
            </div>
            <div className="mt-3 text-center font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/45">
              TAB to skip · ESC quits · misses · {misses}
            </div>
          </div>
        )}

        {status === 'over' && (
          <div className="border border-[#FFD600]/60 p-6 bg-black/60 text-center">
            <div className="font-bungee text-[36px] uppercase text-[#FFD600] mb-2">★ GAME OVER ★</div>
            <div className="font-tabloid text-[64px] leading-none uppercase text-white mb-1">{score} pts</div>
            <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/65 mb-4">
              {DIFFICULTY_CFG[diff].label} · best streak {bestStreak} · misses {misses} · high score {highScore}
            </div>
            <div className="flex items-center justify-center gap-3 flex-wrap">
              {quarters > 0 ? (
                (Object.keys(DIFFICULTY_CFG) as Difficulty[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => start(d)}
                    className="font-bungee text-[14px] uppercase px-4 py-1.5 border-2"
                    style={{ borderColor: DIFFICULTY_CFG[d].color, color: DIFFICULTY_CFG[d].color, boxShadow: '3px 3px 0 #d11a2a' }}
                  >
                    ↻ {d}
                  </button>
                ))
              ) : (
                <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#ff5582]">
                  out of quarters · grab one on the <a href="/" className="text-[#FFD600] underline">lounge</a>
                </div>
              )}
              <a href="/" className="ml-2 font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 hover:text-[#FFD600]">
                back to lounge
              </a>
            </div>
          </div>
        )}

        <div className="mt-8 font-typewriter text-[10px] uppercase tracking-[0.2em] text-white/45">
          all slang and references via real New Yorkers · no AI-generated lingo, no cap
        </div>
      </main>

      <StreetFauna />
    </div>
  );
}

function Hud({ label, value, tone }: { label: string; value: string | number; tone?: 'phosphor' | 'amber' | 'crit' }) {
  const color = tone === 'crit' ? '#ff3a6c' : tone === 'amber' ? '#FFD600' : '#B5F500';
  return (
    <div className="border border-white/10 bg-black/40 px-3 py-2">
      <div className="text-[9px] uppercase tracking-[0.28em] font-typewriter text-white/55">{label}</div>
      <div className="font-tabloid text-[24px] leading-none mt-1" style={{ color }}>{value}</div>
    </div>
  );
}
