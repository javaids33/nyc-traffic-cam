import { useEffect, useRef, useState } from 'react';

/* BodegaCat — the bodega's lofi mascot.

   States (auto-cycling):
     napping  (Z Z Z eyes closed, slow breathing)
     chilling (eyes open, tail twitch)
     looking  (head turns, eyes track)
     playing  (paw bats — only on click)
     roaming  (the cat strolls to a new spot on the page)

   Coats: a few palettes the user can cycle through with double-click.
     bodega   (jet black) · default
     ginger   (orange tabby — Garfield-ish)
     calico   (white belly + ginger/black patches)
     tuxedo   (black with white chest + paws)
     grey     (slate grey shorthair)

   Persists last-chosen coat + last-known position to localStorage so
   the cat stays put across navigations (each anchor is a real page
   reload — no router).

   Tooltip overlay on hover tells the user what they can do
   (click to play, double-click to change color, drag to move).
*/

type CatState = 'napping' | 'chilling' | 'looking' | 'playing' | 'roaming';
type Coat = 'knicks' | 'bodega' | 'ginger' | 'calico' | 'tuxedo' | 'grey';

const COATS: Record<Coat, { primary: string; primaryDark: string; belly: string; ear: string; nose: string; label: string; stripeColor?: string }> = {
  // Knicks tabby — orange base with blue tiger stripes. The team
  // colors (#F58426 / #006BB6) read as a cat that grew up watching
  // games at the Garden. Default coat — orange is fun, recognizable.
  knicks: { primary: '#F58426', primaryDark: '#a8551a', belly: '#fdd9b4', ear: '#006BB6', nose: '#ff9eb5', label: 'KNICKS · go ny go', stripeColor: '#003a73' },
  bodega: { primary: '#5a4332', primaryDark: '#2a1d12', belly: '#5a4332', ear: '#2a1d12', nose: '#ff9eb5', label: 'BODEGA · jet black' },
  ginger: { primary: '#d68740', primaryDark: '#7a4012', belly: '#f3d4a3', ear: '#7a4012', nose: '#ff9eb5', label: 'GINGER · orange tabby' },
  calico: { primary: '#3a2814', primaryDark: '#1a0e04', belly: '#fdfbf2', ear: '#d68740', nose: '#ff9eb5', label: 'CALICO · patched' },
  tuxedo: { primary: '#0e0a06', primaryDark: '#000', belly: '#fdfbf2', ear: '#000', nose: '#ff9eb5', label: 'TUXEDO · ready for prom' },
  grey:   { primary: '#5a5e66', primaryDark: '#2a2c30', belly: '#7a7e86', ear: '#2a2c30', nose: '#ff9eb5', label: 'GREY · alley cat' },
};
const COAT_ORDER: Coat[] = ['knicks', 'bodega', 'ginger', 'calico', 'tuxedo', 'grey'];

const NAP_AFTER_IDLE_MS = 30_000;
const PLAY_DURATION_MS = 4_000;
const STATE_TICK_MS = 6_000;
const ROAM_PROBABILITY = 0.12;
const POS_KEY = 'nyc-cat-pos';
const COAT_KEY = 'nyc-cat-coat';

type Pos = { x: number; y: number };

function defaultPos(): Pos {
  if (typeof window === 'undefined') return { x: 100, y: 100 };
  return {
    x: Math.max(20, window.innerWidth - 110),
    y: Math.max(20, window.innerHeight - 110),
  };
}

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return defaultPos();
    const p = JSON.parse(raw);
    if (typeof p?.x === 'number' && typeof p?.y === 'number') {
      const maxX = Math.max(0, window.innerWidth - 110);
      const maxY = Math.max(0, window.innerHeight - 110);
      return { x: Math.min(maxX, Math.max(0, p.x)), y: Math.min(maxY, Math.max(0, p.y)) };
    }
  } catch { /* private mode */ }
  return defaultPos();
}

function loadCoat(): Coat {
  try {
    const c = localStorage.getItem(COAT_KEY) as Coat | null;
    if (c && COATS[c]) return c;
  } catch { /* */ }
  return 'knicks';
}

