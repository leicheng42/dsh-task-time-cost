import type { MessageKey } from './locale.ts';

export const configFields: ReadonlyArray<{ key: string; label: MessageKey; min: number; max?: number; step: number }> = [
  { key: 'performanceAlpha', label: 'performanceAlpha', min: 0.01, max: 1, step: 0.01 },
  { key: 'workloadAlpha', label: 'workloadAlpha', min: 0.01, max: 1, step: 0.01 },
  { key: 'predictionRefreshMs', label: 'predictionRefreshMs', min: 1, step: 1 },
  { key: 'timerRefreshMs', label: 'timerRefreshMs', min: 1, step: 1 },
  { key: 'historyRetentionDays', label: 'historyRetentionDays', min: 1, step: 1 },
  { key: 'profileStaleDays', label: 'profileStaleDays', min: 1, step: 1 },
  { key: 'minConditionalSamples', label: 'minConditionalSamples', min: 1, step: 1 },
  { key: 'heuristicFirstTextMs', label: 'heuristicFirstTextMs', min: 0, step: 1 },
  { key: 'heuristicVisibleTps', label: 'heuristicVisibleTps', min: 0.01, step: 0.1 },
  { key: 'heuristicTotalCallMs', label: 'heuristicTotalCallMs', min: 0, step: 1 },
];

export function parseConfiguration(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('CONFIG_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

export function numericFields(config: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(configFields.map(({ key }) => [key, typeof config[key] === 'number' ? String(config[key]) : '']));
}
