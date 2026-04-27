import { useEffect, useMemo, useRef, useState } from 'react';
import { RoughNotation } from 'react-rough-notation';
import { BodegaAwning, StreetFauna } from './bodega-tv';
import { QuarterStash, RollingQuarter, HiddenCoin } from './quarter';
import { ShrineParticles } from './fx-particles';
import {
  autocompleteAddress,
  fetchCouncilEvents,
  fetchHpdComplaints,
  fetchHpdViolations,
  type AddressMatch,
  type CouncilEvent,
  type HpdComplaint,
  type HpdViolation,
} from './civic-data';

/* ──────────────────────────────────────────────────────────────────────
   /shrine — THE MAMDANI SHRINE
   A civic-education page styled as a temple. Goal: get a 19-year-old
   to leave the page knowing one new thing about NYC government and
   one place they can plug in.
   ──────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────── live council legislation
   NYC Council exposes all legislation through the Legistar Web API.
   No key, JSON, CORS-friendly. We pull the most recent ~24 matters. */

const LEGISTAR_URL =
  'https://webapi.legistar.com/v1/nyc/Matters' +
  '?$top=24' +
  '&$orderby=MatterIntroDate%20desc' +
  '&$select=MatterId,MatterFile,MatterName,MatterTitle,MatterTypeName,MatterStatusName,MatterIntroDate,MatterBodyName';

type Matter = {
  MatterId: number;
  MatterFile: string;
  MatterName?: string;
  MatterTitle?: string;
  MatterTypeName?: string;
  MatterStatusName?: string;
  MatterIntroDate?: string;
  MatterBodyName?: string;
};

const MATTERS_CACHE_KEY = 'nyc-mamdani-matters-v1';
const MATTERS_CACHE_MS = 6 * 60 * 60 * 1000; // 6h

function useNycLegislation() {
  const [matters, setMatters] = useState<Matter[] | null>(() => {
    try {
      const raw = localStorage.getItem(MATTERS_CACHE_KEY);
      if (!raw) return null;
      const cached = JSON.parse(raw) as { ts: number; data: Matter[] };
      if (Date.now() - cached.ts < MATTERS_CACHE_MS) return cached.data;
    } catch { /* noop */ }
    return null;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (matters) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch(LEGISTAR_URL);
        if (!r.ok) throw new Error('legistar http ' + r.status);
        const j = (await r.json()) as Matter[];
        if (stop) return;
        setMatters(j);
        try {
          localStorage.setItem(MATTERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: j }));
        } catch { /* noop */ }
      } catch (e) {
        if (stop) return;
        setError(e instanceof Error ? e.message : 'feed offline');
      }
    })();
    return () => { stop = true; };
  }, [matters]);

  return { matters, error };
}

/* Wikipedia REST API → page summary returns a thumbnail.source URL for
   the article's lead image. Public, CORS-enabled, no key required.
   Falls back gracefully to the SVG portrait on any failure. */

const MAYOR_WIKI_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary/Zohran_Mamdani';
const PHOTO_CACHE_KEY = 'nyc-mamdani-photo-v1';
const PHOTO_CACHE_MS = 24 * 60 * 60 * 1000;

function useMayorPhoto() {
  const [src, setSrc] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(PHOTO_CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw) as { ts: number; src: string };
      if (Date.now() - c.ts < PHOTO_CACHE_MS) return c.src;
    } catch { /* noop */ }
    return null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (src || failed) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch(MAYOR_WIKI_URL);
        if (!r.ok) throw new Error('wiki http ' + r.status);
        const j = (await r.json()) as {
          thumbnail?: { source: string };
          originalimage?: { source: string };
        };
        const url = j.originalimage?.source ?? j.thumbnail?.source;
        if (stop) return;
        if (url) {
          setSrc(url);
          try { localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify({ ts: Date.now(), src: url })); } catch { /* noop */ }
        } else {
          setFailed(true);
        }
      } catch {
        if (!stop) setFailed(true);
      }
    })();
    return () => { stop = true; };
  }, [src, failed]);

  return { src, failed, markFailed: () => setFailed(true) };
}

/* ──────────────────────────────────────── content: scriptures (real platform) */

type Plank = { id: string; verse: string; teach: string; stat: string };
const SCRIPTURE: Plank[] = [
  {
    id: 'rent-freeze',
    verse: 'Freeze the Rent',
    teach: 'The mayor appoints a majority of the 9-member Rent Guidelines Board, which votes annually on rent-stabilized adjustments. A "freeze" = 0% increase year over year.',
    stat: '~1,000,000 NYC apartments are rent-stabilized — about 22% of all housing.',
  },
  {
    id: 'free-buses',
    verse: 'Make Buses Fast & Free',
    teach: 'Eliminate bus fares citywide and pair it with bus-lane enforcement to speed travel. The MTA is state-controlled, so this requires Albany cooperation.',
    stat: 'NYC piloted free service on 5 routes in 2023; ridership jumped 30–38% on those lines.',
  },
  {
    id: 'childcare',
    verse: 'Universal Childcare',
    teach: 'Free childcare for every kid age 6 weeks → 5 years. Treats childcare as a right, like K-12, instead of a means-tested benefit.',
    stat: 'Average NYC infant care: $25k/year — more than CUNY tuition.',
  },
  {
    id: 'city-grocery',
    verse: 'City-Owned Grocery Stores',
    teach: 'A pilot of municipally operated grocery stores (one per borough) in food deserts. Removes the profit margin on essentials. Models exist in Madison, WI and Atlanta.',
    stat: 'NYC has ~80 designated food deserts where the nearest supermarket is 0.5+ miles away.',
  },
  {
    id: 'min-wage',
    verse: 'Raise the Minimum Wage to $30/hr',
    teach: '$30/hr by 2030, indexed to NYC cost of living. Requires state approval — the city can advocate but not legislate wages directly.',
    stat: 'Current NYC min wage: $16.50. To match 1968 purchasing power it would need to be ~$25.',
  },
  {
    id: 'taxis',
    verse: 'Fix the Taxi Medallion Crisis',
    teach: 'Continue buying down predatory medallion loans that ballooned during the 2010s, when the city auctioned medallions at inflated prices.',
    stat: '~4,000 owner-operators were affected; 9 took their own lives during the 2018 wave.',
  },
  {
    id: 'climate',
    verse: 'Green Schools, Green Housing',
    teach: 'Retrofit every public school for energy efficiency by 2030; build 200K new affordable homes to deep-green standard. Funded by bonds + federal IRA dollars.',
    stat: 'NYC buildings produce ~70% of the city\'s greenhouse-gas emissions.',
  },
];

