import { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { useDrag } from '@use-gesture/react';
import { RoughNotation } from 'react-rough-notation';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, QuarterIcon, useQuarters, HiddenCoin } from './quarter';

/* ──────────────────────────────────────────────────────────────────────
   /scratch — NYC scratch-off arcade.

   Buy a $1 ticket (4 quarters), pick which game you want to play, and
   scratch the silver. Three popular real-world ticket mechanics are
   replicated here, each themed to NYC:

   1. SLICE TRIPLE        — match 3 symbols anywhere (the classic)
   2. NYC NUMBERS         — match your numbers to the winning numbers
   3. BIG APPLE TIC-TAC-TOE — three-in-a-row (h / v / diag) wins

   All payouts are denominated in QUARTERS (so payouts feed straight
   back into the same lounge currency that funds the next ticket).
   ──────────────────────────────────────────────────────────────────── */

const TICKET_COST = 4; // quarters · $1

/* ──────────────────────────────────────── shared payout symbols */

type Prize = {
  id: string;
  label: string;
  payout: number;     // refunded as quarters
  weight: number;     // chance weight when selecting a winning prize
  color: string;
  emoji: string;
  blurb: string;
};

const PRIZES: Prize[] = [
  { id: 'subway', label: 'FREE RIDE',    payout: 4,   weight: 22, color: '#FF6319', emoji: '🚇', blurb: '$1 back · ride the F again' },
  { id: 'slice',  label: 'DOLLAR SLICE', payout: 8,   weight: 14, color: '#d11a2a', emoji: '🍕', blurb: '$2 back · enough for a slice and a can' },
  { id: 'cart',   label: 'HALAL CART',   payout: 12,  weight: 10, color: '#6CBE45', emoji: '🥙', blurb: '$3 back · over rice white sauce' },
  { id: 'cab',    label: 'YELLOW CAB',   payout: 16,  weight: 8,  color: '#FAB80F', emoji: '🚖', blurb: '$4 back · they can\'t catch you now' },
  { id: 'rat',    label: 'PIZZA RAT',    payout: 40,  weight: 2,  color: '#1a1a1a', emoji: '🐀', blurb: '$10 back · u know what u did' },
  { id: 'jackpot',label: 'JACKPOT',      payout: 100, weight: 1,  color: '#FFD600', emoji: '★',  blurb: '$25 back · empire state' },
];

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

/* ──────────────────────────────────────── game catalog */

type GameId = 'slice' | 'numbers' | 'tictactoe';
type GameMeta = {
  id: GameId;
  label: string;
  blurb: string;
  howTo: string;
  color: string;
  emoji: string;
  jackpot: number;     // headline jackpot, in quarters
  winRate: number;     // 0–1 probability of any prize at all
};

const GAMES: GameMeta[] = [
  {
    id: 'slice',
    label: 'SLICE TRIPLE',
    blurb: 'match 3 symbols · anywhere on the ticket',
    howTo: 'scratch all 6 cells · find 3 of the same symbol = win that prize',
    color: '#d11a2a',
    emoji: '🍕',
    jackpot: 100,
    winRate: 0.42,
  },
  {
    id: 'numbers',
    label: 'NYC NUMBERS',
    blurb: 'match your numbers to the 3 winning numbers',
    howTo: 'scratch the winning numbers · then your 6 numbers · any match wins that prize · find a $ = win all',
    color: '#0039A6',
    emoji: '🔢',
    jackpot: 100,
    winRate: 0.50,
  },
  {
    id: 'tictactoe',
    label: 'BIG APPLE TIC-TAC-TOE',
    blurb: 'three in a row wins · h / v / diag',
    howTo: 'scratch the 3×3 board · ★ in any straight line wins the prize shown · only ★s and ●s in play',
    color: '#6CBE45',
    emoji: '🗽',
    jackpot: 80,
    winRate: 0.45,
  },
];

/* ──────────────────────────────────────── ticket data shapes */

type SliceCell = { prize: Prize; revealed: boolean };
type SliceTicket = {
  game: 'slice';
  id: string;
  cells: SliceCell[];
  winner: Prize | null;
  resolved: boolean;
};

