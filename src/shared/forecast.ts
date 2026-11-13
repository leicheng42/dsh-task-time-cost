import { normalizeUsage } from './usage.ts';
import type { NormalizedUsage } from './usage.ts';
import { assertSpan } from './types.ts';
import type { Span } from './types.ts';
import type { RequestBudget } from './workload.ts';
import { estimateCallCost } from './pricing.ts';
import type { CallCost, PriceResolution, PriceContext } from './pricing.ts';
import { MONEY_DECIMALS, parseFixed } from './money.ts';

export interface BillingScenario {
  cacheReadRatio?: Span;
  cacheWrite5mTokens?: Span;
  cacheWrite1hTokens?: Span;
  reasoningTokens?: Span | null;
  outputIncludesReasoning?: boolean | 'unknown';
}

/** Scenario estimates explicitly require cache/hidden-reasoning assumptions; unknown is never zero. */
export function estimateBudgetUsage(request: RequestBudget, bound: 'low' | 'high', scenario: BillingScenario = {}): { usage: NormalizedUsage; reasons: string[] } {
  const reasons: string[] = ['forecast-scenario-reference'];
  const ratio = scenario.cacheReadRatio ?? request.cacheReadRatio;
  if (ratio) {
    assertSpan(ratio, 'cacheReadRatio');
    if (ratio.high > 1) throw new TypeError('Cache ratio must be in [0,1]');
  }
  for (const value of [scenario.cacheWrite5mTokens, scenario.cacheWrite1hTokens, scenario.reasoningTokens, request.inputTokens, request.reasoningTokens, request.visibleOutputTokens]) if (value) assertSpan(value);
  const prompt = request.inputTokens?.[bound] ?? null;
  if (prompt !== null && !Number.isSafeInteger(prompt)) throw new TypeError('Forecast input Tokens must be integers');
  const write5 = prompt === 0 ? 0 : scenario.cacheWrite5mTokens?.[bound] ?? null;
  const write1 = prompt === 0 ? 0 : scenario.cacheWrite1hTokens?.[bound] ?? null;
  // More cache can lower cost, so low/high cost must be evaluated across scenarios by the caller.
  const read = prompt === 0 ? 0 : prompt !== null && ratio ? Math.floor(prompt * ratio[bound]) : null;
  const input = prompt !== null && read !== null && write5 !== null && write1 !== null ? prompt - read - write5 - write1 : null;
  if (input !== null && input < 0) throw new TypeError('Cache forecast exceeds prompt budget');
  if (input === null) reasons.push('future-input-cache-split-unknown');
  const reasoning = scenario.reasoningTokens === undefined ? request.reasoningTokens?.[bound] ?? null : scenario.reasoningTokens?.[bound] ?? null;
  if (reasoning === null) reasons.push('future-reasoning-budget-unknown');
  const visible = request.visibleOutputTokens[bound];
  const includes = scenario.outputIncludesReasoning ?? true;
  const output = includes === true ? reasoning !== null ? visible + reasoning : null : visible;
  return { usage: normalizeUsage({ inputTokens: input, cacheReadTokens: read, cacheWrite5mTokens: write5, cacheWrite1hTokens: write1, outputTokens: output, reasoningTokens: reasoning, visibleOutputTokens: visible }, { schema: 'dsh', outputIncludesReasoning: includes }), reasons };
}

export interface RequestCostRange { low: CallCost; high: CallCost; scenarioCount: number; reasons: string[] }

/** Evaluates joint range corners and prompt-tier boundaries. Cache discounts can reverse low/high. */
export function estimateRequestCostRange(request: RequestBudget, resolution: PriceResolution, scenario: BillingScenario = {}, context: PriceContext = {}): RequestCostRange {
  // Shared validation includes cache [0,1] and the Token range contracts.
  for (const range of [request.inputTokens, request.visibleOutputTokens, request.reasoningTokens, scenario.reasoningTokens, scenario.cacheWrite5mTokens, scenario.cacheWrite1hTokens]) if (range) {
    assertSpan(range);
    if (!Number.isSafeInteger(range.low) || !Number.isSafeInteger(range.high)) throw new TypeError('Forecast Token bounds must be safe integers');
  }
  const ratio = scenario.cacheReadRatio ?? request.cacheReadRatio;
  if (ratio && (assertSpan(ratio, 'cacheReadRatio').high > 1)) throw new TypeError('Cache ratio must be in [0,1]');
  const values = (range: Span | null | undefined): (number | null)[] => range ? [...new Set([range.low, range.high])] : [null];
  const prompts = values(request.inputTokens);
  if (request.inputTokens) for (const rule of resolution.entry?.rules ?? []) {
    const threshold = rule.when.promptTokensAbove;
    if (threshold !== undefined) for (const candidate of [threshold, threshold + 1]) if (candidate >= request.inputTokens.low && candidate <= request.inputTokens.high && !prompts.includes(candidate)) prompts.push(candidate);
  }
  const results: CallCost[] = [];
  const reasoningRange = scenario.reasoningTokens === undefined ? request.reasoningTokens : scenario.reasoningTokens;
  for (const prompt of prompts) for (const write5 of prompt === 0 ? [0] : values(scenario.cacheWrite5mTokens)) for (const write1 of prompt === 0 ? [0] : values(scenario.cacheWrite1hTokens)) {
    let reads: (number | null)[] = prompt === 0 ? [0] : prompt !== null && ratio ? [...new Set([Math.floor(prompt * ratio.low), Math.floor(prompt * ratio.high)])] : [null];
    if (prompt !== null && write5 !== null && write1 !== null && ratio) {
      const maxRead = prompt - write5 - write1;
      const minRead = Math.floor(prompt * ratio.low);
      const highRead = Math.floor(prompt * ratio.high);
      if (maxRead < minRead) continue;
      if (maxRead <= highRead && !reads.includes(maxRead)) reads.push(maxRead);
      reads = reads.filter(read => read === null || read <= maxRead);
    }
    for (const read of reads) for (const visible of values(request.visibleOutputTokens)) for (const reasoning of values(reasoningRange)) {
      const input = prompt !== null && read !== null && write5 !== null && write1 !== null ? prompt - read - write5 - write1 : null;
      if (input !== null && input < 0) continue;
      const includes = scenario.outputIncludesReasoning ?? true;
      const output = includes === true ? reasoning !== null ? visible! + reasoning : null : visible;
      const usage = normalizeUsage({ inputTokens: input, cacheReadTokens: read, cacheWrite5mTokens: write5, cacheWrite1hTokens: write1, outputTokens: output, reasoningTokens: reasoning, visibleOutputTokens: visible }, { schema: 'dsh', outputIncludesReasoning: includes });
      results.push(estimateCallCost(usage, resolution, context));
    }
  }
  if (!results.length) throw new TypeError('No feasible cache/input forecast scenario');
  const incomplete = results.find(result => result.amount === null);
  if (incomplete) return { low: incomplete, high: incomplete, scenarioCount: results.length, reasons: ['forecast-scenario-incomplete', 'unknown-not-zero'] };
  results.sort((a, b) => {
    const left = parseFixed(a.amount!, MONEY_DECIMALS);
    const right = parseFixed(b.amount!, MONEY_DECIMALS);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { low: results[0], high: results.at(-1)!, scenarioCount: results.length, reasons: ['forecast-scenario-reference', 'cache-cost-extremes-evaluated-separately', 'prompt-threshold-boundaries-evaluated'] };
}
