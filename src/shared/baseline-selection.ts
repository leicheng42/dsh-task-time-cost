import { validateBaselines } from './baselines.ts';
import type { BaselineRecord, MetricValue } from './baselines.ts';
import { DEFAULT_TEMPLATES } from './workload.ts';
import type { WorkloadTemplate } from './workload.ts';
import type { RouteIdentity, SourceKind, Span } from './types.ts';
import { heuristicPerformance } from './performance.ts';
import type { PerformancePrior } from './performance.ts';
import type { EstimatorConfig } from './config.ts';

function applicable(record: BaselineRecord, route: RouteIdentity): boolean {
  return Object.entries(record.appliesTo).every(([key, value]) => value === '*' || value === route[key as keyof RouteIdentity]);
}
function bounds(metric: MetricValue): Span {
  if ('low' in metric) return { low: metric.low, high: metric.high };
  if ('mean' in metric) return { low: metric.mean, high: metric.mean };
  if ('value' in metric) return { low: metric.value, high: metric.value };
  return { low: metric.p50, high: metric.p95 ?? metric.p90 ?? metric.p50 };
}
function center(metric: MetricValue): number { const range = bounds(metric); return (range.low + range.high) / 2; }
const sourcePriority: Record<SourceKind, number> = { 'local-measured': 0, 'public-measured': 1, heuristic: 2 };
function ordered(records: BaselineRecord[]): BaselineRecord[] { return [...records].sort((a, b) => sourcePriority[a.sourceKind] - sourcePriority[b.sourceKind] || Date.parse(b.date) - Date.parse(a.date)); }

/** Only complete workload records replace a template; a missing tool budget is never zero. */
export function templatesFromBaselines(records: BaselineRecord[], route: RouteIdentity, fallback: readonly WorkloadTemplate[] = DEFAULT_TEMPLATES): WorkloadTemplate[] {
  validateBaselines(records);
  return fallback.map(template => {
    const record = ordered(records).find(record => record.taskKind === template.kind && applicable(record, route) && record.metrics.requestCount && record.metrics.visibleOutputTokens && record.metrics.toolMs);
    if (!record) return structuredClone(template);
    const requests = bounds(record.metrics.requestCount!);
    return { kind: template.kind, requestCount: { low: Math.max(1, Math.floor(requests.low)), high: Math.max(1, Math.ceil(requests.high)) }, visibleOutputTokens: bounds(record.metrics.visibleOutputTokens!), toolMs: bounds(record.metrics.toolMs!), sourceKind: record.sourceKind, sourceId: `${record.seedId}@${record.dataVersion}:${record.statistic}` };
  });
}

/** Means become labeled centers; this conversion does not create samples or quantiles. */
export function performancePriorsFromBaselines(records: BaselineRecord[], config: Partial<EstimatorConfig> = {}): PerformancePrior[] {
  validateBaselines(records);
  const fallback = heuristicPerformance(config);
  return ordered(records).filter(record => ['firstContentMs', 'firstTextMs', 'visibleTps', 'totalCallMs'].some(name => name in record.metrics)).map(record => {
    const metrics = record.metrics;
    const origins = { firstContent: metrics.firstContentMs ? record.sourceKind : 'heuristic', firstText: metrics.firstTextMs ? record.sourceKind : 'heuristic', speed: metrics.visibleTps ? record.sourceKind : 'heuristic', total: metrics.totalCallMs ? record.sourceKind : 'heuristic' } as const;
    return { id: `${record.seedId}@${record.dataVersion}:${record.statistic}`, sourceKind: record.sourceKind, sourceUrl: record.sourceUrl, dataVersion: record.dataVersion, sampleCount: record.sampleCount, timingBasis: record.timingBasis, appliesTo: { ...record.appliesTo }, firstContentMs: metrics.firstContentMs ? center(metrics.firstContentMs) : null, firstTextMs: metrics.firstTextMs ? center(metrics.firstTextMs) : null, visibleTps: metrics.visibleTps && center(metrics.visibleTps) > 0 ? center(metrics.visibleTps) : null, totalCallMs: metrics.totalCallMs ? center(metrics.totalCallMs) : fallback.totalCallMs, metricOrigins: origins };
  });
}