type NumbersDraw = { value: number; revealed: boolean };
type NumbersPick = { value: number | '$'; prize: Prize; revealed: boolean };
type NumbersTicket = {
  game: 'numbers';
  id: string;
  winning: NumbersDraw[];   // 3 numbers
  picks: NumbersPick[];     // 6 picks (number + prize) — `$` is auto-win
  totalWon: number;         // payout in quarters across all matches
  resolved: boolean;
};

type TttCell = { mark: '★' | '●'; revealed: boolean };
type TttTicket = {
  game: 'tictactoe';
  id: string;
  cells: TttCell[];      // length 9
  prize: Prize;          // the prize you win if you hit a line
  bonusPrize: Prize;     // a small consolation if no line
  totalWon: number;
  resolved: boolean;
};

type Ticket = SliceTicket | NumbersTicket | TttTicket;

/* ──────────────────────────────────────── ticket generators */

const SLICE_CELLS = 6;
const NUMBERS_PICKS = 6;
const NUMBERS_DRAW = 3;
const NUMBER_RANGE = 60; // 1..60

function generateSliceTicket(): SliceTicket {
  const isWinner = Math.random() < GAMES.find((g) => g.id === 'slice')!.winRate;
  let cells: SliceCell[];
  let winner: Prize | null = null;
  if (isWinner) {
    winner = pickWeighted();
    const matched: SliceCell[] = Array.from({ length: 3 }, () => ({ prize: winner!, revealed: false }));
    const filler: SliceCell[] = [];
    const counts: Record<string, number> = {};
    while (filler.length < SLICE_CELLS - 3) {
      const candidate = pickRandomNonMatching(winner);
      if ((counts[candidate.id] ?? 0) >= 2) continue;
      counts[candidate.id] = (counts[candidate.id] ?? 0) + 1;
      filler.push({ prize: candidate, revealed: false });
    }
    cells = [...matched, ...filler].sort(() => Math.random() - 0.5);
  } else {
    cells = [];
    const counts: Record<string, number> = {};
    while (cells.length < SLICE_CELLS) {
      const c = pickWeighted();
      if ((counts[c.id] ?? 0) >= 2) continue;
      counts[c.id] = (counts[c.id] ?? 0) + 1;
      cells.push({ prize: c, revealed: false });
    }
  }
  return {
    game: 'slice',
    id: shortId(),
    cells,
    winner,
    resolved: false,
  };
}

function generateNumbersTicket(): NumbersTicket {
  // Real "Match Your Numbers" tickets pick 3 winning numbers, then
  // each "your numbers" cell gets either a unique number or a "$"
  // auto-win symbol. We replicate that:
  // - 3 distinct winning numbers in [1..NUMBER_RANGE]
  // - 6 picks: most are non-matching numbers (you "miss"), some
  //   match a winning number (you "win" that pick's prize), and
  //   ~10% chance any pick is a "$" auto-winner.
  const winRate = GAMES.find((g) => g.id === 'numbers')!.winRate;
  const isWinner = Math.random() < winRate;

  const winningSet = new Set<number>();
  while (winningSet.size < NUMBERS_DRAW) {
    winningSet.add(1 + Math.floor(Math.random() * NUMBER_RANGE));
  }
  const winning: NumbersDraw[] = Array.from(winningSet, (v) => ({ value: v, revealed: false }));

  const picks: NumbersPick[] = [];
  const usedNumbers = new Set<number>(winningSet);

  // Pre-decide: how many cells will MATCH a winning number? At least 1
  // if isWinner=true; at most 2 to keep the chase fun.
  const matchCount = isWinner ? 1 + (Math.random() < 0.35 ? 1 : 0) : 0;
  const dollarCount = isWinner && Math.random() < 0.18 ? 1 : 0;

  // Build a shuffled set of slot kinds: 'match' / 'dollar' / 'miss'
  const slots: ('match' | 'dollar' | 'miss')[] = [];
  for (let i = 0; i < matchCount; i++) slots.push('match');
  for (let i = 0; i < dollarCount; i++) slots.push('dollar');
  while (slots.length < NUMBERS_PICKS) slots.push('miss');
  shuffle(slots);

  const winningArr = Array.from(winningSet);

  for (const kind of slots) {
    if (kind === 'dollar') {
      picks.push({ value: '$', prize: pickWeighted(), revealed: false });
    } else if (kind === 'match') {
      // Pick a random winning number (allow it to match more than once
      // — multiple cells matching the same winning number stacks the
      // prize, like real tickets do).
      const v = winningArr[Math.floor(Math.random() * winningArr.length)];
      picks.push({ value: v, prize: pickWeighted(), revealed: false });
    } else {
      // miss: any number not already used
      let v = 0;
      for (let i = 0; i < 30; i++) {
        const c = 1 + Math.floor(Math.random() * NUMBER_RANGE);
        if (!usedNumbers.has(c)) { v = c; break; }
      }
      if (v === 0) v = 1 + Math.floor(Math.random() * NUMBER_RANGE);
      usedNumbers.add(v);
      picks.push({ value: v, prize: pickWeighted(), revealed: false });
    }
  }

  return {
    game: 'numbers',
    id: shortId(),
    winning,
    picks,
    totalWon: 0,
    resolved: false,
  };
}

