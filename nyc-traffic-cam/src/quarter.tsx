import { useCallback, useEffect, useRef, useState } from 'react';

/* ========================================================
   QUARTER HUNT
   - useQuarters(): localStorage-backed coin count + helpers
   - <QuarterStash />: corner counter, cross-tab synced
   - <RollingQuarter />: spawns and rolls across the bottom of the
     viewport at random intervals; click to grab.
   ========================================================*/

const STORE_KEY = 'nyc-quarters';
const SEEDED_KEY = 'nyc-quarters-seeded';

function readStash(): number {
  if (typeof window === 'undefined') return 0;
  // First-time visitors get a small starter stack so the arcade isn't a
  // dead end. Three quarters = a few plays before they have to start
  // hunting the rolling coin.
  if (!localStorage.getItem(SEEDED_KEY)) {
    localStorage.setItem(SEEDED_KEY, '1');
    if (!localStorage.getItem(STORE_KEY)) {
      localStorage.setItem(STORE_KEY, '3');
      return 3;
    }
  }
  return parseInt(localStorage.getItem(STORE_KEY) || '0', 10) || 0;
}

export function useQuarters() {
  const [n, setN] = useState<number>(() => readStash());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORE_KEY) setN(readStash());
    };
    const onLocal = () => setN(readStash());
    window.addEventListener('storage', onStorage);
    window.addEventListener('nyc:quarters-changed', onLocal as EventListener);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('nyc:quarters-changed', onLocal as EventListener);
    };
  }, []);
  const set = useCallback((v: number) => {
    try {
      localStorage.setItem(STORE_KEY, String(Math.max(0, v)));
      window.dispatchEvent(new Event('nyc:quarters-changed'));
    } catch { /* noop */ }
    setN(Math.max(0, v));
  }, []);
  const add = useCallback((dn = 1) => set(readStash() + dn), [set]);
  const spend = useCallback((dn = 1) => {
    const cur = readStash();
    if (cur < dn) return false;
    set(cur - dn);
    return true;
  }, [set]);
  return { count: n, add, spend, set };
}

export function QuarterIcon({ size = 22 }: { size?: number }) {
  // Reads unambiguously as a coin: 25¢ inside a milled silver disc with
  // a beveled rim. No faces, no embossed eagle that could read as a head.
  const id = `qg-${size}`;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      <defs>
        <radialGradient id={id} cx="35%" cy="32%" r="70%">
          <stop offset="0%"   stopColor="#fbfbfa" />
          <stop offset="50%"  stopColor="#cfcfcc" />
          <stop offset="85%"  stopColor="#8a8a86" />
          <stop offset="100%" stopColor="#5a5a55" />
        </radialGradient>
      </defs>
      {/* outer milled rim */}
      <circle cx="20" cy="20" r="18.5" fill={`url(#${id})`} stroke="#3d3d3a" strokeWidth="1" />
      {/* engraved inner ring */}
      <circle cx="20" cy="20" r="14.5" fill="none" stroke="#5b5b57" strokeWidth="0.7" />
      {/* milled-edge tick marks */}
      {Array.from({ length: 32 }).map((_, i) => {
        const a = (i / 32) * Math.PI * 2;
        const x1 = 20 + Math.cos(a) * 17;
        const y1 = 20 + Math.sin(a) * 17;
        const x2 = 20 + Math.cos(a) * 18.5;
        const y2 = 20 + Math.sin(a) * 18.5;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#3d3d3a" strokeWidth="0.6" />;
      })}
      {/* the value */}
      <text
        x="20"
        y="24.5"
        textAnchor="middle"
        fontSize="13"
        fontWeight="900"
        fontFamily="Bungee, Impact, sans-serif"
        fill="#1a1a18"
        letterSpacing="-0.5"
      >25¢</text>
    </svg>
  );
}

export function QuarterStash() {
  const { count } = useQuarters();
  return (
    <div className="fixed top-[78px] right-3 z-40 pointer-events-none">
      <div
        className="flex items-center gap-1.5 bg-black/70 border border-[#FFD600] px-2 py-1 font-typewriter text-[10px] uppercase tracking-[0.2em] text-[#FFD600]"
        style={{ boxShadow: '2px 2px 0 #d11a2a' }}
      >
        <QuarterIcon size={16} />
        <span className="tabular text-white">×{count}</span>
        <span className="text-white/45">quarters</span>
      </div>
    </div>
  );
}

/* A "found change" easter egg pinned to a specific spot on the page.
   - Renders at fixed/absolute coords (caller supplies positioning via
     style / className).
   - Sparkles softly so it's visible-but-not-blaring on second look.
   - Clicking it adds coins to the stash and hides the coin. After
     `respawnMs` the coin reappears so repeat visits stay rewarding.
   - localStorage stamp is per spotId, so coins respect their own
     cooldowns across reloads / tabs. */
