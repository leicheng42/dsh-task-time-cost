import { z } from 'zod';
import { estimateWorkload } from './workload.ts';
import type { PlanScenario, WorkloadPlan } from './workload.ts';
import type { RouteIdentity } from './types.ts';
import type { EstimatorConfig } from './config.ts';

const span = (max: number, minimum = 0) => z.object({ low: z.number().int().min(minimum).max(max), high: z.number().int().min(minimum).max(max) }).strict()
  .refine(value => value.low <= value.high, 'Bounds must be ordered');
/** Numeric work metadata only: no free-form prompt, reasoning or file contents. */
export const aiPlanSchema = z.object({
  remainingCalls: span(500, 1),
  remainingOutputTokens: span(2_000_000),
  remainingToolSeconds: span(86_400),
  stage: z.enum(['planning', 'implementation', 'verification', 'finishing']),
  scope: z.enum(['current_turn', 'whole_goal']).optional(),
}).strict();
export type AiPlanInput = z.infer<typeof aiPlanSchema>;
export type AiPlan = AiPlanInput & { afterCalls: number; submittedAt: number };

export function readAiPlanResult(text: string, afterCalls: number, submittedAt: number): AiPlan | null {
  if (text.length > 4_000) return null;
  try {
    const result = z.object({ kind: z.literal('task-estimate-plan'), version: z.literal(1), plan: aiPlanSchema }).strict().parse(JSON.parse(text));
    return { ...result.plan, afterCalls, submittedAt };
  } catch { return null; }
}

/** Replace FUTURE work while preserving the settled request positions and costs. */
export function applyAiPlan(base: WorkloadPlan, ai: AiPlan, route: RouteIdentity, inputTokens: number | null, config: Partial<EstimatorConfig>): WorkloadPlan {
  const future = estimateWorkload({ prompt: '', currentInputTokens: inputTokens }, route, { config,
    rules: [{ id: 'executing-ai-plan', kind: base.kind, patterns: ['.*'] }],
    templates: [{ kind: base.kind, requestCount: ai.remainingCalls, visibleOutputTokens: ai.remainingOutputTokens,
      toolMs: { low: ai.remainingToolSeconds.low * 1_000, high: ai.remainingToolSeconds.high * 1_000 }, sourceKind: 'heuristic', sourceId: 'executing-ai-plan' }],
  });
  const shiftId = (id: string) => id.replace(/^(request|tool)-(\d+)$/, (_, prefix: string, number: string) => `${prefix}-${Number(number) + ai.afterCalls}`);
  function scenario(value: PlanScenario): PlanScenario {
    const placeholder = value.requests[0]!;
    return { requests: [
      ...Array.from({ length: ai.afterCalls }, (_, index) => ({ ...placeholder, id: `request-${index + 1}`, dependsOn: [] })),
      ...value.requests.map(request => ({ ...request, id: shiftId(request.id), dependsOn: request.dependsOn.map(shiftId) })),
    ], tools: value.tools.map(tool => ({ ...tool, id: shiftId(tool.id), dependsOn: tool.dependsOn.map(shiftId) })) };
  }
  return { ...future, low: scenario(future.low), high: scenario(future.high),
    reasons: [...future.reasons.filter(reason => reason !== 'engineering-workload-template'), 'ai-workload-plan-reference'],
    sourceIds: ['executing-ai-plan'], workloadSamples: 0 };
}
