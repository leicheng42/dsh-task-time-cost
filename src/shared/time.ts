import { validateConfig } from './config.ts';
import type { EstimatorConfig } from './config.ts';
import { assertSpan, mergeOrigins, nonnegative } from './types.ts';
import type { EstimateOrigin, RouteIdentity, Span, TaskKind } from './types.ts';
import type { PerformanceEstimate } from './performance.ts';
import type { PlanScenario, RequestBudget, WorkloadPlan } from './workload.ts';

export interface RequestProgress {
  phase: 'not-started' | 'waiting' | 'text' | 'call' | 'completed';
  elapsedMs: number;
  generatedTextTokens?: number;
}
export interface RequestTime { remainingMs: Span | null; reasons: string[] }
export interface ScheduleUnit { id: string; durationMs: Span; dependsOn: string[]; resource?: string }
export interface ScheduleOptions { maxConcurrency?: number; resourceLimits?: Record<string, number> }
export interface ScheduledUnit { id: string; startMs: Span; endMs: Span }
export interface ScheduleResult { makespanMs: Span; totalWorkMs: Span; units: ScheduledUnit[] }
export interface PlanTimeOptions extends ScheduleOptions { progress?: Record<string, RequestProgress>; completedIds?: string[]; config?: Partial<EstimatorConfig> }
export interface PlanTime { remainingMs: Span | null; schedule: ScheduleResult | null; reasons: string[]; origin: EstimateOrigin; localPerformanceSamples: number }

export function estimateRequestTime(request: RequestBudget, performance: PerformanceEstimate, progress: RequestProgress = { phase: 'not-started', elapsedMs: 0 }, config: Partial<EstimatorConfig> = {}): RequestTime {
  const c = validateConfig(config);
  nonnegative(progress.elapsedMs, 'elapsedMs');
  if (progress.generatedTextTokens !== undefined) nonnegative(progress.generatedTextTokens, 'generatedTextTokens');
  if (progress.phase === 'completed') return { remainingMs: { low: 0, high: 0 }, reasons: ['request-completed'] };
  const reasons = [...performance.reasons];
  const bodyCompatible = request.route.requestMode === 'text' && request.visibleTextTokens !== null && performance.firstTextMs !== null && performance.visibleTps !== null && performance.visibleTps > 0;
  if (bodyCompatible) {
    assertSpan(request.visibleTextTokens!, 'visibleTextTokens');
    const generated = progress.generatedTextTokens ?? 0;
    const body = { low: Math.max(0, request.visibleTextTokens!.low - generated) / performance.visibleTps! * 1000, high: Math.max(0, request.visibleTextTokens!.high - generated) / performance.visibleTps! * 1000 };
    if (progress.phase === 'text') {
      if (generated >= request.visibleTextTokens!.high) return { remainingMs: null, reasons: [...reasons, 'output-budget-exhausted-task-still-running'] };
      return { remainingMs: { low: body.low * c.referenceLowFactor, high: body.high * c.referenceHighFactor }, reasons: [...reasons, 'text-stage-no-repeat-wait', 'reasoning-already-in-first-text-wait'] };
    }
    const wait = remainingWait(performance.firstTextMs!, performance.firstTextWaitSamplesMs, progress, c);
    if (wait.remainingMs === null) return { remainingMs: null, reasons: [...reasons, ...wait.reasons] };
    return { remainingMs: { low: wait.remainingMs.low + body.low * c.referenceLowFactor, high: wait.remainingMs.high + body.high * c.referenceHighFactor }, reasons: [...reasons, ...wait.reasons, 'first-text-plus-body', 'reasoning-already-in-first-text-wait'] };
  }
  reasons.push('same-mode-total-call-fallback');
  const total = remainingWait(performance.totalCallMs, performance.totalCallSamplesMs, progress, c);
  return { remainingMs: total.remainingMs, reasons: [...reasons, ...total.reasons] };
}

