import { BILLABLE_CATEGORIES, INPUT_CATEGORIES } from './usage.ts';
import type { BillableCategory, InputCategory, NormalizedUsage } from './usage.ts';
import { formatFixed, MONEY_DECIMALS, multiplyMoney, parseFixed, RATE_DECIMALS, tokenCost } from './money.ts';
import type { CostStatus, Money, MoneyRange, ForecastCostStatus, SourceKind } from './types.ts';

export type UnitPrices = Partial<Record<BillableCategory, string | null>>;
export type PricePriority = 'user-exact' | 'provider-wildcard' | 'provider-catalog' | 'public-catalog';
export interface PriceRule {
  id: string;
  when: { promptTokensAbove?: number; serviceTier?: string; utcHours?: { start: number; end: number } };
  mode?: 'whole-request' | 'excess-only';
  /** Required for excess-only: declares how the prompt threshold consumes input buckets. */
  allocationOrder?: InputCategory[];
  prices?: UnitPrices;
  multiplier?: string;
}
export interface PriceEntry {
  id: string;
  providerId: string;
  endpointFingerprint?: string;
  modelId: string;
  priority: PricePriority;
  currency: string;
  unit: 'per-million-tokens';
  prices: UnitPrices;
  explicitFree?: boolean;
  multiplier?: string;
  rules?: PriceRule[];
  sourceKind: SourceKind;
  sourceUrl: string | null;
  version: string;
  effectiveFrom: string;
  effectiveUntil?: string;
}
export interface PriceIdentity {
  providerId: string;
  endpointFingerprint?: string;
  requestedModelId: string;
  servedModelId?: string;
  /** Set false if even the chargeable provider/model identity cannot be established. */
  billingIdentityConfirmed?: boolean;
}
export interface SameAs {
  providerId: string;
  modelId: string;
  targetProviderId: string;
  targetModelId: string;
  targetEndpointFingerprint?: string;
}
export interface PriceResolution {
  entry: PriceEntry | null;
  match: PricePriority | 'same-as' | 'unpriced';
  billingModelId: string;
  reasons: string[];
}
export interface PriceContext { at?: string; serviceTier?: string }
export interface CallCost {
  status: CostStatus;
  currency: string | null;
  /** Null means the complete amount is unknown. knownAmount remains a lower subtotal. */
  amount: string | null;
  knownAmount: string | null;
  priceId: string | null;
  priceVersion: string | null;
  appliedRuleIds: string[];
  unpricedItems: string[];
  reasons: string[];
}

const PRIORITY: Record<PricePriority, number> = { 'user-exact': 0, 'provider-wildcard': 1, 'provider-catalog': 2, 'public-catalog': 3 };
function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(value);
}
function validDate(value: string): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

