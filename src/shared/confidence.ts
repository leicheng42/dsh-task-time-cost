export type ForecastConfidence = 'assessing' | 'preliminary' | 'calibrated' | 'stable';

export interface ConfidenceInput {
  hasRemaining: boolean;
  hasPlan: boolean;
  localSamples: number;
  completedCalls: number;
  /** high / low of the current remaining range; null when unbounded or unknown. */
  rangeRatio: number | null;
}

/**
 * How much the panel is allowed to claim. A single number is reserved for the
 * stable state; everything else shows a range, so a long task can never open
 * with a confident-looking "2 minutes" (docs/public/design.md §3).
 */
export function forecastConfidence(input: ConfidenceInput): ForecastConfidence {
  if (!input.hasRemaining) return 'assessing';
  const narrow = input.rangeRatio !== null && input.rangeRatio <= 2.2;
  if (input.localSamples >= 8 && input.completedCalls >= 5 && narrow) return 'stable';
  if (input.localSamples >= 3 && narrow) return 'calibrated';
  if (input.hasPlan || input.localSamples >= 1) return 'preliminary';
  return 'preliminary';
}

/** Confidence that still allows a single point estimate. */
export function allowsPointEstimate(confidence: ForecastConfidence): boolean {
  return confidence === 'stable';
}

/** Ratio used for the confidence decision; null when the lower bound is zero. */
export function rangeRatio(span: { low: number; high: number } | null | undefined): number | null {
  if (!span || !Number.isFinite(span.low) || !Number.isFinite(span.high)) return null;
  if (span.high <= 0) return null;
  const low = Math.max(span.low, 1);
  return span.high / low;
}