export function HiddenCoin({
  spotId,
  payout = 1,
  respawnMs = 6 * 60 * 1000,   // 6 min — easy enough to refind
  size = 20,
  hint,
  style,
  className,
  whisper = true,
}: {
  spotId: string;
  payout?: number;
  respawnMs?: number;
  size?: number;
  hint?: string;
  style?: React.CSSProperties;
  className?: string;
  whisper?: boolean;
}) {
  const STORE_KEY = `nyc-coin-spot-${spotId}`;
  const [present, setPresent] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const last = parseInt(localStorage.getItem(STORE_KEY) || '0', 10) || 0;
    return Date.now() - last >= respawnMs;
  });
  const [toast, setToast] = useState<{ x: number; y: number } | null>(null);
  const { add } = useQuarters();

  // Re-check respawn periodically (cheap timer, only when coin is hidden)
  useEffect(() => {
    if (present) return;
    const i = setInterval(() => {
      const last = parseInt(localStorage.getItem(STORE_KEY) || '0', 10) || 0;
      if (Date.now() - last >= respawnMs) setPresent(true);
    }, 8000);
    return () => clearInterval(i);
  }, [present, STORE_KEY, respawnMs]);

  const grab = (e: React.MouseEvent) => {
    if (!present) return;
    e.preventDefault();
    e.stopPropagation();
    add(payout);
    localStorage.setItem(STORE_KEY, String(Date.now()));
    setPresent(false);
    setToast({ x: e.clientX, y: e.clientY });
    setTimeout(() => setToast(null), 1300);
  };

  if (!present) return null;
  return (
    <>
      <button
        type="button"
        onClick={grab}
        aria-label={hint ?? `hidden quarter — +${payout}`}
        title={hint ?? 'hidden quarter — click to grab'}
        className={`fixed z-30 cursor-pointer p-0 m-0 border-0 bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600] ${className ?? ''}`}
        style={{
          // The whisper-mode coin is dim until hovered, so it reads as
          // an easter egg rather than a banner ad. Set whisper={false}
          // for full-volume coins on slow / lonely props.
          opacity: whisper ? 0.55 : 1,
          transition: 'opacity 0.2s, transform 0.2s',
          ...style,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.transform = 'scale(1.18)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = whisper ? '0.55' : '1'; e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <span
          className="block"
          style={{
            animation: 'quarter-spin 1.6s linear infinite',
            filter: 'drop-shadow(0 0 6px rgba(255,214,0,0.55))',
          }}
        >
          <QuarterIcon size={size} />
        </span>
      </button>
      {toast && (
        <div
          className="fixed pointer-events-none z-50 font-bungee text-[#FFD600] text-[16px]"
          style={{
            left: toast.x - 14,
            top: toast.y - 24,
            textShadow: '0 0 8px #FFD600, 2px 2px 0 #d11a2a',
            animation: 'quarter-toast 1.3s ease-out forwards',
          }}
        >
          +{payout} ★
        </div>
      )}
    </>
  );
}

/* Spawns a clickable rolling quarter every 22-55s.
   Clicking it: increments stash, fires a tiny "+1" toast. */
export function RollingQuarter() {
  const [seed, setSeed] = useState(0);
  const [grabbed, setGrabbed] = useState(false);
  const [toast, setToast] = useState<{ x: number; y: number; n: number } | null>(null);
  const { add, count } = useQuarters();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = () => {
      // 22-55s cadence — frequent enough that just hanging on the page
      // is rewarded with coins, infrequent enough that the screen
      // doesn't read as a slot machine.
      const wait = 22_000 + Math.random() * 33_000;
      setTimeout(() => {
        if (stop) return;
        setGrabbed(false);
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    // First spawn ~6s in — visitors learn the mechanic fast.
    setTimeout(() => { if (!stop) { setSeed((s) => s + 1); } }, 6_000);
    tick();
    return () => { stop = true; };
  }, []);

  const onClick = (e: React.MouseEvent) => {
    if (grabbed) return;
    const x = e.clientX;
    const y = e.clientY;
    setGrabbed(true);
    add(1);
    setToast({ x, y, n: count + 1 });
    setTimeout(() => setToast(null), 1500);
  };

  if (seed === 0) return null;

  // Random vertical drift so it doesn't look mechanical.
  const drift = ((seed * 73) % 30) - 15;

  return (
    <>
      {!grabbed && (
        <div
          key={`q-${seed}`}
          ref={ref}
          onClick={onClick}
          className="fixed z-30 cursor-pointer"
          style={{
            bottom: 8 + drift,
            right: -60,
            animation: 'quarter-roll 9s linear forwards',
          }}
          aria-label="quarter — click to grab"
          title="grab the quarter"
        >
          <div style={{ animation: 'quarter-spin 0.45s linear infinite' }}>
            <QuarterIcon size={32} />
          </div>
        </div>
      )}
      {toast && (
        <div
          className="fixed pointer-events-none z-50 font-bungee text-[#FFD600] text-[18px]"
          style={{
            left: toast.x - 20,
            top: toast.y - 30,
            textShadow: '0 0 8px #FFD600, 2px 2px 0 #d11a2a',
            animation: 'quarter-toast 1.5s ease-out forwards',
          }}
        >
          +1 ★ ×{toast.n}
        </div>
      )}
    </>
  );
}
