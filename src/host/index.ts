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
  const repository = new Repository(message => ctx.logger.warn(message));
  await repository.open(ctx.storageDomain);
  let baselines: BaselineRecord[] = [];
  try {
    const text = repository.baselineImport ?? await readFile(new URL('../data/baselines.json', import.meta.url), 'utf8');
    baselines = importBaselines(text, 'json').records;
  } catch (error) { repository.diagnose('baseline-load', 'Baseline data unavailable; engineering defaults remain active.'); ctx.logger.warn(error); }
  const engine = new EstimatorEngine(config, repository, baselines);
  const definition = {
    key: 'taskEstimator', stateVersion: 3, stateSchema: factsSchema,
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
    try { operation(); }
    catch (error) {
      if (agent) { const boundary = ctx.agents.turnBoundaryOf(agent.session); engine.observerFailed(agent.id, boundary.lastTurn, error); }
      else repository.diagnose('observer-failed', 'An estimator observer failed; the original operation continues.');
    }
  }
  function checkpoint(agent: Agent): void {
    const state = projection.stateOf(agent.session);
    const task = state.currentTurn === null ? Object.values(state.tasks).at(-1) : state.tasks[String(state.currentTurn)];
    if (task) engine.persist(agent.id, task, state.lastSeq);
  }
  ctx.on('session/event', (session, event) => {
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
    let ticket: ReturnType<typeof engine.runtime.beginTool> | undefined;
    if (exec.agent && !exec.parent) safe(exec.agent, () => { const boundary = ctx.agents.turnBoundaryOf(exec.agent!.session); ticket = engine.runtime.beginTool(exec.agent!.id, boundary.lastTurn, exec.callId); });
    try { return await next(); }
    finally { if (ticket) safe(exec.agent, () => { engine.runtime.endTool(ticket!); engine.invalidate(ticket!.sessionId, ticket!.turn); }); }
  });
  ctx.on('user-questions/request', async (request, next) => {
    const agent = request.agent;
    let resume: (() => void) | undefined;
    if (agent) safe(agent, () => { const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn; resume = engine.runtime.pause(agent.id, turn); engine.invalidate(agent.id, turn); checkpoint(agent); });
    try { return await next(); }
    finally { if (resume) safe(agent, () => { resume!(); if (agent) { engine.invalidate(agent.id, ctx.agents.turnBoundaryOf(agent.session).lastTurn); checkpoint(agent); } }); }
  });
  ctx.on('approval/request', async (request, next) => {
    let resume: (() => void) | undefined;
    safe(request.agent, () => { const turn = ctx.agents.turnBoundaryOf(request.agent.session).lastTurn; resume = engine.runtime.pause(request.agent.id, turn); engine.invalidate(request.agent.id, turn); checkpoint(request.agent); });
    try { return await next(); }
    finally { if (resume) safe(request.agent, () => { resume!(); engine.invalidate(request.agent.id, ctx.agents.turnBoundaryOf(request.agent.session).lastTurn); checkpoint(request.agent); }); }
  });
  ctx.on('session/flush', async () => { await repository.flush(); });
  ctx.on('agent/disposed', ({ agent }) => { safe(agent, () => checkpoint(agent)); engine.cleanupSession(agent.id); });
  ctx.tools.register({
    name: 'task_estimator', description: 'Read task time/cost estimates or manage this plugin’s local configuration, calibration, and JSON/CSV baselines. Export returns redacted statistics. Reset preserves history and DSH sessions.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['snapshot', 'read', 'saveConfig', 'export', 'resetCalibration', 'importBaselines'] },
      turn: { type: 'integer', minimum: 0, description: 'Completed turn number; omit for the current or latest turn.' },
      payload: { type: 'string', description: 'Full JSON config for saveConfig, JSON/CSV contents for importBaselines; omit for other actions.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
      const text = JSON.stringify(value, null, 2);
      return [{ type: 'text', text }];
    } },
    async execute(args, exec) {
      const input = z.object({ action: z.enum(['snapshot', 'read', 'saveConfig', 'export', 'resetCalibration', 'importBaselines']), turn: z.number().int().nonnegative().optional(), payload: z.string().max(2_000_000).optional() }).strict().parse(args);
      if (input.action === 'snapshot') {
        if (!exec.agent) return { available: false, snapshot: null, error: 'A session is required.' };
        return await service.snapshot(exec.agent.id, input.turn ?? null, exec.signal);
      }
      return await service.manage(input.action, input.payload ?? '', exec.signal);
    },
  });
  ctx.tools.register({
    name: 'task_estimate_plan',
    description: 'Update the current task ETA from your assessment of the work still needed. Submit after understanding a multi-step task, and revise when its scope or remaining work materially changes. The Host combines the plan with this route’s observed response times. These are reference estimates, not completion promises.',
    parameters: { type: 'object', properties: {
      remainingCalls: { type: 'object', description: 'Future model requests after this reporting call, including final answer and verification; ordered integer bounds, 1–500.', properties: { low: { type: 'integer', minimum: 1, maximum: 500 }, high: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['low', 'high'], additionalProperties: false },
      remainingOutputTokens: { type: 'object', description: 'Total future visible text/tool-argument tokens, excluding hidden reasoning; ordered bounds, 0–2000000.', properties: { low: { type: 'integer', minimum: 0, maximum: 2000000 }, high: { type: 'integer', minimum: 0, maximum: 2000000 } }, required: ['low', 'high'], additionalProperties: false },
      remainingToolSeconds: { type: 'object', description: 'Future tool execution time, excluding model requests and human waits; ordered bounds, 0–86400 seconds.', properties: { low: { type: 'integer', minimum: 0, maximum: 86400 }, high: { type: 'integer', minimum: 0, maximum: 86400 } }, required: ['low', 'high'], additionalProperties: false },
      stage: { type: 'string', enum: ['planning', 'implementation', 'verification', 'finishing'] },
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
    text: 'For a multi-step user task, submit a task_estimate_plan after understanding the scope, preferably alongside your initial work tools. Include implementation, verification and delivery. Revise it only when scope or remaining work materially changes or the budget is exceeded. Count work remaining after the reporting call. Use task_estimator snapshot route timings when useful; never invent measured performance or treat call count as percentage complete. Skip planning for trivial answers. This uses the executing agent; do not start another model request just to estimate or poll.' });
  // Existing sessions are folded once on demand by the projection owner. No log rescans per frame.
  for (const agent of ctx.agents.list()) safe(agent, () => { projection.stateOf(agent.session); engine.runtime.task(agent.id, ctx.agents.turnBoundaryOf(agent.session).lastTurn); });
  ctx.effect(() => async () => {
    for (const agent of ctx.agents.list()) safe(agent, () => checkpoint(agent));
    engine.dispose(); await repository.close();
  });
}
