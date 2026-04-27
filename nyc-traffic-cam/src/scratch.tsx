import { useEffect, useRef, useState } from 'react';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, QuarterIcon, useQuarters } from './quarter';

/* ──────────────────────────────────────────────────────────────────────
   /scratch — "buy a $1 NYC Lottery scratch-off." Costs 4 quarters from
   the stash. The ticket is a six-cell card; each cell is hidden under a
   silver canvas overlay you scratch off with the mouse / finger. Three
   matching prize symbols anywhere on the ticket = you win that prize.
   Otherwise it's "BETTER LUCK NEXT TIME" — but the city always gives
   you ONE quarter back, because nobody walks home empty-handed.
   ──────────────────────────────────────────────────────────────────── */

const TICKET_COST = 4; // 4 quarters = $1

type Prize = {
  id: string;
  label: string;
  payout: number;     // refunded as quarters
  weight: number;     // chance weight for landing 3-of-a-kind
  color: string;
  emoji: string;
  blurb: string;
};

const PRIZES: Prize[] = [
  { id: 'subway', label: 'FREE RIDE',  payout: 4,  weight: 22, color: '#FF6319', emoji: '🚇', blurb: '$1 back · ride the F again' },
  { id: 'slice',  label: 'DOLLAR SLICE', payout: 8, weight: 14, color: '#d11a2a', emoji: '🍕', blurb: '$2 back · enough for a slice and a can' },
  { id: 'cab',    label: 'YELLOW CAB', payout: 16, weight: 8, color: '#FAB80F', emoji: '🚖', blurb: '$4 back · they can\'t catch you now' },
  { id: 'cart',   label: 'HALAL CART', payout: 12, weight: 10, color: '#6CBE45', emoji: '🥙', blurb: '$3 back · over rice white sauce' },
  { id: 'rat',    label: 'PIZZA RAT',  payout: 40, weight: 2,  color: '#1a1a1a', emoji: '🐀', blurb: '$10 back · u know what u did' },
  { id: 'jackpot',label: 'JACKPOT',    payout: 100,weight: 1,  color: '#FFD600', emoji: '★',  blurb: '$25 back · empire state' },
];

const SYMBOLS_PER_TICKET = 6;
// House always wins (mostly). If the dice say "winner", we plant 3 of one
// prize and fill the rest with non-matching symbols. Otherwise none of
// the symbols repeat 3 times.
const WIN_PROBABILITY = 0.42;

type CellState = { prize: Prize; revealed: boolean };
type Ticket = {
  id: string;
  cells: CellState[];
  winner: Prize | null;     // populated only if the ticket is configured to win
  resolved: boolean;        // user has scratched ≥ THRESHOLD; result has been reckoned
  payoutClaimed: boolean;
};

function pickWeighted(): Prize {
  const total = PRIZES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of PRIZES) {
    if ((r -= p.weight) <= 0) return p;
  }
  return PRIZES[0];
}

function pickRandomNonMatching(exclude: Prize): Prize {
  const pool = PRIZES.filter((p) => p.id !== exclude.id);
  return pool[Math.floor(Math.random() * pool.length)];
}

function generateTicket(): Ticket {
  const isWinner = Math.random() < WIN_PROBABILITY;
  let cells: CellState[];
  let winner: Prize | null = null;
  if (isWinner) {
    winner = pickWeighted();
    // Three matching cells, three random non-matching, shuffled.
    const matched: CellState[] = Array.from({ length: 3 }, () => ({ prize: winner!, revealed: false }));
    // Make sure the non-winners themselves don't accidentally form 3-of-a-kind.
    const filler: CellState[] = [];
    const counts: Record<string, number> = {};
    while (filler.length < SYMBOLS_PER_TICKET - 3) {
      const candidate = pickRandomNonMatching(winner);
      if ((counts[candidate.id] ?? 0) >= 2) continue; // never 3 fillers of same kind
      counts[candidate.id] = (counts[candidate.id] ?? 0) + 1;
      filler.push({ prize: candidate, revealed: false });
    }
    cells = [...matched, ...filler].sort(() => Math.random() - 0.5);
  } else {
    // Non-winner: still no symbol may appear 3+ times.
    cells = [];
    const counts: Record<string, number> = {};
    while (cells.length < SYMBOLS_PER_TICKET) {
      const c = pickWeighted();
      if ((counts[c.id] ?? 0) >= 2) continue;
      counts[c.id] = (counts[c.id] ?? 0) + 1;
      cells.push({ prize: c, revealed: false });
    }
  }
  return {
    id: Math.random().toString(36).slice(2, 8).toUpperCase(),
    cells,
    winner,
    resolved: false,
    payoutClaimed: false,
  };
}

