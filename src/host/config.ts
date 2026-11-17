import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import { DEFAULT_CONFIG, validateConfig } from '../shared/config.ts';
import type { EstimatorConfig } from '../shared/config.ts';
import { validatePrices } from '../shared/pricing.ts';
import type { PriceEntry, SameAs } from '../shared/pricing.ts';
import type { Span } from '../shared/types.ts';
import { DEFAULT_CLASSIFICATION_RULES, DEFAULT_TEMPLATES, validateTemplates } from '../shared/workload.ts';
import type { ClassificationRule, WorkloadTemplate } from '../shared/workload.ts';

export interface RouteOverride {
  /** A user-chosen opaque endpoint identity; never a credential or URL. */
  endpointFingerprint?: string;
  serviceTier: string;
  outputIncludesReasoning: boolean | 'unknown';
  cacheFieldsOmittedAreZero: boolean;
  cacheWriteTtl: '5m' | '1h' | null;
  forecastCacheReadRatio: Span | null;
  forecastCacheWrite5mTokens: Span | null;
  forecastCacheWrite1hTokens: Span | null;
  forecastReasoningTokens: Span | null;
}
export interface EstimatorModelConfig {
  /** On by default: it reuses the session route, so no new recipient sees the text. */
  enabled: boolean;
  provider: string;
  model: string;
  timeoutMs: number;
  /** Wait this long for the executing agent's own plan before asking the model. */
  delayMs: number;
  /** Only ask the model when the uncalibrated forecast is at least this long. */
  minHighMs: number;
}
export interface PluginConfig extends EstimatorConfig {
  prices: PriceEntry[];
  usePublicPriceCatalog: boolean;
  sameAs: SameAs[];
  routeOverrides: Record<string, RouteOverride>;
  workloadTemplates: WorkloadTemplate[];
  classificationRules: ClassificationRule[];
  estimatorModel: EstimatorModelConfig;
}
const rangeSchema = z.object({ low: z.number().finite().nonnegative(), high: z.number().finite().nonnegative() })
  .strict().refine(value => value.low <= value.high);
const routeSchema = z.object({
  endpointFingerprint: z.string().min(1).max(128).regex(/^[\p{L}\p{N}_.:-]+$/u).optional(),
  serviceTier: z.string().min(1).max(80).default('unknown'),
  outputIncludesReasoning: z.union([z.boolean(), z.literal('unknown')]).default('unknown'),
  cacheFieldsOmittedAreZero: z.boolean().default(false),
  cacheWriteTtl: z.enum(['5m', '1h']).nullable().default(null),
  forecastCacheReadRatio: rangeSchema.nullable().default(null),
  forecastCacheWrite5mTokens: rangeSchema.nullable().default(null),
  forecastCacheWrite1hTokens: rangeSchema.nullable().default(null),
  forecastReasoningTokens: rangeSchema.nullable().default(null),
}).strict();

