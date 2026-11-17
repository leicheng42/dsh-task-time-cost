export interface CalibrationEntry {
  /** Upper bound of the first estimate for a finished turn; null when none was recorded. */
  initialHighMs: number | null;
  actualMs: number;
  completed: boolean;
}

export interface CalibrationSummary {
  samples: number;
  /** Median of actual / initial; >1 means the early estimate was too low. */
  medianRatio: number | null;
  underestimated: number;
}

/**
 * The only honest place the word "accurate" can rest: finished turns compared
 * with what was promised at their start (docs/public/design.md §7).
 */
export function summarizeCalibration(entries: readonly CalibrationEntry[]): CalibrationSummary {
  const ratios: number[] = [];
  let underestimated = 0;
  for (const entry of entries) {
    if (!entry.completed) continue;
    const initial = entry.initialHighMs;
    if (initial === null || !Number.isFinite(initial) || initial <= 0) continue;
    if (!Number.isFinite(entry.actualMs) || entry.actualMs <= 0) continue;
    ratios.push(entry.actualMs / initial);
    if (entry.actualMs > initial) underestimated += 1;
  }
  ratios.sort((a, b) => a - b);
  return {
    samples: ratios.length,
    medianRatio: ratios.length === 0 ? null : ratios[Math.floor(ratios.length / 2)]!,
    underestimated,
  };
}