const CAT_SIZE = 112; // bigger again — a real bodega cat presence

export function BodegaCat() {
  const [state, setState] = useState<CatState>('napping');
  const [hovered, setHovered] = useState(false);
  const [coat, setCoat] = useState<Coat>(loadCoat);
  const [pos, setPos] = useState<Pos>(loadPos);
  const [tipShown, setTipShown] = useState<boolean>(() => {
    try { return localStorage.getItem('nyc-cat-tip-seen') === '1'; } catch { return true; }
  });
  const lastInteractionRef = useRef(Date.now());
  const playTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

  // Persist coat + position
  useEffect(() => { try { localStorage.setItem(COAT_KEY, coat); } catch { /* */ } }, [coat]);
  useEffect(() => { try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch { /* */ } }, [pos]);

  // Auto-roam: occasionally the cat strolls to a new random spot.
  // Picks a target within the visible viewport (avoiding edges and
  // the boombox dock area on the left).
  const roamTo = (dest?: Pos) => {
    setState('roaming');
    const target = dest ?? {
      x: 240 + Math.floor(Math.random() * (window.innerWidth - 360)),
      y: 80 + Math.floor(Math.random() * (window.innerHeight - 200)),
    };
    setPos(target);
    // After the CSS transition (set on transform via style), drop
    // back to napping/chilling so the cat doesn't permanently look
    // mid-stride.
    window.setTimeout(() => setState(Math.random() < 0.6 ? 'chilling' : 'looking'), 1800);
  };

  // State cycler — every 6s pick a new idle behavior weighted toward
  // napping. Occasionally the cat ROAMS to a new spot.
  useEffect(() => {
    const i = window.setInterval(() => {
      if (state === 'playing' || state === 'roaming') return;
      const now = Date.now();
      const idleFor = now - lastInteractionRef.current;
      if (idleFor > NAP_AFTER_IDLE_MS) {
        setState('napping');
        return;
      }
      const r = Math.random();
      // Roam every once in a while when active
      if (idleFor < 12_000 && Math.random() < ROAM_PROBABILITY) {
        roamTo();
        return;
      }
      if (idleFor < 8_000) {
        if (r < 0.5) setState('chilling');
        else if (r < 0.8) setState('looking');
        else setState('napping');
      } else {
        if (r < 0.7) setState('napping');
        else if (r < 0.9) setState('chilling');
        else setState('looking');
      }
    }, STATE_TICK_MS);
    return () => clearInterval(i);
  }, [state]);

  // Pointer near the cat wakes it up briefly.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - (pos.x + CAT_SIZE / 2);
      const dy = e.clientY - (pos.y + CAT_SIZE / 2);
      if (dx * dx + dy * dy < 200 * 200) {
        lastInteractionRef.current = Date.now();
      }
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => window.removeEventListener('mousemove', onMove);
  }, [pos]);

  // Drag the cat by holding pointer down. Ignored if the gesture is
  // a quick click (no real movement) — that path triggers play.
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.hypot(dx, dy) < 4) return; // drag threshold
    d.moved = true;
    const maxX = Math.max(0, window.innerWidth - CAT_SIZE);
    const maxY = Math.max(0, window.innerHeight - CAT_SIZE);
    setPos({
      x: Math.min(maxX, Math.max(0, d.ox + dx)),
      y: Math.min(maxY, Math.max(0, d.oy + dy)),
    });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    // No real movement → treat as click → play.
    if (d && !d.moved) {
      lastInteractionRef.current = Date.now();
      setState('playing');
      if (playTimerRef.current) window.clearTimeout(playTimerRef.current);
      playTimerRef.current = window.setTimeout(() => setState('chilling'), PLAY_DURATION_MS);
    }
  };

  // Double-click cycles coat color.
  const onDoubleClick = () => {
    const idx = COAT_ORDER.indexOf(coat);
    setCoat(COAT_ORDER[(idx + 1) % COAT_ORDER.length]);
    setTipShown(true);
    try { localStorage.setItem('nyc-cat-tip-seen', '1'); } catch { /* */ }
  };

  useEffect(() => () => {
    if (playTimerRef.current) window.clearTimeout(playTimerRef.current);
  }, []);

  const stateLabel: Record<CatState, string> = {
    napping: 'Z z z',
    chilling: 'just vibing',
    looking: 'huh?',
    playing: 'you got me',
    roaming: 'on patrol',
  };
  const c = COATS[coat];

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { dragRef.current = null; }}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="fixed z-30 pointer-events-auto select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      style={{
        left: pos.x,
        top: pos.y,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: dragRef.current ? 'grabbing' : 'grab',
        transition: state === 'roaming' ? 'left 1.6s cubic-bezier(0.4, 0, 0.2, 1), top 1.6s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
        touchAction: 'none',
      }}
      title={`Bodega cat (${c.label}) · click to play, double-click to change coat, drag to move`}
      aria-label={`Bodega cat (${c.label}) is ${state}. Click to play, double-click to change coat, drag to move.`}
    >
      <div className="relative" style={{ width: CAT_SIZE, height: CAT_SIZE }}>
        <svg viewBox="0 0 100 100" width={CAT_SIZE} height={CAT_SIZE} aria-hidden>
          <defs>
            <radialGradient id={`catFur-${coat}`} cx="50%" cy="40%">
              <stop offset="0%" stopColor={c.primary} />
              <stop offset="100%" stopColor={c.primaryDark} />
            </radialGradient>
            {/* Calico patches */}
            {coat === 'calico' && (
              <pattern id="calicoPatch" x="0" y="0" width="30" height="30" patternUnits="userSpaceOnUse">
                <rect width="30" height="30" fill={c.primary} />
                <ellipse cx="8" cy="10" rx="6" ry="4" fill="#d68740" />
                <ellipse cx="22" cy="20" rx="5" ry="6" fill="#fdfbf2" />
              </pattern>
            )}
          </defs>

          {/* Tail */}
          <path
            d="M 78 70 q 14 -2 16 -16 q 2 -10 -6 -16"
            fill="none"
            stroke={`url(#catFur-${coat})`}
            strokeWidth="6"
            strokeLinecap="round"
            className={state === 'chilling' || state === 'looking' ? 'cat-tail' : undefined}
          />

          {/* Body */}
          <ellipse
            cx="50"
            cy="68"
            rx="30"
            ry="22"
            fill={coat === 'calico' ? 'url(#calicoPatch)' : `url(#catFur-${coat})`}
            className={state === 'napping' ? 'cat-breathe' : undefined}
          />
          {/* Belly contrast (tuxedo, calico, ginger, knicks have lighter belly) */}
          {(coat === 'tuxedo' || coat === 'calico' || coat === 'ginger' || coat === 'knicks') && (
            <ellipse cx="50" cy="78" rx="18" ry="10" fill={c.belly} opacity={coat === 'ginger' ? 0.55 : coat === 'knicks' ? 0.7 : 0.95} />
          )}
          {/* Knicks tiger stripes — six curved blue stripes across
              the body + a bonus hat stripe across the head. Drawn
              as semicircular paths so they hug the body silhouette. */}
          {coat === 'knicks' && c.stripeColor && (
            <g stroke={c.stripeColor} strokeWidth="2.4" fill="none" strokeLinecap="round" opacity="0.92">
              <path d="M 27 60 q 4 -4 8 0" />
              <path d="M 38 56 q 5 -5 10 0" />
              <path d="M 53 56 q 5 -5 10 0" />
              <path d="M 65 60 q 4 -4 8 0" />
              <path d="M 32 72 q 5 -3 10 0" />
              <path d="M 58 72 q 5 -3 10 0" />
              {/* head stripe (between the ears) */}
              <path d="M 40 36 q 10 -3 20 0" strokeWidth="2" />
              {/* tail rings */}
              <path d="M 84 56 l 3 -2" />
              <path d="M 89 50 l 3 -2" />
            </g>
          )}

          {/* Front paws */}
          <g className={state === 'playing' ? 'cat-paw' : undefined}>
            <ellipse cx="38" cy="86" rx="6" ry="4" fill={coat === 'tuxedo' ? c.belly : c.primaryDark} />
            <ellipse cx="62" cy="86" rx="6" ry="4" fill={coat === 'tuxedo' ? c.belly : c.primaryDark} />
          </g>

          {/* Head */}
          <circle cx="50" cy="46" r="20" fill={`url(#catFur-${coat})`} />
          {coat === 'tuxedo' && (
            <ellipse cx="50" cy="58" rx="6" ry="3" fill={c.belly} opacity="0.95" />
          )}
          {/* Ears */}
          <path d="M 32 32 L 38 22 L 44 36 Z" fill={c.ear} />
          <path d="M 68 32 L 62 22 L 56 36 Z" fill={c.ear} />
          <path d="M 35 31 L 38 25 L 41 33 Z" fill={c.nose} opacity="0.6" />
          <path d="M 65 31 L 62 25 L 59 33 Z" fill={c.nose} opacity="0.6" />

          {/* Eyes */}
          {state === 'napping' ? (
            <>
              <path d="M 41 47 q 3 -2 6 0" stroke="#1a1208" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              <path d="M 53 47 q 3 -2 6 0" stroke="#1a1208" strokeWidth="1.6" fill="none" strokeLinecap="round" />
              <text x="74" y="34" fontSize="9" fontWeight="700" fill="#FFD600" fontFamily="'Bungee',sans-serif">z</text>
              <text x="80" y="28" fontSize="7" fontWeight="700" fill="#FFD600" fontFamily="'Bungee',sans-serif">z</text>
            </>
          ) : (
            <g className={state === 'chilling' ? 'cat-blink' : undefined}>
              <ellipse cx="44" cy="46" rx={state === 'looking' ? '3.2' : '2.4'} ry={state === 'looking' ? '4' : '3.2'} fill="#1a1208" />
              <ellipse cx="56" cy="46" rx={state === 'looking' ? '3.2' : '2.4'} ry={state === 'looking' ? '4' : '3.2'} fill="#1a1208" />
              <circle cx="45" cy="44.5" r="0.8" fill="#fff" />
              <circle cx="57" cy="44.5" r="0.8" fill="#fff" />
            </g>
          )}

          {/* Nose */}
          <path d="M 48 52 L 52 52 L 50 55 Z" fill={c.nose} />
          {/* Mouth */}
          <path
            d={state === 'playing' ? 'M 47 56 q 3 3 6 0' : 'M 46 56 q 4 2 8 0'}
            stroke="#1a1208"
            strokeWidth="1"
            fill="none"
            strokeLinecap="round"
          />
          {/* Whiskers */}
          <path d="M 28 53 L 38 54" stroke="#fff" strokeWidth="0.5" opacity="0.65" />
          <path d="M 28 56 L 38 56" stroke="#fff" strokeWidth="0.5" opacity="0.65" />
          <path d="M 62 54 L 72 53" stroke="#fff" strokeWidth="0.5" opacity="0.65" />
          <path d="M 62 56 L 72 56" stroke="#fff" strokeWidth="0.5" opacity="0.65" />
        </svg>

        {/* Tooltip — bigger now, more readable */}
        {(hovered || state === 'playing' || state === 'roaming') && (
          <div
            className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-1 bg-black/90 border border-[#FFD600] text-[#FFD600] font-typewriter text-[10px] uppercase tracking-[0.18em] pointer-events-none whitespace-nowrap"
            aria-hidden
          >
            {stateLabel[state]}
          </div>
        )}

        {/* First-visit help bubble. Disappears once user double-clicks
            once (taught), or after 14 seconds. */}
        {!tipShown && (
          <div
            className="absolute top-full mt-1 left-1/2 -translate-x-1/2 px-2 py-1 bg-[#FFD600] text-black font-typewriter text-[9px] uppercase tracking-[0.16em] pointer-events-none whitespace-nowrap"
            style={{ boxShadow: '2px 2px 0 #d11a2a' }}
            aria-hidden
            onAnimationEnd={() => setTipShown(true)}
          >
            click · play · 2x = new color
          </div>
        )}
      </div>
    </button>
  );
}
