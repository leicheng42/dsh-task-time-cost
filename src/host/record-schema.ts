import { z } from 'zod';
import type { CallRecord } from './repository.ts';
import type { CallFact } from './facts.ts';
import type { CallObservation } from '../shared/performance.ts';
import type { RouteIdentity } from '../shared/types.ts';
import type { RawUsage, NormalizedUsage } from '../shared/usage.ts';
import { BILLABLE_CATEGORIES, INPUT_CATEGORIES, sumKnown } from '../shared/usage.ts';
import type { CallCost, PriceEntry, PriceResolution } from '../shared/pricing.ts';
import { validatePrices } from '../shared/pricing.ts';
import { MONEY_DECIMALS, RATE_DECIMALS, parseFixed } from '../shared/money.ts';

const identifier = z.string().min(1).max(1024);
const metadata = z.string().max(16_384);
const messages = z.array(metadata).max(10_000);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Real stream timestamps include fractional performance.now() deltas. Counts do not.
const milliseconds = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const mode = z.enum(['text', 'tool', 'mixed', 'unknown', 'non-streaming']);
const sourceKind = z.enum(['public-measured', 'local-measured', 'heuristic']);
const priority = z.enum(['user-exact', 'provider-wildcard', 'provider-catalog', 'public-catalog']);
const currency = z.string().regex(/^[A-Z]{3}$/);
const date = z.string().min(1).max(128).refine(value => Number.isFinite(Date.parse(value)), 'Invalid pricing date');

function decimal(places: number) {
  return z.string().min(1).max(1024).refine(value => {
    try { parseFixed(value, places); return true; } catch { return false; }
  }, `Expected a nonnegative fixed decimal with at most ${places} significant fractional places`);
}
const amount = decimal(MONEY_DECIMALS);
const rate = decimal(RATE_DECIMALS);

const routeSchema: z.ZodType<RouteIdentity> = z.object({
  providerId: identifier, endpointFingerprint: identifier, modelId: identifier,
  requestMode: mode, reasoningEffort: identifier, serviceTier: identifier,
  inputBucket: identifier.optional(), cacheBucket: identifier.optional(), concurrencyBucket: identifier.optional(),
  mixedRoute: z.boolean().optional(),
}).strict();
const factRouteSchema = z.object({ providerId: identifier, modelId: identifier, reasoningEffort: identifier }).strict();
const rawUsageSchema: z.ZodType<RawUsage> = z.object({
  inputTokens: count.nullable().optional(), cacheReadTokens: count.nullable().optional(),
  cacheWriteTokens: count.nullable().optional(), cacheWrite5mTokens: count.nullable().optional(),
  cacheWrite1hTokens: count.nullable().optional(), outputTokens: count.nullable().optional(),
  reasoningTokens: count.nullable().optional(), visibleOutputTokens: count.nullable().optional(),
  totalTokens: count.nullable().optional(),
}).strict();

const normalizedUsageSchema: z.ZodType<NormalizedUsage> = z.object({
  inputTokens: count.nullable(), cacheReadTokens: count.nullable(), cacheWrite5mTokens: count.nullable(),
  cacheWrite1hTokens: count.nullable(), cacheWriteUnknownTokens: count.nullable(), outputTokens: count.nullable(),
  reasoningTokens: count.nullable(), visibleOutputTokens: count.nullable(), promptTokens: count.nullable(), totalTokens: count.nullable(),
  status: z.enum(['complete', 'partial', 'unknown']), exact: z.boolean(), diagnostics: messages,
}).strict().superRefine((usage, ctx) => {
  const conflict = usage.diagnostics.some(message => message.startsWith('conflict:'));
  const invalid = usage.diagnostics.some(message => message.startsWith('invalid:'));
  const complete = BILLABLE_CATEGORIES.every(key => usage[key] !== null);
  const anyKnown = BILLABLE_CATEGORIES.some(key => usage[key] !== null);
  const expectedStatus = complete && !conflict ? 'complete' : anyKnown ? 'partial' : 'unknown';
  if (usage.status !== expectedStatus) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Usage status disagrees with known categories' });
  if (usage.exact !== (complete && !conflict && !invalid)) ctx.addIssue({ code: 'custom', path: ['exact'], message: 'Usage exactness disagrees with known categories and diagnostics' });
  const prompt = sumKnown(INPUT_CATEGORIES.map(key => usage[key]));
  if (usage.promptTokens !== prompt) ctx.addIssue({ code: 'custom', path: ['promptTokens'], message: 'Prompt tokens disagree with exclusive input categories' });
  const total = conflict ? null : sumKnown([prompt, usage.outputTokens]);
  if (usage.totalTokens !== total) ctx.addIssue({ code: 'custom', path: ['totalTokens'], message: 'Total tokens disagree with normalized usage' });
});

