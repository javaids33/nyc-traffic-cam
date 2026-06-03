import { useCallback, useEffect, useMemo, useState } from 'react';
import confetti from 'canvas-confetti';
import { Start } from './start';
import { RoundView } from './round';
import { Summary } from './summary';
import {
  camsByIds,
  dailySeed,
  pickCams,
  randomSeed,
  type Cam,
  type Mode,
  type Tier,
} from './cams';
import { haversine, scoreFor, ROUNDS, MAX_SCORE } from './scoring';
import { fetchChallenge, DEFAULT_MODIFIERS, type FetchedChallenge, type Modifiers } from './share';
import { loadStats, recordDailyResult, dailyView, type DailyView } from './stats';
import type { LngLat, RoundState } from './game-types';

type Phase = 'start' | 'playing' | 'summary';

const freshRounds = (): RoundState[] =>
  Array.from({ length: ROUNDS }, () => ({ guess: null, distance: null, score: null, timedOut: false }));

function fireConfetti(big: boolean) {
  const opts = {
    particleCount: big ? 150 : 70,
    spread: 75,
    startVelocity: big ? 55 : 40,
    origin: { y: 0.6 },
    colors: ['#FFD400', '#FF4D2E', '#39FF6A', '#37a0ff', '#ffffff'],
  };
  try {
    confetti(opts);
  } catch {
    /* noop */
  }
}

const MODE_SET = new Set<Mode>(['easy', 'medium', 'hard', 'daily']);

function parseInitial() {
  if (typeof window === 'undefined') {
    return { hash: null, seed: '', mode: 'medium' as Mode, mods: DEFAULT_MODIFIERS, friendScore: null, daily: false, play: false };
  }
  const url = new URL(window.location.href);
  const hash = url.searchParams.get('h');
  const seed = url.searchParams.get('seed') ?? '';
  const dRaw = url.searchParams.get('d');
  // Bare landing (no challenge hash, no seed) drops you straight into today's
  // daily — the game leads with play, Wordle-style. The menu / free play is
  // one tap away (the home button mid-game, or "play more" on the summary).
  const daily = url.searchParams.get('daily') === '1' || (!hash && !seed);
  const scoreP = url.searchParams.get('score');
  const t = parseInt(url.searchParams.get('t') ?? '0', 10);
  const mods: Modifiers = {
    grayscale: url.searchParams.get('g') === '1',
    timerSec: t === 30 ? 30 : t === 60 ? 60 : 0,
    noZoom: url.searchParams.get('nz') === '1',
  };
  const mode: Mode = dRaw && MODE_SET.has(dRaw as Mode) ? (dRaw as Mode) : 'medium';
  const friendScore = scoreP ? parseInt(scoreP, 10) || null : null;
  return { hash, seed, mode, mods, friendScore, daily, play: !!(hash || seed || daily) };
}

function setUrl(params: Record<string, string | number | null | undefined>) {
  const u = new URL(window.location.href);
  u.search = '';
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') u.searchParams.set(k, String(v));
  }
  history.replaceState(null, '', u.toString());
}

