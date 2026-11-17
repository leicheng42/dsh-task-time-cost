import { aiPlanSchema } from './ai-plan.ts';
import type { AiPlanInput } from './ai-plan.ts';

/** The user's own words are the only useful input, so the prompt is bounded. */
export const ESTIMATOR_PROMPT_LIMIT = 4_000;
/** A reply is expected to be short JSON; anything longer is refused unparsed. */
export const ESTIMATOR_REPLY_LIMIT = 2_000;

/**
 * One self-contained request for a second model: the task text plus the exact
 * numeric contract. It never asks for prose, so the reply can be parsed and
 * discarded without retaining anything the user wrote.
 */
export interface EstimatorContext { elapsedMs: number; completedCalls: number; refresh: boolean }
export function buildEstimatorPrompt(taskText: string, context?: EstimatorContext): string {
  const text = taskText.trim().slice(0, ESTIMATOR_PROMPT_LIMIT);
  if (context?.refresh) {
    return [
      'You estimate how much work REMAINS in a software task that is already running.',
      `Observed so far: ${Math.round(context.elapsedMs / 60_000)} minutes elapsed, ${context.completedCalls} model rounds completed.`,
      'Answer with one JSON object and nothing else, using these integer keys:',
      '{"remainingCalls":{"low":N,"high":N},"remainingOutputTokens":{"low":N,"high":N},"remainingToolSeconds":{"low":N,"high":N},"stage":"planning|implementation|verification|finishing","scope":"current_turn"}',
      'remainingCalls counts model rounds still needed FROM NOW (1-500). Do not repeat the work already done.',
      'Task:',
      text,
    ].join('\n');
  }
  return [
    'You estimate the remaining work of a software task that another AI agent is about to execute.',
    'Answer with one JSON object and nothing else, using these integer keys:',
    '{"remainingCalls":{"low":N,"high":N},"remainingOutputTokens":{"low":N,"high":N},"remainingToolSeconds":{"low":N,"high":N},"stage":"planning|implementation|verification|finishing","scope":"current_turn|whole_goal"}',
    'remainingCalls counts model response rounds still needed (1-500). remainingOutputTokens counts visible output tokens (0-2000000).',
    'remainingToolSeconds counts tool wall time on the critical path (0-86400). Keep low <= high and stay within the ranges.',
    'Task:',
    text,
  ].join('\n');
}

/**
 * Accept only a complete, in-range numeric plan. Any prose around the object is
 * ignored, but unknown or missing keys are refused rather than guessed.
 */
export function parseEstimatorPlan(raw: string): AiPlanInput | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ESTIMATOR_REPLY_LIMIT) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  const parsed = aiPlanSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface EstimatorRoute {
  provider: string;
  model: string;
  source: 'override' | 'session-route';
}

/**
 * The user should not have to name a provider: an empty override follows the
 * route the session already uses, which is also the only model that already
 * received this task text. An explicit override wins when both halves are set.
 */
export function resolveEstimatorRoute(
  providers: ReadonlyArray<{ id: string }>, session: { providerId: string | null; modelId: string | null },
  override: { provider: string; model: string },
): EstimatorRoute | null {
  const wantedProvider = override.provider.trim();
  const wantedModel = override.model.trim();
  if (wantedProvider && wantedModel) return { provider: wantedProvider, model: wantedModel, source: 'override' };
  const providerId = session.providerId?.trim() ?? '';
  const modelId = session.modelId?.trim() ?? '';
  if (!modelId) return null;
  if (!providerId) return providers.length === 1 ? { provider: providers[0]!.id, model: modelId, source: 'session-route' } : null;
  const exact = providers.find(candidate => candidate.id === providerId);
  const loose = exact ?? providers.find(candidate => candidate.id.toLowerCase() === providerId.toLowerCase())
    ?? providers.find(candidate => candidate.id.toLowerCase().startsWith(providerId.toLowerCase()) || providerId.toLowerCase().startsWith(candidate.id.toLowerCase()));
  return loose ? { provider: loose.id, model: modelId, source: 'session-route' } : null;
}

/** Bounded facts about goal progress; no code, no file names, no prompt text. */
export interface GoalContext {
  elapsedMs: number;
  roundsDone: number;
  toolsDone: number;
  /** The previous model answer for this goal, so a fresh answer cannot swing wildly. */
  previous?: { lowMs: number; highMs: number } | null;
}

const GOAL_MINUTE_LIMIT = 7 * 24 * 60;

export function buildGoalPrompt(goalText: string, context: GoalContext): string {
  const text = goalText.trim().slice(0, ESTIMATOR_PROMPT_LIMIT);
  const spent = Math.max(0, Math.round(context.elapsedMs / 60_000));
  const previous = context.previous
    ? `Previous estimate for this goal: ${Math.round(context.previous.lowMs / 60_000)}-${Math.round(context.previous.highMs / 60_000)} minutes.`
    : 'No previous estimate for this goal.';
  return [
    'You estimate how much longer a whole goal will take an AI agent, measured in minutes of active work.',
    'A goal runs over many rounds; each round ends and the next one continues the same objective.',
    `Observed so far: ${spent} minutes of active work, ${context.roundsDone} rounds finished, ${context.toolsDone} tool calls completed.`,
    previous,
    'Answer with one JSON object and nothing else:',
    '{"remainingMinutes":{"low":N,"high":N}}',
    'Use whole minutes. low must be >= 1 and <= high; both must be <= 10080. Judge the work that is still missing, not the work already done, and keep the range wide when the goal is vague.',
    'Goal:',
    text,
  ].join('\n');
}

export interface GoalPlan {
  lowMs: number;
  highMs: number;
}

/** Accept only a complete in-range minute range; nothing else survives. */
export function parseGoalPlan(raw: string): GoalPlan | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ESTIMATOR_REPLY_LIMIT) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const minutes = (value as { remainingMinutes?: unknown }).remainingMinutes;
  if (!minutes || typeof minutes !== 'object') return null;
  const low = (minutes as { low?: unknown }).low;
  const high = (minutes as { high?: unknown }).high;
  if (typeof low !== 'number' || typeof high !== 'number' || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const lowMinutes = Math.round(low);
  const highMinutes = Math.round(high);
  if (lowMinutes < 1 || highMinutes < lowMinutes || highMinutes > GOAL_MINUTE_LIMIT) return null;
  return { lowMs: lowMinutes * 60_000, highMs: highMinutes * 60_000 };
}