export default function Scratch() {
  const { count: quarters, add, spend } = useQuarters();
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [history, setHistory] = useState<{ when: number; ticketId: string; result: string; net: number }[]>([]);

  const buy = () => {
    if (!spend(TICKET_COST)) return;
    setTicket(generateTicket());
  };

  const reveal = (idx: number) => {
    setTicket((t) => {
      if (!t) return t;
      const next = { ...t, cells: t.cells.map((c, i) => (i === idx ? { ...c, revealed: true } : c)) };
      return next;
    });
  };

  const allRevealed = ticket?.cells.every((c) => c.revealed) ?? false;

  // Once everything's scratched, settle: pay out prize, log to history.
  useEffect(() => {
    if (!ticket || ticket.resolved || !allRevealed) return;
    const win = ticket.winner;
    if (win) {
      add(win.payout);
    } else {
      // Consolation: one quarter back so the screen doesn't feel hostile.
      add(1);
    }
    setHistory((h) => [
      {
        when: Date.now(),
        ticketId: ticket.id,
        result: win ? `${win.emoji} ${win.label}` : 'no match · -1¢ consolation',
        net: (win ? win.payout : 1) - TICKET_COST,
      },
      ...h,
    ].slice(0, 8));
    setTicket((t) => (t ? { ...t, resolved: true, payoutClaimed: true } : t));
  }, [ticket, allRevealed, add]);

  return (
    <div
      className="min-h-screen w-screen flex flex-col text-white"
      style={{ background: 'radial-gradient(ellipse at 50% 25%,#1a1530 0%,#0a0a18 55%,#06060c 100%)' }}
    >
      <BodegaAwning
        rightSlot={
          <a
            href="/"
            className="ml-2 px-2 py-0.5 border border-[#FFD600] text-[#FFD600] hover:bg-[#FFD600] hover:text-black transition-colors font-typewriter text-[10px] uppercase tracking-[0.18em]"
          >
            ← LOUNGE
          </a>
        }
      />
      <QuarterStash />
      <RollingQuarter />

      <main className="flex-1 px-3 py-5 z-10 max-w-[920px] mx-auto w-full">
        <div className="font-bungee text-[36px] sm:text-[52px] leading-[0.95] uppercase">
          ★ NY <span className="text-[#FFD600]">Scratch-Off</span>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-5">
          collect $1 in coins · scratch the silver · 3-in-a-row pays
        </div>

        {!ticket && <BuyCard quarters={quarters} onBuy={buy} />}

        {ticket && (
          <ScratchCard
            key={ticket.id}
            ticket={ticket}
            onReveal={reveal}
            onDiscard={() => setTicket(null)}
            allRevealed={allRevealed}
          />
        )}

        <PrizeTable />

        {history.length > 0 && (
          <div className="mt-6 px-3 py-3 bg-black/55 border border-[#FFD600]/40 font-typewriter text-[11px] uppercase tracking-[0.18em]">
            <div className="font-bungee text-[12px] text-[#FFD600] mb-1">★ ticket history</div>
            <ul className="space-y-0.5">
              {history.map((h) => (
                <li key={h.when} className="flex items-center gap-2 text-white/75">
                  <span className="text-white/35 tabular">#{h.ticketId}</span>
                  <span>{h.result}</span>
                  <span className={`ml-auto tabular ${h.net >= 0 ? 'text-[#6CBE45]' : 'text-[#ff8a9a]'}`}>
                    {h.net >= 0 ? `+${h.net}` : h.net} ¢
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      <StreetFauna />
    </div>
  );
}

function BuyCard({ quarters, onBuy }: { quarters: number; onBuy: () => void }) {
  const enough = quarters >= TICKET_COST;
  const need = Math.max(0, TICKET_COST - quarters);
  return (
    <div
      className="px-4 py-5 bg-[#0e0f14] border-2 border-[#FFD600] flex flex-wrap items-center gap-4"
      style={{ boxShadow: '5px 5px 0 #d11a2a' }}
    >
      <div className="flex items-center gap-2">
        {Array.from({ length: TICKET_COST }).map((_, i) => (
          <span key={i} style={{ opacity: i < quarters ? 1 : 0.25 }}>
            <QuarterIcon size={28} />
          </span>
        ))}
      </div>
      <div className="font-typewriter text-[12px] uppercase tracking-[0.18em]">
        <div className={enough ? 'text-[#FFD600]' : 'text-white/65'}>
          {enough ? 'all four quarters · ready to play' : `find ${need} more quarter${need === 1 ? '' : 's'} on the lounge`}
        </div>
        <div className="text-white/45 mt-0.5">you have {quarters} ¢ · ticket costs {TICKET_COST}</div>
      </div>
      <button
        type="button"
        onClick={onBuy}
        disabled={!enough}
        className="ml-auto px-5 py-2.5 font-bungee text-[18px] uppercase tracking-[0.06em] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
        style={{
          background: enough ? '#FFD600' : '#2a2a2e',
          color: enough ? '#000' : 'rgba(255,255,255,0.6)',
          boxShadow: enough ? '5px 5px 0 #d11a2a' : 'none',
          border: '3px solid #000',
        }}
      >
        ★ BUY $1 TICKET ★
      </button>
    </div>
  );
}

function PrizeTable() {
  return (
    <div
      className="mt-6 px-3 py-3 bg-black/55 border-2 border-[#FFD600]/40"
      style={{ boxShadow: '3px 3px 0 #d11a2a' }}
    >
      <div className="font-bungee text-[14px] uppercase text-[#FFD600] mb-2">★ prize table · match 3</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PRIZES.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 px-2 py-1.5 border font-typewriter text-[10px] uppercase tracking-[0.18em]"
            style={{ borderColor: `${p.color}55`, background: `${p.color}14` }}
          >
            <span className="text-[18px]" aria-hidden>{p.emoji}</span>
            <span className="font-bungee text-[12px]" style={{ color: p.color }}>{p.label}</span>
            <span className="ml-auto tabular text-white/85">+{p.payout}¢</span>
          </div>
        ))}
      </div>
      <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-2">
        no match → 1¢ consolation · house edge keeps the lights on
      </div>
    </div>
  );
}

/* ──────────────────────────────────────── the actual scratch surface */

function ScratchCard({
  ticket,
  onReveal,
  onDiscard,
  allRevealed,
}: {
  ticket: Ticket;
  onReveal: (idx: number) => void;
  onDiscard: () => void;
  allRevealed: boolean;
}) {
  return (
    <div>
      <div
        className="px-3 py-2 mb-3 flex items-center gap-3 bg-[#FFD600] text-black font-bungee uppercase tracking-[0.06em] text-[14px]"
        style={{ border: '3px solid #000', boxShadow: '4px 4px 0 #d11a2a' }}
      >
        <span>★ TICKET #{ticket.id}</span>
        <span className="ml-auto font-typewriter text-[10px] tracking-[0.22em]">
          {allRevealed
            ? ticket.winner
              ? '★ WINNER ★'
              : 'no match'
            : 'scratch the silver to reveal'}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {ticket.cells.map((c, i) => (
          <ScratchCell key={`${ticket.id}-${i}`} cell={c} onReveal={() => onReveal(i)} />
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {allRevealed && (
          <button
            type="button"
            onClick={onDiscard}
            className="px-4 py-2 font-bungee text-[14px] uppercase tracking-[0.04em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            style={{ background: '#FF6319', color: '#fff', boxShadow: '4px 4px 0 #000', border: '3px solid #000' }}
          >
            ↻ NEW TICKET
          </button>
        )}
        {allRevealed && ticket.winner && (
          <span className="font-bungee text-[16px] uppercase text-[#FFD600]" style={{ textShadow: '0 0 8px #FFD600' }}>
            ★ +{ticket.winner.payout}¢ added to your stash · {ticket.winner.blurb} ★
          </span>
        )}
        {allRevealed && !ticket.winner && (
          <span className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/65">
            +1¢ consolation · NYC owes you nothing but it gave you something anyway
          </span>
        )}
      </div>
    </div>
  );
}

/* A single cell. Underneath: the prize symbol/label. On top: a silver
   canvas overlay you scratch off with mouse drag / touch. Once enough
   pixels have been cleared we mark it revealed and remove the overlay. */
const SCRATCH_THRESHOLD = 0.35; // 35% of pixels cleared = "revealed"

function ScratchCell({ cell, onReveal }: { cell: CellState; onReveal: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const [revealed, setRevealed] = useState(cell.revealed);

  // Initial paint of the silver overlay
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = wrap.getBoundingClientRect();
    cv.width = Math.floor(rect.width * dpr);
    cv.height = Math.floor(rect.height * dpr);
    cv.style.width = `${rect.width}px`;
    cv.style.height = `${rect.height}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    // base silver
    const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    grad.addColorStop(0, '#dadee5');
    grad.addColorStop(0.5, '#a7adb6');
    grad.addColorStop(1, '#7c828c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rect.width, rect.height);
    // speckles + "SCRATCH HERE" text
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * rect.width;
      const y = Math.random() * rect.height;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.font = `bold ${Math.max(11, rect.width * 0.075)}px 'Bungee','Anton',sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.textAlign = 'center';
    ctx.fillText('SCRATCH HERE', rect.width / 2, rect.height / 2);
    ctx.font = `${Math.max(8, rect.width * 0.045)}px 'Courier New',monospace`;
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillText('NYS LOTTERY · $1', rect.width / 2, rect.height / 2 + rect.width * 0.09);
  }, []);

  const eraseAt = (clientX: number, clientY: number) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
  };

  const checkReveal = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const w = cv.width, h = cv.height;
    const sample = ctx.getImageData(0, 0, w, h).data;
    let cleared = 0;
    let total = 0;
    for (let i = 3; i < sample.length; i += 4 * 18) {
      total++;
      if (sample[i] < 24) cleared++;
    }
    if (cleared / total >= SCRATCH_THRESHOLD) {
      setRevealed(true);
      onReveal();
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (revealed) return;
    drawingRef.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    eraseAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current || revealed) return;
    eraseAt(e.clientX, e.clientY);
  };
  const onPointerUp = () => {
    if (!drawingRef.current || revealed) return;
    drawingRef.current = false;
    checkReveal();
  };

  // Keyboard accessible: Enter / Space instantly clears the cell.
  const onKey = (e: React.KeyboardEvent) => {
    if (revealed) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) {
        ctx.clearRect(0, 0, cv.width, cv.height);
      }
      setRevealed(true);
      onReveal();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative aspect-[4/3] select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      style={{
        background: cell.prize.color,
        border: '3px solid #000',
        boxShadow: '3px 3px 0 #d11a2a',
        minHeight: 110,
        cursor: revealed ? 'default' : 'crosshair',
      }}
      onKeyDown={onKey}
      tabIndex={0}
      role="button"
      aria-label={revealed ? `${cell.prize.label}` : 'scratch this cell — press enter to reveal'}
    >
      {/* the prize underneath */}
      <div className="absolute inset-0 grid place-items-center text-center px-1.5">
        <div>
          <div className="text-[44px] sm:text-[52px] leading-none" aria-hidden>
            {cell.prize.emoji}
          </div>
          <div
            className="font-bungee text-[12px] sm:text-[14px] uppercase tracking-[0.04em] mt-1"
            style={{
              color: cell.prize.color === '#FFD600' || cell.prize.color === '#FAB80F' ? '#000' : '#fff',
              textShadow: '1px 1px 0 rgba(0,0,0,0.45)',
            }}
          >
            {cell.prize.label}
          </div>
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] mt-0.5"
               style={{ color: cell.prize.color === '#FFD600' || cell.prize.color === '#FAB80F' ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)' }}>
            +{cell.prize.payout}¢
          </div>
        </div>
      </div>
      {/* canvas overlay */}
      {!revealed && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerUp}
        />
      )}
    </div>
  );
}
