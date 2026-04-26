import { useCallback, useEffect, useRef, useState } from 'react';

/* ========================================================
   QUARTER HUNT
   - useQuarters(): localStorage-backed coin count + helpers
   - <QuarterStash />: corner counter, cross-tab synced
   - <RollingQuarter />: spawns and rolls across the bottom of the
     viewport at random intervals; click to grab.
   ========================================================*/

const STORE_KEY = 'nyc-quarters';

function readStash(): number {
  if (typeof window === 'undefined') return 0;
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
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      <defs>
        <radialGradient id="qg" cx="40%" cy="40%" r="65%">
          <stop offset="0%" stopColor="#f1f1f1" />
          <stop offset="60%" stopColor="#bcbcbc" />
          <stop offset="100%" stopColor="#7a7a7a" />
        </radialGradient>
      </defs>
      <circle cx="20" cy="20" r="18" fill="url(#qg)" stroke="#555" strokeWidth="1.4" />
      <circle cx="20" cy="20" r="14" fill="none" stroke="#999" strokeWidth="0.8" strokeDasharray="1.2 1" />
      <text x="20" y="24" textAnchor="middle" fontSize="11" fill="#1a1a1a" fontWeight="900" fontFamily="Bungee, Impact, sans-serif">25¢</text>
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

/* Spawns a clickable rolling quarter every 25-70s.
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
      const wait = 25_000 + Math.random() * 45_000;
      setTimeout(() => {
        if (stop) return;
        setGrabbed(false);
        setSeed((s) => s + 1);
        tick();
      }, wait);
    };
    // seed an initial spawn quickly so first-time visitors notice
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
