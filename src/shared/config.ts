import { alphaValue, nonnegative } from './types.ts';

export interface EstimatorConfig {
  performanceAlpha: number;
  workloadAlpha: number;
  predictionRefreshMs: number;
  timerRefreshMs: number;
  historyRetentionDays: number;
  profileStaleDays: number;
  maxSamplesPerBucket: number;
  minConditionalSamples: number;
  heuristicFirstTextMs: number;
  heuristicVisibleTps: number;
  heuristicTotalCallMs: number;
  referenceLowFactor: number;
  referenceHighFactor: number;
  minGenerationWindowMs: number;
  maxVisibleTps: number;
  toolResultTokensPerCall: { low: number; high: number };
  extraPlanningCall: false;
  magpieIntegration: boolean;
  saveRawContent: boolean;
}

export const DEFAULT_CONFIG: Readonly<EstimatorConfig> = Object.freeze({
  performanceAlpha: 0.2,
  workloadAlpha: 0.2,
  predictionRefreshMs: 5_000,
  timerRefreshMs: 1_000,
  historyRetentionDays: 90,
  profileStaleDays: 7,
  maxSamplesPerBucket: 200,
  minConditionalSamples: 5,
  heuristicFirstTextMs: 10_000,
  heuristicVisibleTps: 80,
  heuristicTotalCallMs: 30_000,
  referenceLowFactor: 0.5,
  referenceHighFactor: 2.5,
  minGenerationWindowMs: 250,
  maxVisibleTps: 2_000,
  toolResultTokensPerCall: Object.freeze({ low: 0, high: 4_000 }),
  extraPlanningCall: false,
  magpieIntegration: false,
  saveRawContent: false,
});

/** Rejects invalid saved values; returns a fresh, fully populated configuration. */
export function validateConfig(input: Partial<EstimatorConfig> = {}): EstimatorConfig {
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_CONFIG)) throw new TypeError(`Unknown configuration field: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...input, toolResultTokensPerCall: { ...DEFAULT_CONFIG.toolResultTokensPerCall, ...input.toolResultTokensPerCall } };
  alphaValue(config.performanceAlpha);
  alphaValue(config.workloadAlpha);
  const positive = ['predictionRefreshMs', 'timerRefreshMs', 'historyRetentionDays', 'profileStaleDays', 'maxSamplesPerBucket', 'minConditionalSamples', 'heuristicVisibleTps', 'referenceHighFactor', 'maxVisibleTps'] as const;
  for (const key of positive) if (nonnegative(config[key], key) === 0) throw new TypeError(`${key} must be positive`);
  for (const key of ['heuristicFirstTextMs', 'heuristicTotalCallMs', 'referenceLowFactor', 'minGenerationWindowMs'] as const) nonnegative(config[key], key);
  for (const key of ['maxSamplesPerBucket', 'minConditionalSamples'] as const) if (!Number.isSafeInteger(config[key])) throw new TypeError(`${key} must be an integer`);
  if (config.referenceLowFactor > 1 || config.referenceHighFactor < 1 || config.referenceLowFactor > config.referenceHighFactor) throw new TypeError('Reference factors must bracket 1');
  const range = config.toolResultTokensPerCall;
  if (!range || !Number.isSafeInteger(range.low) || !Number.isSafeInteger(range.high) || range.low < 0 || range.low > range.high) throw new TypeError('Invalid tool result Token range');
  if (config.extraPlanningCall !== false) throw new TypeError('P0 does not make additional planning calls');
  if (typeof config.magpieIntegration !== 'boolean' || typeof config.saveRawContent !== 'boolean') throw new TypeError('Expected boolean configuration');
  return config;
}
