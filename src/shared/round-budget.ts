export interface RoundBudget {
  /** Rounds already started for this goal (including the running one). */
  started: number;
  /** The cap DSH will refuse to exceed. */
  max: number;
}

/**
 * A goal stops when its round budget runs out, whatever the clock says, so the
 * forecast must never promise time the budget cannot deliver
 * (docs/public/design.md §3.6).
 */
export function capByRoundBudget(
  remaining: { low: number; high: number } | null,
  budget: RoundBudget | null,
  averageRoundMs: number | null,
): { remaining: { low: number; high: number } | null; reasons: string[] } {
  if (!budget || budget.max <= 0) return { remaining, reasons: [] };
  const roundsLeft = Math.max(0, budget.max - budget.started);
  if (roundsLeft <= 0) return { remaining, reasons: ['goal-round-budget-spent'] };
  if (remaining === null || averageRoundMs === null || !Number.isFinite(averageRoundMs) || averageRoundMs <= 0) {
    return { remaining, reasons: roundsLeft <= 2 ? ['goal-round-budget-close'] : [] };
  }
  const ceiling = Math.max(60_000, roundsLeft * averageRoundMs);
  const capped = remaining.high <= ceiling ? remaining : { low: Math.min(remaining.low, ceiling * 0.8), high: ceiling };
  const reasons = roundsLeft <= 2 ? ['goal-round-budget-close'] : [];
  if (capped !== remaining) reasons.push('goal-round-budget-capped');
  return { remaining: capped, reasons };
}