function generateTttTicket(): TttTicket {
  const winRate = GAMES.find((g) => g.id === 'tictactoe')!.winRate;
  const isWinner = Math.random() < winRate;
  const prize = pickWeighted();
  const bonusPrize = PRIZES.find((p) => p.id === 'subway')!;

  // 8 winning lines on a 3x3 grid
  const LINES: number[][] = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ];

  const marks: ('★' | '●')[] = Array(9).fill('●');
  if (isWinner) {
    // pick a winning line, fill it with stars, fill rest with mostly dots
    // (with 1-2 random stars sprinkled to make it visually plausible)
    const line = LINES[Math.floor(Math.random() * LINES.length)];
    for (const i of line) marks[i] = '★';
    // 1 extra star at random non-line positions ~30% of the time
    if (Math.random() < 0.3) {
      const offLine = [...Array(9).keys()].filter((i) => !line.includes(i));
      marks[offLine[Math.floor(Math.random() * offLine.length)]] = '★';
    }
  } else {
    // Non-winner: place 2-4 stars but ENSURE no line of 3
    const targetStars = 2 + Math.floor(Math.random() * 3);
    const stars: number[] = [];
    let attempts = 0;
    while (stars.length < targetStars && attempts < 60) {
      attempts++;
      const cand = Math.floor(Math.random() * 9);
      if (stars.includes(cand)) continue;
      // would adding this complete a line?
      const hypothetical = new Set([...stars, cand]);
      const completes = LINES.some((line) => line.every((i) => hypothetical.has(i)));
      if (completes) continue;
      stars.push(cand);
    }
    for (const i of stars) marks[i] = '★';
  }

  return {
    game: 'tictactoe',
    id: shortId(),
    cells: marks.map((m) => ({ mark: m, revealed: false })),
    prize,
    bonusPrize,
    totalWon: 0,
    resolved: false,
  };
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ──────────────────────────────────────── outcome resolution */

function resolveTicket(t: Ticket): { payout: number; tag: string } {
  if (t.game === 'slice') {
    if (t.winner) return { payout: t.winner.payout, tag: `${t.winner.emoji} ${t.winner.label}` };
    return { payout: 1, tag: 'no match · -1¢ consolation' };
  }
  if (t.game === 'numbers') {
    const winningSet = new Set(t.winning.map((d) => d.value));
    let won = 0;
    let parts: string[] = [];
    for (const p of t.picks) {
      if (p.value === '$') {
        won += p.prize.payout;
        parts.push(`$ → ${p.prize.label}`);
      } else if (winningSet.has(p.value)) {
        won += p.prize.payout;
        parts.push(`${p.value} → ${p.prize.label}`);
      }
    }
    if (won === 0) return { payout: 1, tag: 'no numbers matched · -1¢ consolation' };
    return { payout: won, tag: parts.join(' · ') };
  }
  // tic-tac-toe
  const LINES: number[][] = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ];
  const won = LINES.some((line) => line.every((i) => t.cells[i].mark === '★'));
  if (won) return { payout: t.prize.payout, tag: `★★★ in a row · ${t.prize.label}` };
  return { payout: 1, tag: 'no line · -1¢ consolation' };
}

