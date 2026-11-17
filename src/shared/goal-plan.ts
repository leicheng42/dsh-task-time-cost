export interface RoundObservation {
  /** Active (wall-clock minus pauses) duration of one finished round. */
  elapsedMs: number;
}

export interface GoalPlanInput {
  /** Rounds already started, including the running one. */
  started: number;
  /** The cap DSH enforces. */
  max: number;
  /** Durations of the finished rounds of this goal, oldest first. */
  rounds: readonly RoundObservation[];
}

export interface GoalPlan {
  roundsLeft: number;
  /** How many finished rounds the statistics came from. */
  observed: number;
  medianRoundMs: number | null;
  /** Earliest plausible finish: every remaining round as quick as the quick quartile. */
  lowMs: number | null;
  /** Latest plausible finish: every remaining round as slow as the slow quartile. */
  highMs: number | null;
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * A goal is a sequence of rounds, so the honest question is not "how long will
 * this round take" but "how many rounds are left, and how long does a round
 * take for this goal". The result is deliberately a range: rounds vary, and the
 * cap only bounds the count, not the work (docs/public/design.md §3.7).
 */
export function planGoal(input: GoalPlanInput): GoalPlan {
  const roundsLeft = Math.max(0, Math.floor(input.max) - Math.floor(input.started));
  const durations = input.rounds
    .map(round => round.elapsedMs)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (durations.length === 0) {
    return { roundsLeft, observed: 0, medianRoundMs: null, lowMs: null, highMs: null };
  }
  const centre = median(durations);
  if (roundsLeft === 0) return { roundsLeft, observed: durations.length, medianRoundMs: centre, lowMs: null, highMs: null };
  const quick = Math.max(60_000, quantile(durations, 0.25));
  const slow = quantile(durations, 0.75) * (durations.length < 4 ? 1.5 : 1);
  const low = Math.max(60_000, quick * roundsLeft);
  // A quick quartile of sub-minute rounds must not produce a high bound below it.
  const high = Math.max(low, 60_000, slow * roundsLeft);
  return { roundsLeft, observed: durations.length, medianRoundMs: centre, lowMs: low, highMs: high };
}