export function validatePrices(entries: PriceEntry[], aliases: SameAs[] = []): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id)) throw new TypeError('Price ids must be unique and nonempty');
    ids.add(entry.id);
    if (!entry.providerId || !entry.modelId || !(entry.priority in PRIORITY) || !/^[A-Z]{3}$/.test(entry.currency)) throw new TypeError(`Invalid price identity: ${entry.id}`);
    if (entry.unit !== 'per-million-tokens' || !entry.version || !['heuristic', 'local-measured', 'public-measured'].includes(entry.sourceKind) || !validDate(entry.effectiveFrom)) throw new TypeError(`Invalid price metadata: ${entry.id}`);
    if (entry.effectiveUntil && (!validDate(entry.effectiveUntil) || Date.parse(entry.effectiveUntil) <= Date.parse(entry.effectiveFrom))) throw new TypeError('Invalid price effective interval');
    if (entry.priority !== 'provider-wildcard' && entry.modelId.includes('*')) throw new TypeError('Only explicit provider-wildcard prices may contain wildcards');
    validateRates(entry.prices);
    if (entry.multiplier !== undefined) parseFixed(entry.multiplier, RATE_DECIMALS);
    if (entry.explicitFree && (Object.values(entry.prices).some(value => value != null && parseFixed(value, RATE_DECIMALS) !== 0n) || entry.rules?.some(rule => Object.values(rule.prices ?? {}).some(value => value != null && parseFixed(value, RATE_DECIMALS) !== 0n)))) throw new TypeError('A free entry cannot contain paid rates');
    const ruleIds = new Set<string>();
    const excessCategories = new Set<string>();
    for (const rule of entry.rules ?? []) {
      if (!rule.id || ruleIds.has(rule.id)) throw new TypeError('Rule ids must be unique within a price');
      ruleIds.add(rule.id);
      if (!rule.when || (rule.mode && !['whole-request', 'excess-only'].includes(rule.mode))) throw new TypeError('Invalid pricing rule');
      if (rule.when.promptTokensAbove !== undefined && (!Number.isSafeInteger(rule.when.promptTokensAbove) || rule.when.promptTokensAbove < 0)) throw new TypeError('Invalid prompt threshold');
      if (rule.when.utcHours) {
        const { start, end } = rule.when.utcHours;
        if (![start, end].every(hour => Number.isInteger(hour) && hour >= 0 && hour < 24) || start === end) throw new TypeError('Invalid UTC rate window');
      }
      validateRates(rule.prices ?? {});
      if (rule.multiplier !== undefined) parseFixed(rule.multiplier, RATE_DECIMALS);
      if (rule.mode === 'excess-only') {
        if (rule.when.promptTokensAbove === undefined || !rule.prices || rule.prices.outputTokens !== undefined || rule.multiplier !== undefined) throw new TypeError('Excess-only needs a prompt threshold and input prices, without an output override or multiplier');
        if (!rule.allocationOrder || rule.allocationOrder.length !== INPUT_CATEGORIES.length || new Set(rule.allocationOrder).size !== INPUT_CATEGORIES.length || rule.allocationOrder.some(key => !INPUT_CATEGORIES.includes(key))) throw new TypeError('Excess-only requires an exhaustive input allocation order');
        for (const category of Object.keys(rule.prices)) {
          if (excessCategories.has(category)) throw new TypeError('Overlapping excess-only category rules are not supported');
          excessCategories.add(category);
        }
      }
    }
  }
  const keys = new Set<string>();
  for (const alias of aliases) {
    const key = JSON.stringify([alias.providerId, alias.modelId]);
    if (!alias.providerId || !alias.modelId || !alias.targetProviderId || !alias.targetModelId || keys.has(key)) throw new TypeError('Invalid or duplicate Same as identity');
    keys.add(key);
    const seen = new Set<string>([key]);
    let current = alias;
    while (current) {
      const target = JSON.stringify([current.targetProviderId, current.targetModelId]);
      if (seen.has(target)) throw new TypeError('Cyclic Same as price alias');
      seen.add(target);
      current = aliases.find(item => JSON.stringify([item.providerId, item.modelId]) === target)!;
    }
  }
}
function validateRates(prices: UnitPrices): void {
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) throw new TypeError('Prices must be an object');
  for (const [key, value] of Object.entries(prices)) {
    if (!BILLABLE_CATEGORIES.includes(key as BillableCategory)) throw new TypeError(`Unknown price category: ${key}`);
    if (value !== null) parseFixed(value, RATE_DECIMALS);
  }
}

export function resolvePrice(identity: PriceIdentity, entries: PriceEntry[], aliases: SameAs[] = [], at = new Date().toISOString()): PriceResolution {
  validatePrices(entries, aliases);
  if (!validDate(at)) throw new TypeError('Invalid pricing date');
  const model = identity.servedModelId ?? identity.requestedModelId;
  if (identity.billingIdentityConfirmed === false) return { entry: null, match: 'unpriced', billingModelId: model, reasons: ['billing-identity-unknown'] };
  const time = Date.parse(at);
  const pick = (provider: string, modelId: string, endpoint?: string) => entries.filter(entry =>
    (entry.providerId === provider || (entry.priority === 'public-catalog' && entry.providerId === '*')) &&
    (entry.endpointFingerprint === undefined || entry.endpointFingerprint === endpoint) &&
    (entry.priority === 'provider-wildcard' ? wildcardMatch(entry.modelId, modelId) : entry.modelId === modelId) &&
    Date.parse(entry.effectiveFrom) <= time && (!entry.effectiveUntil || time < Date.parse(entry.effectiveUntil)),
  ).sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || Number(!!b.endpointFingerprint) - Number(!!a.endpointFingerprint) || Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
  let matches = pick(identity.providerId, model, identity.endpointFingerprint);
  if (matches[0]) return { entry: structuredClone(matches[0]), match: matches[0].priority, billingModelId: model, reasons: matches[0].priority === 'public-catalog' ? ['public-reference-price-not-provider-bill'] : [] };
  let provider = identity.providerId;
  let aliasModel = model;
  let endpoint = identity.endpointFingerprint;
  let aliased = false;
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases.find(item => item.providerId === provider && item.modelId === aliasModel);
    if (!alias) break;
    aliased = true;
    provider = alias.targetProviderId;
    aliasModel = alias.targetModelId;
    endpoint = alias.targetEndpointFingerprint;
    matches = pick(provider, aliasModel, endpoint);
    if (matches[0]) return { entry: structuredClone(matches[0]), match: 'same-as', billingModelId: model, reasons: ['user-explicit-same-as-reference'] };
  }
  return { entry: null, match: 'unpriced', billingModelId: model, reasons: [aliased ? 'same-as-target-unpriced' : 'no-matching-price'] };
}