function remainingWait(center: number, samples: number[], progress: RequestProgress, config: EstimatorConfig): RequestTime {
  nonnegative(center, 'duration prior');
  const observed = samples.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const initial = observed.length >= config.minConditionalSamples ? {
    low: observed[Math.floor((observed.length - 1) * 0.2)]!, high: observed[Math.ceil((observed.length - 1) * 0.8)]!,
  } : { low: center * config.referenceLowFactor, high: center * config.referenceHighFactor };
  if (progress.phase === 'not-started') return { remainingMs: initial, reasons: [
    ...(observed.length >= config.minConditionalSamples ? ['observed-call-duration-reference'] : []), 'reference-range-not-calibrated-confidence',
  ] };
  const elapsed = progress.elapsedMs;
  const conditional = samples.filter(value => Number.isFinite(value) && value > elapsed).sort((a, b) => a - b);
  if (conditional.length >= config.minConditionalSamples) return { remainingMs: {
    low: conditional[Math.floor((conditional.length - 1) * 0.2)]! - elapsed,
    high: conditional[Math.ceil((conditional.length - 1) * 0.8)]! - elapsed,
  }, reasons: ['conditional-observed-remaining-range', 'reference-range-not-calibrated-confidence'] };
  if (elapsed >= initial.high) return { remainingMs: null, reasons: ['reference-range-exhausted-reassessing'] };
  return { remainingMs: { low: Math.max(0, initial.low - elapsed), high: initial.high - elapsed }, reasons: ['waiting-for-model-response', 'conditional-samples-insufficient'] };
}

/** Deterministic non-preemptive list scheduling. Dependencies are mandatory, not inferred. */
export function schedule(units: ScheduleUnit[], options: ScheduleOptions = {}): ScheduleResult {
  const maxConcurrency = options.maxConcurrency ?? Infinity;
  if (maxConcurrency !== Infinity && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)) throw new TypeError('maxConcurrency must be a positive integer');
  for (const limit of Object.values(options.resourceLimits ?? {})) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Resource limits must be positive integers');
  const byId = new Map<string, ScheduleUnit>();
  for (const unit of units) {
    if (!unit.id || byId.has(unit.id)) throw new TypeError('Schedule ids must be unique');
    assertSpan(unit.durationMs, unit.id);
    if (!Array.isArray(unit.dependsOn) || new Set(unit.dependsOn).size !== unit.dependsOn.length) throw new TypeError('Dependencies must be unique');
    byId.set(unit.id, unit);
  }
  for (const unit of units) for (const dependency of unit.dependsOn) if (!byId.has(dependency) || dependency === unit.id) throw new TypeError(`Invalid dependency: ${dependency}`);
  const topo = new Set<string>();
  while (topo.size < units.length) {
    const next = units.find(unit => !topo.has(unit.id) && unit.dependsOn.every(id => topo.has(id)));
    if (!next) throw new TypeError('Dependency cycle');
    topo.add(next.id);
  }
  function run(bound: 'low' | 'high'): Map<string, { start: number; end: number }> {
    const result = new Map<string, { start: number; end: number }>();
    const running = new Map<string, { end: number; resource?: string }>();
    const done = new Set<string>();
    let now = 0;
    while (done.size < units.length) {
      for (const [id, item] of running) if (item.end <= now) { done.add(id); running.delete(id); }
      let launched = false;
      for (const unit of units) {
        if (result.has(unit.id) || !unit.dependsOn.every(id => done.has(id)) || running.size >= maxConcurrency) continue;
        const sameResource = [...running.values()].filter(item => item.resource === unit.resource).length;
        if (unit.resource && sameResource >= (options.resourceLimits?.[unit.resource] ?? Infinity)) continue;
        const end = now + unit.durationMs[bound];
        result.set(unit.id, { start: now, end });
        if (end === now) done.add(unit.id);
        else running.set(unit.id, { end, resource: unit.resource });
        launched = true;
      }
      if (done.size === units.length) break;
      // A zero-duration dependency can make an earlier array item ready at this same instant.
      if (launched && units.some(unit => !result.has(unit.id) && unit.dependsOn.every(id => done.has(id)) && running.size < maxConcurrency && (!unit.resource || [...running.values()].filter(item => item.resource === unit.resource).length < (options.resourceLimits?.[unit.resource] ?? Infinity)))) continue;
      if (!running.size) throw new TypeError('Schedule could not make progress');
      now = Math.min(...[...running.values()].map(item => item.end));
    }
    return result;
  }
  const low = run('low');
  const high = run('high');
  const lowMakespan = Math.max(0, ...[...low.values()].map(item => item.end));
  const highMakespan = Math.max(lowMakespan, ...[...high.values()].map(item => item.end));
  return {
    makespanMs: { low: lowMakespan, high: highMakespan },
    totalWorkMs: { low: units.reduce((sum, unit) => sum + unit.durationMs.low, 0), high: units.reduce((sum, unit) => sum + unit.durationMs.high, 0) },
    units: units.map(unit => ({ id: unit.id, startMs: { low: Math.min(low.get(unit.id)!.start, high.get(unit.id)!.start), high: Math.max(low.get(unit.id)!.start, high.get(unit.id)!.start) }, endMs: { low: Math.min(low.get(unit.id)!.end, high.get(unit.id)!.end), high: Math.max(low.get(unit.id)!.end, high.get(unit.id)!.end) } })),
  };
}

