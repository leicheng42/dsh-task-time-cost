import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-llm';
import { ESTIMATOR_REPLY_LIMIT, buildEstimatorPrompt, buildGoalPrompt, parseEstimatorPlan, parseGoalPlan, resolveEstimatorRoute } from '../shared/estimator-model.ts';
import type { GoalContext, GoalPlan } from '../shared/estimator-model.ts';
import type { AiPlanInput } from '../shared/ai-plan.ts';

/** Declare the auxiliary purpose so adapters can label this call as non-conversation. */
declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap { 'task-estimate': true }
}

export interface EstimatorModelSettings {
  /** Registered provider route, for example the one the session already uses. */
  provider: string;
  model: string;
  timeoutMs: number;
}

interface StreamService {
  listProviders(): Array<{ id: string; name: string }>;
  stream(options: {
    provider: string;
    model: string;
    purpose?: 'task-estimate';
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  }): AsyncIterable<{ type: string; text?: string }>;
}

/**
 * Ask a second model for a bounded numeric plan. The task text goes only into
 * this request: nothing is written to storage, and only the accepted numbers
 * are returned. Every failure — missing service, refusal, timeout, malformed
 * reply — resolves to null so the caller keeps its template forecast.
 */
export async function requestEstimatorPlan(
  ctx: Context, settings: EstimatorModelSettings, sessionRoute: { providerId: string | null; modelId: string | null },
  taskText: string, context?: { elapsedMs: number; completedCalls: number; refresh: boolean }, parent?: AbortSignal,
): Promise<AiPlanInput | null> {
  if (!taskText.trim()) return null;
  const llm = ctx.get('llm') as StreamService | undefined;
  if (!llm || typeof llm.stream !== 'function') return null;
  let providers: Array<{ id: string }> = [];
  try { providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []; } catch { providers = []; }
  const route = resolveEstimatorRoute(providers, sessionRoute, { provider: settings.provider, model: settings.model });
  if (!route) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, settings.timeoutMs));
  const forward = () => controller.abort();
  parent?.addEventListener('abort', forward, { once: true });
  let text = '';
  try {
    const stream = llm.stream({
      provider: route.provider, model: route.model, purpose: 'task-estimate',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildEstimatorPrompt(taskText, context) }] }],
      signal: controller.signal, maxTokens: 400, temperature: 0,
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text;
        if (text.length > ESTIMATOR_REPLY_LIMIT) break;
      }
    }
  } catch { return null; }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', forward);
  }
  return parseEstimatorPlan(text);
}

/**
 * Ask the model for the remaining time of the whole goal. The goal text is used
 * only for this request; the accepted minute range is all that is kept.
 */
export async function requestGoalPlan(
  ctx: Context, settings: EstimatorModelSettings, sessionRoute: { providerId: string | null; modelId: string | null },
  goalText: string, context: GoalContext, parent?: AbortSignal,
): Promise<GoalPlan | null> {
  if (!goalText.trim()) return null;
  const llm = ctx.get('llm') as StreamService | undefined;
  if (!llm || typeof llm.stream !== 'function') return null;
  let providers: Array<{ id: string }> = [];
  try { providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []; } catch { providers = []; }
  const route = resolveEstimatorRoute(providers, sessionRoute, { provider: settings.provider, model: settings.model });
  if (!route) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, settings.timeoutMs));
  const forward = () => controller.abort();
  parent?.addEventListener('abort', forward, { once: true });
  let reply = '';
  try {
    const stream = llm.stream({
      provider: route.provider, model: route.model, purpose: 'task-estimate',
      messages: [{ role: 'user', content: [{ type: 'text', text: buildGoalPrompt(goalText, context) }] }],
      signal: controller.signal, maxTokens: 200, temperature: 0,
    });
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        reply += chunk.text;
        if (reply.length > ESTIMATOR_REPLY_LIMIT) break;
      }
    }
  } catch { return null; }
  finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', forward);
  }
  return parseGoalPlan(reply);
}