export function validatePluginConfig(raw: unknown): PluginConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Configuration must be an object');
  const input = raw as Record<string, unknown>;
  const { prices = [], usePublicPriceCatalog = true, sameAs = [], routeOverrides = {}, workloadTemplates = [...DEFAULT_TEMPLATES], classificationRules = [...DEFAULT_CLASSIFICATION_RULES], estimatorModel = {}, ...engine } = input;
  if (typeof usePublicPriceCatalog !== 'boolean') throw new TypeError('usePublicPriceCatalog must be a boolean');
  const validated = validateConfig(engine as Partial<EstimatorConfig>);
  if (validated.saveRawContent || validated.magpieIntegration) throw new TypeError('This release supports local DSH statistics only; saveRawContent and magpieIntegration must stay false');
  if (validated.predictionRefreshMs < 1000 || validated.predictionRefreshMs > 60000 || validated.timerRefreshMs < 250 || validated.timerRefreshMs > 60000) throw new TypeError('Refresh intervals must stay within supported bounds');
  if (validated.maxSamplesPerBucket > 2000 || validated.historyRetentionDays > 3650) throw new TypeError('Retention limits exceed the supported local data size');
  if (!Array.isArray(prices) || !Array.isArray(sameAs)) throw new TypeError('prices and sameAs must be arrays');
  validatePrices(prices as PriceEntry[], sameAs as SameAs[]);
  const routes = z.record(z.string().min(1).max(256), routeSchema).parse(routeOverrides);
  for (const route of Object.values(routes)) if (route.forecastCacheReadRatio && route.forecastCacheReadRatio.high > 1) throw new TypeError('Cache ratio must be between 0 and 1');
  if (!Array.isArray(workloadTemplates) || !Array.isArray(classificationRules)) throw new TypeError('Templates and classification rules must be arrays');
  validateTemplates(workloadTemplates as WorkloadTemplate[]);
  const ruleIds = new Set<string>();
  for (const rule of classificationRules as ClassificationRule[]) {
    if (!rule.id || ruleIds.has(rule.id) || !DEFAULT_TEMPLATES.some(template => template.kind === rule.kind) || !Array.isArray(rule.patterns) || !rule.patterns.length) throw new TypeError('Invalid classification rule');
    ruleIds.add(rule.id);
    for (const pattern of [...rule.patterns, ...(rule.excludePatterns ?? [])]) { if (typeof pattern !== 'string' || pattern.length > 1000) throw new TypeError('Invalid classification pattern'); new RegExp(pattern, 'iu'); }
  }
  const model = z.object({
    enabled: z.boolean().default(true),
    provider: z.string().max(120).default(''),
    model: z.string().max(160).default(''),
    timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
    delayMs: z.number().int().min(0).max(120_000).default(8_000),
    minHighMs: z.number().int().min(0).max(86_400_000).default(300_000),
  }).strict().parse(estimatorModel);
  if (Boolean(model.provider.trim()) !== Boolean(model.model.trim())) throw new TypeError('An estimator override needs both a provider and a model, or leave both empty to follow the session route');
  return { ...validated, estimatorModel: model, prices:  structuredClone(prices) as PriceEntry[], usePublicPriceCatalog, sameAs: structuredClone(sameAs) as SameAs[], routeOverrides: routes,
    workloadTemplates: structuredClone(workloadTemplates) as WorkloadTemplate[], classificationRules: structuredClone(classificationRules) as ClassificationRule[] };
}
export function defaultPluginConfig(): PluginConfig {
  return validatePluginConfig({ ...DEFAULT_CONFIG, prices: [], sameAs: [], routeOverrides: {} });
}

const configFields: Record<string, Schema> = {};
for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  if (typeof value === 'number') configFields[key] = Schema.number().min(0).default(value);
  else if (typeof value === 'boolean') configFields[key] = Schema.boolean().default(value);
  else configFields[key] = Schema.object({ low: Schema.number().min(0), high: Schema.number().min(0) }).default(value);
}
configFields.usePublicPriceCatalog = Schema.boolean().default(true).description('Automatically match the bundled models.dev list-price reference; never a provider invoice.');
configFields.prices = Schema.array(Schema.any()).default([]).description('Per-request prices with currency, provenance and version. Unknown prices remain unpriced.');
configFields.sameAs = Schema.array(Schema.any()).default([]).description('Explicit price aliases; cycles are refused.');
configFields.routeOverrides = Schema.dict(Schema.any()).default({}).description('Opaque endpoint identities, service tiers and adapter-specific usage semantics.');
configFields.workloadTemplates = Schema.array(Schema.any()).default([...DEFAULT_TEMPLATES]).description('Versioned workload assumptions for each task type.');
configFields.classificationRules = Schema.array(Schema.any()).default([...DEFAULT_CLASSIFICATION_RULES]).description('Ordered local task classification rules.');
configFields.estimatorModel = Schema.object({
  enabled: Schema.boolean().default(true).description('On by default. The task text goes to the session route, or to the override below, for one bounded estimate.'),
  provider: Schema.string().default('').description('Optional override; empty means follow the route the session already uses.'),
  model: Schema.string().default('').description('Optional override model id; set it together with the provider.'),
  timeoutMs: Schema.number().min(1_000).max(120_000).default(20_000).description('Abort a single estimator call after this long.'),
  delayMs: Schema.number().min(0).max(120_000).default(8_000).description('Wait this long for the executing agent plan before asking the model.'),
  minHighMs: Schema.number().min(0).max(86_400_000).default(300_000).description('Skip the model for tasks whose uncalibrated forecast is shorter than this; small tasks finish too fast to need it.'),
}).default({ enabled: true, provider: '', model: '', timeoutMs: 20_000, delayMs: 8_000, minHighMs: 300_000 }).description('Optional second-model estimator; disabled unless enabled explicitly.');
export const Config = Schema.object(configFields).description('Local task time and cost estimates. The optional estimator model is off by default and, when enabled, sends the task text to the chosen model.');