export function estimatePlanTime(scenario: PlanScenario, performanceFor: (route: RouteIdentity, request?: RequestBudget) => PerformanceEstimate, options: PlanTimeOptions = {}): PlanTime {
  const completed = new Set(options.completedIds ?? []);
  for (const [id, progress] of Object.entries(options.progress ?? {})) if (progress.phase === 'completed') completed.add(id);
  const units: ScheduleUnit[] = [];
  const reasons: string[] = [];
  const origins: EstimateOrigin[] = [];
  let unknown = false;
  let localPerformanceSamples = 0;
  for (const request of scenario.requests) {
    if (completed.has(request.id)) continue;
    const performance = performanceFor(request.route, request);
    const estimate = estimateRequestTime(request, performance, options.progress?.[request.id], options.config);
    const bodyMetrics = request.route.requestMode === 'text' && request.visibleTextTokens !== null && performance.firstTextMs !== null && performance.visibleTps !== null;
    origins.push(bodyMetrics ? mergeOrigins([performance.metricOrigins.firstText, performance.metricOrigins.speed]) : performance.metricOrigins.total);
    localPerformanceSamples = Math.max(localPerformanceSamples, performance.samples);
    reasons.push(...estimate.reasons);
    if (estimate.remainingMs === null) unknown = true;
    else units.push({ id: request.id, durationMs: estimate.remainingMs, dependsOn: request.dependsOn.filter(id => !completed.has(id)), resource: 'model' });
  }
  for (const tool of scenario.tools) {
    if (completed.has(tool.id)) continue;
    units.push({ id: tool.id, durationMs: tool.durationMs, dependsOn: tool.dependsOn.filter(id => !completed.has(id)), resource: tool.resource ?? 'tool' });
    origins.push(tool.sourceKind);
  }
  if (unknown) return { remainingMs: null, schedule: null, reasons: [...new Set(reasons)], origin: mergeOrigins(origins), localPerformanceSamples };
  const result = schedule(units, options);
  return { remainingMs: result.makespanMs, schedule: result, reasons: [...new Set(reasons)], origin: mergeOrigins(origins), localPerformanceSamples };
}

