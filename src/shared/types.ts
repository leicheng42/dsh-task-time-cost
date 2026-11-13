export type Span = { low: number; high: number };
export type SourceKind = 'public-measured' | 'local-measured' | 'heuristic';
export type EstimateOrigin = SourceKind | 'mixed';
export type RequestMode = 'text' | 'tool' | 'mixed' | 'unknown' | 'non-streaming';
export type TaskKind = 'question' | 'writing' | 'file-analysis' | 'code' | 'research' | 'unknown';
export type Outcome = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'timeout' | 'truncated';
export type CostStatus = 'complete' | 'partial' | 'unpriced' | 'free';
export type ForecastCostStatus = 'reference' | 'partial' | 'unavailable' | 'free';
export type Money = { currency: string; amount: string };
export type MoneyRange = { currency: string; range: { low: string; high: string } };

/** modelId is the pricing/performance identity, never a display alias. */
export interface RouteIdentity {
  providerId: string;
  endpointFingerprint: string;
  modelId: string;
  requestMode: RequestMode;
  reasoningEffort: string;
  serviceTier: string;
  inputBucket?: string;
  cacheBucket?: string;
  concurrencyBucket?: string;
  mixedRoute?: boolean;
}

export type RouteApplicability = { [K in keyof RouteIdentity]?: RouteIdentity[K] | '*' };

export interface SourceMetadata {
  sourceKind: SourceKind;
  sourceUrl: string | null;
  dataVersion: string;
  date: string;
  scope: string;
  sampleCount: number | null;
  timingBasis: string;
  statistic: 'assumption-range' | 'mean' | 'sample' | 'quantiles';
}

export function assertSpan(value: Span, name = 'range'): Span {
  if (!value || !Number.isFinite(value.low) || !Number.isFinite(value.high) || value.low < 0 || value.low > value.high) {
    throw new TypeError(`${name} must be finite, nonnegative, and ordered`);
  }
  return value;
}

export function nonnegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
  return value;
}

export function alphaValue(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new TypeError('alpha must be in (0, 1]');
  return alpha;
}

export function ewma(previous: number, observed: number, alpha = 0.2): number {
  alphaValue(alpha);
  nonnegative(previous, 'previous');
  nonnegative(observed, 'observed');
  return (1 - alpha) * previous + alpha * observed;
}

export function mergeOrigins(origins: EstimateOrigin[]): EstimateOrigin {
  const distinct = new Set(origins);
  return distinct.size === 1 ? origins[0] : distinct.size === 0 ? 'heuristic' : 'mixed';
}