const factSchema: z.ZodType<CallFact> = z.object({
  id: identifier, seq: count, turn: count, step: count,
  startedAt: milliseconds, endedAt: milliseconds, route: factRouteSchema, mode,
  firstContentAt: milliseconds.nullable(), firstTextAt: milliseconds.nullable(), lastContentAt: milliseconds.nullable(),
  textChars: count, reasoningChars: count, toolChars: count, textDeltas: count,
  usage: rawUsageSchema.nullable(),
  // The official FinishReasonMap is merge-extensible. A closed enum would discard valid adapters.
  finish: identifier.nullable(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'truncated', 'interrupted']),
  timingSource: z.enum(['step-boundary', 'live-attempt']),
  // A first-release spread also persisted these harmless LiveAttempt fields. Admit only this
  // bounded, typed whitelist, then remove it; all other extra fields still fail strict parsing.
  startedMono: milliseconds.optional(),
  lastIndex: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).optional(),
  sessionId: identifier.optional(),
}).strict().transform(({ startedMono: _mono, lastIndex: _index, sessionId: _session, ...fact }) => fact);

const unitPricesSchema = z.object({
  inputTokens: rate.nullable().optional(), cacheReadTokens: rate.nullable().optional(),
  cacheWrite5mTokens: rate.nullable().optional(), cacheWrite1hTokens: rate.nullable().optional(),
  cacheWriteUnknownTokens: rate.nullable().optional(), outputTokens: rate.nullable().optional(),
}).strict();
const ruleSchema = z.object({
  id: identifier,
  when: z.object({
    promptTokensAbove: count.optional(), serviceTier: identifier.optional(),
    utcHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).strict().optional(),
  }).strict(),
  mode: z.enum(['whole-request', 'excess-only']).optional(),
  allocationOrder: z.array(z.enum(INPUT_CATEGORIES)).max(INPUT_CATEGORIES.length).optional(),
  prices: unitPricesSchema.optional(), multiplier: rate.optional(),
}).strict();
const entrySchema: z.ZodType<PriceEntry> = z.object({
  id: identifier, providerId: identifier, endpointFingerprint: identifier.optional(), modelId: identifier,
  priority, currency, unit: z.literal('per-million-tokens'), prices: unitPricesSchema,
  explicitFree: z.boolean().optional(), multiplier: rate.optional(), rules: z.array(ruleSchema).max(10_000).optional(),
  sourceKind, sourceUrl: metadata.nullable(), version: identifier, effectiveFrom: date, effectiveUntil: date.optional(),
}).strict().superRefine((entry, ctx) => {
  // Reuse the actual tier/free/rate/date rules; do not maintain a weaker storage-only variant.
  try { validatePrices([entry]); } catch {
    ctx.addIssue({ code: 'custom', message: 'Invalid persisted pricing rules' });
  }
});
const resolutionSchema: z.ZodType<PriceResolution> = z.object({
  entry: entrySchema.nullable(),
  match: z.enum(['user-exact', 'provider-wildcard', 'provider-catalog', 'public-catalog', 'same-as', 'unpriced']),
  billingModelId: identifier, reasons: messages,
}).strict().superRefine((resolution, ctx) => {
  if (resolution.entry === null ? resolution.match !== 'unpriced' : resolution.match !== 'same-as' && resolution.match !== resolution.entry.priority) {
    ctx.addIssue({ code: 'custom', path: ['match'], message: 'Price match disagrees with the resolved entry' });
  }
});

