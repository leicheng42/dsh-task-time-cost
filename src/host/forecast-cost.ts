import { estimateRequestCostRange } from '../shared/forecast.ts';
import { resolveWithPublicPrices } from '../shared/public-prices.ts';
import type { ForecastCostUnit } from '../shared/pricing.ts';
import type { RequestBudget } from '../shared/workload.ts';
import type { PluginConfig, RouteOverride } from './config.ts';

export function forecastCall(request: RequestBudget, config: PluginConfig, route: RouteOverride | undefined, at: string): ForecastCostUnit {
  const resolution = resolveWithPublicPrices({ providerId: request.route.providerId, requestedModelId: request.route.modelId, endpointFingerprint: request.route.endpointFingerprint }, config.prices, config.sameAs, at, config.usePublicPriceCatalog);
  return estimateRequestCostRange(request, resolution, {
    ...(route?.forecastCacheReadRatio ? { cacheReadRatio: route.forecastCacheReadRatio } : {}),
    ...(route?.forecastCacheWrite5mTokens ? { cacheWrite5mTokens: route.forecastCacheWrite5mTokens } : {}),
    ...(route?.forecastCacheWrite1hTokens ? { cacheWrite1hTokens: route.forecastCacheWrite1hTokens } : {}),
    ...(route?.forecastReasoningTokens ? { reasoningTokens: route.forecastReasoningTokens } : {}),
    outputIncludesReasoning: true,
  }, { at, serviceTier: request.route.serviceTier });
}
