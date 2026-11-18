let goalForecastRunner: ((sessionId: string) => Promise<string>) | null = null;
import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { aiPlanSchema } from '../shared/ai-plan.ts';
import type {} from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-config-editor';
import type {} from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-typert-registry';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { classifyTask } from '../shared/workload.ts';
import { importBaselines } from '../shared/baselines.ts';
import type { BaselineRecord } from '../shared/baselines.ts';
import { ALGORITHM_VERSION, PACKAGE_NAME } from '../shared/wire.ts';
import type { EstimateSnapshot, EstimatorView, ManagementAction, ManagementResult } from '../shared/wire.ts';
import { descriptors } from '../shared/remote-contract.ts';
import { retainedTimeForecast } from '../shared/retained-time.ts';
import { ObserverMetrics } from './metrics.ts';
import { observeHumanWaits } from './user-wait.ts';
import { requestEstimatorPlan, requestGoalPlan } from './estimator-model.ts';
import { ESTIMATOR_PROMPT_LIMIT } from '../shared/estimator-model.ts';
import { Config, validatePluginConfig } from './config.ts';
import type { PluginConfig } from './config.ts';
import { persistConfig } from './config-entry.ts';
import type { ConfigEditorLike, ConfigEntryLike } from './config-entry.ts';
import { initialFacts, foldFacts } from './facts.ts';
import type { FactsState } from './facts.ts';
import { Repository } from './repository.ts';
import { EstimatorEngine } from './engine.ts';

export { Config };
export const name = 'task-time-cost';
export const inject = ['agents', 'sessionProjections', 'storageDomain', 'tokenMeter', 'tools', 'typert', 'systemPrompt'];
declare module '@deepseek-ai/cordis' { interface Context { taskEstimator: TaskEstimatorService } }
declare module '@deepseek-ai/dsh-session-projection/types' { interface SessionProjectionMap { taskEstimator: { revision: number; currentTurn: number | null } } }

const factsSchema: z.ZodType<FactsState> = z.json().refine(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return 'sessionId' in value && typeof value.sessionId === 'string' && 'tasks' in value && !!value.tasks && typeof value.tasks === 'object' && 'lastSeq' in value && typeof value.lastSeq === 'number';
}, 'Invalid estimator projection checkpoint').transform(value => value as unknown as FactsState);