/* ──────────────────────────────────────── confetti */

/* Emoji confetti — uses canvas-confetti's shapeFromText API to spray
   pizza/cab/dollar/bagel emojis instead of paper. Only fires for big
   wins so it stays special. */
const EMOJI_SHAPES = (() => {
  try {
    return ['🍕', '🚖', '💵', '🥯', '★'].map((t) =>
      confetti.shapeFromText({ text: t, scalar: 2.4 }),
    );
  } catch {
    return null;
  }
})();

function fireConfetti(intensity: 'big' | 'medium' = 'medium') {
  const opts = {
    particleCount: intensity === 'big' ? 200 : 80,
    spread: 80,
    startVelocity: intensity === 'big' ? 60 : 42,
    origin: { y: 0.55 },
    colors: ['#FFD600', '#FF6319', '#d11a2a', '#0039A6', '#6CBE45'],
  };
  try {
    confetti(opts);
    if (intensity === 'big') {
      // Emoji shower follows the paper — runs only on big wins
      if (EMOJI_SHAPES) {
        setTimeout(() => confetti({
          particleCount: 36,
          spread: 90,
          startVelocity: 50,
          scalar: 1.6,
          origin: { y: 0.6 },
          shapes: EMOJI_SHAPES,
        }), 120);
      }
      setTimeout(() => confetti({ ...opts, angle: 60, origin: { x: 0, y: 0.7 } }), 200);
      setTimeout(() => confetti({ ...opts, angle: 120, origin: { x: 1, y: 0.7 } }), 240);
    }
  } catch { /* noop */ }
}

/* ──────────────────────────────────────── page */

