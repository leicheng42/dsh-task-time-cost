export type ProgressState =
  | 'done'        // turn finished
  | 'starting'    // no evidence yet, first seconds
  | 'unknown'     // running, but no credible remaining
  | 'finishing'   // remaining is small and the pace is steady
  | 'faster'      // last estimates shrank noticeably
  | 'slower'      // last estimates grew noticeably
  | 'onTrack';    // a credible remaining range

export interface ProgressInput {
  ended: boolean;
  elapsedMs: number;
  remainingHighMs: number | null;
  /** Recent high bounds of the remaining range, oldest first. */
  trail: readonly number[];
  completedCalls: number;
}

/**
 * One human sentence decides whether to keep waiting, so the state is derived
 * from evidence rather than from a single number: a missing forecast is a
 * first-class "cannot say yet", never a claim that the task is late
 * (docs/public/design.md §3).
 */
export function progressState(input: ProgressInput): { state: ProgressState; trendRatio: number | null } {
  if (input.ended) return { state: 'done', trendRatio: null };
  const trail = input.trail.filter(value => Number.isFinite(value) && value > 0);
  const previous = trail.length >= 2 ? trail[trail.length - 2]! : null;
  const current = trail.length >= 1 ? trail[trail.length - 1]! : null;
  const trendRatio = previous !== null && current !== null ? current / previous : null;
  if (input.remainingHighMs === null) {
    return { state: input.completedCalls === 0 ? 'starting' : 'unknown', trendRatio };
  }
  if (input.remainingHighMs <= 60_000) return { state: 'finishing', trendRatio };
  if (trendRatio !== null && trendRatio <= 0.7) return { state: 'faster', trendRatio };
  if (trendRatio !== null && trendRatio >= 1.4) return { state: 'slower', trendRatio };
  return { state: 'onTrack', trendRatio };
}