/* ──────────────────────────────────────── content: did-you-know cards
   Concrete civic facts. Kept punchy and verifiable. */
type Fact = { id: string; q: string; a: string };
const FACTS: Fact[] = [
  { id: 'budget',  q: 'NYC\'s annual budget?',                                 a: '~$112 BILLION. Bigger than 36 US states\' budgets — combined.' },
  { id: 'council', q: 'How many City Council members?',                        a: '51. Each represents ~170,000 New Yorkers. They write local laws and approve the budget.' },
  { id: 'mayor',   q: 'How long can a mayor serve?',                           a: 'Two consecutive 4-year terms (the law changed in 2008 and back in 2010). Max 8 years in a row.' },
  { id: 'mta',     q: 'Does the mayor run the MTA?',                           a: 'NO. The MTA is a state authority — Albany controls it. The mayor appoints 4 of 21 board members.' },
  { id: 'cb',      q: 'What\'s a Community Board?',                            a: '59 hyperlocal advisory boards. They review zoning, liquor licenses, & street redesigns. Show up — they need warm bodies.' },
  { id: 'budget2', q: 'Where does most of the budget go?',                     a: 'Education (~$38B) > Social Services (~$20B) > NYPD (~$12B) > Sanitation, Fire, parks, etc.' },
  { id: 'dem',     q: 'Why does the Democratic primary matter so much?',      a: 'NYC is ~6:1 Democrat. The Dem primary is effectively the general — winning it is winning office.' },
  { id: 'turn',    q: 'What was 2025 mayoral primary turnout?',                a: 'Around 1.1M votes cast — the highest mayoral primary turnout in decades.' },
  { id: 'rent',    q: 'What\'s "rent stabilization"?',                         a: 'NY State law capping yearly rent hikes on certain apartments built before 1974. The RGB sets the cap.' },
  { id: 'budget3', q: 'When is the city budget passed?',                       a: 'Every year by July 1. The mayor proposes (Jan/Apr), Council negotiates, both sign off.' },
  { id: 'hearing', q: 'Can I testify at a Council hearing?',                   a: 'Yes — anyone can. Sign up at council.nyc.gov/testify · 2 min per speaker, free, in person or remote.' },
  { id: 'cau',     q: 'What does the Mayor\'s Office actually DO?',           a: '~330,000 employees across 80+ agencies — sanitation, NYPD, FDNY, DOE, parks, courts, jails, hospitals, the works.' },
];

/* ──────────────────────────────────────── content: take-action links */
type Action = { label: string; sub: string; href: string; emoji: string; tone: string };
const ACTIONS: Action[] = [
  {
    label: 'Register to vote',
    sub: 'Or check your registration · 18+ · takes 4 minutes',
    href: 'https://www.elections.ny.gov/votingregister.html',
    emoji: '🗳️',
    tone: '#FFD600',
  },
  {
    label: 'Find your Council member',
    sub: '51 districts · type your address',
    href: 'https://council.nyc.gov/districts/',
    emoji: '🏛️',
    tone: '#0039A6',
  },
  {
    label: 'Find your Community Board',
    sub: '59 boards · zoning · liquor · street redesigns',
    href: 'https://council.nyc.gov/community-boards/',
    emoji: '🪧',
    tone: '#6CBE45',
  },
  {
    label: 'Testify at a hearing',
    sub: '2 min · in person or remote · anyone can',
    href: 'https://council.nyc.gov/testify/',
    emoji: '🎙️',
    tone: '#FF6319',
  },
  {
    label: 'Read the City Record',
    sub: 'every notice the city has to publish · fascinating',
    href: 'https://a856-cityrecord.nyc.gov/',
    emoji: '📜',
    tone: '#d11a2a',
  },
  {
    label: 'Open a 311 complaint',
    sub: 'noise · pothole · heat · the actual lever',
    href: 'https://portal.311.nyc.gov/',
    emoji: '📞',
    tone: '#B5F500',
  },
];

/* ──────────────────────────────────────── content: glossary */
type GlossaryEntry = { term: string; def: string };
const GLOSSARY: GlossaryEntry[] = [
  { term: 'Introduction',
    def: 'A proposed bill. Most "Intros" never pass — only ~10% of introduced bills become law in any given Council session.' },
  { term: 'Local Law',
    def: 'An Intro that has passed Council, been signed (or vetoed-and-overridden) by the mayor, and is now binding NYC law.' },
  { term: 'Resolution',
    def: 'A formal Council position with no force of law. Used to take a stance on state/federal issues, or to honor people.' },
  { term: 'Mayoral Veto',
    def: 'The mayor can refuse to sign a bill within 30 days. Council can override with 34 of 51 votes (2/3 supermajority).' },
  { term: 'Charter',
    def: 'NYC\'s constitution. Sets up agencies, defines who has what power. Last fully revised in 1989. Charter amendments need a public referendum.' },
  { term: 'CAPA',
    def: 'City Administrative Procedure Act — the public-comment process every NYC agency must run before adopting new rules.' },
];

/* ──────────────────────────────────────── content: candle actions
   Each candle is a discrete civic action — clicking lights it AND
   reveals what taking that action actually means. */
type CandleAction = {
  label: string;
  why: string;
};
const CANDLE_ACTIONS: CandleAction[] = [
  { label: 'VOTE',         why: 'Off-year city elections decide who runs your block. Turnout under 25% is normal — your vote is loud.' },
  { label: 'TESTIFY',      why: '2 minutes at a hearing changes the room. Council members read every transcript.' },
  { label: 'SHOW UP',      why: 'Community Board meetings are mostly empty. Your face shifts what passes.' },
  { label: 'CALL 311',     why: 'Every complaint creates a public record. Trends move budgets.' },
  { label: 'READ',         why: 'The City Record publishes every public notice. Knowing > guessing.' },
  { label: 'CANVASS',      why: 'Door-knocking decided 2025\'s primary. Turnout in your building is on you.' },
  { label: 'RUN',          why: 'NYC has 51 Council seats. Median age of winners is mid-40s, but that\'s changing fast.' },
];

