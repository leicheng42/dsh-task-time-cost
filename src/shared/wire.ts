/** Package-owned DTOs. These are not DSH SDK types. All amounts are decimal strings. */
export type Span = { low: number; high: number };
export type TaskState = 'queued' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type Money = { currency: string; amount: string };
export type MoneyRange = { currency: string; range: { low: string; high: string } };
export type TokenBreakdown = {
  input: number | null; cacheRead: number | null; cacheWrite: number | null;
  output: number | null; reasoning: number | null;
};
export interface EstimateSnapshot {
  taskKey: string;
  sessionId: string;
  turn: number;
  revision: number;
  algorithmVersion: string;
  state: TaskState;
  taskType: string;
  workloadScale?: 'task' | 'project' | 'program';
  forecastScope?: 'current_turn' | 'whole_goal';
  updatedAt: number;
  startedAt: number;
  endedAt: number | null;
  elapsedWallMs: number;
  elapsedActiveMs: number;
  elapsedPausedMs: number;
  remainingMs: Span | null;
  /** Nominal work scenario at route performance centers; not a confidence bound. */
  remainingTypicalMs?: number | null;
  estimatedTotalMs: Span | null;
  estimateOrigin: 'heuristic' | 'public-measured' | 'local-measured' | 'mixed';
  localPerformanceSamples: number;
  workloadSamples: number;
  observedTokenStatus: 'complete' | 'partial' | 'unknown';
  observedTokens: number | null;
  tokens: TokenBreakdown;
  estimatedTotalTokens: Span | null;
  /** Planned visible generation, including tool arguments; excludes hidden reasoning. */
  estimatedRemainingOutputTokens?: Span | null;
  knownCost: Money[];
  estimatedTotalCost: MoneyRange[] | null;
  observedCostStatus: 'complete' | 'partial' | 'unpriced' | 'free';
  forecastCostStatus: 'reference' | 'partial' | 'unavailable' | 'free';
  unpricedCalls: number;
  incompleteForecastUnits: number;
  calls: { completed: number; active: number; failed: number; expected: Span };
  tools: { completed: number; active: number; workMs: number };
  performance: {
    providerId: string; modelId: string; endpointFingerprint: string;
    requestMode: string; reasoningEffort: string; serviceTier: string;
    firstContentMs: number | null; firstTextMs: number | null; visibleTps: number | null;
    totalCallMs: number | null; source: string; stale: boolean;
    /** Optional only for stored snapshots predating metric-specific provenance. */
    trust?: 'observed' | 'reference';
    metricOrigins?: { firstContent: 'heuristic' | 'public-measured' | 'local-measured'; firstText: 'heuristic' | 'public-measured' | 'local-measured'; speed: 'heuristic' | 'public-measured' | 'local-measured'; total: 'heuristic' | 'public-measured' | 'local-measured' };
  } | null;
  priceSources: string[];
  initial: { estimatedTotalMs: Span | null; estimatedTotalCost: MoneyRange[] | null } | null;
  error: string | null;
  reasons: string[];
  scope: 'current_turn';
  /** How strongly the panel may state a number; only 'stable' allows a point estimate. */
  confidence?: 'assessing' | 'preliminary' | 'calibrated' | 'stable';
  /** Finished turns compared against their first estimate; the honest accuracy record. */
  calibration?: { samples: number; medianRatio: number | null; underestimated: number };
  /** Model answer for the whole goal: remaining active time, never a round-count product. */
  goalForecast?: { lowMs: number; highMs: number; at: number };
  /** Active time this goal has already spent, including the running round. */
  goalSpentMs?: number;
  /** Goal round budget, when this turn belongs to a goal. */
  goalRounds?: { started: number; max: number };
  /** Opaque goal identity; used to group rounds, never rendered. */
  goalId?: string;
  /** Activity counts per 10s bucket over the last minute; progress evidence, not a percentage. */
  activity?: number[];
  /** Recent high bounds of the remaining range, oldest first; a display trail only. */
  forecastTrail?: { at: number; highMs: number }[];
  /** Whole-session elapsed/remaining, filled by the Host when other turns of this session are known. */
  sessionElapsedMs?: number;
  sessionRemainingMs?: Span | null;
  sessionTurns?: number;
}
export interface HistoryItem {
  taskKey: string; sessionId: string; turn: number; taskType: string; state: TaskState;
  startedAt: number; elapsedActiveMs: number; elapsedPausedMs: number; knownCost: Money[];
  initialMs: Span | null; durationErrorMs: number | null;
}
export interface RetainedTimeForecast {
  taskKey: string;
  remainingMs: Span;
  remainingTypicalMs?: number | null;
  estimatedTotalMs: Span | null;
  updatedAt: number;
}
export interface EstimatorView {
  snapshot: EstimateSnapshot | null;
  /** Display reference only; never used for current usage, costs or calibration. */
  lastForecast?: RetainedTimeForecast;
  available: boolean;
  error: string | null;
}
export interface ManagementView {
  config: Record<string, unknown>;
  history: HistoryItem[];
  profiles: ProfileSummary[];
  diagnostics: { time: number; code: string; message: string }[];
  storage: 'ready' | 'unavailable';
}
/**
 * Calibration summary for one provider/route bucket. Values are smoothed local
 * centers; the sample counts decide whether a metric is an observation or still
 * a prior, so the UI must never present a prior-only value as a measurement.
 */
export interface ProfileSummary {
  key: string;
  providerId: string;
  modelId: string;
  endpointFingerprint: string;
  requestMode: string;
  reasoningEffort: string;
  serviceTier: string;
  /** Explicit buckets keep two rows of the same model distinguishable. */
  inputBucket?: string;
  cacheBucket?: string;
  concurrencyBucket?: string;
  /** Upstream identity was unknown or mixed for this bucket. */
  mixedRoute?: boolean;
  firstContentMs: number | null;
  firstTextMs: number | null;
  /** Local speed center; null until a call contributed an accepted speed sample. */
  visibleTps: number | null;
  /** Prior speed that the estimator would fall back to when no local speed exists. */
  priorVisibleTps: number | null;
  totalCallMs: number;
  totalCallSamples: number;
  firstTextSamples: number;
  speedSamples: number;
  failedCalls: number;
  /** End of the newest accepted local observation; null until one exists. */
  testedAt: number | null;
  sourceKind: 'heuristic' | 'public-measured' | 'local-measured';
}
export type ManagementAction = 'read' | 'saveConfig' | 'estimatorModel' | 'export' | 'resetCalibration' | 'importBaselines';
export interface ManagementResult {
  ok: boolean;
  message: string;
  data?: ManagementView;
  exported?: string;
}
export interface EstimatorRemote {
  snapshot(sessionId: string, turn: number | null, signal?: AbortSignal): Promise<RemoteResult<EstimatorView>>;
  manage(action: ManagementAction, payload: string, signal?: AbortSignal): Promise<RemoteResult<ManagementResult>>;
}
export type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code: string } };
export const ALGORITHM_VERSION = 'p0-0.3.0-goal3';
export const PACKAGE_NAME = 'dsh-task-time-cost';