export class TaskEstimatorService extends TypertRemoteService {
  readonly engine: EstimatorEngine;
  readonly projection: ProjectionHandle<FactsState>;
  constructor(ctx: Context, engine: EstimatorEngine, projection: ProjectionHandle<FactsState>) {
    super(ctx, 'taskEstimator'); this.engine = engine; this.projection = projection;
  }
  /** Attach whole-session totals so the Client can show one ETA for the conversation. */
  private withSession(snapshot: EstimateSnapshot | null): EstimateSnapshot | null {
    if (!snapshot) return snapshot;
    let elapsed = 0;
    let turns = 1;
    for (const record of this.engine.repository.tasks.values()) {
      const task = record.current;
      if (task.sessionId !== snapshot.sessionId || task.turn === snapshot.turn) continue;
      turns += 1;
      elapsed += Number.isFinite(task.elapsedActiveMs) ? task.elapsedActiveMs : 0;
    }
    return { ...snapshot, sessionElapsedMs: elapsed + snapshot.elapsedActiveMs, sessionRemainingMs: snapshot.remainingMs, sessionTurns: turns };
  }
  private withRetained(snapshot: EstimateSnapshot | null): Pick<EstimatorView, 'snapshot' | 'lastForecast'> {
    if (!snapshot || ['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.state) || snapshot.remainingMs !== null) return { snapshot };
    const previous = retainedTimeForecast(snapshot, this.engine.repository.tasks.get(snapshot.taskKey));
    return previous ? { snapshot, lastForecast: previous } : { snapshot };
  }
  @Remote({ resources: { session: (sessionId: string) => sessionId as SessionId } })
  async snapshot(sessionId: string, turn: number | null, signal: AbortSignal): Promise<EstimatorView> {
    signal.throwIfAborted();
    if (typeof sessionId !== 'string' || !sessionId || (turn !== null && (!Number.isSafeInteger(turn) || turn < 0))) throw new TypeError('Invalid session or turn');
    const agent = this.ctx.agents.get(sessionId as SessionId);
    if (!agent) {
      const history = [...this.engine.repository.tasks.values()].filter(record => record.current.sessionId === sessionId && (turn === null || record.current.turn === turn)).sort((a, b) => b.savedAt - a.savedAt)[0];
      const stale = history && history.current.algorithmVersion !== ALGORITHM_VERSION;
      return { ...this.withRetained(this.withSession(history?.current ?? null)), available: this.engine.repository.available,
        error: this.engine.repository.error ?? (stale ? 'History uses an earlier estimator version. Open this session to refresh its summary from the original events.' : null) };
    }
    const state = this.projection.stateOf(agent.session);
    const target = turn ?? state.currentTurn ?? Math.max(-1, ...Object.keys(state.tasks).map(Number));
    const task = state.tasks[String(target)];
    if (!task) return { snapshot: null, available: this.engine.repository.available, error: this.engine.repository.error };
    try {
      if (state.error) this.engine.onDurable(sessionId, state, 'projection/error');
      const snapshot = this.withSession(this.engine.estimate(sessionId, task, state.lastSeq))!;
      return { ...this.withRetained(snapshot), available: this.engine.repository.available && !snapshot.error, error: snapshot.error ?? this.engine.repository.error };
    } catch (error) {
      this.engine.observerFailed(sessionId, task.turn, error);
      return { snapshot: null, available: false, error: 'Estimation failed. The original task is unaffected; see plugin diagnostics.' };
    }
  }
  @Remote
  async manage(action: ManagementAction, payload: string, signal: AbortSignal): Promise<ManagementResult> {
    signal.throwIfAborted();
    if (this.ctx.invocation && this.ctx.invocation.peer.principal.kind !== 'owner') return { ok: false, message: 'Only the local owner can manage estimator data.' };
    if (typeof payload !== 'string' || payload.length > 2_000_000) return { ok: false, message: 'Payload must be a string of at most 2 MB.' };
    const repository = this.engine.repository;
    try {
      if (action === 'read') return { ok: true, message: '', data: this.engine.view() };
      if (action === 'export') {
        await repository.flush();
        const tasks = [...repository.tasks.values()];
        return { ok: true, message: 'Export contains local statistics only; no prompts or credentials.', exported: JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), algorithmVersion: ALGORITHM_VERSION,
          historyDerivation: { pendingTasks: tasks.filter(task => task.current.algorithmVersion !== ALGORITHM_VERSION).length,
            note: 'algorithmVersion identifies the exporter. Each snapshot retains its own algorithmVersion; summaries from earlier versions refresh when the original session events are loaded. Initial forecasts and historical price resolutions are retained.' },
          config: this.engine.config, baselines: this.engine.baselines, resetAt: repository.resetAt, calls: [...repository.calls.values()], tasks }, null, 2) };
      }
      if (!repository.available) return { ok: false, message: repository.error ?? 'Local storage is unavailable.' };
      if (action === 'saveConfig') {
        const config = validatePluginConfig(JSON.parse(payload));
        const editor = this.ctx.get('configEditor') as ConfigEditorLike | undefined;
        if (!editor) return { ok: false, message: 'Configuration cannot be saved in this profile: configEditor is unavailable.' };
        await persistConfig(editor, this.ctx.fiber.entry as ConfigEntryLike | undefined, config as unknown as Record<string, unknown>,
          value => validatePluginConfig(value) as unknown as Record<string, unknown>);
        return { ok: true, message: 'Configuration saved. The plugin reloads through the DSH lifecycle.' };
      }
      if (action === 'estimatorModel') {
        const patch = z.object({ enabled: z.boolean() }).strict().parse(JSON.parse(payload));
        const config = validatePluginConfig({ ...this.engine.config, estimatorModel: { ...this.engine.config.estimatorModel, ...patch } });
        const editor = this.ctx.get('configEditor') as ConfigEditorLike | undefined;
        if (!editor) return { ok: false, message: 'Configuration cannot be saved in this profile: configEditor is unavailable.' };
        await persistConfig(editor, this.ctx.fiber.entry as ConfigEntryLike | undefined, config as unknown as Record<string, unknown>,
          value => validatePluginConfig(value) as unknown as Record<string, unknown>);
        return { ok: true, message: patch.enabled ? 'Model estimate on. It follows this session route.' : 'Model estimate off. The template forecast stays.' };
      }
      if (action === 'goalForecast') {
        if (!goalForecastRunner) return { ok: false, message: 'The estimator is still starting.' };
        const outcome = await goalForecastRunner(payload.trim());
        const message = outcome === 'ok' ? 'Goal estimate updated.'
          : outcome === 'no-objective' ? 'The goal text is not available yet.'
          : outcome === 'no-model' ? 'The model did not answer; check the session route.'
          : outcome === 'busy' ? 'An estimate is already running.' : 'Goal estimate failed.';
        return { ok: outcome === 'ok', message };
      }
      if (action === 'resetCalibration') {
        await repository.resetCalibration();
        if (!repository.available) return { ok: false, message: repository.error ?? 'Calibration reset could not be saved.' };
        this.engine.rebuildCalibration();
        return { ok: true, message: 'Local performance and workload calibration reset. History, configuration and DSH sessions were retained.', data: this.engine.view() };
      }
      if (action === 'importBaselines') {
        const format = /^[\s\uFEFF]*[\[{]/.test(payload) ? 'json' : 'csv';
        const imported = importBaselines(payload, format, this.engine.baselines);
        const serialized = JSON.stringify({ schemaVersion: 1, records: imported.records });
        await repository.saveBaselineImport(serialized);
        if (!repository.available) return { ok: false, message: repository.error ?? 'Baseline import could not be saved.' };
        this.engine.updateBaselines(imported.records);
        return { ok: true, message: `Imported ${imported.imported} baseline records.`, data: this.engine.view() };
      }
      return { ok: false, message: 'Unknown management action.' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Validation errors refer to package-owned fields, never model request bodies.
      return { ok: false, message };
    }
  }
}

export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  const config: PluginConfig = validatePluginConfig(rawConfig);
  const metrics = new ObserverMetrics();
  const repository = new Repository(message => ctx.logger.warn(message));
  await repository.open(ctx.storageDomain);
  let baselines: BaselineRecord[] = [];
  try {
    const text = repository.baselineImport ?? await readFile(new URL('../data/baselines.json', import.meta.url), 'utf8');
    baselines = importBaselines(text, 'json').records;
  } catch (error) { repository.diagnose('baseline-load', 'Baseline data unavailable; engineering defaults remain active.'); ctx.logger.warn(error); }
  const engine = new EstimatorEngine(config, repository, baselines);
  const definition = {
    key: 'taskEstimator', stateVersion: 5, stateSchema: factsSchema,
    init: initialFacts,
    apply(state, event) {
      try { return foldFacts(state, event, prompt => classifyTask({ prompt, currentInputTokens: null }, config.classificationRules).kind); }
      catch (error) {
        repository.diagnose('projection-fold', 'A session observation could not be folded; this estimate is unavailable.');
        return { ...state, lastSeq: event.seq, error: 'projection-fold-failed', view: { revision: event.seq, currentTurn: state.currentTurn } };
      }
    },
    wire: { summary: false, viewSchema: z.object({ revision: z.number().int(), currentTurn: z.number().int().nullable() }), view: state => state.view },
  } satisfies ProjectionDefinition<'taskEstimator', FactsState>;
  const projection = await ctx.sessionProjections.register(definition);
  const service = new TaskEstimatorService(ctx, engine, projection);
  ctx.typert.register({ package: PACKAGE_NAME, face: 'host', schemas: [], invocations: descriptors,
    model: { services: [{ key: 'taskEstimator', exportName: 'TaskEstimatorService', tags: [], members: [
      { kind: 'method', name: 'snapshot', signature: 'async snapshot(sessionId: string, turn: number | null, signal: AbortSignal): Promise<EstimatorView>' },
      { kind: 'method', name: 'manage', signature: 'async manage(action: ManagementAction, payload: string, signal: AbortSignal): Promise<ManagementResult>' },
    ], types: [] }], events: [], objects: [] } });

  function safe(agent: Agent | undefined, operation: () => void): void {
    const started = performance.now();
    try { operation(); }
    catch (error) {
      if (agent) { const boundary = ctx.agents.turnBoundaryOf(agent.session); engine.observerFailed(agent.id, boundary.lastTurn, error); }
      else repository.diagnose('observer-failed', 'An estimator observer failed; the original operation continues.');
    } finally { metrics.record('observer', performance.now() - started); }
  }
  function checkpoint(agent: Agent): void {
    const state = projection.stateOf(agent.session);
    const task = state.currentTurn === null ? Object.values(state.tasks).at(-1) : state.tasks[String(state.currentTurn)];
    if (task) engine.persist(agent.id, task, state.lastSeq);
  }
  // The optional second-model estimator: the task text lives only in this map
  // and is never written to storage; only accepted numbers reach the engine.
  const taskTexts = new Map<string, string>();
  const estimatorRequested = new Set<string>();
  const estimatorTimers = new Set<ReturnType<typeof setTimeout>>();
  const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Goal objective text, kept in memory only: it is never written to storage. */
  /** DSH owns the goal; asking it beats caching the objective ourselves. */
  interface GoalServiceLike { get(agent: unknown): { objective?: string; phase?: string; roundsStarted?: number; maxGoalRounds?: number } | undefined }
  const goalTexts = new Map<string, string>();
  const goalForecastInFlight = new Set<string>();
  function readUserText(data: unknown): string | null {
    if (!data || typeof data !== 'object' || !('content' in data)) return null;
    const content = (data as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const candidate = block as { type?: unknown; text?: unknown };
      if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text);
    }
    const joined = parts.join('\n').trim();
    return joined ? joined.slice(0, ESTIMATOR_PROMPT_LIMIT) : null;
  }
  /**
   * A plan can run out mid-turn (the agent did more rounds than it predicted),
   * and then nothing estimates the rest. Every few minutes, while the turn is
   * still running and no estimate exists, ask the model once what remains.
   * Turns that started before this plugin mounted are picked up on the first
   * event instead of being left without an estimate forever.
   */
  function attemptRefresh(session: Session, turn: number): void {
    const state = projection.stateOf(session);
    const task = state.tasks[String(turn)];
    if (!task || task.endedAt !== null) return;
    let snapshot: ReturnType<typeof engine.estimate> | null = null;
    try { snapshot = engine.estimate(session.id, task, state.view.revision ?? 0); } catch { snapshot = null; }
    if (!snapshot || snapshot.remainingMs || snapshot.elapsedActiveMs < 5 * 60_000) return;
    if (!engine.needsRefresh(session.id, turn)) return;
    const text = taskTexts.get(session.id);
    if (!text) return;
    const avgRound = snapshot.elapsedActiveMs / Math.max(1, snapshot.calls.completed);
    engine.markRefreshAttempt(session.id, turn);
    void (async () => {
      const plan = await requestEstimatorPlan(ctx, config.estimatorModel,
        { providerId: task.route?.providerId ?? null, modelId: task.route?.modelId ?? null }, text,
        { elapsedMs: snapshot!.elapsedActiveMs, completedCalls: snapshot!.calls.completed, refresh: true });
      if (!plan) return;
      const low = plan.remainingCalls.low * avgRound * 0.6 + plan.remainingToolSeconds.low * 1_000;
      const high = plan.remainingCalls.high * avgRound * 1.8 + plan.remainingToolSeconds.high * 1_000;
      engine.setRefreshedRemaining(session.id, turn, { low: Math.max(60_000, low), high: Math.max(120_000, high) });
    })().catch(() => undefined);
  }
  function observeGoalObjective(event: { type: string; data: unknown }): void {
    if (event.type !== 'goal/change') return;
    const data = event.data as { operation?: string; goal?: { id?: string; objective?: string } } | null;
    if (!data || typeof data !== 'object') return;
    if (data.operation === 'clear') { goalTexts.clear(); return; }
    const id = data.goal?.id;
    const objective = data.goal?.objective;
    if (typeof id === 'string' && typeof objective === 'string' && objective.trim()) goalTexts.set(id, objective.trim());
  }