/* ──────────────────────────────────────── ornaments */

function HaloPortrait({ size = 240, photoSrc, onPhotoFail }: { size?: number; photoSrc: string | null; onPhotoFail: () => void }) {
  const ringId = `halo-rings-${size}`;
  // Photo shows inside the halo when available; SVG silhouette is the
  // fallback. The halo and concentric rings render in front of either
  // so the iconography reads consistently.
  return (
    <div className="relative inline-block" style={{ width: size, height: (size * 220) / 200 }}>
      <svg viewBox="0 0 200 220" width={size} height={(size * 220) / 200} aria-label="Halo iconography">
        <defs>
          <radialGradient id={`bg-${ringId}`} cx="50%" cy="40%" r="65%">
            <stop offset="0%" stopColor="#FFE89A" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#FFD600" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#FFD600" stopOpacity="0" />
          </radialGradient>
          <pattern id={`rays-${ringId}`} x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="20" stroke="#FFD600" strokeWidth="0.8" opacity="0.4" />
          </pattern>
        </defs>
        <circle cx="100" cy="92" r="100" fill={`url(#bg-${ringId})`} />
        <circle cx="100" cy="92" r="84" fill={`url(#rays-${ringId})`} />
        {[88, 72, 58].map((r, i) => (
          <circle key={r} cx="100" cy="92" r={r} fill="none" stroke="#FFD600" strokeWidth={i === 0 ? 1.2 : 0.6} opacity={0.4 + i * 0.13} />
        ))}
      </svg>

      {/* photo OR SVG silhouette, clipped to a circle, centered on halo */}
      <div
        className="absolute"
        style={{
          left: '50%',
          top: `${(92 / 220) * 100}%`,
          transform: 'translate(-50%, -50%)',
          width: size * 0.42,
          height: size * 0.42,
          borderRadius: '50%',
          overflow: 'hidden',
          border: '3px solid #FFD600',
          boxShadow: '0 0 22px rgba(255,214,0,0.65), 0 0 0 4px #02163a',
          background: '#02163a',
        }}
      >
        {photoSrc ? (
          <img
            src={photoSrc}
            alt="Mayor Zohran Mamdani"
            referrerPolicy="no-referrer"
            decoding="async"
            onError={onPhotoFail}
            className="w-full h-full object-cover"
            style={{ display: 'block' }}
          />
        ) : (
          <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden>
            <rect width="100" height="100" fill="#02163a" />
            <ellipse cx="50" cy="42" rx="22" ry="26" fill="#1a1410" />
            <path d="M 28 38 Q 32 12 50 8 Q 68 12 72 38 Q 70 22 50 18 Q 30 22 28 38 Z" fill="#0a0a0a" />
            <path d="M 35 60 Q 50 78 65 60 Q 64 78 50 84 Q 36 78 35 60 Z" fill="#0a0a0a" opacity="0.85" />
            <path d="M 14 100 Q 14 74 50 74 Q 86 74 86 100 Z" fill="#0a3a82" />
            <path d="M 36 86 Q 50 80 64 86 L 60 92 Q 50 86 40 92 Z" fill="#FFD600" opacity="0.85" />
          </svg>
        )}
      </div>

      {/* nameplate ribbon under the halo */}
      <div
        className="absolute left-1/2 -translate-x-1/2 px-3 py-0.5 font-bungee text-[11px] uppercase tracking-[0.18em]"
        style={{
          bottom: 4,
          background: '#FFD600',
          color: '#02163a',
          border: '2px solid #02163a',
          boxShadow: '2px 2px 0 #d11a2a',
        }}
      >
        ZOHRAN ★ K. ★ MAMDANI
      </div>
    </div>
  );
}

function StainedGlass({ side }: { side: 'left' | 'right' }) {
  const tile = (
    <div className="grid place-items-center px-2 py-3 border-2 border-[#02163a]" style={{
      background:
        'radial-gradient(ellipse at 50% 30%, #FFD600 0%, #FF8A3A 22%, #d11a2a 46%, #6a0d1c 75%, #02163a 100%)',
      boxShadow: 'inset 0 0 0 4px #02163a, inset 0 0 0 6px #FFD600',
      minHeight: 110,
    }}>
      <span className="text-[28px]" aria-hidden>★</span>
    </div>
  );
  return (
    <div className={`hidden lg:flex flex-col gap-3 ${side === 'left' ? '' : 'order-last'}`}>
      <div className="px-2 py-1 bg-[#02163a] text-[#FFD600] text-center font-bungee text-[10px] uppercase tracking-[0.18em] border border-[#FFD600]">
        FIVE BOROUGHS
      </div>
      {tile}{tile}{tile}
    </div>
  );
}

/* Candle row — each candle is a CIVIC ACTION. Clicking lights it and
   reveals the why-it-matters card next to the row. State persists. */