export default function Scratch() {
  const { count: quarters, add, spend } = useQuarters();
  type Phase = 'lobby' | 'pickGame' | 'play';
  const [phase, setPhase] = useState<Phase>('lobby');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [history, setHistory] = useState<{ when: number; ticketId: string; game: string; result: string; net: number }[]>([]);

  const buy = () => {
    if (!spend(TICKET_COST)) return;
    setPhase('pickGame');
  };

  const pickGame = (id: GameId) => {
    let t: Ticket;
    if (id === 'slice') t = generateSliceTicket();
    else if (id === 'numbers') t = generateNumbersTicket();
    else t = generateTttTicket();
    setTicket(t);
    setPhase('play');
  };

  const refundIntoStash = () => {
    setPhase('lobby');
    setTicket(null);
  };

  // When the ticket finishes resolving, log to history + payout.
  // Each game's play surface calls onResolve once it has revealed all
  // necessary cells.
  const onResolved = (t: Ticket) => {
    const { payout, tag } = resolveTicket(t);
    add(payout);
    const game = GAMES.find((g) => g.id === t.game)!;
    setHistory((h) => [
      {
        when: Date.now(),
        ticketId: t.id,
        game: game.label,
        result: tag,
        net: payout - TICKET_COST,
      },
      ...h,
    ].slice(0, 10));
    if (payout >= 40) fireConfetti('big');
    else if (payout >= 8) fireConfetti('medium');
  };

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

      {/* easter-egg coins on this page too */}
      <HiddenCoin spotId="scratch-corner" size={16} hint="dropped behind the lotto rack" style={{ right: 18, bottom: 64 }} />
      <HiddenCoin spotId="scratch-tipjar" size={16} hint="under the tip jar" payout={2} style={{ left: 22, bottom: 80 }} />

      <main className="flex-1 px-3 py-5 z-10 max-w-[940px] mx-auto w-full">
        <div className="font-bungee text-[36px] sm:text-[52px] leading-[0.95] uppercase">
          ★ NY <span className="text-[#FFD600]">Scratch-Off</span>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65 mt-1 mb-5">
          collect $1 in coins · pick a game · scratch the silver · payouts go straight to your stash
        </div>

        {phase === 'lobby' && <BuyCard quarters={quarters} onBuy={buy} />}

        {phase === 'pickGame' && (
          <PickGame onPick={pickGame} onCancel={() => { setPhase('lobby'); add(TICKET_COST); }} />
        )}

        {phase === 'play' && ticket && (
          <ScratchSurface
            key={ticket.id}
            ticket={ticket}
            onTicketChange={(next) => setTicket(next)}
            onResolved={onResolved}
            onDiscard={refundIntoStash}
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
                  <span className="text-[#FFD600]/85 tracking-[0.1em]">{h.game}</span>
                  <span className="truncate">· {h.result}</span>
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

/* ──────────────────────────────────────── lobby (buy) */

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
          {enough ? 'all four quarters · pick your game next' : `find ${need} more quarter${need === 1 ? '' : 's'} on the lounge`}
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

function PickGame({ onPick, onCancel }: { onPick: (id: GameId) => void; onCancel: () => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <div className="font-bungee text-[20px] sm:text-[26px] uppercase">★ Pick a Game</div>
        <button
          type="button"
          onClick={onCancel}
          className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55 hover:text-[#FFD600]"
          title="refund the $1 back to your stash"
        >
          ↩ refund
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {GAMES.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => onPick(g.id)}
            className="relative text-left bg-[#0e0f14] hover:bg-black px-3 pt-4 pb-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
            style={{
              border: `3px solid ${g.color}`,
              boxShadow: `4px 4px 0 ${g.color}88`,
            }}
          >
            <div
              className="absolute -top-3 left-3 px-2 py-0.5 font-bungee text-[10px] uppercase tracking-[0.18em]"
              style={{ background: g.color, color: g.color === '#FFD600' ? '#000' : '#fff', border: '2px solid #000' }}
            >
              ★ {g.id === 'numbers' ? 'numbers' : g.id === 'tictactoe' ? '3-in-a-row' : 'match 3'}
            </div>
            <div className="text-[42px] leading-none mb-1" aria-hidden>{g.emoji}</div>
            <div className="font-bungee text-[16px] uppercase tracking-[0.04em]" style={{ color: g.color }}>
              {g.label}
            </div>
            <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/85 mt-1 leading-snug">
              {g.blurb}
            </div>
            <div className="font-typewriter text-[9px] uppercase tracking-[0.18em] text-white/45 mt-2 leading-snug">
              top prize · <span className="text-[#FFD600]">{g.jackpot}¢</span> · win rate ~{Math.round(g.winRate * 100)}%
            </div>
          </button>
        ))}
      </div>
      <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/45 mt-3">
        ★ all tickets cost the same $1 · payouts vary by game · scratch luck doesn't roll over
      </div>
    </div>
  );
}

function PrizeTable() {
  return (
    <div
      className="mt-6 px-3 py-3 bg-black/55 border-2 border-[#FFD600]/40"
      style={{ boxShadow: '3px 3px 0 #d11a2a' }}
    >
      <div className="font-bungee text-[14px] uppercase text-[#FFD600] mb-2">★ shared prize table · paid in quarters</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PRIZES.map((p) => (
          <div
            key={p.id}
            className="flex items-center gap-2 px-2 py-1.5 border font-typewriter text-[10px] uppercase tracking-[0.18em]"
            style={{ borderColor: `${p.color}55`, background: `${p.color}14` }}
          >
            <span className="text-[18px]" aria-hidden>{p.emoji}</span>
            <span className="font-bungee text-[12px]" style={{ color: p.color }}>
              {p.id === 'jackpot' ? (
                <RoughNotation type="circle" color="#FFD600" show strokeWidth={2} padding={3} animationDuration={1100}>
                  <span>{p.label}</span>
                </RoughNotation>
              ) : p.label}
            </span>
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

/* ──────────────────────────────────────── play surface dispatcher */

function ScratchSurface({
  ticket,
  onTicketChange,
  onResolved,
  onDiscard,
}: {
  ticket: Ticket;
  onTicketChange: (t: Ticket) => void;
  onResolved: (t: Ticket) => void;
  onDiscard: () => void;
}) {
  // Resolve once everything's been scratched.
  const allRevealed = isAllRevealed(ticket);
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (resolvedRef.current) return;
    if (!allRevealed) return;
    resolvedRef.current = true;
    onResolved(ticket);
    onTicketChange({ ...ticket, resolved: true } as Ticket);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRevealed]);

  const game = GAMES.find((g) => g.id === ticket.game)!;

  return (
    <div>
      <div
        className="px-3 py-2 mb-3 flex items-center gap-3"
        style={{
          background: game.color,
          color: game.color === '#FFD600' ? '#000' : '#fff',
          border: '3px solid #000',
          boxShadow: '4px 4px 0 #d11a2a',
        }}
      >
        <span className="font-bungee uppercase text-[14px] tracking-[0.06em]">★ {game.label}</span>
        <span className="font-typewriter text-[10px] uppercase tracking-[0.18em] opacity-85">#{ticket.id}</span>
        <span className="ml-auto font-typewriter text-[10px] uppercase tracking-[0.22em] opacity-85">
          {allRevealed ? '★ TICKET CLOSED ★' : game.howTo}
        </span>
      </div>

      {ticket.game === 'slice' && (
        <SlicePlay ticket={ticket} onTicketChange={onTicketChange} />
      )}
      {ticket.game === 'numbers' && (
        <NumbersPlay ticket={ticket} onTicketChange={onTicketChange} />
      )}
      {ticket.game === 'tictactoe' && (
        <TttPlay ticket={ticket} onTicketChange={onTicketChange} />
      )}

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
      </div>
    </div>
  );
}

function isAllRevealed(t: Ticket): boolean {
  if (t.game === 'slice') return t.cells.every((c) => c.revealed);
  if (t.game === 'numbers') {
    return t.winning.every((d) => d.revealed) && t.picks.every((p) => p.revealed);
  }
  return t.cells.every((c) => c.revealed);
}

/* ──────────────────────────────────────── game 1: slice triple (match 3) */

function SlicePlay({ ticket, onTicketChange }: { ticket: SliceTicket; onTicketChange: (t: SliceTicket) => void }) {
  const reveal = (idx: number) => {
    const next: SliceTicket = {
      ...ticket,
      cells: ticket.cells.map((c, i) => (i === idx ? { ...c, revealed: true } : c)),
    };
    onTicketChange(next);
  };
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {ticket.cells.map((c, i) => (
        <ScratchCell
          key={`${ticket.id}-${i}`}
          revealed={c.revealed}
          onReveal={() => reveal(i)}
          background={c.prize.color}
        >
          <div className="text-[44px] sm:text-[52px] leading-none" aria-hidden>{c.prize.emoji}</div>
          <div
            className="font-bungee text-[12px] sm:text-[14px] uppercase tracking-[0.04em] mt-1"
            style={{
              color: c.prize.color === '#FFD600' || c.prize.color === '#FAB80F' ? '#000' : '#fff',
              textShadow: '1px 1px 0 rgba(0,0,0,0.45)',
            }}
          >
            {c.prize.label}
          </div>
          <div
            className="font-typewriter text-[9px] uppercase tracking-[0.22em] mt-0.5"
            style={{ color: c.prize.color === '#FFD600' || c.prize.color === '#FAB80F' ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)' }}
          >
            +{c.prize.payout}¢
          </div>
        </ScratchCell>
      ))}
    </div>
  );
}

/* ──────────────────────────────────────── game 2: nyc numbers */

function NumbersPlay({ ticket, onTicketChange }: { ticket: NumbersTicket; onTicketChange: (t: NumbersTicket) => void }) {
  const revealWinning = (i: number) => {
    onTicketChange({
      ...ticket,
      winning: ticket.winning.map((d, j) => (j === i ? { ...d, revealed: true } : d)),
    });
  };
  const revealPick = (i: number) => {
    onTicketChange({
      ...ticket,
      picks: ticket.picks.map((p, j) => (j === i ? { ...p, revealed: true } : p)),
    });
  };

  // Highlight a "your pick" if its number matches any revealed winning number
  const winningSet = new Set(ticket.winning.filter((d) => d.revealed).map((d) => d.value));

  return (
    <div className="grid gap-3">
      {/* winning numbers row */}
      <div
        className="px-3 py-3 bg-[#0a0a0e] border-2"
        style={{ borderColor: '#0039A655' }}
      >
        <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#0039A6] mb-2">
          ★ WINNING NUMBERS — scratch all 3
        </div>
        <div className="grid grid-cols-3 gap-2">
          {ticket.winning.map((d, i) => (
            <ScratchCell
              key={`w-${i}`}
              revealed={d.revealed}
              onReveal={() => revealWinning(i)}
              background="#0039A6"
              compact
            >
              <div className="font-tabloid text-[36px] sm:text-[44px] leading-none tabular text-white" style={{ textShadow: '2px 2px 0 rgba(0,0,0,0.45)' }}>
                {d.value}
              </div>
              <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/85 mt-0.5">winning</div>
            </ScratchCell>
          ))}
        </div>
      </div>

      {/* your numbers grid */}
      <div
        className="px-3 py-3 bg-[#0a0a0e] border-2"
        style={{ borderColor: '#FFD60055' }}
      >
        <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600] mb-2">
          ★ YOUR NUMBERS — match any winning number to win that prize · find a $ to win the prize automatically
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {ticket.picks.map((p, i) => {
            const isWin = p.revealed && (p.value === '$' || (typeof p.value === 'number' && winningSet.has(p.value)));
            return (
              <ScratchCell
                key={`p-${i}`}
                revealed={p.revealed}
                onReveal={() => revealPick(i)}
                background={isWin ? p.prize.color : '#1a1a22'}
                ring={isWin ? '#FFD600' : undefined}
                compact
              >
                <div
                  className="font-tabloid text-[30px] sm:text-[36px] leading-none tabular"
                  style={{
                    color: isWin
                      ? (p.prize.color === '#FFD600' || p.prize.color === '#FAB80F' ? '#000' : '#fff')
                      : '#fff',
                  }}
                >
                  {p.value === '$' ? '$' : p.value}
                </div>
                <div
                  className="font-typewriter text-[8.5px] uppercase tracking-[0.18em] mt-0.5"
                  style={{
                    color: isWin
                      ? (p.prize.color === '#FFD600' || p.prize.color === '#FAB80F' ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)')
                      : 'rgba(255,255,255,0.6)',
                  }}
                >
                  {p.prize.label} · +{p.prize.payout}¢
                </div>
                {isWin && (
                  <div className="font-bungee text-[10px] uppercase tracking-[0.18em] mt-0.5" style={{ color: p.prize.color === '#FFD600' || p.prize.color === '#FAB80F' ? '#000' : '#FFD600' }}>
                    ★ WINNER
                  </div>
                )}
              </ScratchCell>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────── game 3: tic-tac-toe */

function TttPlay({ ticket, onTicketChange }: { ticket: TttTicket; onTicketChange: (t: TttTicket) => void }) {
  const reveal = (idx: number) => {
    onTicketChange({
      ...ticket,
      cells: ticket.cells.map((c, i) => (i === idx ? { ...c, revealed: true } : c)),
    });
  };

  // Compute winning line (if any) once everything's revealed
  const allRevealed = ticket.cells.every((c) => c.revealed);
  const LINES: number[][] = [
    [0,1,2],[3,4,5],[6,7,8],
    [0,3,6],[1,4,7],[2,5,8],
    [0,4,8],[2,4,6],
  ];
  const winningLine = allRevealed
    ? LINES.find((line) => line.every((i) => ticket.cells[i].mark === '★'))
    : null;

  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
      <div className="grid grid-cols-3 gap-2">
        {ticket.cells.map((c, i) => {
          const inWinLine = !!winningLine && winningLine.includes(i);
          return (
            <ScratchCell
              key={`tt-${i}`}
              revealed={c.revealed}
              onReveal={() => reveal(i)}
              background={c.mark === '★' ? '#6CBE45' : '#1a1a22'}
              ring={inWinLine ? '#FFD600' : undefined}
            >
              <div
                className="font-bungee leading-none"
                style={{
                  fontSize: '64px',
                  color: c.mark === '★' ? '#fff' : 'rgba(255,255,255,0.55)',
                  textShadow: c.mark === '★' ? '3px 3px 0 rgba(0,0,0,0.45)' : 'none',
                }}
              >
                {c.mark}
              </div>
            </ScratchCell>
          );
        })}
      </div>
      <div
        className="px-3 py-3 bg-[#0a0a0e] border-2 self-start"
        style={{ borderColor: `${ticket.prize.color}66` }}
      >
        <div className="font-bungee text-[12px] uppercase tracking-[0.04em] mb-1" style={{ color: ticket.prize.color }}>
          ★ ROW PRIZE
        </div>
        <div className="text-[44px] leading-none" aria-hidden>{ticket.prize.emoji}</div>
        <div className="font-bungee text-[16px] uppercase mt-1" style={{ color: ticket.prize.color }}>
          {ticket.prize.label}
        </div>
        <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/85 mt-1">
          +{ticket.prize.payout}¢ · {ticket.prize.blurb}
        </div>
        <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-2 leading-snug">
          ★ get ★★★ in any straight line to win this prize · ●s lose
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────── canvas scratch primitive */

const SCRATCH_THRESHOLD = 0.35;

function ScratchCell({
  revealed,
  onReveal,
  background,
  ring,
  compact = false,
  children,
}: {
  revealed: boolean;
  onReveal: () => void;
  background: string;
  ring?: string;
  compact?: boolean;
  children: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawingRef = useRef(false);
  const [revealedLocal, setRevealedLocal] = useState(revealed);

  useEffect(() => { setRevealedLocal(revealed); }, [revealed]);

  // Initial silver paint
  useEffect(() => {
    const cv = canvasRef.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap || revealedLocal) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = wrap.getBoundingClientRect();
    cv.width = Math.floor(rect.width * dpr);
    cv.height = Math.floor(rect.height * dpr);
    cv.style.width = `${rect.width}px`;
    cv.style.height = `${rect.height}px`;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const grad = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    grad.addColorStop(0, '#dadee5');
    grad.addColorStop(0.5, '#a7adb6');
    grad.addColorStop(1, '#7c828c');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, rect.width, rect.height);
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
  }, [revealedLocal]);

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
    let cleared = 0, total = 0;
    for (let i = 3; i < sample.length; i += 4 * 18) {
      total++;
      if (sample[i] < 24) cleared++;
    }
    if (cleared / total >= SCRATCH_THRESHOLD) {
      setRevealedLocal(true);
      onReveal();
    }
  };

  // useDrag handles pointer + touch + multi-finger gracefully and
  // gives us per-frame xy coords. Cleaner than the pointer-event
  // ladder we had before, especially on iOS where pointer capture is
  // flaky for canvas elements.
  const bindDrag = useDrag(
    ({ first, last, dragging, xy: [x, y] }) => {
      if (revealedLocal) return;
      if (first) drawingRef.current = true;
      if (dragging) eraseAt(x, y);
      if (last) {
        drawingRef.current = false;
        checkReveal();
      }
    },
    { filterTaps: false, pointer: { touch: true } },
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (revealedLocal) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const cv = canvasRef.current;
      const ctx = cv?.getContext('2d');
      if (cv && ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      setRevealedLocal(true);
      onReveal();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative aspect-[4/3] select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      style={{
        background,
        border: '3px solid #000',
        boxShadow: ring ? `3px 3px 0 ${ring}, 0 0 0 3px ${ring} inset` : '3px 3px 0 #d11a2a',
        minHeight: compact ? 90 : 110,
        cursor: revealedLocal ? 'default' : 'crosshair',
      }}
      onKeyDown={onKey}
      tabIndex={0}
      role="button"
      aria-label={revealedLocal ? 'revealed cell' : 'scratch this cell — press enter to reveal'}
    >
      <div className="absolute inset-0 grid place-items-center text-center px-1.5">
        <div>{children}</div>
      </div>
      {!revealedLocal && (
        <canvas
          ref={canvasRef}
          {...bindDrag()}
          className="absolute inset-0 touch-none"
        />
      )}
    </div>
  );
}