  async function attemptGoalForecast(session: Session, force = false): Promise<'ok' | 'no-objective' | 'no-model' | 'failed' | 'busy'> {
    const state = projection.stateOf(session);
    const goal = state.goal;
    if (!goal || goal.phase !== 'active') return 'no-objective';
    let live: { objective?: string; phase?: string; roundsStarted?: number; maxGoalRounds?: number } | undefined;
    try {
      const agent = ctx.agents.get(session.id);
      const candidate = [ctx, (ctx as unknown as { root?: unknown }).root, agent?.ctx]
        .find(scope => scope && typeof (scope as { get?: unknown }).get === 'function');
      const service = (candidate as { get: (name: string) => unknown } | undefined)?.get('goals') as GoalServiceLike | undefined;
      if (agent && service && typeof service.get === 'function') live = service.get(agent);
    } catch { live = undefined; }
    if (live && live.phase && live.phase !== 'active') return 'no-objective';
    const objective = live?.objective ?? goalTexts.get(goal.id);
    const text = objective?.trim();
    if (!text) { engine.setGoalForecastState(goal.id, 'no-objective'); return 'no-objective'; }
    if (goalForecastInFlight.has(goal.id) && !force) return 'busy';
    const rounds = Object.values(state.tasks).filter(task => task.goalId === goal.id);
    const finished = rounds.filter(task => task.endedAt !== null);
    const startedRounds = Math.max(finished.length, typeof live?.roundsStarted === 'number' ? live.roundsStarted : 0);
    if (startedRounds === 0) return 'no-objective';
    const now = Date.now();
    const elapsedMs = rounds.reduce((sum, task) => sum + Math.max(0, (task.endedAt ?? now) - task.startedAt), 0);
    const toolsDone = rounds.reduce((sum, task) => sum + Object.keys(task.tools).length, 0);
    goalForecastInFlight.add(goal.id);
    try {
      const plan = await requestGoalPlan(ctx, config.estimatorModel,
        { providerId: finished[finished.length - 1]?.route?.providerId ?? null, modelId: finished[finished.length - 1]?.route?.modelId ?? null },
        text, { elapsedMs, roundsDone: startedRounds, toolsDone, previous: engine.goalForecastOf(goal.id) });
      if (!plan) { engine.setGoalForecastState(goal.id, 'no-model'); return 'no-model'; }
      engine.setGoalForecast(goal.id, plan.lowMs, plan.highMs);
      engine.setGoalForecastState(goal.id, 'ok');
      return 'ok';
    } catch { engine.setGoalForecastState(goal.id, 'failed'); return 'failed'; }
    finally { goalForecastInFlight.delete(goal.id); }
  }