function CandleRow() {
  const [lit, setLit] = useState<boolean[]>(() => {
    try {
      const raw = localStorage.getItem('shrine-candles-v2');
      if (raw) {
        const arr = JSON.parse(raw) as boolean[];
        if (Array.isArray(arr) && arr.length === CANDLE_ACTIONS.length) return arr;
      }
    } catch { /* noop */ }
    return Array.from({ length: CANDLE_ACTIONS.length }, () => false);
  });
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    try { localStorage.setItem('shrine-candles-v2', JSON.stringify(lit)); } catch { /* noop */ }
  }, [lit]);
  const toggle = (i: number) => {
    setLit((p) => p.map((v, j) => (j === i ? !v : v)));
    setActive(i);
  };
  const litCount = lit.filter(Boolean).length;
  const focused = active != null ? CANDLE_ACTIONS[active] : null;
  return (
    <div className="px-3 py-3 bg-[#02163a] border-2 border-[#FFD600]">
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-1">
        <span className="font-bungee text-[14px] uppercase tracking-[0.06em] text-[#FFD600]">
          ✦ light a candle for an action you'll take
        </span>
        <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-[#FFD600]/65">
          {litCount} of {CANDLE_ACTIONS.length} pledged
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-end">
        <div className="flex justify-between gap-1 sm:gap-2">
          {lit.map((on, i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggle(i)}
              className="relative flex flex-col items-center w-10 sm:w-12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              aria-pressed={on}
              aria-label={`${on ? 'extinguish' : 'pledge'} ${CANDLE_ACTIONS[i].label}`}
              title={CANDLE_ACTIONS[i].label}
            >
              <div className="relative w-full h-20 grid place-items-end">
                {on && (
                  <span
                    className="absolute left-1/2 -translate-x-1/2"
                    style={{
                      bottom: 50,
                      width: 10,
                      height: 16,
                      borderRadius: '50% 50% 50% 50% / 70% 70% 30% 30%',
                      background: 'radial-gradient(ellipse at 50% 70%, #FFE89A, #FFD600 35%, #FF6319 70%, #d11a2a)',
                      filter: 'drop-shadow(0 0 8px rgba(255,150,40,0.85))',
                      animation: 'shrine-flicker 1.6s ease-in-out infinite',
                    }}
                    aria-hidden
                  />
                )}
                <span className="absolute left-1/2 -translate-x-1/2" style={{ bottom: 48, width: 1, height: 5, background: '#1a1410' }} aria-hidden />
                <span
                  className="block w-full"
                  style={{
                    height: 50,
                    background: on
                      ? 'linear-gradient(180deg, #fff7d0 0%, #ffd97a 60%, #c7912b 100%)'
                      : 'linear-gradient(180deg, #f7f0d8 0%, #d6c89a 60%, #8a7a4a 100%)',
                    borderRadius: '3px 3px 1px 1px',
                    boxShadow: 'inset 0 -3px 0 rgba(0,0,0,0.35), 0 2px 0 rgba(0,0,0,0.45)',
                  }}
                />
                <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-2 bg-[#1a1410] rounded-b" aria-hidden />
              </div>
              <span
                className="font-bungee text-[8.5px] sm:text-[9px] uppercase tracking-[0.06em] mt-1"
                style={{ color: on ? '#FFD600' : 'rgba(255,214,0,0.55)' }}
              >
                {CANDLE_ACTIONS[i].label}
              </span>
            </button>
          ))}
        </div>
        <div
          className="px-3 py-3 border-2 self-stretch"
          style={{ background: 'rgba(0,0,0,0.4)', borderColor: focused ? '#FFD600' : 'rgba(255,214,0,0.35)' }}
        >
          <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600] mb-1">
            ✦ {focused ? focused.label : 'pick a candle'}
          </div>
          <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 leading-snug">
            {focused
              ? focused.why
              : 'each candle is a real way to plug into nyc government. tap one — it lights up and tells you why it matters.'}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────── page */

export default function Shrine() {
  const { matters, error } = useNycLegislation();
  const photo = useMayorPhoto();
  // pick a "verse of the day" deterministically by date
  const todayVerse = useMemo(() => {
    const d = new Date();
    const idx = (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) % SCRIPTURE.length;
    return SCRIPTURE[idx];
  }, []);

  // Did-you-know rotation — auto-cycle every 9 seconds; user can also click for a new one
  const [factIdx, setFactIdx] = useState(() => Math.floor(Math.random() * FACTS.length));
  useEffect(() => {
    const i = setInterval(() => setFactIdx((n) => (n + 1) % FACTS.length), 9_000);
    return () => clearInterval(i);
  }, []);
  const advanceFact = () => setFactIdx((n) => (n + 1 + Math.floor(Math.random() * (FACTS.length - 1))) % FACTS.length);

  // Click the halo: spawn a quick civic-fact toast (easter egg)
  const [haloToast, setHaloToast] = useState<string | null>(null);
  const haloPing = () => {
    const f = FACTS[Math.floor(Math.random() * FACTS.length)];
    setHaloToast(`${f.q} — ${f.a}`);
    setTimeout(() => setHaloToast(null), 5500);
  };

  return (
    <div
      className="min-h-screen w-screen flex flex-col text-white"
      style={{
        background:
          'radial-gradient(ellipse at 50% 18%, #2a1a4d 0%, #14082a 45%, #04020a 90%)',
      }}
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

      {/* easter-egg coins, each carrying a civic factoid in its hover hint */}
      <HiddenCoin spotId="shrine-altar-left" size={16}
        hint="did you know? the city budget is ~$112B/yr · bigger than 36 US states combined"
        style={{ left: 18, top: 240 }} />
      <HiddenCoin spotId="shrine-altar-right" size={16} payout={2}
        hint="did you know? city council = 51 members · each represents ~170k new yorkers"
        style={{ right: 22, top: 280 }} />
      <HiddenCoin spotId="shrine-pew" size={14}
        hint="did you know? anyone can testify at a council hearing · 2 min, free"
        style={{ left: '50%', bottom: 80 }} />
      <HiddenCoin spotId="shrine-vestibule" size={14} payout={2}
        hint="did you know? the mta is state-run · the mayor only appoints 4 of 21 board members"
        style={{ left: 30, bottom: 200 }} />
      <HiddenCoin spotId="shrine-window" size={14}
        hint="did you know? the nyc budget passes by july 1 every year"
        style={{ right: 40, bottom: 260 }} />

      <main className="flex-1 px-3 py-5 z-10 max-w-[1200px] mx-auto w-full">

        {/* hero */}
        <header className="text-center mb-6">
          <div className="font-typewriter text-[10px] uppercase tracking-[0.3em] text-[#FFD600]/65 mb-1">
            Civic Education · NYC · For New Yorkers Who Want to Know What's Actually Happening
          </div>
          <h1
            className="font-bungee uppercase leading-[0.9] tracking-[0.02em]"
            style={{
              fontSize: 'clamp(40px, 8vw, 88px)',
              color: '#FFD600',
              textShadow: '0 0 18px rgba(255,214,0,0.55), 4px 4px 0 #d11a2a',
            }}
          >
            ★ The <span className="text-white">Mamdani</span> Shrine ★
          </h1>
        </header>

        {/* nave layout */}
        <div className="grid lg:grid-cols-[140px_minmax(0,1fr)_140px] gap-4 mb-6">
          <StainedGlass side="left" />

          <section
            className="px-4 sm:px-8 py-6 text-center relative overflow-hidden"
            style={{
              background:
                'radial-gradient(ellipse at 50% 0%, rgba(255,214,0,0.12), transparent 60%), linear-gradient(180deg, #02163a 0%, #050a18 100%)',
              border: '4px double #FFD600',
              boxShadow: 'inset 0 0 60px rgba(255,214,0,0.18), 6px 6px 0 #d11a2a',
            }}
          >
            <ShrineParticles />
            <button
              type="button"
              onClick={haloPing}
              className="grid place-items-center w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
              aria-label="reveal a civic fact"
              title="tap the halo for a civic fact"
            >
              <HaloPortrait size={260} photoSrc={photo.src} onPhotoFail={photo.markFailed} />
            </button>
            <div className="font-typewriter text-[11px] uppercase tracking-[0.28em] text-[#FFD600]/85 mt-3">
              Mayor · The City of New York · 110th
            </div>

            {/* verse of the day */}
            <div className="mt-5 mx-auto max-w-[640px] px-3 py-3 bg-black/45 border-2 border-[#FFD600]/55 text-left">
              <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600] mb-1">
                ✦ Verse of the day
              </div>
              <div
                className="font-bungee uppercase leading-tight"
                style={{ fontSize: 'clamp(20px, 3vw, 28px)', color: '#fff' }}
              >
                "<RoughNotation type="highlight" color="#FFD60055" show animationDelay={400} animationDuration={1100} padding={4}>
                  <span>{todayVerse.verse}</span>
                </RoughNotation>"
              </div>
              <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 mt-2 leading-snug">
                {todayVerse.teach}
              </div>
              <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-[#FFD600]/85 mt-2 leading-snug">
                ★ {todayVerse.stat}
              </div>
            </div>

            {/* halo-fact toast */}
            {haloToast && (
              <div
                className="absolute left-1/2 -translate-x-1/2 px-3 py-2 max-w-[480px] z-20"
                style={{
                  bottom: -18,
                  background: '#FFD600',
                  color: '#02163a',
                  border: '3px solid #02163a',
                  boxShadow: '4px 4px 0 #d11a2a',
                  animation: 'halo-toast 5.5s ease forwards',
                }}
                role="status"
              >
                <div className="font-bungee text-[10px] uppercase tracking-[0.18em] mb-0.5">★ from the halo</div>
                <div className="font-typewriter text-[11px] uppercase tracking-[0.12em] leading-snug">{haloToast}</div>
              </div>
            )}
          </section>

          <StainedGlass side="right" />
        </div>

        {/* DID YOU KNOW — auto-rotating, click to skip */}
        <button
          type="button"
          onClick={advanceFact}
          className="block w-full mb-6 px-4 py-3 text-left transition-transform hover:translate-x-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
          style={{
            background: 'linear-gradient(90deg, #FFD600 0%, #FF8A3A 100%)',
            border: '4px solid #02163a',
            boxShadow: '6px 6px 0 #d11a2a',
            color: '#02163a',
          }}
        >
          <div className="font-bungee text-[12px] uppercase tracking-[0.18em] mb-1">
            <RoughNotation key={`dyk-${factIdx}`} type="circle" color="#02163a" show strokeWidth={2} padding={4} animationDuration={900}>
              <span>★ DID YOU KNOW?</span>
            </RoughNotation>
          </div>
          <div className="font-bungee uppercase leading-tight" style={{ fontSize: 'clamp(18px, 2.4vw, 24px)' }}>
            {FACTS[factIdx].q}
          </div>
          <div className="font-typewriter text-[12px] uppercase tracking-[0.12em] mt-1.5 leading-snug">
            → {FACTS[factIdx].a}
          </div>
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] mt-2 opacity-65">
            tap for another fact · {factIdx + 1} / {FACTS.length}
          </div>
        </button>

        {/* SCRIPTURES */}
        <section
          className="mb-6 px-4 py-4"
          style={{
            background: 'rgba(2,22,58,0.6)',
            border: '3px solid #FFD600',
            boxShadow: '5px 5px 0 #d11a2a',
          }}
        >
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#FFD600]">
              ✦ The Seven Scriptures
            </h2>
            <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-[#FFD600]/65">
              campaign platform · zohranfornyc.com
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCRIPTURE.map((s, i) => (
              <article
                key={s.id}
                className="px-3 py-2 bg-black/55 border border-[#FFD600]/40 hover:border-[#FFD600] transition-colors"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-tabloid text-[18px] tabular text-[#FFD600]">{i + 1}.</span>
                  <span className="font-bungee uppercase tracking-[0.04em] text-[15px] text-white">
                    {s.verse}
                  </span>
                </div>
                <div className="font-typewriter text-[10px] uppercase tracking-[0.16em] text-white/75 leading-snug mt-1.5">
                  {s.teach}
                </div>
                <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-[#FFD600]/80 leading-snug mt-1">
                  ★ {s.stat}
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* TAKE ACTION */}
        <section
          className="mb-6 px-4 py-4"
          style={{
            background: 'rgba(2,22,58,0.6)',
            border: '3px solid #6CBE45',
            boxShadow: '5px 5px 0 #02501c',
          }}
        >
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#6CBE45]">
              ✦ Take Action — Today
            </h2>
            <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65">
              every link goes to the official source
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {ACTIONS.map((a) => (
              <a
                key={a.href}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-3 py-3 bg-black/55 border-2 transition-colors hover:bg-black"
                style={{ borderColor: `${a.tone}66` }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[28px]" aria-hidden>{a.emoji}</span>
                  <span className="font-bungee text-[14px] uppercase tracking-[0.04em]" style={{ color: a.tone }}>
                    {a.label}
                  </span>
                </div>
                <div className="font-typewriter text-[10px] uppercase tracking-[0.16em] text-white/75 mt-1.5 leading-snug">
                  {a.sub}
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* LOOK UP YOUR BUILDING — HPD violations + complaints */}
        <BuildingLookup />

        {/* PUBLIC HEARINGS — upcoming Legistar events */}
        <PublicHearings />

        {/* SCROLLS — live legislation */}
        <section
          className="mb-6 px-4 py-4"
          style={{
            background: 'rgba(2,22,58,0.6)',
            border: '3px solid #FFD600',
            boxShadow: '5px 5px 0 #d11a2a',
          }}
        >
          <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
            <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#FFD600]">
              ✦ Scrolls from the City
            </h2>
            <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-[#FFD600]/65">
              live · nyc council legistar
            </span>
          </div>
          <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/75 mb-3 leading-snug">
            Recent bills, resolutions, and introductions. The mayor signs, vetoes, or proposes.
            The Council debates and votes. Click any scroll for the official text.
          </div>

          {!matters && !error && (
            <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#FFD600]/65">
              ⚙ summoning the latest scrolls…
            </div>
          )}
          {error && <GatedFeedCard kind="matters" />}
          {matters && matters.length === 0 && (
            <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65">
              the council is in recess · no fresh scrolls
            </div>
          )}
          {matters && matters.length > 0 && (
            <ul className="grid gap-2">
              {matters.map((m) => (
                <ScrollItem key={m.MatterId} matter={m} />
              ))}
            </ul>
          )}
        </section>

        {/* GLOSSARY — collapsible */}
        <section
          className="mb-6 px-4 py-4"
          style={{
            background: 'rgba(2,22,58,0.6)',
            border: '3px solid #FF6319',
            boxShadow: '5px 5px 0 #6a2a08',
          }}
        >
          <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#FF6319] mb-1">
            ✦ Learn the Lingo
          </h2>
          <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65 mb-3">
            Tap a term to read it. The vocabulary is most of the secret.
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {GLOSSARY.map((g) => (
              <Glossary key={g.term} entry={g} />
            ))}
          </div>
        </section>

        {/* CANDLES */}
        <CandleRow />
      </main>

      <StreetFauna />

      <style>{SHRINE_KEYFRAMES}</style>
    </div>
  );
}

function ScrollItem({ matter }: { matter: Matter }) {
  const id = matter.MatterFile || `#${matter.MatterId}`;
  const title = matter.MatterTitle || matter.MatterName || '(untitled)';
  const date = matter.MatterIntroDate
    ? new Date(matter.MatterIntroDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
  const url = `https://legistar.council.nyc.gov/LegislationDetail.aspx?ID=${matter.MatterId}`;
  const teach = explainMatter(matter);
  return (
    <li>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 py-2 bg-black/45 border border-[#FFD600]/40 hover:border-[#FFD600] transition-colors group"
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600]">
            {id}
          </span>
          <span className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/55">
            {matter.MatterTypeName ?? 'matter'} · {matter.MatterStatusName ?? 'pending'} · {date}
          </span>
        </div>
        <div className="font-typewriter text-[11px] uppercase tracking-[0.1em] text-white/85 mt-1 line-clamp-3 leading-snug group-hover:text-white">
          {title}
        </div>
        {teach && (
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-[#FFD600]/75 mt-1">
            ✦ {teach}
          </div>
        )}
      </a>
    </li>
  );
}

function Glossary({ entry }: { entry: GlossaryEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      className="text-left px-3 py-2 bg-black/55 border border-[#FF6319]/40 hover:border-[#FF6319] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FFD600]"
      aria-expanded={open}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-bungee uppercase text-[14px] tracking-[0.06em] text-[#FF6319]">
          ✦ {entry.term}
        </span>
        <span className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/55">
          {open ? '−' : '+'}
        </span>
      </div>
      {open && (
        <div className="font-typewriter text-[11px] uppercase tracking-[0.16em] text-white/85 mt-2 leading-snug">
          {entry.def}
        </div>
      )}
    </button>
  );
}

function explainMatter(m: Matter): string | null {
  const t = (m.MatterTypeName ?? '').toLowerCase();
  const title = (m.MatterTitle ?? m.MatterName ?? '').toLowerCase();
  if (t.includes('introduction')) {
    if (title.includes('housing') || title.includes('rent')) return 'a new housing/rent bill — these usually amend the Administrative Code and need a mayoral signature';
    if (title.includes('school') || title.includes('education')) return 'an education bill — DOE rules or city support for schools';
    if (title.includes('transit') || title.includes('bus') || title.includes('subway')) return 'a transit bill — note: the MTA is state-controlled, the city can request but not mandate most service changes';
    if (title.includes('police') || title.includes('nypd')) return 'a public-safety bill — usually amends the Charter or Admin Code, often via Public Safety Committee';
    return 'a new bill (Introduction) — has to pass Council and be signed by the mayor';
  }
  if (t.includes('resolution')) return 'a resolution — formal Council position, no force of law on its own';
  if (t.includes('local law')) return 'a local law — already enacted; the highest tier of city legislation';
  if (t.includes('communication') || t.includes('msg')) return 'a communication from the mayor or another agency to the Council';
  return null;
}

const SHRINE_KEYFRAMES = `
@keyframes shrine-flicker {
  0%   { transform: translateY(0) scale(1, 1); opacity: 0.95; }
  35%  { transform: translateY(-1px) scale(1.05, 0.96); opacity: 1; }
  60%  { transform: translateY(0) scale(0.96, 1.05); opacity: 0.85; }
  100% { transform: translateY(0) scale(1, 1); opacity: 0.95; }
}
@keyframes halo-toast {
  0%   { transform: translate(-50%, 8px); opacity: 0; }
  10%  { transform: translate(-50%, 0); opacity: 1; }
  85%  { transform: translate(-50%, 0); opacity: 1; }
  100% { transform: translate(-50%, -8px); opacity: 0; }
}
`;

/* ──────────────────────────────────────── Look Up Your Building
   Address autocomplete via NYC GeoSearch (no key, CORS-friendly).
   Selecting an address fetches HPD violations + complaints for the
   resolved BIN. Renters discover whether their landlord has open
   violations — directly ties to the rent-freeze plank. */

function BuildingLookup() {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<AddressMatch[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AddressMatch | null>(null);
  const [violations, setViolations] = useState<HpdViolation[] | null>(null);
  const [complaints, setComplaints] = useState<HpdComplaint[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  // Debounced autocomplete
  useEffect(() => {
    if (text.trim().length < 3) {
      setMatches([]);
      return;
    }
    const t = setTimeout(async () => {
      acRef.current?.abort();
      const ac = new AbortController();
      acRef.current = ac;
      try {
        const list = await autocompleteAddress(text, ac.signal);
        if (!ac.signal.aborted) setMatches(list);
      } catch { /* abort or network — silent */ }
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const pickAddress = async (m: AddressMatch) => {
    setPicked(m);
    setText(m.label);
    setOpen(false);
    setError(null);
    if (!m.bin && !m.bbl) {
      setError('no building id found for this address — try a more specific number');
      setViolations([]);
      setComplaints([]);
      return;
    }
    setLoading(true);
    setViolations(null);
    setComplaints(null);
    try {
      const [v, c] = await Promise.all([
        m.bin ? fetchHpdViolations(m.bin) : Promise.resolve([]),
        // Complaints dataset filters by BBL (block + lot), not BIN.
        fetchHpdComplaints(m.bbl),
      ]);
      setViolations(v);
      setComplaints(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'lookup failed');
    } finally {
      setLoading(false);
    }
  };

  const openViolations = (violations ?? []).filter(
    (v) => (v.currentstatus ?? '').toUpperCase().includes('OPEN') || (v.currentstatus ?? '').toUpperCase().includes('VIOLATION'),
  );
  const openComplaints = (complaints ?? []).filter(
    (c) => (c.status ?? '').toUpperCase() === 'OPEN',
  );

  // Severity totals for the headline card
  const counts = (violations ?? []).reduce(
    (acc, v) => {
      const k = (v.class ?? '').toUpperCase();
      if (k === 'A' || k === 'B' || k === 'C') acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    },
    {} as Record<'A' | 'B' | 'C', number>,
  );

  return (
    <section
      className="mb-6 px-4 py-4"
      style={{
        background: 'rgba(2,22,58,0.6)',
        border: '3px solid #ff5582',
        boxShadow: '5px 5px 0 #6a0d1c',
      }}
    >
      <div className="flex items-baseline justify-between mb-2 flex-wrap gap-2">
        <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#ff5582]">
          ✦ Look Up Your Building
        </h2>
        <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/65">
          hpd violations · complaints · live data
        </span>
      </div>
      <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 mb-3 leading-snug">
        Type your address. We'll show you every open HPD violation and complaint on the building.
        This is the data your landlord doesn't want you reading.
      </div>

      <div className="relative max-w-[640px]">
        <input
          value={text}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="350 5 Av · 1600 Ocean Pkwy · 1 Wall St"
          className="w-full bg-[#0e0f14] border-2 border-[#ff5582]/65 px-3 py-2 font-typewriter text-[12px] tracking-[0.1em] text-white placeholder-white/35 focus:border-[#ff5582] focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {open && matches.length > 0 && (
          <ul className="absolute left-0 right-0 top-full mt-1 z-10 bg-[#0e0f14] border-2 border-[#ff5582]/65 max-h-[260px] overflow-y-auto">
            {matches.map((m, i) => (
              <li key={i}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickAddress(m)}
                  className="w-full text-left px-3 py-2 font-typewriter text-[11px] uppercase tracking-[0.1em] text-white/85 hover:bg-[#ff5582] hover:text-black transition-colors"
                >
                  ★ {m.label}
                  {m.bin && <span className="text-white/45 ml-2">bin {m.bin}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* result panel */}
      {picked && (
        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div
            className="px-3 py-3 bg-black/55 border-2"
            style={{ borderColor: '#ff558266' }}
          >
            <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#ff5582] mb-1">
              ✦ {picked.label}
            </div>
            <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/65">
              bin {picked.bin ?? '—'} · bbl {picked.bbl ?? '—'} · {picked.borough ?? '—'}
            </div>
            {loading && (
              <div className="mt-3 font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#ff5582]/85">
                ⚙ pulling hpd records…
              </div>
            )}
            {error && (
              <div className="mt-3 font-typewriter text-[11px] uppercase tracking-[0.18em] text-[#ff8a3a]">
                ★ {error}
              </div>
            )}
            {!loading && !error && violations && complaints && (
              <div className="mt-3 grid grid-cols-3 gap-2 font-typewriter text-[10px] uppercase tracking-[0.18em]">
                <ScoreTile label="open viol." big={openViolations.length} sub={`${violations.length} all-time`} tone="#ff5582" />
                <ScoreTile label="open comp." big={openComplaints.length} sub={`${complaints.length} all-time`} tone="#FFD600" />
                <ScoreTile
                  label="class C"
                  big={counts.C ?? 0}
                  sub={`A ${counts.A ?? 0} · B ${counts.B ?? 0}`}
                  tone="#d11a2a"
                />
              </div>
            )}
            {!loading && !error && (violations?.length === 0 && complaints?.length === 0) && (
              <div className="mt-3 font-typewriter text-[11px] uppercase tracking-[0.18em] text-[#6CBE45]">
                ★ no hpd records found · either pristine landlord or no data on file
              </div>
            )}
          </div>

          {/* recent violations list */}
          <div className="px-3 py-3 bg-black/55 border-2" style={{ borderColor: '#ff558266' }}>
            <div className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#ff5582] mb-2">
              ✦ recent violations
            </div>
            {!violations && !error && <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55">⚙ loading…</div>}
            {violations && violations.length === 0 && (
              <div className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-white/55">— none on file —</div>
            )}
            {violations && violations.length > 0 && (
              <ul className="grid gap-1.5 max-h-[260px] overflow-y-auto pr-1">
                {violations.slice(0, 8).map((v) => (
                  <li key={v.violationid} className="text-left px-2 py-1.5 bg-[#0e0f14] border" style={{ borderColor: violationColor(v.class) + '88' }}>
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-bungee text-[11px] uppercase tracking-[0.06em]" style={{ color: violationColor(v.class) }}>
                        Class {v.class ?? '?'}
                      </span>
                      <span className="font-typewriter text-[9px] uppercase tracking-[0.18em] text-white/55">
                        {fmtDate(v.novissueddate)} · {v.currentstatus ?? '—'}
                      </span>
                    </div>
                    <div className="font-typewriter text-[9.5px] uppercase tracking-[0.06em] text-white/85 mt-0.5 line-clamp-3 leading-snug">
                      {v.novdescription ?? '(no description)'}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="mt-3 font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 leading-snug">
        ✦ data: nyc open data (hpd violations · complaints) · address: nyc geosearch (dcp planning labs) · no api keys, no backend, just the web
      </div>
    </section>
  );
}

function ScoreTile({ label, big, sub, tone }: { label: string; big: number; sub: string; tone: string }) {
  return (
    <div className="px-2 py-2 border" style={{ borderColor: tone + '55', background: tone + '14' }}>
      <div className="text-[9px] uppercase tracking-[0.22em]" style={{ color: tone }}>{label}</div>
      <div className="font-tabloid text-[26px] tabular leading-none mt-0.5 text-white">{big}</div>
      <div className="text-[9px] uppercase tracking-[0.18em] text-white/55 mt-0.5">{sub}</div>
    </div>
  );
}

function violationColor(cls?: string): string {
  const k = (cls ?? '').toUpperCase();
  if (k === 'C') return '#d11a2a';
  if (k === 'B') return '#FF6319';
  if (k === 'A') return '#FFD600';
  return '#888';
}

function fmtDate(s?: string): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ──────────────────────────────────────── Public Hearings — Council events */

function PublicHearings() {
  // null = still loading / blocked. Empty array = loaded but no events.
  const [events, setEvents] = useState<CouncilEvent[] | null | 'gated'>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      const list = await fetchCouncilEvents();
      if (stop) return;
      // fetchCouncilEvents returns null on any failure (403/CORS/etc).
      // We surface that as a "feed gated" state so the UI can drop in
      // a clean direct-link card instead of pretending to load forever.
      setEvents(list === null ? 'gated' : list);
    })();
    return () => { stop = true; };
  }, []);

  return (
    <section
      className="mb-6 px-4 py-4"
      style={{
        background: 'rgba(2,22,58,0.6)',
        border: '3px solid #FFD600',
        boxShadow: '5px 5px 0 #d11a2a',
      }}
    >
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <h2 className="font-bungee text-[18px] sm:text-[22px] uppercase text-[#FFD600]">
          ✦ Public Hearings & Meetings
        </h2>
        <span className="font-typewriter text-[10px] uppercase tracking-[0.22em] text-[#FFD600]/65">
          {events === 'gated' ? 'feed gated · view live' : 'live · upcoming · anyone can attend'}
        </span>
      </div>
      <div className="font-typewriter text-[11px] uppercase tracking-[0.18em] text-white/85 mb-3 leading-snug">
        Show up. Two minutes of public testimony at any of these moves the room.
        Most are open to remote testimony too — link is on the event page.
      </div>

      {events === null && (
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-[#FFD600]/65">
          ⚙ summoning the calendar…
        </div>
      )}
      {events === 'gated' && <GatedFeedCard kind="events" />}
      {Array.isArray(events) && events.length === 0 && (
        <div className="font-typewriter text-[11px] uppercase tracking-[0.22em] text-white/65">
          the council is in recess · check back soon
        </div>
      )}
      {Array.isArray(events) && events.length > 0 && (
        <ul className="grid gap-2">
          {events.slice(0, 12).map((e) => <HearingItem key={e.EventId} event={e} />)}
        </ul>
      )}
    </section>
  );
}

/* When the Granicus Legistar Web API returns 403 to anonymous calls
   (started gating in 2026), we drop in a card that points users at the
   live, public legistar.council.nyc.gov site. The data still lives
   there — we just can't pull JSON without a token now. */
function GatedFeedCard({ kind }: { kind: 'events' | 'matters' }) {
  const url =
    kind === 'events'
      ? 'https://legistar.council.nyc.gov/Calendar.aspx'
      : 'https://legistar.council.nyc.gov/Legislation.aspx';
  const labels =
    kind === 'events'
      ? { title: 'Live Calendar', sub: 'every upcoming committee meeting and public hearing' }
      : { title: 'Live Legislation', sub: 'every bill, resolution, and introduction in the Council' };
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block px-3 py-3 bg-black/55 border-2 border-[#FFD600]/55 hover:border-[#FFD600] transition-colors"
    >
      <div className="font-bungee text-[14px] uppercase tracking-[0.06em] text-[#FFD600]">
        ✦ {labels.title} → legistar.council.nyc.gov
      </div>
      <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/75 mt-1">
        {labels.sub}
      </div>
      <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-1.5 leading-snug">
        ★ live data is public; the json feed is currently gated. one click → official source.
      </div>
    </a>
  );
}

function HearingItem({ event }: { event: CouncilEvent }) {
  const date = event.EventDate
    ? new Date(event.EventDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : '—';
  const time = (event.EventTime ?? '').trim();
  const url = event.EventInSiteURL
    || `https://legistar.council.nyc.gov/MeetingDetail.aspx?ID=${event.EventId}`;
  return (
    <li>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 py-2 bg-black/45 border border-[#FFD600]/40 hover:border-[#FFD600] transition-colors"
      >
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-bungee text-[12px] uppercase tracking-[0.06em] text-[#FFD600]">
            {date}{time ? ` · ${time}` : ''}
          </span>
          <span className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/65">
            {event.EventBodyName ?? 'Council'}
          </span>
        </div>
        {event.EventLocation && (
          <div className="font-typewriter text-[10px] uppercase tracking-[0.18em] text-white/85 mt-0.5">
            ✦ {event.EventLocation}
          </div>
        )}
        {event.EventComment && (
          <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-[#FFD600]/75 mt-0.5 line-clamp-2">
            {event.EventComment}
          </div>
        )}
        <div className="font-typewriter text-[9px] uppercase tracking-[0.22em] text-white/45 mt-1">
          ✦ click for agenda + remote-testimony link
        </div>
      </a>
    </li>
  );
}