export function estimateWorkloadTime(plan: WorkloadPlan, performanceFor: (route: RouteIdentity, request?: RequestBudget) => PerformanceEstimate, options: PlanTimeOptions = {}): PlanTime {
  const low = estimatePlanTime(plan.low, performanceFor, options);
  const high = estimatePlanTime(plan.high, performanceFor, options);
  return { remainingMs: low.remainingMs && high.remainingMs ? { low: Math.min(low.remainingMs.low, high.remainingMs.low), high: Math.max(low.remainingMs.high, high.remainingMs.high) } : null, schedule: high.schedule, reasons: [...new Set([...plan.reasons, ...low.reasons, ...high.reasons])], origin: mergeOrigins([plan.origin, low.origin, high.origin]), localPerformanceSamples: Math.max(low.localPerformanceSamples, high.localPerformanceSamples) };
}

export interface ContinuationSample {
  elapsedActiveMs: number;
  completedRequests: number;
}
export interface ContinuationInput {
  elapsedActiveMs: number;
  completedRequests: number;
  activeRequests: number;
  /** One finished task per sample, already matched by task kind and route. */
  history?: readonly ContinuationSample[];
  minSamples?: number;
}

/**
 * Conditional residual duration from comparable completed local tasks. A call
 * count is not percentage complete: adding calls must never by itself imply
 * that a task is nearly finished. Only past tasks which reached the observed
 * call count AND outlasted the current elapsed time can supply a residual.
 *
 * The central 20–80% empirical range limits single-outlier effects. It remains
 * a reference, not a calibrated confidence interval. With insufficient eligible
 * tasks the result is unknown; retired machine-specific multipliers are never
 * used as a universal forecast or to keep an exhausted plan looking valid.
 */
export function estimateContinuation(input: ContinuationInput): Span | null {
  nonnegative(input.elapsedActiveMs, 'elapsedActiveMs');
  nonnegative(input.completedRequests, 'completedRequests');
  nonnegative(input.activeRequests, 'activeRequests');
  const minSamples = input.minSamples ?? 5;
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) throw new TypeError('Invalid minimum continuation samples');
  const observed = input.completedRequests + input.activeRequests;
  if (input.elapsedActiveMs === 0 || observed === 0) return null;
  const remaining = (input.history ?? []).filter(sample => Number.isFinite(sample.elapsedActiveMs)
    && Number.isSafeInteger(sample.completedRequests) && sample.completedRequests >= observed
    && sample.elapsedActiveMs > input.elapsedActiveMs)
    .map(sample => sample.elapsedActiveMs - input.elapsedActiveMs).sort((a, b) => a - b);
  if (remaining.length < minSamples) return null;
  // Outward order statistics avoid interpolating invented second-level detail.
  return { low: remaining[Math.floor((remaining.length - 1) * 0.2)]!, high: remaining[Math.ceil((remaining.length - 1) * 0.8)]! };
}

export function calculateElapsed(input: { startedAtMs: number; nowMs: number; endedAtMs?: number; pauses?: { startMs: number; endMs: number | null }[] }): { elapsedWallMs: number; elapsedActiveMs: number; elapsedPausedMs: number } {
  const end = input.endedAtMs ?? input.nowMs;
  if (![input.startedAtMs, end].every(Number.isFinite) || end < input.startedAtMs) throw new TypeError('Invalid task interval');
  const intervals = (input.pauses ?? []).map(pause => {
    if (!Number.isFinite(pause.startMs) || (pause.endMs !== null && (!Number.isFinite(pause.endMs) || pause.endMs < pause.startMs))) throw new TypeError('Invalid pause interval');
    return { start: Math.max(input.startedAtMs, pause.startMs), end: Math.min(end, pause.endMs ?? end) };
  }).filter(interval => interval.end > interval.start).sort((a, b) => a.start - b.start);
  let paused = 0;
  let lastEnd = input.startedAtMs;
  for (const interval of intervals) { paused += Math.max(0, interval.end - Math.max(lastEnd, interval.start)); lastEnd = Math.max(lastEnd, interval.end); }
  return { elapsedWallMs: end - input.startedAtMs, elapsedActiveMs: end - input.startedAtMs - paused, elapsedPausedMs: paused };
}