const costSchema: z.ZodType<CallCost> = z.object({
  status: z.enum(['complete', 'partial', 'unpriced', 'free']), currency: currency.nullable(),
  amount: amount.nullable(), knownAmount: amount.nullable(), priceId: identifier.nullable(), priceVersion: identifier.nullable(),
  appliedRuleIds: z.array(identifier).max(10_000), unpricedItems: messages, reasons: messages,
}).strict().superRefine((cost, ctx) => {
  if (cost.status === 'complete' || cost.status === 'free') {
    if (cost.currency === null || cost.amount === null || cost.knownAmount === null || cost.unpricedItems.length) {
      ctx.addIssue({ code: 'custom', message: 'A complete or free cost needs currency, both amounts, and no unpriced items' });
      return;
    }
    // Decimal refinements can already have failed. safeParse must still return failure, never throw.
    try {
      const total = parseFixed(cost.amount, MONEY_DECIMALS);
      if (total !== parseFixed(cost.knownAmount, MONEY_DECIMALS) || (cost.status === 'free' ? total !== 0n : total === 0n)) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Cost amount disagrees with status or known amount' });
      }
    } catch { /* The decimal schema owns the validation issue. */ }
  } else if (cost.amount !== null) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'An incomplete cost cannot claim a complete amount' });
  }
  if (cost.knownAmount !== null && cost.currency === null) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'A known amount needs a currency' });
});

const observationSchema: z.ZodType<CallObservation> = z.object({
  attemptId: identifier, route: routeSchema, startedAtMs: milliseconds, endedAtMs: milliseconds,
  firstContentAtMs: milliseconds.nullable(), firstTextAtMs: milliseconds.nullable(), lastContentAtMs: milliseconds.nullable(),
  outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted', 'timeout', 'truncated']),
  streaming: z.boolean(), buffered: z.boolean().optional(), hiddenReasoningSeparable: z.boolean(), toolOnly: z.boolean().optional(),
  visibleTextTokens: count.nullable(), tokenMeasurement: z.enum(['reported', 'tokenizer-approximate']).optional(),
  userPausedMs: milliseconds.optional(), processGapMs: milliseconds.optional(), includedInternalRetryMs: milliseconds.optional(),
  timingSource: identifier,
}).strict();
const routeFields = ['providerId', 'endpointFingerprint', 'modelId', 'requestMode', 'reasoningEffort', 'serviceTier', 'inputBucket', 'cacheBucket', 'concurrencyBucket', 'mixedRoute'] as const;

/** Strict, lossless admission for immutable historical call facts and their original valuation.
 * No repricing, coercion, null defaults, or raw-content passthrough occurs at this boundary.
 * Clock/window anomalies are retained for the performance core to exclude, without losing usage/cost.
 */
export const callRecordSchema: z.ZodType<CallRecord> = z.object({
  id: identifier, savedAt: milliseconds, fact: factSchema, route: routeSchema,
  usage: normalizedUsageSchema, cost: costSchema, resolution: resolutionSchema,
  observation: observationSchema.nullable(),
}).strict().superRefine((record, ctx) => {
  for (const field of ['providerId', 'modelId', 'reasoningEffort'] as const) {
    if (record.fact.route[field] !== record.route[field]) ctx.addIssue({ code: 'custom', path: ['fact', 'route', field], message: 'Fact belongs to a different route' });
  }
  if (record.fact.mode !== record.route.requestMode) ctx.addIssue({ code: 'custom', path: ['route', 'requestMode'], message: 'Request mode disagrees with the fact' });
  if (record.observation && routeFields.some(field => record.observation!.route[field] !== record.route[field])) {
    ctx.addIssue({ code: 'custom', path: ['observation', 'route'], message: 'Observation belongs to a different provider/configuration bucket' });
  }
  const entry = record.resolution.entry;
  if (record.cost.priceId !== (entry?.id ?? null) || record.cost.priceVersion !== (entry?.version ?? null)) {
    ctx.addIssue({ code: 'custom', path: ['cost', 'priceVersion'], message: 'Historical cost and resolved price identity disagree' });
  }
  if (record.cost.currency !== (entry?.currency ?? null)) ctx.addIssue({ code: 'custom', path: ['cost', 'currency'], message: 'Historical cost currency disagrees with the resolved price' });
  if (entry === null && record.cost.status !== 'unpriced') ctx.addIssue({ code: 'custom', path: ['cost', 'status'], message: 'A missing price cannot be presented as priced or free' });
});
