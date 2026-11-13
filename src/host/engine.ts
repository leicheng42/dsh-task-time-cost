import type { Session } from '@deepseek-ai/dsh-session';
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import { normalizeUsage, sumKnown as knownSum, subtotalKnown as knownSubtotal } from '../shared/usage.ts';
import type { NormalizedUsage } from '../shared/usage.ts';
import { aggregateCosts, aggregateForecastCosts, estimateCallCost } from '../shared/pricing.ts';
import { resolveWithPublicPrices } from '../shared/public-prices.ts';
import { retainedTimeForecast } from '../shared/retained-time.ts';
import { createProfile, heuristicPerformance, profileKey, selectPerformance, updateProfile } from '../shared/performance.ts';
import type { CallObservation, PerformanceEstimate, PerformancePrior, ProviderProfile } from '../shared/performance.ts';
import { selectCallSizePerformance } from '../shared/call-size.ts';
import type { CallSizeSample } from '../shared/call-size.ts';
import { DEFAULT_TEMPLATES, estimateWorkload, updateWorkload } from '../shared/workload.ts';
import type { PlanScenario, RequestBudget, WorkloadHistory, WorkloadPlan, WorkloadTemplate } from '../shared/workload.ts';
import { estimateContinuation, estimateWorkloadTime } from '../shared/time.ts';
import type { RequestProgress } from '../shared/time.ts';
import { applyAiPlan } from '../shared/ai-plan.ts';
import type { RouteIdentity, Span, TaskKind } from '../shared/types.ts';
import type { BaselineRecord } from '../shared/baselines.ts';
import { performancePriorsFromBaselines, templatesFromBaselines } from '../shared/baseline-selection.ts';
import { ALGORITHM_VERSION } from '../shared/wire.ts';
import type { EstimateSnapshot, HistoryItem, ManagementView, MoneyRange, ProfileSummary } from '../shared/wire.ts';
import { MONEY_DECIMALS, formatFixed, parseFixed } from '../shared/money.ts';
import { snapshotSchema } from '../shared/remote-contract.ts';
import type { FactsState, TaskFact, CallFact, RouteFact } from './facts.ts';
import type { PluginConfig } from './config.ts';
import { Repository } from './repository.ts';
import type { CallRecord, TaskRecord } from './repository.ts';
import { RuntimeObservations } from './runtime.ts';
import type { LiveAttempt } from './runtime.ts';
import { forecastCall } from './forecast-cost.ts';

const syntheticPrompts: Record<TaskKind, string> = { question: '解释这个概念', writing: '写故事', 'file-analysis': '分析文件', code: '修改项目运行测试', research: '多步调研', unknown: '' };
const terminal = (state: string) => !['running', 'waiting_user', 'queued'].includes(state);