export function estimateCallCost(usage: NormalizedUsage, resolution: PriceResolution, context: PriceContext = {}): CallCost {
  const entry = resolution.entry;
  const base = { priceId: entry?.id ?? null, priceVersion: entry?.version ?? null, appliedRuleIds: [] as string[], reasons: [...resolution.reasons, ...usage.diagnostics], unpricedItems: [] as string[] };
  if (!entry) return { ...base, status: 'unpriced', currency: null, amount: null, knownAmount: null, unpricedItems: ['price'] };
  validatePrices([entry]);
  if (entry.explicitFree) return { ...base, status: 'free', currency: entry.currency, amount: '0', knownAmount: '0' };
  let prices = { ...entry.prices };
  const multipliers = entry.multiplier === undefined ? [] : [entry.multiplier];
  const excessRules: PriceRule[] = [];
  const uncertainCategories = new Set<BillableCategory>();
  let unknownMultiplier = false;
  for (const rule of entry.rules ?? []) {
    const decision = ruleApplies(rule, usage, context);
    if (decision === null) {
      base.unpricedItems.push(`rule-condition:${rule.id}`);
      if (rule.multiplier !== undefined) unknownMultiplier = true;
      for (const category of Object.keys(rule.prices ?? {})) uncertainCategories.add(category as BillableCategory);
      continue;
    }
    if (!decision) continue;
    base.appliedRuleIds.push(rule.id);
    if (rule.mode === 'excess-only') excessRules.push(rule);
    else prices = { ...prices, ...rule.prices };
    if (rule.multiplier !== undefined) multipliers.push(rule.multiplier);
  }
  if (unknownMultiplier) return { ...base, status: 'unpriced', currency: entry.currency, amount: null, knownAmount: null, reasons: [...base.reasons, 'price-multiplier-condition-unknown'] };
  for (const category of uncertainCategories) prices[category] = null;
  let known = 0n;
  let knownComponents = 0;
  const categoryCosts = new Map<BillableCategory, bigint>();
  for (const category of BILLABLE_CATEGORIES) {
    const tokens = usage[category];
    const price = prices[category];
    if (tokens === 0 || (price != null && parseFixed(price, RATE_DECIMALS) === 0n)) {
      knownComponents++;
      categoryCosts.set(category, 0n);
    } else if (tokens === null || price == null) base.unpricedItems.push(`${category}:${tokens === null ? 'usage' : 'price'}`);
    else {
      knownComponents++;
      categoryCosts.set(category, tokenCost(tokens, price));
    }
  }
  for (const rule of excessRules) {
    let covered = rule.when.promptTokensAbove!;
    for (const category of rule.allocationOrder!) {
      const tokens = usage[category]!;
      const baseTokens = Math.min(tokens, covered);
      covered -= baseTokens;
      const excess = tokens - baseTokens;
      if (excess === 0 || rule.prices![category] === undefined) continue;
      const basePrice = prices[category];
      const excessPrice = rule.prices![category];
      if (basePrice == null || excessPrice == null) {
        categoryCosts.delete(category);
        base.unpricedItems.push(`${category}:excess-price`);
      } else categoryCosts.set(category, tokenCost(baseTokens, basePrice) + tokenCost(excess, excessPrice));
    }
  }
  known = [...categoryCosts.values()].reduce((sum, value) => sum + value, 0n);
  for (const multiplier of multipliers) known = multiplyMoney(known, multiplier);
  if (usage.diagnostics.some(reason => reason.startsWith('invalid:') || reason.startsWith('conflict:'))) base.unpricedItems.push('usage-integrity');
  const complete = base.unpricedItems.length === 0;
  const amount = formatFixed(known);
  return {
    ...base,
    status: complete ? (known === 0n ? 'free' : 'complete') : knownComponents > 0 ? 'partial' : 'unpriced',
    currency: entry.currency,
    amount: complete ? amount : null,
    knownAmount: categoryCosts.size ? amount : null,
  };
}

