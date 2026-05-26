export type LngLat = { lng: number; lat: number };

export type RoundState = {
  guess: LngLat | null;
  distance: number | null; // meters; Infinity for a timed-out no-guess
  score: number | null; // null until the round is locked
  timedOut: boolean;
};
