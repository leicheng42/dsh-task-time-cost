export interface ForecastCorrectionInput {
  /** Elapsed active time of the running turn. */
  elapsedActiveMs: number;
  /** Upper bound of the total recorded when the turn started; null when unknown. */
  initialHighMs: number | null;
  /** Remaining upper bound the current plan claims, when a plan exists. */
  planRemainingHighMs: number | null;
  completedCalls: number;
  /** Remaining upper bound currently shown, used as a floor candidate. */
  currentRemainingHighMs: number | null;
}

export interface ForecastCorrection {
  correct: boolean;
  /** Remaining upper bound to show once corrected. */
  floorHighMs: number;
  reasons: string[];
}

/**
 * Decide whether the running estimate must be replaced because observed work
 * contradicts it. Two facts are enough: the task already ran past the initial
 * forecast, or a self-reported plan claims the rest will finish in a small
 * fraction of the time already spent. Pure so the rule can be tested directly.
 */
export function forecastCorrection(input: ForecastCorrectionInput): ForecastCorrection {
  const elapsed = Math.max(0, input.elapsedActiveMs);
  const exceeded = input.initialHighMs !== null && input.initialHighMs > 0 && elapsed > input.initialHighMs * 1.05;
  const implausiblePlan = input.planRemainingHighMs !== null && input.completedCalls >= 6 && elapsed >= 120_000
    && input.planRemainingHighMs < Math.min(elapsed / 6, 600_000);
  const correct = elapsed > 0 && (exceeded || implausiblePlan);
  // The floor raises a too-small range; it never shrinks a range that is already wider.
  const floorHigh = Math.max(input.currentRemainingHighMs ?? 0, Math.min(Math.max(elapsed * 0.5, 60_000), 3_600_000));
  const reasons: string[] = [];
  if (correct) {
    reasons.push('forecast-exceeded-observed-work');
    if (exceeded) reasons.push('initial-forecast-exceeded');
    if (implausiblePlan) reasons.push('plan-below-observed-effort');
  }
  return { correct, floorHighMs: Math.round(floorHigh), reasons };
}