export function App() {
  const initial = useMemo(parseInitial, []);

  const [phase, setPhase] = useState<Phase>(initial.play ? 'playing' : 'start');
  const [mode, setMode] = useState<Mode>(initial.daily ? 'daily' : initial.mode);
  const [mods, setMods] = useState<Modifiers>(initial.daily ? DEFAULT_MODIFIERS : initial.mods);
  const [seed, setSeed] = useState<string>(
    initial.seed || (initial.daily ? dailySeed() : initial.hash ? '' : randomSeed()),
  );
  const [challenge, setChallenge] = useState<FetchedChallenge | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [friendScore, setFriendScore] = useState<number | null>(initial.friendScore);
  const [rounds, setRounds] = useState<RoundState[]>(freshRounds);
  const [roundIdx, setRoundIdx] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [stats, setStats] = useState(() => loadStats());
  const daily = useMemo<DailyView>(() => dailyView(stats), [stats]);

  // Resolve a shared challenge link (?h=) into its pinned 5 cameras.
  useEffect(() => {
    if (!initial.hash) return;
    let stop = false;
    fetchChallenge(initial.hash)
      .then((ch) => {
        if (stop) return;
        setChallenge(ch);
        if (ch.difficulty) setMode(ch.difficulty);
        if (ch.modifiers) setMods(ch.modifiers);
        if (ch.score != null) setFriendScore(ch.score);
      })
      .catch((e: Error) => {
        if (stop) return;
        setChallengeError(
          e.message === 'expired'
            ? 'this challenge expired (24h limit) — playing a fresh run'
            : "couldn't load that challenge — playing a fresh run",
        );
        setSeed(randomSeed());
        setMode('medium');
      });
    return () => {
      stop = true;
    };
  }, [initial.hash]);

  // Live-frame refresh while playing.
  useEffect(() => {
    if (phase !== 'playing') return;
    const i = window.setInterval(() => setTick(Date.now()), 2000);
    return () => clearInterval(i);
  }, [phase]);

  const usingChallenge = !!initial.hash && !challengeError;

  const roundCameras: Cam[] = useMemo(() => {
    if (usingChallenge) return challenge ? camsByIds(challenge.cameras).slice(0, ROUNDS) : [];
    if (!seed) return [];
    return pickCams(seed, mode);
  }, [usingChallenge, challenge, seed, mode]);

  const cam = roundCameras[roundIdx];
  const round = rounds[roundIdx];
  const revealed = round?.score != null;
  const totalScore = rounds.reduce((s, r) => s + (r.score ?? 0), 0);

  const setGuess = useCallback(
    (g: LngLat) => {
      setRounds((prev) => {
        if (prev[roundIdx]?.score != null) return prev; // locked
        return prev.map((x, i) => (i === roundIdx ? { ...x, guess: g } : x));
      });
    },
    [roundIdx],
  );

  const lockGuess = useCallback(() => {
    const r = rounds[roundIdx];
    if (!r || r.score != null || !cam || !r.guess) return;
    const d = haversine(r.guess.lat, r.guess.lng, cam.lat, cam.lng);
    const score = scoreFor(d);
    setRounds((prev) => prev.map((x, i) => (i === roundIdx ? { ...x, distance: d, score, timedOut: false } : x)));
    if (score >= 95) fireConfetti(true);
    else if (score >= 80) fireConfetti(false);
  }, [rounds, roundIdx, cam]);

  const forceLock = useCallback(() => {
    const r = rounds[roundIdx];
    if (!r || r.score != null || !cam) return;
    if (r.guess) {
      lockGuess();
      return;
    }
    setRounds((prev) =>
      prev.map((x, i) => (i === roundIdx ? { guess: null, distance: Infinity, score: 0, timedOut: true } : x)),
    );
  }, [rounds, roundIdx, cam, lockGuess]);

  const nextRound = useCallback(() => {
    if (roundIdx >= ROUNDS - 1) {
      if (mode === 'daily') {
        setStats(recordDailyResult(totalScore, rounds.map((r) => r.score ?? 0)));
      }
      setPhase('summary');
    } else {
      setRoundIdx((i) => i + 1);
    }
  }, [roundIdx, mode, totalScore, rounds]);

  const beginRun = useCallback((nextMode: Mode, nextMods: Modifiers, nextSeed: string, daily: boolean) => {
    setMode(nextMode);
    setMods(nextMods);
    setSeed(nextSeed);
    setChallenge(null);
    setChallengeError(null);
    setFriendScore(null);
    setRounds(freshRounds());
    setRoundIdx(0);
    setTick(Date.now());
    setPhase('playing');
    if (daily) setUrl({ daily: 1 });
    else
      setUrl({
        d: nextMode,
        seed: nextSeed,
        g: nextMods.grayscale ? 1 : null,
        t: nextMods.timerSec || null,
        nz: nextMods.noZoom ? 1 : null,
      });
  }, []);

  const startGame = useCallback((tier: Tier, m: Modifiers) => beginRun(tier, m, randomSeed(), false), [beginRun]);
  const startDaily = useCallback(() => beginRun('daily', DEFAULT_MODIFIERS, dailySeed(), true), [beginRun]);
  const newGame = useCallback(
    () => beginRun(mode === 'daily' ? 'medium' : mode, mods, randomSeed(), false),
    [beginRun, mode, mods],
  );

  const goHome = useCallback(() => {
    setPhase('start');
    setRounds(freshRounds());
    setRoundIdx(0);
    setChallenge(null);
    setChallengeError(null);
    setFriendScore(null);
    setStats(loadStats());
    setUrl({});
  }, []);

  const banner =
    challengeError ??
    (usingChallenge && challenge
      ? `challenge ${challenge.hash}${friendScore != null ? ` · friend scored ${friendScore}` : ''} · same 5 cams`
      : friendScore != null
        ? `a friend scored ${friendScore}/${MAX_SCORE} · beat them`
        : null);

  if (phase === 'start') {
    return <Start onStart={startGame} onDaily={startDaily} daily={daily} />;
  }

  if (phase === 'summary') {
    return (
      <Summary
        rounds={rounds}
        roundCameras={roundCameras}
        totalScore={totalScore}
        mode={mode}
        mods={mods}
        seed={seed}
        challenge={challenge}
        friendScore={friendScore}
        daily={
          mode === 'daily'
            ? { date: daily.date, streak: daily.streak, rounds: rounds.map((r) => r.score ?? 0) }
            : null
        }
        onNewGame={newGame}
        onHome={goHome}
      />
    );
  }

  return (
    <RoundView
      roundIdx={roundIdx}
      cam={cam}
      tick={tick}
      round={round}
      rounds={rounds}
      revealed={revealed}
      totalScore={totalScore}
      mode={mode}
      mods={mods}
      banner={banner}
      onGuess={setGuess}
      onLock={lockGuess}
      onForceLock={forceLock}
      onNext={nextRound}
      onHome={goHome}
    />
  );
}
