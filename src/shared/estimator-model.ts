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
export function buildEstimatorPrompt(taskText: string): string {
  const text = taskText.trim().slice(0, ESTIMATOR_PROMPT_LIMIT);
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