  function startRefreshLoop(session: Session, turn: number): void {
    const key = `${session.id}:${turn}`;
    if (refreshTimers.has(key)) return;
    const tick = () => {
      refreshTimers.delete(key);
      const state = projection.stateOf(session);
      const task = state.tasks[String(turn)];
      if (!task || task.endedAt !== null) return;
      attemptRefresh(session, turn);
      refreshTimers.set(key, setTimeout(tick, 5 * 60_000));
    };
    refreshTimers.set(key, setTimeout(tick, 5 * 60_000));
  }
  function observeRunningTurn(session: Session): void {
    const state = projection.stateOf(session);
    const turn = state.currentTurn;
    if (turn === null) return;
    const task = state.tasks[String(turn)];
    if (!task || task.endedAt !== null) return;
    const key = `${session.id}:${turn}`;
    if (refreshTimers.has(key)) return;
    startRefreshLoop(session, turn);
    // Adopt turns that began before this plugin mounted: try right away.
    attemptRefresh(session, turn);
  }
  function observeEstimatorInput(session: Session, event: { type: string; data: unknown }): void {
    if (event.type === 'user/message') {
      const text = readUserText(event.data);
      if (text) taskTexts.set(session.id, text);
      return;
    }
    if (event.type !== 'turn/start') return;
    const turn = (event.data as { turn?: unknown }).turn;
    if (typeof turn !== 'number') return;
    const key = `${session.id}:${turn}`;
    const text = taskTexts.get(session.id);
    if (!text || estimatorRequested.has(key)) return;
    estimatorRequested.add(key);
    const timer = setTimeout(() => {
      estimatorTimers.delete(timer);
      void (async () => {
        const state = projection.stateOf(session);
        const task = state.tasks[String(turn)];
        // The executing agent's own plan wins; never call the model when one exists.
        if (!task || task.aiPlan || task.calls.length < 1) return;
        // A task that will finish in a couple of minutes does not deserve a
        // second model call; only long or still-unknown work asks the model.
        let highMs: number | null = null;
        try { highMs = engine.estimate(session.id, task, state.view.revision ?? 0).estimatedTotalMs?.high ?? null; } catch { highMs = null; }
        // A template can badly underestimate a large task, so the size gate also
        // looks at what is visible about the work itself: a long prompt or a
        // goal/program scope gets an estimate even when the early forecast is small.
        const scaleSignal = (task.promptChars ?? 0) >= 1_200 || (task.workloadScale !== undefined && task.workloadScale !== 'task');
        if (highMs !== null && highMs < config.estimatorModel.minHighMs && !scaleSignal) return;
        const plan = await requestEstimatorPlan(ctx, config.estimatorModel,
          { providerId: task.route?.providerId ?? null, modelId: task.route?.modelId ?? null }, text);
        if (plan) engine.setEstimatorPlan(session.id, turn, plan);
      })().catch(() => undefined);
    }, config.estimatorModel.delayMs);
    estimatorTimers.add(timer);
    startRefreshLoop(session, turn);
  }
  goalForecastRunner = async (sessionId: string) => {
    const agent = sessionId ? ctx.agents.get(sessionId as Parameters<typeof ctx.agents.get>[0]) : undefined;
    if (!agent) return 'no-objective';
    return attemptGoalForecast(agent.session, true);
  };
  ctx.effect(() => () => { for (const timer of estimatorTimers) clearTimeout(timer); estimatorTimers.clear(); for (const timer of refreshTimers.values()) clearTimeout(timer); refreshTimers.clear(); taskTexts.clear(); estimatorRequested.clear(); goalTexts.clear(); goalForecastInFlight.clear(); });
  ctx.on('session/event', (session, event) => {
    if (config.estimatorModel.enabled) observeEstimatorInput(session, event);
    observeGoalObjective(event);
    // A finished round is the natural moment to re-ask how much of the goal is left.
    if (config.estimatorModel.enabled && (event.type === 'turn/end' || event.type === 'turn/start')) {
      setTimeout(() => { void attemptGoalForecast(session); }, event.type === 'turn/end' ? 2_000 : 20_000);
    }
    if (config.estimatorModel.enabled && !refreshTimers.has(`${session.id}:${projection.stateOf(session).currentTurn ?? ''}`)) observeRunningTurn(session);
    const agent = ctx.agents.get(session.id);
    safe(agent, () => {
      const state = projection.stateOf(session);
      engine.onDurable(session.id, state, event.type);
      // Persist at semantic checkpoints, never per streamed character.
      if (['turn/start', 'turn/end', 'assistant/message', 'assistant/attempt', 'tool/result', 'user/message', 'model/selection'].includes(event.type) && agent) checkpoint(agent);
      if (event.type === 'turn/end') void repository.prune(config);
    });
  });
  ctx.on('agent/assistant-stream', ({ agent, frame }) => safe(agent, () => {
    const state = projection.stateOf(agent.session);
    if (frame.type === 'start') {
      try { engine.setInput(agent.id, frame.turn, ctx.tokenMeter.measure(agent.session).totalTokens); }
      catch { engine.setInput(agent.id, frame.turn, null); }
    }
    engine.onStream(agent.id, frame, state);
    if (frame.type === 'end') checkpoint(agent);
  }));
  ctx.on('tools/execute', async (exec, next) => {
    const started = performance.now();
    let ticket: ReturnType<typeof engine.runtime.beginTool> | undefined;
    if (exec.agent && !exec.parent) safe(exec.agent, () => { const boundary = ctx.agents.turnBoundaryOf(exec.agent!.session); ticket = engine.runtime.beginTool(exec.agent!.id, boundary.lastTurn, exec.callId); });
    const entered = performance.now();
    try { return await next(); }
    finally {
      const returned = performance.now();
      if (ticket) safe(exec.agent, () => { engine.runtime.endTool(ticket!); engine.invalidate(ticket!.sessionId, ticket!.turn); });
      metrics.record('tool-dispatch-extra', entered - started + performance.now() - returned);
    }
  });
  observeHumanWaits(ctx, agent => {
    let resume = () => {};
    safe(agent, () => {
      const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn, release = engine.runtime.pause(agent.id, turn);
      engine.invalidate(agent.id, turn); checkpoint(agent);
      resume = () => safe(agent, () => { release(); engine.invalidate(agent.id, turn); checkpoint(agent); });
    });
    return resume;
  });
  ctx.on('session/flush', async () => {
    const started = performance.now();
    try { await repository.flush(); } finally { metrics.record('flush', performance.now() - started); }
  });
  ctx.on('agent/disposed', ({ agent }) => { safe(agent, () => checkpoint(agent)); engine.cleanupSession(agent.id); });
  ctx.tools.register({
    name: 'task_estimator', description: 'Read task time/cost estimates or manage this plugin’s local configuration, calibration, and JSON/CSV baselines. Export returns redacted statistics. Reset preserves history and DSH sessions.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['snapshot', 'read', 'saveConfig', 'estimatorModel', 'export', 'resetCalibration', 'importBaselines'] },
      turn: { type: 'integer', minimum: 0, description: 'Completed turn number; omit for the current or latest turn.' },
      payload: { type: 'string', description: 'Full JSON config for saveConfig, JSON/CSV contents for importBaselines; omit for other actions.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
      const text = JSON.stringify(value, null, 2);
      return [{ type: 'text', text }];
    } },
    async execute(args, exec) {
      const input = z.object({ action: z.enum(['snapshot', 'read', 'saveConfig', 'estimatorModel', 'export', 'resetCalibration', 'importBaselines', 'goalForecast']), turn: z.number().int().nonnegative().optional(), payload: z.string().max(2_000_000).optional() }).strict().parse(args);
      if (input.action === 'snapshot') {
        if (!exec.agent) return { available: false, snapshot: null, error: 'A session is required.' };
        const started = performance.now();
        const view = await service.snapshot(exec.agent.id, input.turn ?? null, exec.signal);
        metrics.record('snapshot', performance.now() - started);
        return { ...view, observerOverhead: metrics.snapshot() };
      }
      if (input.action === 'goalForecast') {
        if (!exec.agent) return { ok: false, message: 'A session is required.' };
        const outcome = await attemptGoalForecast(exec.agent.session, true);
        const message = outcome === 'ok' ? 'Goal estimate updated.'
          : outcome === 'no-objective' ? 'The goal text is not available yet.'
          : outcome === 'no-model' ? 'The model did not answer; check the session route.'
          : outcome === 'busy' ? 'An estimate is already running.' : 'Goal estimate failed.';
        return { ok: outcome === 'ok', message };
      }
      return await service.manage(input.action, input.payload ?? '', exec.signal);
    },
  });
  ctx.tools.register({
    name: 'task_estimate_plan',
    description: 'Update the current task ETA from your assessment of the work still needed. Submit after understanding a multi-step task, and revise when its scope or remaining work materially changes. The Host combines the plan with this route’s observed response times. These are reference estimates, not completion promises.',
    parameters: { type: 'object', properties: {
      remainingCalls: { type: 'object', description: 'Future model response rounds after this reporting call, including final answer and verification; 1–500. Count one response containing many tool calls as ONE model request, not one per tool or file. Reuse the observed work pattern to bound remaining rounds.', properties: { low: { type: 'integer', minimum: 1, maximum: 500 }, high: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['low', 'high'], additionalProperties: false },
      remainingOutputTokens: { type: 'object', description: 'Total future visible text/tool-argument tokens, excluding hidden reasoning; ordered bounds, 0–2000000.', properties: { low: { type: 'integer', minimum: 0, maximum: 2000000 }, high: { type: 'integer', minimum: 0, maximum: 2000000 } }, required: ['low', 'high'], additionalProperties: false },
      remainingToolSeconds: { type: 'object', description: 'Future tool execution time, excluding model requests and human waits; ordered bounds, 0–86400 seconds.', properties: { low: { type: 'integer', minimum: 0, maximum: 86400 }, high: { type: 'integer', minimum: 0, maximum: 86400 } }, required: ['low', 'high'], additionalProperties: false },
      stage: { type: 'string', enum: ['planning', 'implementation', 'verification', 'finishing'] },
      scope: { type: 'string', enum: ['current_turn', 'whole_goal'], description: 'Use whole_goal for the complete active objective, including future goal rounds and acceptance. A current_turn plan cannot represent an entire Goal.' },
    }, required: ['remainingCalls', 'remainingOutputTokens', 'remainingToolSeconds', 'stage'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!exec.agent || exec.signal.aborted) throw new Error('An active task is required.');
      const state = projection.stateOf(exec.agent.session);
      if (state.currentTurn === null || !state.tasks[String(state.currentTurn)] || state.tasks[String(state.currentTurn)].endedAt !== null) throw new Error('An active task is required.');
      return { kind: 'task-estimate-plan', version: 1, plan: aiPlanSchema.parse(args) };
    },
  });
  ctx.systemPrompt.section({ name: 'task-estimate-planning', order: 1_000,
    text: 'For a multi-step user task, submit task_estimate_plan as your first work tool, before exploration or delegation and before the first substantive reply, so the panel can show a planned estimate instead of a reference prior. For an active Goal, set scope to whole_goal and estimate all remaining deliverables, integrations and acceptance across goal rounds; do not estimate just the next planning step or response. Complete multi-app systems require substantial work even on fast models. For ordinary tasks use current_turn. Include implementation, verification and delivery. Revise it whenever a new human message arrives during an active multi-step task, when scope or remaining work materially changes, or when the budget is exceeded. A follow-up invalidates the old plan; promptly assess all outstanding implementation, verification and delivery instead of forecasting only the next action. Count work remaining after the reporting call. Count model response rounds, not individual tools, files, commands or parallel calls; one model response can contain many tools. Estimate tool wall time on the critical path, not the sum of parallel execution times. Prefer concrete bounds for the known scope and revise when evidence changes; do not add speculative optional work. Use task_estimator snapshot route timings when useful; never invent measured performance or treat call count as percentage complete. Skip planning for trivial answers. This uses the executing agent; do not start another model request just to estimate or poll.' });
  // Existing sessions are folded once on demand by the projection owner. No log rescans per frame.
  for (const agent of ctx.agents.list()) safe(agent, () => { projection.stateOf(agent.session); engine.runtime.task(agent.id, ctx.agents.turnBoundaryOf(agent.session).lastTurn); });
  ctx.effect(() => async () => {
    for (const agent of ctx.agents.list()) safe(agent, () => checkpoint(agent));
    engine.dispose(); await repository.close();
  });
}
