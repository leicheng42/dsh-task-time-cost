import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-goal';
import { inferWorkloadScale, mergeWorkloadScale } from '../shared/scope.ts';
import type { WorkloadScale } from '../shared/scope.ts';
import type { AssistantStreamRecord, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { TaskState } from '../shared/wire.ts';
import type { TaskKind, RequestMode } from '../shared/types.ts';
import type { RawUsage } from '../shared/usage.ts';
import { readAiPlanResult } from '../shared/ai-plan.ts';
import type { AiPlan } from '../shared/ai-plan.ts';

export interface RouteFact { providerId: string; modelId: string; reasoningEffort: string }
export interface StreamStats {
  firstContentAt: number | null; firstTextAt: number | null; lastContentAt: number | null;
  textChars: number; reasoningChars: number; toolChars: number; textDeltas: number;
  usage: RawUsage | null; finish: string | null;
}
export interface CallFact extends StreamStats {
  id: string; seq: number; turn: number; step: number;
  startedAt: number; endedAt: number; route: RouteFact; mode: RequestMode;
  outcome: 'completed' | 'failed' | 'cancelled' | 'truncated' | 'interrupted';
  timingSource: 'step-boundary' | 'live-attempt';
}
export interface ToolFact { id: string; name: string; startedAt: number; endedAt: number | null; failed: boolean }
export interface TaskFact {
  turn: number; startSeq: number; startedAt: number; endedAt: number | null; lastAt: number;
  state: TaskState; taskType: TaskKind; promptChars: number; attachmentCount: number;
  explicitOutputWords: number | null; userMessages: number; scopeChanged: boolean;
  step: number; stepStartedAt: number; route: RouteFact | null;
  calls: CallFact[]; tools: Record<string, ToolFact>;
  workloadScale?: WorkloadScale;
  goalId?: string; goalHasPriorWork?: boolean; goalRounds?: { started: number; max: number };
  aiPlan?: AiPlan;
}
type PromptFeatures = Pick<TaskFact, 'taskType' | 'promptChars' | 'attachmentCount' | 'explicitOutputWords' | 'userMessages' | 'workloadScale'>;
export interface FactsState {
  sessionId: string; inheritedEventCount: number; lastSeq: number; currentTurn: number | null;
  pendingPrompt: PromptFeatures | null;
  goal?: { id: string; phase: string; features: PromptFeatures; scopeSeq?: number; maxRounds?: number; rounds?: number } | null;
  route: RouteFact | null; tasks: Record<string, TaskFact>;
  view: { revision: number; currentTurn: number | null };
  error: string | null;
}
export type Classifier = (prompt: string) => TaskKind;

export function initialFacts(header: SessionHeader, inheritedEventCount: number): FactsState {
  return { sessionId: header.id, inheritedEventCount, lastSeq: -1, currentTurn: null, pendingPrompt: null, route: null, tasks: {}, view: { revision: -1, currentTurn: null }, error: null };
}
export function emptyStreamStats(): StreamStats {
  return { firstContentAt: null, firstTextAt: null, lastContentAt: null, textChars: 0, reasoningChars: 0, toolChars: 0, textDeltas: 0, usage: null, finish: null };
}
export function rawDshUsage(usage: TokenUsage): RawUsage {
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}) };
}
/** Counts metadata only; model text and tool arguments are never retained. */
export function observeChunk(previous: StreamStats, chunk: StreamChunk, at: number): StreamStats {
  const next = { ...previous };
  if (chunk.type === 'text-delta' && chunk.text) {
    next.firstContentAt ??= at; next.firstTextAt ??= at; next.lastContentAt = at;
    next.textChars += chunk.text.length; next.textDeltas++;
  } else if (chunk.type === 'reasoning-delta' && chunk.text) {
    next.firstContentAt ??= at; next.lastContentAt = at; next.reasoningChars += chunk.text.length;
  } else if (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta || chunk.name)) {
    next.firstContentAt ??= at; next.lastContentAt = at; next.toolChars += chunk.argumentsDelta.length;
  } else if (chunk.type === 'usage') next.usage = rawDshUsage(chunk.usage);
  else if (chunk.type === 'finish') next.finish = chunk.reason.kind;
  return next;
}
export function durableStreamStats(stream: readonly AssistantStreamRecord[]): StreamStats {
  let stats = emptyStreamStats();
  for (const record of stream) {
    if (record.type === 'chunk') { stats = observeChunk(stats, record.chunk, record.time); continue; }
    const values = record.type === 'tool-call-chunks' ? record.args : record.texts;
    let time = record.time0;
    for (let i = 0; i < values.length; i++) {
      if (i) time += record.dt[i - 1];
      if (record.type === 'text-chunks') stats = observeChunk(stats, { type: 'text-delta', index: record.index, text: values[i] }, time);
      else if (record.type === 'reasoning-chunks') stats = observeChunk(stats, { type: 'reasoning-delta', index: record.index, text: values[i] }, time);
      else stats = observeChunk(stats, { type: 'tool-call-delta', index: record.index, id: record.id, argumentsDelta: values[i], ...(record.name ? { name: record.name } : {}) }, time);
    }
  }
  return stats;
}
export function streamMode(stats: StreamStats): RequestMode {
  return stats.toolChars > 0 ? stats.textChars > 0 ? 'mixed' : 'tool' : stats.textChars > 0 ? 'text' : 'unknown';
}
export function turnEndState(kind: string): TaskState {
  if (kind === 'completed') return 'completed';
  if (kind === 'aborted') return 'cancelled';
  if (kind === 'interrupted' || kind === 'forked') return 'interrupted';
  return 'failed';
}