function ruleApplies(rule: PriceRule, usage: NormalizedUsage, context: PriceContext): boolean | null {
  if (rule.when.serviceTier !== undefined) {
    if (context.serviceTier === undefined) return null;
    if (context.serviceTier !== rule.when.serviceTier) return false;
  }
  if (rule.when.promptTokensAbove !== undefined) {
    if (usage.promptTokens === null) return null;
    if (usage.promptTokens <= rule.when.promptTokensAbove) return false;
  }
  if (rule.when.utcHours) {
    if (!context.at || !validDate(context.at)) return null;
    const hour = new Date(context.at).getUTCHours();
    const { start, end } = rule.when.utcHours;
    if (!(start < end ? hour >= start && hour < end : hour >= start || hour < end)) return false;
  }
  return true;
}

export interface CostAggregate { status: CostStatus; knownCost: Money[]; totalCost: Money[] | null; unpricedCalls: number; reasons: string[] }
export function aggregateCosts(costs: CallCost[], toolCosts: Money[] = []): CostAggregate {
  const totals = new Map<string, bigint>();
  for (const cost of costs) if (cost.currency && cost.knownAmount !== null) totals.set(cost.currency, (totals.get(cost.currency) ?? 0n) + parseFixed(cost.knownAmount, MONEY_DECIMALS));
  for (const cost of toolCosts) {
    if (!/^[A-Z]{3}$/.test(cost.currency)) throw new TypeError('Invalid tool cost currency');
    totals.set(cost.currency, (totals.get(cost.currency) ?? 0n) + parseFixed(cost.amount, MONEY_DECIMALS));
  }
  const unpricedCalls = costs.filter(cost => cost.status === 'partial' || cost.status === 'unpriced').length;
  const knownCost = [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount: formatFixed(amount) }));
  const status: CostStatus = unpricedCalls ? knownCost.length ? 'partial' : 'unpriced' : costs.length + toolCosts.length > 0 && knownCost.every(cost => cost.amount === '0') ? 'free' : 'complete';
  return { status, knownCost, totalCost: unpricedCalls ? null : knownCost, unpricedCalls, reasons: [...new Set(costs.flatMap(cost => cost.reasons))] };
}

export interface ForecastCostUnit { low: CallCost; high: CallCost }
export function aggregateForecastCosts(observed: CostAggregate, forecast: ForecastCostUnit[]): { status: ForecastCostStatus; remainingCost: MoneyRange[] | null; totalCost: MoneyRange[] | null; incompleteUnits: number } {
  const incompleteUnits = forecast.filter(unit => unit.low.amount === null || unit.high.amount === null || unit.low.currency !== unit.high.currency).length;
  const sums = new Map<string, { low: bigint; high: bigint }>();
  for (const unit of forecast) {
    if (unit.low.amount === null || unit.high.amount === null || !unit.low.currency || unit.low.currency !== unit.high.currency) continue;
    const low = parseFixed(unit.low.amount, MONEY_DECIMALS);
    const high = parseFixed(unit.high.amount, MONEY_DECIMALS);
    if (low > high) throw new TypeError('Forecast cost bounds are inverted');
    const sum = sums.get(unit.low.currency) ?? { low: 0n, high: 0n };
    sums.set(unit.low.currency, { low: sum.low + low, high: sum.high + high });
  }
  const remaining = [...sums].map(([currency, range]) => ({ currency, range: { low: formatFixed(range.low), high: formatFixed(range.high) } }));
  if (incompleteUnits) return { status: sums.size ? 'partial' : 'unavailable', remainingCost: null, totalCost: null, incompleteUnits };
  const allFree = remaining.every(item => item.range.high === '0');
  const remainingCost = remaining;
  for (const known of observed.knownCost) {
    const sum = sums.get(known.currency) ?? { low: 0n, high: 0n };
    const value = parseFixed(known.amount, MONEY_DECIMALS);
    sums.set(known.currency, { low: sum.low + value, high: sum.high + value });
  }
  const totalCost = observed.unpricedCalls ? null : [...sums].map(([currency, range]) => ({ currency, range: { low: formatFixed(range.low), high: formatFixed(range.high) } }));
  return { status: allFree ? 'free' : 'reference', remainingCost, totalCost, incompleteUnits };
}
