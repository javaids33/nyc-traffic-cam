import { useCallback, useEffect, useRef, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';

/* NYC slang typing game — 60 seconds, type the word that appears, hit space.
   No external libs, all keyboard. */

const NYC_WORDS: { word: string; gloss: string }[] = [
  { word: 'deadass', gloss: 'for real' },
  { word: 'mad', gloss: 'very (e.g. mad good)' },
  { word: 'brick', gloss: 'cold' },
  { word: 'wylin', gloss: 'acting wild' },
  { word: 'lit', gloss: 'amazing' },
  { word: 'son', gloss: 'dude / man' },
  { word: 'bet', gloss: 'a done deal' },
  { word: 'tight', gloss: 'angry' },
  { word: 'salty', gloss: 'bitter' },
  { word: 'bodega', gloss: 'corner store' },
  { word: 'stoop', gloss: 'front steps' },
  { word: 'schlep', gloss: 'long trek' },
  { word: 'schmear', gloss: 'cream cheese' },
  { word: 'fuhgeddaboudit', gloss: 'forget about it' },
  { word: 'chopped cheese', gloss: 'bodega sandwich' },
  { word: 'bacon egg cheese', gloss: 'BEC' },
  { word: 'dollar slice', gloss: 'cheap pizza' },
  { word: 'halal cart', gloss: 'street food' },
  { word: 'egg cream', gloss: 'no egg, no cream' },
  { word: 'pork roll', gloss: 'NJ + NYC staple' },
  { word: 'jawn', gloss: 'a thing' },
  { word: 'shorty', gloss: 'a person' },
  { word: 'crib', gloss: 'home' },
  { word: 'whip', gloss: 'car' },
  { word: 'guap', gloss: 'money' },
  { word: 'fronting', gloss: 'faking' },
  { word: 'spilling tea', gloss: 'gossip' },
  { word: 'pizza rat', gloss: 'icon' },
  { word: 'cabbie', gloss: 'taxi driver' },
  { word: 'subway', gloss: 'how you get around' },
  { word: 'metrocard', gloss: 'how you pay' },
  { word: 'L train', gloss: 'Brooklyn lifeline' },
  { word: 'the city', gloss: 'Manhattan' },
  { word: 'uptown', gloss: 'above 59th' },
  { word: 'downtown', gloss: 'below 14th' },
  { word: 'midtown', gloss: 'where the offices are' },
  { word: 'Bk', gloss: 'Brooklyn' },
  { word: 'Bx', gloss: 'the Bronx' },
  { word: 'Qns', gloss: 'Queens' },
  { word: 'the rock', gloss: 'Staten Island' },
  { word: 'the boogie down', gloss: 'the Bronx' },
  { word: 'the Garden', gloss: 'MSG' },
  { word: 'the Belt', gloss: 'Belt Parkway' },
  { word: 'the BQE', gloss: 'Brooklyn-Queens Expwy' },
  { word: 'the FDR', gloss: 'east-side highway' },
  { word: 'the GW', gloss: 'George Washington Bridge' },
  { word: 'the Verrazzano', gloss: 'SI bridge' },
  { word: 'Coney Island', gloss: 'south Brooklyn beach' },
  { word: 'Times Square', gloss: 'tourist trap' },
  { word: 'Empire State', gloss: 'the building' },
  { word: 'Yankees', gloss: 'the Bronx team' },
  { word: 'Mets', gloss: 'the Queens team' },
  { word: 'Knicks', gloss: 'MSG basketball' },
  { word: 'bridge and tunnel', gloss: 'not from the city' },
  { word: 'no cap', gloss: 'no lie' },
  { word: 'OD', gloss: 'overdoing it' },
  { word: 'good lookin', gloss: 'thanks' },
  { word: 'word', gloss: 'agreed' },
  { word: 'you good', gloss: 'are you ok' },
];

type Status = 'idle' | 'playing' | 'over';

const ROUND_SECONDS = 60;

export default function Game() {
  const [status, setStatus] = useState<Status>('idle');
  const [target, setTarget] = useState(NYC_WORDS[0]);
  const [typed, setTyped] = useState('');
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [misses, setMisses] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(ROUND_SECONDS);
  const [highScore, setHighScore] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return parseInt(localStorage.getItem('nyc-game-high') || '0', 10);
  });
  const inputRef = useRef<HTMLInputElement | null>(null);

  const newWord = useCallback(() => {
    let next = NYC_WORDS[Math.floor(Math.random() * NYC_WORDS.length)];
    if (next.word === target.word && NYC_WORDS.length > 1) {
      next = NYC_WORDS[(NYC_WORDS.indexOf(next) + 1) % NYC_WORDS.length];
    }
    setTarget(next);
    setTyped('');
  }, [target.word]);

  const start = useCallback(() => {
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setMisses(0);
    setTyped('');
    setSecondsLeft(ROUND_SECONDS);
    setTarget(NYC_WORDS[Math.floor(Math.random() * NYC_WORDS.length)]);
    setStatus('playing');
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  const finish = useCallback(() => {
    setStatus('over');
    setHighScore((prev) => {
      const next = Math.max(prev, score);
      try { localStorage.setItem('nyc-game-high', String(next)); } catch { /* noop */ }
      return next;
    });
  }, [score]);

  // Tick clock
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

  // Match logic — when typed (case-insensitive) equals target, score and reset.
  useEffect(() => {
    if (status !== 'playing') return;
    if (typed.toLowerCase() === target.word.toLowerCase()) {
      const points = target.word.length;
      setScore((s) => s + points);
      setStreak((s) => {
        const next = s + 1;
        setBestStreak((b) => Math.max(b, next));
        return next;
      });
      newWord();
    }
  }, [typed, target.word, status, newWord]);

  // Skip word with TAB → costs streak but no points lost
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

      <main className="flex-1 max-w-[760px] mx-auto px-6 py-8 z-10 w-full">
        <div className="font-bungee text-[44px] leading-[0.95] uppercase mb-2">
          JIMMY'S <span className="text-[#FFD600]">★</span> ARCADE
        </div>
        <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/65 mb-6">
          type the slang · 60 seconds · longer words = more points · TAB to skip
        </div>

        {/* HUD */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
          <Hud label="TIME" value={`${secondsLeft}s`} tone={secondsLeft <= 10 ? 'crit' : 'phosphor'} />
          <Hud label="SCORE" value={score} />
          <Hud label="STREAK" value={`${streak} (best ${bestStreak})`} />
          <Hud label="MISSES" value={misses} tone={misses > 0 ? 'amber' : 'phosphor'} />
        </div>

        {status === 'idle' && (
          <div className="border border-[#FFD600]/40 p-6 bg-black/40">
            <p className="font-typewriter text-[14px] leading-relaxed text-white/85 mb-4">
              A bodega-arcade typing trainer. Words are NYC slang, terms, and
              neighborhoods only. Type each word, hit return or wait — when it
              matches, you get points equal to the length of the word. TAB to skip.
              Personal best is saved in your browser.
            </p>
            <button
              onClick={start}
              className="font-bungee text-[20px] uppercase px-6 py-2 bg-[#FFD600] text-black hover:bg-white transition-colors"
              style={{ boxShadow: '4px 4px 0 #d11a2a' }}
            >
              ★ START
            </button>
            <span className="ml-4 font-typewriter text-[11px] uppercase tracking-[0.2em] text-white/55">
              high score · {highScore}
            </span>
          </div>
        )}

        {status === 'playing' && (
          <div className="border border-[#FFD600] p-6 bg-black/60">
            <div className="text-center mb-2 text-[10px] uppercase tracking-[0.3em] font-typewriter text-[#FFD600]">
              type this
            </div>
            <div className="font-bungee text-center text-[#FFD600] uppercase leading-none" style={{ fontSize: 'clamp(40px, 9vw, 96px)' }}>
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
              TAB to skip · ESC quits
            </div>
          </div>
        )}

        {status === 'over' && (
          <div className="border border-[#FFD600]/60 p-6 bg-black/60 text-center">
            <div className="font-bungee text-[36px] uppercase text-[#FFD600] mb-2">★ GAME OVER ★</div>
            <div className="font-tabloid text-[64px] leading-none uppercase text-white mb-1">{score} pts</div>
            <div className="font-typewriter text-[12px] uppercase tracking-[0.22em] text-white/65 mb-4">
              best streak {bestStreak} · misses {misses} · high score {highScore}
            </div>
            <button
              onClick={start}
              className="font-bungee text-[18px] uppercase px-5 py-2 bg-[#FFD600] text-black hover:bg-white transition-colors"
              style={{ boxShadow: '4px 4px 0 #d11a2a' }}
            >
              ↻ AGAIN
            </button>
            <a href="/" className="ml-4 font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 hover:text-[#FFD600]">
              back to lounge
            </a>
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