function mergePrompt(previous: PromptFeatures | null, incoming: PromptFeatures): PromptFeatures {
  const workloadScale = mergeWorkloadScale(previous?.workloadScale, incoming.workloadScale);
  return { workloadScale, taskType: workloadScale !== 'task' ? 'code' : incoming.taskType === 'unknown' ? previous?.taskType ?? 'unknown' : incoming.taskType,
    promptChars: (previous?.promptChars ?? 0) + incoming.promptChars,
    attachmentCount: (previous?.attachmentCount ?? 0) + incoming.attachmentCount,
    explicitOutputWords: incoming.explicitOutputWords ?? previous?.explicitOutputWords ?? null,
    userMessages: (previous?.userMessages ?? 0) + incoming.userMessages };
}

/** Pure incremental projection. Ignored events keep reference identity. */
export function foldFacts(state: FactsState, event: SessionEvent, classify: Classifier): FactsState {
  if (event.seq <= state.lastSeq || event.seq < state.inheritedEventCount) return state;
  const kind = event.type;
  const interested = ['goal/change', 'turn/start', 'turn/end', 'step/start', 'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'request/header', 'model/selection'];
  if (!interested.includes(kind)) return state;
  let next: FactsState = { ...state, tasks: { ...state.tasks }, lastSeq: event.seq };
  if (event.type === 'request/header' || event.type === 'model/selection') {
    const config = event.type === 'request/header' ? event.data.header.config : event.data;
    next.route = { providerId: config.provider, modelId: config.model, reasoningEffort: config.reasoningEffort ?? 'unknown' };
  }
  if (event.type === 'goal/change') {
    if (event.data.operation === 'clear') { next.goal = null; return next; }
    const objective = event.data.goal.objective;
    const taskType = classify(objective), scale = inferWorkloadScale(objective, taskType);
    const count = /(?:\b|约|写|生成|输出)(\d{1,6})\s*(?:字|words?\b)/i.exec(objective);
    const features: PromptFeatures = { taskType: scale === 'task' ? taskType : 'code', workloadScale: scale,
      promptChars: objective.length, attachmentCount: 0, explicitOutputWords: count ? Number(count[1]) : null, userMessages: 0 };
    const scopeSeq = event.data.operation === 'create' || event.data.operation === 'edit' || next.goal?.id !== event.data.goal.id ? event.seq : next.goal?.scopeSeq ?? 0;
    const maxRounds = typeof event.data.goal.maxGoalRounds === 'number' ? event.data.goal.maxGoalRounds : next.goal?.maxRounds;
    const rounds = typeof event.data.roundsStarted === 'number' ? event.data.roundsStarted : next.goal?.rounds;
    next.goal = { id: event.data.goal.id, phase: event.data.goal.phase, features, scopeSeq, ...(maxRounds !== undefined ? { maxRounds } : {}), ...(rounds !== undefined ? { rounds } : {}) };
    const current = next.currentTurn === null ? undefined : next.tasks[String(next.currentTurn)];
    if (current && current.endedAt === null && next.goal.phase === 'active') {
      const task = { ...current, ...mergePrompt(current, features), goalId: next.goal.id };
      if (event.data.operation === 'create' || event.data.operation === 'edit') { delete task.aiPlan; task.scopeChanged = true; task.goalHasPriorWork = false; }
      next.tasks[String(task.turn)] = task;
    }
    return next;
  }
  let incoming: PromptFeatures | null = null;
  if (event.type === 'user/message' && event.data.source.kind === 'user') {
    const prompt = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const count = /(?:\b|约|写|生成|输出)(\d{1,6})\s*(?:字|words?\b)/i.exec(prompt);
    const taskType = classify(prompt);
    incoming = { taskType, workloadScale: inferWorkloadScale(prompt, taskType), promptChars: prompt.length,
      attachmentCount: event.data.content.filter(block => block.type === 'file' || block.type === 'image').length,
      explicitOutputWords: count ? Number(count[1]) : null, userMessages: 1 };
  }
  if (event.type === 'user/message' && event.data.source.kind === 'goal' && next.goal?.phase === 'active' && event.data.source.goalId === next.goal.id) {
    // DSH increments roundsStarted as each goal round starts; mirror it here or the
    // counter freezes at the value it had when the goal was created.
    if (typeof event.data.source.round === 'number' && event.data.source.round > 0) {
      next.goal = { ...next.goal, rounds: event.data.source.round };
    }
    incoming = { ...next.goal.features, userMessages: 0 };
  }
  if (event.type === 'turn/start') {
    if (next.goal?.phase === 'active') next.pendingPrompt = mergePrompt(next.goal.features, next.pendingPrompt ?? { taskType: 'unknown', promptChars: 0, attachmentCount: 0, explicitOutputWords: null, userMessages: 0 });
    const turn = event.data.turn;
    const goalHasPriorWork = next.goal?.phase === 'active' && Object.values(next.tasks).some(past => past.goalId === next.goal!.id
      && past.calls.some(call => call.seq > (next.goal!.scopeSeq ?? 0)));
    next.currentTurn = turn;
    next.tasks[String(turn)] = { turn, startSeq: event.seq, startedAt: event.time, endedAt: null, lastAt: event.time, state: 'running', taskType: 'unknown', promptChars: 0, attachmentCount: 0, explicitOutputWords: null, userMessages: 0, scopeChanged: false, step: 0, stepStartedAt: event.time, route: next.route, calls: [], tools: {}, ...(next.goal?.phase === 'active' ? { goalId: next.goal.id, goalHasPriorWork, ...(next.goal.maxRounds ? { goalRounds: { started: Math.min(next.goal.maxRounds, Math.max(1, next.goal.rounds ?? 1)), max: next.goal.maxRounds } } : {}) } : {}), ...(next.pendingPrompt ?? {}) };
    next.pendingPrompt = null;
    // Bound the per-session checkpoint. Older completed snapshots remain in plugin storage.
    const old = Object.keys(next.tasks).sort((a, b) => Number(a) - Number(b));
    for (const key of old.slice(0, Math.max(0, old.length - 200))) delete next.tasks[key];
  } else {
    const data = event.data;
    const eventTurn = data && typeof data === 'object' && 'turn' in data && typeof data.turn === 'number' ? data.turn : next.currentTurn;
    const previous = eventTurn === null ? undefined : next.tasks[String(eventTurn)];
    if (incoming && (!previous || previous.endedAt !== null)) next.pendingPrompt = mergePrompt(next.pendingPrompt, incoming);
    if (previous) {
      const task: TaskFact = { ...previous, lastAt: event.time };
      next.tasks[String(task.turn)] = task;
      if (event.type === 'step/start') {
        task.step = event.data.step; task.stepStartedAt = event.time; task.route = next.route;
      } else if (event.type === 'request/header' || event.type === 'model/selection') task.route = next.route;
      else if (incoming && task.endedAt === null) {
        Object.assign(task, mergePrompt(task, incoming));
        task.scopeChanged ||= task.userMessages > 1 || incoming.userMessages > 0 && !!task.goalId;
        // New human scope invalidates an earlier AI forecast until it is revised.
        delete task.aiPlan;
      } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
        let stats = durableStreamStats(event.data.stream);
        if (event.type === 'assistant/message' && event.data.usage) stats = { ...stats, usage: rawDshUsage(event.data.usage) };
        const source = event.type === 'assistant/message' ? event.data.message.source : null;
        const route = source ? { providerId: source.provider, modelId: source.model, reasoningEffort: task.route?.reasoningEffort ?? 'unknown' } : task.route ?? { providerId: 'unknown', modelId: 'unknown', reasoningEffort: 'unknown' };
        const outcome: CallFact['outcome'] = event.type === 'assistant/message' && event.data.interrupted ? 'interrupted' : stats.finish === 'aborted' ? 'cancelled' : stats.finish === 'error' ? 'failed' : stats.finish === 'max-tokens' ? 'truncated' : event.type === 'assistant/attempt' ? 'failed' : 'completed';
        task.calls = [...task.calls, { ...stats, id: `${state.sessionId}:${event.seq}`, seq: event.seq, turn: task.turn, step: event.data.step, startedAt: task.stepStartedAt, endedAt: event.time, route, mode: streamMode(stats), outcome, timingSource: 'step-boundary' }];
      } else if (event.type === 'tool/call') {
        task.tools = { ...task.tools, [event.data.callId]: { id: event.data.callId, name: event.data.name, startedAt: event.time, endedAt: null, failed: false } };
      } else if (event.type === 'tool/result') {
        const id = event.data.message.toolCallId;
        const tool = task.tools[id];
        if (tool) task.tools = { ...task.tools, [id]: { ...tool, endedAt: event.time, failed: !!event.data.message.isError } };
        if (tool?.name === 'task_estimate_plan' && !event.data.message.isError) {
          const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
          const plan = readAiPlanResult(text, task.calls.length, event.time);
          if (plan) task.aiPlan = plan;
        }
      } else if (event.type === 'turn/end') {
        task.endedAt = event.time; task.state = turnEndState(event.data.reason.kind);
        if (next.currentTurn === task.turn) next.currentTurn = null;
      }
    }
  }
  next.view = { revision: event.seq, currentTurn: next.currentTurn };
  return next;
}
