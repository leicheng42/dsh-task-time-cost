import type { EstimateSnapshot } from '../../src/shared/wire.ts';
import { en } from '../../src/client/locale.ts';
import type { MessageKey, Translate } from '../../src/client/locale.ts';

export function translator(dictionary: Record<MessageKey, string> = en): Translate {
  return (key, params = {}) => dictionary[key].replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params[name] ?? `{${name}}`));
}

export function snapshot(overrides: Partial<EstimateSnapshot> = {}): EstimateSnapshot {
  return {
    taskKey: 's:1', sessionId: 's', turn: 1, revision: 1, algorithmVersion: 'test', state: 'running', taskType: 'code',
    updatedAt: 1_000, startedAt: 0, endedAt: null, elapsedWallMs: 1_000, elapsedActiveMs: 1_000, elapsedPausedMs: 0,
    remainingMs: { low: 10_000, high: 20_000 }, estimatedTotalMs: { low: 11_000, high: 21_000 },
    estimateOrigin: 'heuristic', localPerformanceSamples: 0, workloadSamples: 0,
    observedTokenStatus: 'partial', observedTokens: 10, tokens: { input: 10, cacheRead: null, cacheWrite: null, output: null, reasoning: null },
    estimatedTotalTokens: null, knownCost: [{ currency: 'USD', amount: '0.01' }],
    estimatedTotalCost: [{ currency: 'USD', range: { low: '0.02', high: '0.05' } }],
    observedCostStatus: 'partial', forecastCostStatus: 'reference', unpricedCalls: 0, incompleteForecastUnits: 0,
    calls: { completed: 0, active: 1, failed: 0, expected: { low: 1, high: 2 } },
    tools: { completed: 0, active: 0, workMs: 0 }, performance: null, priceSources: [], initial: null,
    error: null, reasons: [], scope: 'current_turn', ...overrides,
  };
}