export class EstimatorEngine {
  readonly runtime: RuntimeObservations;
  readonly profiles = new Map<string, ProviderProfile>();
  readonly workloadHistory = new Map<TaskKind, WorkloadHistory>();
  private readonly plans = new Map<string, { signature: string; plan: WorkloadPlan }>();
  private readonly latest = new Map<string, { revision: number; at: number; snapshot: EstimateSnapshot }>();
  private readonly currentInput = new Map<string, number | null>();
  private readonly initialInput = new Map<string, number | null>();
  private readonly requestInputs = new Map<string, number | null>();
  private readonly startedHere = new Set<string>();
  private readonly pendingFacts = new Map<string, { sessionId: string; fact: CallFact }>();
  private readonly unavailable = new Map<string, string>();
  private priors: PerformancePrior[];
  readonly repository: Repository;
  config: PluginConfig;
  baselines: BaselineRecord[];
  constructor(config: PluginConfig, repository: Repository, baselines: BaselineRecord[], runtime = new RuntimeObservations()) {
    this.config = config; this.repository = repository; this.baselines = baselines; this.runtime = runtime;
    this.priors = performancePriorsFromBaselines(this.effectiveBaselines(), this.engineConfig());
    this.rebuildCalibration();
  }
  private engineConfig() {
    const { prices: _p, usePublicPriceCatalog: _catalog, sameAs: _s, routeOverrides: _r, workloadTemplates: _w, classificationRules: _c, ...engine } = this.config;
    return engine;
  }
  private effectiveBaselines(): BaselineRecord[] {
    // Packaged assumptions document the editable defaults; they must not override them.
    const seeds = new Set(['engineering-performance-v1', ...DEFAULT_TEMPLATES.map(template => `engineering-${template.kind}-v1`)]);
    return this.baselines.filter(record => !(record.sourceKind === 'heuristic' && record.dataVersion === 'engineering-v1' && seeds.has(record.seedId)));
  }
  rebuildCalibration(): void {
    this.profiles.clear(); this.workloadHistory.clear(); this.plans.clear(); this.latest.clear();
    for (const record of [...this.repository.calls.values()].sort((a, b) => a.savedAt - b.savedAt || a.id.localeCompare(b.id))) {
      // Stored records are read for live snapshots, so a normalization rule that
      // changed since they were written must be applied to them as well.
      this.healCall(record);
      if (!record.observation || (this.repository.resetAt > 0 && record.savedAt <= this.repository.resetAt)) continue;
      this.trainProfile(record.observation, record.id);
    }
    for (const record of [...this.repository.tasks.values()].sort((a, b) => a.savedAt - b.savedAt || a.id.localeCompare(b.id))) this.trainWorkload(record);
  }
  updateBaselines(records: BaselineRecord[]): void {
    this.baselines = records; this.priors = performancePriorsFromBaselines(this.effectiveBaselines(), this.engineConfig()); this.rebuildCalibration();
  }
  setInput(sessionId: string, turn: number, input: number | null): void {
    const key = `${sessionId}:${turn}`;
    if (input !== null && (!Number.isSafeInteger(input) || input < 0)) input = null;
    if (!this.initialInput.has(key) || this.initialInput.get(key) === null) this.initialInput.set(key, input);
    this.currentInput.set(key, input); this.invalidate(sessionId, turn);
  }
  route(fact: RouteFact | null, mode: RouteIdentity['requestMode'] = 'unknown'): RouteIdentity {
    const providerId = fact?.providerId ?? 'unknown';
    const overrides = this.config.routeOverrides[providerId];
    // An unresolved endpoint keeps the stable 'unknown' identity. A per-process
    // random value would split one logical route into several calibration buckets
    // across reloads and would bypass the unknown-endpoint trust/reference rules.
    return { providerId, endpointFingerprint: overrides?.endpointFingerprint ?? 'unknown',
      modelId: fact?.modelId ?? 'unknown', requestMode: mode, reasoningEffort: fact?.reasoningEffort ?? 'unknown', serviceTier: overrides?.serviceTier ?? 'unknown', mixedRoute: !overrides?.endpointFingerprint };
  }
  invalidate(sessionId: string, turn: number): void { this.latest.delete(`${sessionId}:${turn}`); }
  observerFailed(sessionId: string, turn: number, error: unknown): void {
    const key = `${sessionId}:${turn}`;
    this.unavailable.set(key, 'observer-failed'); this.latest.delete(key);
    this.repository.diagnose('observer-failed', 'Observation failed; task continues and this estimate is unavailable.');
    // Keep provider content and arguments out of diagnostics exported to the Client.
    if (error instanceof Error) console.error('[dsh-task-time-cost]', error);
  }
  normalize(fact: Pick<CallFact, 'route' | 'usage'>): NormalizedUsage {
    const route = this.config.routeOverrides[fact.route.providerId];
    const configured = route?.outputIncludesReasoning ?? 'unknown';
    // An unconfigured route is not evidence of a broken adapter: derive the
    // semantics from the adapter's own token arithmetic before giving up.
    return normalizeUsage(fact.usage ?? {}, { schema: 'dsh', outputIncludesReasoning: configured, inferOutputIncludesReasoning: configured === 'unknown', defaultCacheWriteTtl: route?.cacheWriteTtl ?? null,
      ...(route?.cacheFieldsOmittedAreZero ? { missingMeansZero: ['cacheReadTokens', 'cacheWriteTokens'] as const as ['cacheReadTokens', 'cacheWriteTokens'] } : {}) });
  }
  recordCall(sessionId: string, fact: CallFact, live?: { attempt: LiveAttempt; endedAt: number }): CallRecord {
    const id = `${sessionId}:${fact.seq}`;
    const existing = this.repository.calls.get(id);
    if (existing) return this.healCall(existing);
    const call: CallFact = live ? { ...fact, startedAt: live.attempt.startedAt, endedAt: live.endedAt,
      firstContentAt: live.attempt.firstContentAt ?? fact.firstContentAt,
      firstTextAt: live.attempt.firstTextAt ?? fact.firstTextAt,
      lastContentAt: live.attempt.lastContentAt ?? fact.lastContentAt,
      textChars: Math.max(fact.textChars, live.attempt.textChars), reasoningChars: Math.max(fact.reasoningChars, live.attempt.reasoningChars),
      toolChars: Math.max(fact.toolChars, live.attempt.toolChars), textDeltas: Math.max(fact.textDeltas, live.attempt.textDeltas),
      usage: fact.usage ?? live.attempt.usage, finish: fact.finish ?? live.attempt.finish, timingSource: 'live-attempt' } : fact;
    const route = this.route(call.route, call.mode);
    const usage = this.normalize(call);
    const at = new Date(call.startedAt).toISOString();
    const resolution = resolveWithPublicPrices({ providerId: route.providerId, endpointFingerprint: route.endpointFingerprint, requestedModelId: live?.attempt.route.modelId ?? route.modelId, servedModelId: route.modelId }, this.config.prices, this.config.sameAs, at, this.config.usePublicPriceCatalog);
    const cost = estimateCallCost(usage, resolution, { at, serviceTier: route.serviceTier });
    const separable = route.requestMode === 'text' && call.toolChars === 0 && usage.visibleOutputTokens !== null;
    const observation: CallObservation | null = live ? {
      attemptId: `${sessionId}:${live.attempt.id}`, route, startedAtMs: call.startedAt, firstContentAtMs: call.firstContentAt,
      firstTextAtMs: call.firstTextAt, lastContentAtMs: call.lastContentAt, endedAtMs: call.endedAt,
      outcome: call.outcome, streaming: call.textDeltas > 1 || call.toolChars > 0,
      buffered: call.textDeltas <= 1 || (call.firstTextAt !== null && call.lastContentAt !== null && call.lastContentAt - call.firstTextAt < this.config.minGenerationWindowMs),
      hiddenReasoningSeparable: separable, toolOnly: call.mode === 'tool', visibleTextTokens: separable ? usage.visibleOutputTokens : null,
      tokenMeasurement: 'reported', userPausedMs: this.runtime.pausedMs(sessionId, call.turn, call.startedAt, call.endedAt), timingSource: 'live-attempt-monotonic',
    } : null;
    const record: CallRecord = { id, savedAt: call.endedAt, fact: call, route, usage, cost, resolution, observation };
    void this.repository.saveCall(record);
    if (observation && (this.repository.resetAt === 0 || record.savedAt > this.repository.resetAt)) this.trainProfile(observation, id);
    return record;
  }
  private trainProfile(observation: CallObservation, committedCallId: string): void {
    const key = profileKey(observation.route);
    const previous = this.profiles.get(key);
    const stale = previous?.lastLocalAtMs !== null && previous?.lastLocalAtMs !== undefined && observation.startedAtMs - previous.lastLocalAtMs > this.config.profileStaleDays * 86_400_000;
    const selected = selectPerformance(observation.route, [], this.priors, observation.startedAtMs, this.engineConfig());
    const prior = this.priors.find(candidate => candidate.id === selected.sourceId) ?? heuristicPerformance(this.engineConfig());
    const base = previous && !stale ? previous : createProfile(observation.route, prior);
    // Live IDs are unique only within one Agent lifecycle. The committed
    // session/seq identity survives restart; keep the original observation
    // untouched so training never rewrites its raw source or valuation.
    const updated = updateProfile(base, { ...observation, attemptId: committedCallId }, this.engineConfig());
    this.profiles.set(key, updated.profile);
  }
  onDurable(sessionId: string, state: FactsState, type: string): void {
    const task = state.currentTurn === null ? Object.values(state.tasks).at(-1) : state.tasks[String(state.currentTurn)];
    if (!task) return;
    if (state.error) { this.unavailable.set(`${sessionId}:${task.turn}`, 'projection-fold-failed'); this.invalidate(sessionId, task.turn); return; }
    this.runtime.task(sessionId, task.turn); this.invalidate(sessionId, task.turn);
    if (type === 'turn/start') this.startedHere.add(`${sessionId}:${task.turn}`);
    if (type === 'assistant/message' || type === 'assistant/attempt') {
      const fact = task.calls.at(-1);
      if (fact) {
        const active = this.runtime.activeAttempts(sessionId, task.turn).some(attempt => attempt.step === fact.step);
        if (active) this.pendingFacts.set(`${sessionId}:${fact.seq}`, { sessionId, fact });
        else this.recordCall(sessionId, fact);
      }
    }
  }
  onStream(sessionId: string, frame: AssistantStreamFrame, state: FactsState): void {
    if (frame.type === 'start') {
      const task = state.tasks[String(frame.turn)];
      const route = task?.route ?? state.route ?? { providerId: 'unknown', modelId: 'unknown', reasoningEffort: 'unknown' };
      this.runtime.startAttempt(sessionId, frame, route);
      this.requestInputs.set(frame.attemptId, this.currentInput.get(`${sessionId}:${frame.turn}`) ?? null);
      this.invalidate(sessionId, frame.turn);
    } else if (frame.type === 'chunk') this.runtime.chunk(frame);
    else {
      const live = this.runtime.endAttempt(frame.attemptId);
      this.requestInputs.delete(frame.attemptId);
      if (!live) return;
      if (frame.outcome.kind === 'committed') {
        const settledSeq = frame.outcome.seq;
        const key = `${sessionId}:${settledSeq}`;
        const pending = this.pendingFacts.get(key);
        const task = state.tasks[String(live.attempt.turn)];
        const fact = pending?.fact ?? task?.calls.find(call => call.seq === settledSeq);
        if (fact) this.recordCall(sessionId, fact, live);
        this.pendingFacts.delete(key);
      } else this.repository.diagnose('abandoned-attempt', 'A live attempt ended without a durable settlement; its incomplete usage is excluded from calibration.');
      this.invalidate(sessionId, live.attempt.turn);
    }
  }
  private templates(route: RouteIdentity): WorkloadTemplate[] {
    return templatesFromBaselines(this.effectiveBaselines(), route, this.config.workloadTemplates).map(template => {
      const configured = this.config.workloadTemplates.find(candidate => candidate.kind === template.kind)!;
      const standard = DEFAULT_TEMPLATES.find(candidate => candidate.kind === template.kind);
      return JSON.stringify(configured) === JSON.stringify(standard) ? template : structuredClone(configured);
    });
  }
  private plan(sessionId: string, task: TaskFact): WorkloadPlan {
    const key = `${sessionId}:${task.turn}`;
    const firstCall = task.calls[0];
    const input = this.initialInput.get(key) ?? (firstCall ? this.normalize(firstCall).promptTokens : null);
    const requestMode = task.calls.findLast(call => call.mode !== 'unknown' && (!task.route
      || call.route.providerId === task.route.providerId && call.route.modelId === task.route.modelId && call.route.reasoningEffort === task.route.reasoningEffort))?.mode ?? 'unknown';
    const signature = JSON.stringify([task.taskType, task.explicitOutputWords, task.attachmentCount, task.route, requestMode, input, task.aiPlan]);
    const previous = this.plans.get(key);
    if (previous?.signature === signature) return structuredClone(previous.plan);
    const route = this.route(task.route, requestMode);
    const templates = this.templates(route);
    let plan = estimateWorkload({ prompt: syntheticPrompts[task.taskType], currentInputTokens: input, fileCount: task.attachmentCount,
      ...(task.explicitOutputWords ? { explicitOutputTokens: { low: task.explicitOutputWords, high: task.explicitOutputWords * 2 } } : {}) }, route,
    { config: this.engineConfig(), templates, history: [...this.workloadHistory.values()], rules: [{ id: 'durable-classification', kind: task.taskType, patterns: ['.*'] }] });
    if (task.aiPlan) plan = applyAiPlan(plan, task.aiPlan, route, this.currentInput.get(key) ?? input, this.engineConfig());
    this.plans.set(key, { signature, plan });
    return structuredClone(plan);
  }
  estimate(sessionId: string, task: TaskFact, revision: number, force = false): EstimateSnapshot {
    const key = `${sessionId}:${task.turn}`;
    const runtime = this.runtime.task(sessionId, task.turn);
    const now = task.endedAt ?? this.runtime.time(runtime);
    const cached = this.latest.get(key);
    if (!force && cached && cached.revision === revision && now - cached.at < this.config.predictionRefreshMs) return cached.snapshot;
    const saved = this.repository.tasks.get(key);
    const errors = this.repository.error ?? this.unavailable.get(key) ?? null;
    // A finished turn normally reuses its stored snapshot, but that snapshot is
    // an old derivation: a later algorithm version may compute the same facts
    // differently (a token subtotal rule, for example). Returning it blindly
    // would keep a retired rule alive in the history forever.
    if (!errors && task.endedAt !== null && saved?.current.endedAt !== null && saved?.current.endedAt !== undefined
      && saved.current.algorithmVersion === ALGORITHM_VERSION && (!force || saved.sourceRevision === revision)) return saved.current;
    // A durable event can precede the stream end frame; count its attempt once until exact settlement.
    const calls = task.calls.filter(fact => !this.pendingFacts.has(`${sessionId}:${fact.seq}`))
      .map(fact => this.referenceCall(this.repository.calls.get(`${sessionId}:${fact.seq}`) ?? this.ephemeralCall(sessionId, fact)));
    const settledCosts = aggregateCosts(calls.map(call => call.cost));
    const active = this.runtime.activeAttempts(sessionId, task.turn);
    const liveUsage = active.map(attempt => {
      const mode = attempt.toolChars ? attempt.textChars ? 'mixed' : 'tool' : attempt.firstTextAt !== null ? 'text' : 'unknown';
      const route = this.route(attempt.route, mode), usage = this.normalize(attempt);
      const at = new Date(attempt.startedAt).toISOString();
      const resolution = resolveWithPublicPrices({ providerId: route.providerId, endpointFingerprint: route.endpointFingerprint, requestedModelId: route.modelId }, this.config.prices, this.config.sameAs, at, this.config.usePublicPriceCatalog);
      return { route, usage, resolution, cost: estimateCallCost(usage, resolution, { at, serviceTier: route.serviceTier }) };
    });
    const usageCalls = [...calls, ...liveUsage];
    const observed = aggregateCosts(usageCalls.map(call => call.cost));
    const tools = Object.values(task.tools);
    const activeTools = tools.filter(tool => tool.endedAt === null);
    const completedTools = tools.filter(tool => tool.endedAt !== null);
    const priorPause = saved && saved.savedAt < runtime.anchorWall ? saved.current.elapsedPausedMs : 0;
    const paused = Math.min(Math.max(0, now - task.startedAt), priorPause + this.runtime.pausedMs(sessionId, task.turn, task.startedAt, now));
    const elapsedWall = Math.max(0, now - task.startedAt), elapsedActive = Math.max(0, elapsedWall - paused);
    const plan = this.plan(sessionId, task);
    const reasons = [...plan.reasons, 'scope:current-turn-only', 'timing-start:confirmed-turn-start', 'queue-duration-unavailable'];
    if (!this.config.routeOverrides[task.route?.providerId ?? '']?.endpointFingerprint) reasons.push('endpoint-unresolved-mixed-route');
    if (task.scopeChanged) reasons.push('task-scope-changed-workload-not-learned');
    if (calls.some(call => call.fact.timingSource === 'step-boundary')) reasons.push('historical-timing-approximate-not-provider-sample');
    const completedCount = calls.length;
    const activeCount = active.length;
    const maxObserved = completedCount + activeCount;
    // The planned request count is captured before the plan is extended, because
    // extension is an admission that the plan under-counted the work. Reading the
    // ceiling afterwards would let a plan that was already exhausted look fresh
    // again on every new attempt.
    const plannedRequests = plan.high.requests.length;
    if (maxObserved > plannedRequests) reasons.push('observed-call-count-expanded-workload');
    for (const scenario of [plan.low, plan.high]) extendScenario(scenario, maxObserved, this.route(task.route));
    const anchors = calls.map((call, index) => ({ index, input: call.usage.promptTokens }));
    for (const [index, attempt] of active.entries()) anchors.push({ index: completedCount + index, input: liveUsage[index]!.usage.promptTokens ?? this.requestInputs.get(attempt.id) ?? null });
    for (const scenario of [plan.low, plan.high]) anchorInputs(scenario, anchors);
    if (active.length) reasons.push('live-usage-provisional-until-durable-settlement');
    const completedIds = Array.from({ length: completedCount }, (_, index) => `request-${index + 1}`);
    // A new request proves that preceding tool stages have settled. Active tools keep their stage.
    const doneToolStages = Math.max(0, completedCount - (activeCount ? 0 : 1));
    for (let index = 1; index <= doneToolStages; index++) completedIds.push(`tool-${index}`);
    const progress: Record<string, RequestProgress> = {};
    for (const [index, attempt] of active.entries()) {
      const id = `request-${completedCount + index + 1}`;
      const mode = attempt.toolChars ? attempt.textChars ? 'mixed' : 'tool' : attempt.firstTextAt !== null ? 'text' : 'unknown';
      for (const scenario of [plan.low, plan.high]) {
        const budget = scenario.requests.find(request => request.id === id);
        if (budget) {
          if (mode !== 'unknown') budget.route = { ...this.route(attempt.route, mode) };
          const generated = liveUsage[index]!.usage.visibleOutputTokens;
          if (generated !== null) budget.visibleOutputTokens = { low: Math.max(budget.visibleOutputTokens.low, generated), high: Math.max(budget.visibleOutputTokens.high, generated) };
          budget.visibleTextTokens = mode === 'text' ? budget.visibleOutputTokens : null;
        }
      }
      const reportedVisible = liveUsage[index]!.usage.visibleOutputTokens;
      progress[id] = { phase: attempt.firstTextAt !== null && !attempt.toolChars ? 'text' : attempt.toolChars ? 'call' : 'waiting', elapsedMs: Math.max(0, now - attempt.startedAt - this.runtime.pausedMs(sessionId, task.turn, attempt.startedAt, now)), generatedTextTokens: reportedVisible ?? Math.floor(attempt.textChars / 4) };
      if (attempt.textChars && reportedVisible === null) reasons.push('live-visible-tokens-character-approximation');
    }
    let toolWorkMs = 0;
    for (const tool of completedTools) toolWorkMs += this.runtime.tools.get(`${sessionId}:${tool.id}`)?.workMs ?? Math.max(0, tool.endedAt! - tool.startedAt);
    if (activeTools.length) {
      const activeToolElapsed = Math.max(...activeTools.map(tool => Math.max(0, now - tool.startedAt - this.runtime.pausedMs(sessionId, task.turn, tool.startedAt, now))));
      for (const scenario of [plan.low, plan.high]) {
        const tool = scenario.tools.find(tool => !completedIds.includes(tool.id));
        if (tool) tool.durationMs = { low: Math.max(0, tool.durationMs.low - activeToolElapsed), high: Math.max(0, tool.durationMs.high - activeToolElapsed) };
      }
    }
    const sizeSamples: CallSizeSample[] = [...this.repository.calls.values()].filter(record => {
      const observation = record.observation;
      return observation && observation.outcome === 'completed' && !(observation.userPausedMs ?? 0) && !(observation.processGapMs ?? 0)
        && observation.endedAtMs <= now && record.savedAt > this.repository.resetAt
        && now - record.savedAt <= this.config.profileStaleDays * 86_400_000;
    }).slice(-this.config.maxSamplesPerBucket * 20).map(record => ({ route: record.route,
      inputTokens: record.usage.promptTokens, visibleOutputTokens: record.usage.visibleOutputTokens,
      cacheReadRatio: record.usage.promptTokens && record.usage.cacheReadTokens !== null ? record.usage.cacheReadTokens / record.usage.promptTokens : null,
      durationMs: record.observation!.endedAtMs - record.observation!.startedAtMs }));
    const sizeCache = new Map<string, PerformanceEstimate>();
    const performanceFor = (route: RouteIdentity, request?: RequestBudget) => {
      const base = selectPerformance(route, [...this.profiles.values()], this.priors, now, this.engineConfig());
      if (!request || route.requestMode === 'text') return base;
      const key = JSON.stringify([profileKey(route), request.inputTokens, request.visibleOutputTokens, request.cacheReadRatio]);
      let selected = sizeCache.get(key);
      if (!selected) { selected = selectCallSizePerformance(request, base, sizeSamples, this.config.minConditionalSamples); sizeCache.set(key, selected); }
      return selected;
    };
    const prediction = estimateWorkloadTime(plan, performanceFor, { completedIds, progress, config: this.engineConfig() });
    reasons.push(...prediction.reasons);
    let remaining = task.endedAt !== null ? { low: 0, high: 0 } : prediction.remainingMs;
    // Once the planned request count has been consumed the plan is no longer a
    // description of the work, and that stays true for the rest of the turn. The
    // earlier test also required "no active attempt", so a long turn collapsed
    // back to a single-call budget every time the next request started: the plan
    // had been extended to exactly the observed count, leaving one short request
    // whose positive estimate looked like a fresh forecast.
    const planExhausted = completedCount >= plannedRequests;
    if (task.endedAt === null && (!remaining || remaining.high <= 0 || planExhausted)) {
      const route = this.route(task.route);
      const history = [...this.repository.tasks.values()].filter(record => {
        const past = record.current, p = past.performance;
        return record.id !== key && past.state === 'completed' && past.endedAt !== null && past.endedAt <= task.startedAt
          && record.savedAt > this.repository.resetAt && past.taskType === task.taskType
          && !past.reasons.includes('task-scope-changed-workload-not-learned')
          && p?.providerId === route.providerId && p.modelId === route.modelId
          && p.endpointFingerprint === route.endpointFingerprint && p.reasoningEffort === route.reasoningEffort && p.serviceTier === route.serviceTier;
      }).map(record => ({ elapsedActiveMs: record.current.elapsedActiveMs, completedRequests: record.current.calls.completed }));
      // Discard the exhausted plan instead of taking its stale upper bound.
      // Each comparable TASK contributes once, regardless of its revision count.
      remaining = estimateContinuation({ elapsedActiveMs: elapsedActive, completedRequests: completedCount,
        activeRequests: activeCount, history, minSamples: this.config.minConditionalSamples });
      reasons.push(remaining ? 'continuation-local-task-history' : 'continuation-history-insufficient');
    }
    // Historical duration can estimate time after plan exhaustion, but supplies
    // no future token/call budget from which to invent a complete cost forecast.
    const unknownFuture = task.endedAt === null && (remaining === null || planExhausted);
    const activeByRequest = new Map(active.map((attempt, index) => [`request-${completedCount + index + 1}`, attempt]));
    const projections = [plan.low, plan.high].map(scenario => {
      const forecast = task.endedAt !== null ? [] : scenario.requests.filter(request => !completedIds.includes(request.id)).map(request => forecastCall(request, this.config, this.config.routeOverrides[request.route.providerId], new Date(activeByRequest.get(request.id)?.startedAt ?? now).toISOString()));
      // Each active request is forecast once in full; its provisional cost is already part of that budget.
      return aggregateForecastCosts(settledCosts, forecast);
    });
    // Workload alternatives can contain different request counts; keep both cost bounds.
    const costRange = unknownFuture ? null : combineCostScenarios(projections.map(projected => projected.totalCost));
    const totalCost = costRange?.map(cost => {
      const known = observed.knownCost.find(known => known.currency === cost.currency);
      if (!known) return cost;
      const floor = parseFixed(known.amount, MONEY_DECIMALS);
      const low = parseFixed(cost.range.low, MONEY_DECIMALS), high = parseFixed(cost.range.high, MONEY_DECIMALS);
      return { currency: cost.currency, range: { low: formatFixed(low > floor ? low : floor), high: formatFixed(high > floor ? high : floor) } };
    }) ?? null;
    const incompleteUnits = Math.max(...projections.map(projected => projected.incompleteUnits));
    const route = this.route(task.route, active.at(0)?.toolChars ? 'mixed' : active.at(0)?.firstTextAt !== null && active.length ? 'text' : task.calls.at(-1)?.mode ?? 'unknown');
    const performanceEstimate = performanceFor(route);
    reasons.push(...performanceEstimate.reasons);
    // A request whose adapter reported no usage at all contributes nothing to
    // the subtotal; coverage is disclosed separately instead of discarding the
    // hundreds of requests that did report numbers.
    const tokenTotals = usageCalls.map(call => call.usage.totalTokens);
    const totalTokens = usageCalls.length ? knownSubtotal(tokenTotals) : null;
    const exactTokens = usageCalls.length ? knownSum(tokenTotals) : null;
    const totalOutput = usageCalls.map(call => call.usage.outputTokens);
    // Forecast totals require complete settled usage. A reported subtotal is
    // useful as an observation, but cannot stand in for missing requests.
    const settledTokens = calls.length === 0 ? 0 : knownSum(calls.map(call => call.usage.totalTokens));
    const tokenScenarios = [plan.low, plan.high].map(scenario => {
      if (settledTokens === null) return null;
      const remainingRequests = scenario.requests.filter(request => !completedIds.includes(request.id));
      const lows = [settledTokens], highs = [settledTokens];
      for (const request of remainingRequests) {
        const reasoning = this.config.routeOverrides[request.route.providerId]?.forecastReasoningTokens ?? request.reasoningTokens;
        if (!request.inputTokens || !reasoning) return null;
        for (const span of [request.inputTokens, request.visibleOutputTokens, reasoning]) {
          lows.push(Math.floor(span.low)); highs.push(Math.ceil(span.high));
        }
      }
      const low = knownSum(lows), high = knownSum(highs);
      return low === null || high === null ? null : { low, high };
    });
    const outputScenarios = [plan.low, plan.high].map(scenario => scenario.requests.filter(request => !completedIds.includes(request.id))
      .reduce((sum, request) => ({ low: sum.low + request.visibleOutputTokens.low, high: sum.high + request.visibleOutputTokens.high }), { low: 0, high: 0 }));
    const estimatedRemainingOutputTokens = task.endedAt !== null ? { low: 0, high: 0 } : errors || planExhausted ? null
      : { low: Math.min(...outputScenarios.map(value => value.low)), high: Math.max(...outputScenarios.map(value => value.high)) };
    const estimatedTokens = tokenScenarios.every((span): span is Span => span !== null)
      ? { low: Math.max(totalTokens ?? 0, Math.min(...tokenScenarios.map(span => span.low))), high: Math.max(totalTokens ?? 0, ...tokenScenarios.map(span => span.high)) } : null;
    const initial = saved?.current.initial ?? (task.endedAt === null && task.promptChars > 0 && this.startedHere.has(key) ? { estimatedTotalMs: remaining ? { low: elapsedActive + remaining.low, high: elapsedActive + remaining.high } : null, estimatedTotalCost: totalCost } : null);
    const snapshot: EstimateSnapshot = snapshotSchema.parse({
      taskKey: key, sessionId, turn: task.turn, revision: Math.max(1, (cached?.snapshot.revision ?? saved?.current.revision ?? 0) + 1), algorithmVersion: ALGORITHM_VERSION,
      state: task.endedAt === null && runtime.pauseOwners.size ? 'waiting_user' : task.state,
      taskType: task.taskType, updatedAt: now, startedAt: task.startedAt, endedAt: task.endedAt,
      elapsedWallMs: elapsedWall, elapsedActiveMs: elapsedActive, elapsedPausedMs: paused,
      remainingMs: errors ? null : remaining, estimatedTotalMs: errors ? null : remaining ? { low: elapsedActive + remaining.low, high: elapsedActive + remaining.high } : null,
      estimateOrigin: prediction.origin, localPerformanceSamples: prediction.localPerformanceSamples, workloadSamples: plan.workloadSamples,
      // Coverage describes the requests, not the arithmetic: a request that
      // reported numbers is complete even when a neighbour reported none.
      observedTokenStatus: usageCalls.length === 0 ? 'unknown' : exactTokens !== null ? 'complete' : usageCalls.some(call => call.usage.status !== 'unknown') ? 'partial' : 'unknown', observedTokens: totalTokens,
      tokens: { input: usageCalls.length ? knownSubtotal(usageCalls.map(call => call.usage.inputTokens)) : null,
        cacheRead: usageCalls.length ? knownSubtotal(usageCalls.map(call => call.usage.cacheReadTokens)) : null,
        cacheWrite: usageCalls.length ? knownSubtotal(usageCalls.map(call => knownSubtotal([call.usage.cacheWrite5mTokens, call.usage.cacheWrite1hTokens, call.usage.cacheWriteUnknownTokens]))) : null,
        output: usageCalls.length ? knownSubtotal(totalOutput) : null, reasoning: usageCalls.length ? knownSubtotal(usageCalls.map(call => call.usage.reasoningTokens)) : null },
      estimatedTotalTokens: task.endedAt !== null ? exactTokens !== null ? { low: exactTokens, high: exactTokens } : null : unknownFuture ? null : estimatedTokens,
      estimatedRemainingOutputTokens,
      knownCost: observed.knownCost, estimatedTotalCost: errors ? null : totalCost,
      observedCostStatus: observed.status, forecastCostStatus: unknownFuture ? 'unavailable' : totalCost ? totalCost.length > 0 && totalCost.every(cost => cost.range.high === '0') ? 'free' : 'reference' : projections.some(projected => projected.status === 'partial') ? 'partial' : 'unavailable',
      unpricedCalls: observed.unpricedCalls, incompleteForecastUnits: incompleteUnits + (unknownFuture ? 1 : 0),
      calls: { completed: completedCount, active: activeCount, failed: calls.filter(call => call.fact.outcome !== 'completed').length, expected: { low: plan.low.requests.length, high: Math.max(plan.low.requests.length, plan.high.requests.length) } },
      tools: { completed: completedTools.length, active: activeTools.length, workMs: toolWorkMs },
      performance: { ...route, firstContentMs: performanceEstimate.firstContentMs, firstTextMs: performanceEstimate.firstTextMs, visibleTps: performanceEstimate.visibleTps, totalCallMs: performanceEstimate.totalCallMs, source: `${performanceEstimate.sourceKind}:${performanceEstimate.match}`, trust: performanceEstimate.trust, metricOrigins: performanceEstimate.metricOrigins, stale: performanceEstimate.reasons.includes('stale-profile-retained-for-audit') },
      priceSources: [...new Set(usageCalls.flatMap(call => call.resolution.entry ? [`${call.resolution.entry.id}@${call.resolution.entry.version}${call.resolution.entry.sourceUrl ? ` ${call.resolution.entry.sourceUrl}` : ''}`] : []))],
      initial, error: errors, reasons: [...new Set([...reasons, ...observed.reasons])], scope: 'current_turn',
    });
    this.latest.set(key, { revision, at: now, snapshot });
    // A stored snapshot that predates the current algorithm was re-derived
    // above; write the corrected bytes back so history and export stop
    // reporting the retired rule. This happens once per stale turn: afterwards
    // the saved version matches and the early return above takes over.
    if (saved && saved.current.algorithmVersion !== ALGORITHM_VERSION) {
      void this.repository.saveTask({ ...saved, savedAt: snapshot.updatedAt, sourceRevision: revision, current: snapshot, revisions: [...saved.revisions, snapshot].slice(-128) });
    }
    return snapshot;
  }
  /**
   * Re-derive a stored record's usage from the adapter's own facts.
   *
   * Normalization is a derivation, not an observation: a rule improved in a
   * later version must heal bytes written by an earlier one, otherwise the same
   * call is read two different ways and a live snapshot stays stale forever
   * without any new model activity. The historical price resolution is kept as
   * recorded — only the amount implied by the recovered usage is recomputed —
   * so a rate change never revaluates an already-billed call.
   */
  private healCall(existing: CallRecord): CallRecord {
    if (!existing.fact) return existing;
    const usage = this.normalize(existing.fact);
    if (JSON.stringify(existing.usage) === JSON.stringify(usage)) return existing;
    const at = new Date(existing.fact.startedAt).toISOString();
    const cost = estimateCallCost(usage, existing.resolution, { at, serviceTier: existing.route.serviceTier });
    const healed: CallRecord = { ...existing, usage, cost };
    void this.repository.replaceCall(healed);
    return healed;
  }
  private referenceCall(record: CallRecord): CallRecord {
    if (record.resolution.entry || !this.config.usePublicPriceCatalog) return record;
    const at = new Date(record.fact.startedAt).toISOString();
    const resolution = resolveWithPublicPrices({ providerId: record.route.providerId, requestedModelId: record.route.modelId,
      endpointFingerprint: record.route.endpointFingerprint }, this.config.prices, this.config.sameAs, at, true);
    if (resolution.match !== 'public-catalog') return record;
    // Display-only valuation of previously unpriced usage. Never replace the
    // historical per-call resolution, amount or price version in the ledger.
    return { ...record, resolution, cost: estimateCallCost(record.usage, resolution, { at, serviceTier: record.route.serviceTier }) };
  }
  private ephemeralCall(sessionId: string, fact: CallFact): CallRecord {
    const route = this.route(fact.route, fact.mode), usage = this.normalize(fact);
    const at = new Date(fact.startedAt).toISOString();
    const resolution = resolveWithPublicPrices({ providerId: route.providerId, requestedModelId: route.modelId, endpointFingerprint: route.endpointFingerprint }, this.config.prices, this.config.sameAs, at, this.config.usePublicPriceCatalog);
    return { id: `${sessionId}:${fact.seq}`, savedAt: fact.endedAt, fact, route, usage, resolution, cost: estimateCallCost(usage, resolution, { at, serviceTier: route.serviceTier }), observation: null };
  }
  persist(sessionId: string, task: TaskFact, revision: number): EstimateSnapshot {
    const snapshot = this.estimate(sessionId, task, revision, true), saved = this.repository.tasks.get(snapshot.taskKey);
    if (snapshot === saved?.current || (saved?.sourceRevision === revision && saved.current.revision === snapshot.revision)) return snapshot;
    const calls = task.calls.map(fact => this.repository.calls.get(`${sessionId}:${fact.seq}`) ?? this.ephemeralCall(sessionId, fact));
    const outputs = calls.map(call => call.usage.visibleOutputTokens), output = knownSum(outputs);
    const learned = task.endedAt === null ? null : { calls: calls.length, visibleOutputTokens: output ?? 0, toolWorkMs: snapshot.tools.workMs,
      eligible: task.state === 'completed' && !task.scopeChanged && calls.length > 0 && output !== null && calls.every(call => call.fact.outcome === 'completed') && Object.values(task.tools).every(tool => this.runtime.tools.has(`${sessionId}:${tool.id}`)) };
    const revisions = [...(saved?.revisions ?? []), snapshot].slice(-128);
    const record: TaskRecord = { id: snapshot.taskKey, savedAt: snapshot.updatedAt, sourceRevision: revision, current: snapshot, revisions,
      lastForecast: retainedTimeForecast(snapshot, saved), learned };
    void this.repository.saveTask(record);
    if (learned && !saved?.learned) this.trainWorkload(record);
    return snapshot;
  }
  private trainWorkload(record: TaskRecord): void {
    const learned = record.learned;
    if (!learned?.eligible || (this.repository.resetAt > 0 && record.savedAt <= this.repository.resetAt)) return;
    const kind = record.current.taskType as TaskKind;
    const performance = record.current.performance;
    const route = this.route(performance ? { providerId: performance.providerId, modelId: performance.modelId, reasoningEffort: performance.reasoningEffort } : null);
    const template = this.templates(route).find(candidate => candidate.kind === kind)!;
    const center = (span: Span) => (span.low + span.high) / 2;
    const base: WorkloadHistory = this.workloadHistory.get(kind) ?? { kind, requestCount: center(template.requestCount), visibleOutputTokens: center(template.visibleOutputTokens), toolMs: center(template.toolMs), samples: 0, lastObservedAtMs: null, sourceKind: 'local-measured' };
    const result = updateWorkload(base, { kind, outcome: 'completed', requestCount: learned.calls, visibleOutputTokens: learned.visibleOutputTokens, toolMs: learned.toolWorkMs, observedAtMs: record.savedAt, dataComplete: true }, this.config.workloadAlpha);
    if (result.history) this.workloadHistory.set(kind, result.history);
  }
  view(): ManagementView {
    const history: HistoryItem[] = [...this.repository.tasks.values()].sort((a, b) => b.savedAt - a.savedAt).slice(0, 100).map(record => {
      const task = record.current, initial = task.initial?.estimatedTotalMs ?? null;
      return { taskKey: task.taskKey, sessionId: task.sessionId, turn: task.turn, taskType: task.taskType, state: task.state, startedAt: task.startedAt,
        elapsedActiveMs: task.elapsedActiveMs, elapsedPausedMs: task.elapsedPausedMs, knownCost: task.knownCost, initialMs: initial,
        durationErrorMs: task.endedAt !== null && initial ? task.elapsedActiveMs - (initial.low + initial.high) / 2 : null };
    });
    const stale = [...this.repository.tasks.values()].filter(record => record.current.algorithmVersion !== ALGORITHM_VERSION).length;
    const diagnostics = [...this.repository.diagnostics];
    if (stale) diagnostics.push({ time: this.runtime.clock.wall(), code: 'history-recompute-pending',
      message: `${stale} historical summaries use an earlier algorithm. Open their sessions to refresh from the original events; export retains each snapshot's version.` });
    return { config: JSON.parse(JSON.stringify(this.config)) as Record<string, unknown>, history,
      // A calibration read needs the smoothed centers, real sample counts and the
      // newest accepted observation time. Dedup identities, raw sample arrays and
      // exclusion counters stay out; the explicit export keeps the full records.
      profiles: [...this.profiles.values()].slice(-100).map((profile): ProfileSummary => ({
        key: profile.key,
        providerId: profile.route.providerId, modelId: profile.route.modelId, endpointFingerprint: profile.route.endpointFingerprint,
        requestMode: profile.route.requestMode, reasoningEffort: profile.route.reasoningEffort, serviceTier: profile.route.serviceTier,
        // Absent buckets stay off the wire instead of serializing as undefined.
        ...(profile.route.inputBucket ? { inputBucket: profile.route.inputBucket } : {}),
        ...(profile.route.cacheBucket ? { cacheBucket: profile.route.cacheBucket } : {}),
        ...(profile.route.concurrencyBucket ? { concurrencyBucket: profile.route.concurrencyBucket } : {}),
        ...(profile.route.mixedRoute ? { mixedRoute: true } : {}),
        firstContentMs: profile.firstContentMs, firstTextMs: profile.firstTextMs,
        visibleTps: profile.realVisibleSeconds > 0 ? profile.realVisibleTokens / profile.realVisibleSeconds : null,
        priorVisibleTps: profile.prior.visibleTps,
        totalCallMs: profile.totalCallMs, totalCallSamples: profile.totalCallSamples,
        firstTextSamples: profile.firstTextSamples, speedSamples: profile.speedSamples, failedCalls: profile.failedCalls,
        testedAt: profile.lastLocalAtMs, sourceKind: profile.totalCallSamples > 0 ? 'local-measured' : profile.prior.sourceKind,
      })),
      diagnostics, storage: this.repository.available ? 'ready' : 'unavailable' };
  }
  flushPending(): void {
    for (const pending of this.pendingFacts.values()) this.recordCall(pending.sessionId, pending.fact);
    this.pendingFacts.clear();
  }
  cleanupSession(sessionId: string): void {
    for (const [key, pending] of this.pendingFacts) if (pending.sessionId === sessionId) { this.recordCall(sessionId, pending.fact); this.pendingFacts.delete(key); }
    for (const [id, attempt] of this.runtime.attempts) if (attempt.sessionId === sessionId) this.requestInputs.delete(id);
    this.runtime.cleanupSession(sessionId);
    for (const map of [this.latest, this.plans, this.currentInput, this.initialInput, this.unavailable]) {
      for (const key of map.keys()) if (key.startsWith(`${sessionId}:`)) map.delete(key);
    }
    for (const key of this.startedHere) if (key.startsWith(`${sessionId}:`)) this.startedHere.delete(key);
  }
  dispose(): void {
    this.flushPending(); this.runtime.clear(); this.latest.clear(); this.plans.clear(); this.currentInput.clear(); this.initialInput.clear();
    this.requestInputs.clear(); this.startedHere.clear(); this.unavailable.clear();
  }
}
function combineCostScenarios(scenarios: (MoneyRange[] | null)[]): MoneyRange[] | null {
  if (scenarios.some(scenario => scenario === null)) return null;
  const known = scenarios as MoneyRange[][];
  const currencies = [...new Set(known.flatMap(scenario => scenario.map(cost => cost.currency)))].sort();
  return currencies.map(currency => {
    const ranges = known.map(scenario => scenario.find(cost => cost.currency === currency)?.range ?? { low: '0', high: '0' });
    const low = ranges.map(range => parseFixed(range.low, MONEY_DECIMALS)).reduce((a, b) => a < b ? a : b);
    const high = ranges.map(range => parseFixed(range.high, MONEY_DECIMALS)).reduce((a, b) => a > b ? a : b);
    return { currency, range: { low: formatFixed(low), high: formatFixed(high) } };
  });
}
/** Anchor each observed request input once, preserving only the planned growth after it. */
function anchorInputs(scenario: PlanScenario, anchors: { index: number; input: number | null }[]): void {
  for (const { index, input } of anchors) {
    if (input === null || !Number.isSafeInteger(input) || input < 0) continue;
    const request = scenario.requests[index];
    if (!request) continue;
    const previous = request.inputTokens;
    request.inputTokens = { low: input, high: input };
    if (!previous) continue;
    for (const future of scenario.requests.slice(index + 1)) {
      if (!future.inputTokens) continue;
      const low = Math.max(0, future.inputTokens.low + input - previous.low);
      const high = Math.max(low, future.inputTokens.high + input - previous.high);
      future.inputTokens = Number.isSafeInteger(low) && Number.isSafeInteger(high) ? { low, high } : null;
    }
  }
}
function extendScenario(scenario: PlanScenario, count: number, route: RouteIdentity): void {
  const last = scenario.requests.at(-1);
  if (!last) return;
  while (scenario.requests.length < count) {
    const index = scenario.requests.length;
    scenario.requests.push({ ...structuredClone(last), id: `request-${index + 1}`, route: { ...route, requestMode: 'unknown' }, visibleTextTokens: null, dependsOn: [`request-${index}`] });
  }
}
