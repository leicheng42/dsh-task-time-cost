import { z } from 'zod';
import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
import type { EstimateSnapshot } from './wire.ts';
import { PACKAGE_NAME } from './wire.ts';

const nonnegative = z.number().finite().nonnegative();
const integer = z.number().int().nonnegative();
const span = z.object({ low: nonnegative, high: nonnegative }).refine(value => value.low <= value.high);
const amount = z.string().regex(/^\d+(?:\.\d+)?$/);
const money = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), amount });
const moneyRange = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), range: z.object({ low: amount, high: amount }) });
const taskState = z.enum(['queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled', 'interrupted']);
const count = integer.nullable();
export const snapshotSchema: z.ZodType<EstimateSnapshot> = z.object({
  taskKey: z.string(), sessionId: z.string(), turn: integer, revision: integer,
  algorithmVersion: z.string(), state: taskState, taskType: z.string(),
  updatedAt: nonnegative, startedAt: nonnegative, endedAt: nonnegative.nullable(),
  elapsedWallMs: nonnegative, elapsedActiveMs: nonnegative, elapsedPausedMs: nonnegative,
  remainingMs: span.nullable(), estimatedTotalMs: span.nullable(),
  sessionElapsedMs: nonnegative.optional(), sessionRemainingMs: span.nullable().optional(), sessionTurns: integer.optional(),
  estimateOrigin: z.enum(['heuristic', 'public-measured', 'local-measured', 'mixed']),
  localPerformanceSamples: integer, workloadSamples: integer,
  observedTokenStatus: z.enum(['complete', 'partial', 'unknown']), observedTokens: count,
  tokens: z.object({ input: count, cacheRead: count, cacheWrite: count, output: count, reasoning: count }),
  estimatedTotalTokens: span.nullable(), estimatedRemainingOutputTokens: span.nullable().optional(), knownCost: z.array(money), estimatedTotalCost: z.array(moneyRange).nullable(),
  observedCostStatus: z.enum(['complete', 'partial', 'unpriced', 'free']),
  forecastCostStatus: z.enum(['reference', 'partial', 'unavailable', 'free']),
  unpricedCalls: integer, incompleteForecastUnits: integer,
  calls: z.object({ completed: integer, active: integer, failed: integer, expected: span }),
  tools: z.object({ completed: integer, active: integer, workMs: nonnegative }),
  performance: z.object({
    providerId: z.string(), modelId: z.string(), endpointFingerprint: z.string(), requestMode: z.string(),
    reasoningEffort: z.string(), serviceTier: z.string(), firstContentMs: nonnegative.nullable(),
    firstTextMs: nonnegative.nullable(), visibleTps: nonnegative.nullable(), totalCallMs: nonnegative.nullable(),
    source: z.string(), stale: z.boolean(), trust: z.enum(['observed', 'reference']).optional(),
    metricOrigins: z.object({ firstContent: z.enum(['heuristic', 'public-measured', 'local-measured']), firstText: z.enum(['heuristic', 'public-measured', 'local-measured']),
      speed: z.enum(['heuristic', 'public-measured', 'local-measured']), total: z.enum(['heuristic', 'public-measured', 'local-measured']) }).optional(),
  }).nullable(),
  priceSources: z.array(z.string()),
  initial: z.object({ estimatedTotalMs: span.nullable(), estimatedTotalCost: z.array(moneyRange).nullable() }).nullable(),
  error: z.string().nullable(), reasons: z.array(z.string()), scope: z.literal('current_turn'),
});
export const managementViewSchema = z.object({
  config: z.record(z.string(), z.json()),
  history: z.array(z.object({ taskKey: z.string(), sessionId: z.string(), turn: integer, taskType: z.string(), state: taskState,
    startedAt: nonnegative, elapsedActiveMs: nonnegative, elapsedPausedMs: nonnegative, knownCost: z.array(money), initialMs: span.nullable(), durationErrorMs: z.number().finite().nullable() })),
  profiles: z.array(z.record(z.string(), z.json())),
  diagnostics: z.array(z.object({ time: nonnegative, code: z.string(), message: z.string() })),
  storage: z.enum(['ready', 'unavailable']),
});
export const retainedTimeForecastSchema = z.object({ taskKey: z.string(), remainingMs: span, estimatedTotalMs: span.nullable(), updatedAt: nonnegative });
const viewSchema = z.object({ snapshot: snapshotSchema.nullable(), available: z.boolean(), error: z.string().nullable(), lastForecast: retainedTimeForecastSchema.optional() });
const manageResultSchema = z.object({ ok: z.boolean(), message: z.string(), data: managementViewSchema.optional(), exported: z.string().optional() });
function codec(schema: z.ZodType, typeSymbol: string): TypertCodec {
  return { mode: 'strict', typeSymbol, create: () => schema };
}
/** Authored from the installed public InvocationDescriptor contract; shared by both faces. */
export const descriptors: readonly InvocationDescriptor[] = [
  { id: `${PACKAGE_NAME}#snapshot`, service: 'taskEstimator', namespace: 'taskEstimator', method: 'snapshot',
    invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
    parameters: [
      { name: 'sessionId', wire: 'sessionId', source: 'json', codec: codec(z.string().min(1).max(256), 'string') },
      { name: 'turn', wire: 'turn', source: 'json', codec: codec(integer.nullable(), 'number|null') },
    ], result: codec(viewSchema, 'EstimatorView'), description: 'Read the current or a completed turn estimate.' },
  { id: `${PACKAGE_NAME}#manage`, service: 'taskEstimator', namespace: 'taskEstimator', method: 'manage',
    invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' },
    parameters: [
      { name: 'action', wire: 'action', source: 'json', codec: codec(z.enum(['read', 'saveConfig', 'export', 'resetCalibration', 'importBaselines']), 'ManagementAction') },
      { name: 'payload', wire: 'payload', source: 'json', codec: codec(z.string().max(2_000_000), 'string') },
    ], result: codec(manageResultSchema, 'ManagementResult'), description: 'Manage local estimator configuration and calibration data.' },
];
export const remoteContribution: TypertRemoteContribution = { package: PACKAGE_NAME, descriptors };
