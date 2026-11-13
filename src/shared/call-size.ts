import type { PerformanceEstimate } from './performance.ts';
import type { RequestBudget } from './workload.ts';
import type { RouteIdentity } from './types.ts';

export interface CallSizeSample {
  route: RouteIdentity;
  inputTokens: number | null;
  visibleOutputTokens: number | null;
  cacheReadRatio: number | null;
  durationMs: number;
}

/** Match token scale instead of dividing cumulative input/cache tokens by decode speed. */
export function selectCallSizePerformance(request: RequestBudget, base: PerformanceEstimate, samples: readonly CallSizeSample[], minSamples: number): PerformanceEstimate {
  const route = request.route;
  const similar = (value: number | null, range: { low: number; high: number } | null) => range === null
    || value !== null && Number.isFinite(value) && value >= range.low / 2 && value <= Math.max(1, range.high) * 2;
  const matched = samples.filter(sample => sample.route.providerId === route.providerId && sample.route.modelId === route.modelId
    && sample.route.endpointFingerprint === route.endpointFingerprint && sample.route.requestMode === route.requestMode
    && sample.route.reasoningEffort === route.reasoningEffort && sample.route.serviceTier === route.serviceTier
    && Number.isFinite(sample.durationMs) && sample.durationMs >= 0
    && similar(sample.inputTokens, request.inputTokens) && similar(sample.visibleOutputTokens, request.visibleOutputTokens)
    && (request.cacheReadRatio === null || sample.cacheReadRatio !== null
      && sample.cacheReadRatio >= Math.max(0, request.cacheReadRatio.low - 0.1)
      && sample.cacheReadRatio <= Math.min(1, request.cacheReadRatio.high + 0.1)));
  if (matched.length < minSamples) return { ...base, reasons: [...base.reasons, 'size-matched-samples-insufficient'] };
  const durations = matched.map(sample => sample.durationMs).sort((a, b) => a - b);
  return { ...base, totalCallMs: durations[Math.floor((durations.length - 1) / 2)]!,
    totalCallSamplesMs: durations, samples: matched.length, sourceKind: 'local-measured',
    metricOrigins: { ...base.metricOrigins, total: 'local-measured' },
    reasons: [...base.reasons, 'size-matched-call-duration-reference'] };
}
