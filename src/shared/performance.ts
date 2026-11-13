import { DEFAULT_CONFIG, validateConfig } from './config.ts';
import type { EstimatorConfig } from './config.ts';
import { alphaValue, ewma, nonnegative } from './types.ts';
import type { Outcome, RouteIdentity, RouteApplicability, SourceKind } from './types.ts';

export interface PerformancePrior {
  id: string;
  sourceKind: SourceKind;
  firstContentMs: number | null;
  firstTextMs: number | null;
  visibleTps: number | null;
  totalCallMs: number;
  /** Public priors are explicitly matched; local buckets never cross providers. */
  appliesTo?: RouteApplicability;
  sourceUrl?: string | null;
  dataVersion?: string;
  sampleCount?: number | null;
  timingBasis?: string;
  metricOrigins?: { firstContent: SourceKind; firstText: SourceKind; speed: SourceKind; total: SourceKind };
}
export interface CallObservation {
  attemptId: string;
  route: RouteIdentity;
  startedAtMs: number;
  firstContentAtMs: number | null;
  firstTextAtMs: number | null;
  lastContentAtMs: number | null;
  endedAtMs: number;
  outcome: Outcome;
  streaming: boolean;
  buffered?: boolean;
  hiddenReasoningSeparable: boolean;
  toolOnly?: boolean;
  visibleTextTokens: number | null;
  tokenMeasurement?: 'reported' | 'tokenizer-approximate';
  userPausedMs?: number;
  processGapMs?: number;
  /** Already included in endedAtMs - startedAtMs, not added again. */
  includedInternalRetryMs?: number;
  timingSource: string;
}
export interface ProviderProfile {
  key: string;
  route: RouteIdentity;
  prior: PerformancePrior;
  firstContentMs: number | null;
  firstTextMs: number | null;
  totalCallMs: number;
  decayedVisibleTokens: number;
  decayedVisibleSeconds: number;
  realVisibleTokens: number;
  realVisibleSeconds: number;
  totalCallSamples: number;
  firstContentSamples: number;
  firstTextSamples: number;
  speedSamples: number;
  approximateSpeedSamples: number;
  failedCalls: number;
  exclusions: Record<string, number>;
  firstTextWaitSamplesMs: number[];
  totalCallSamplesMs: number[];
  observedAttemptIds: string[];
  lastLocalAtMs: number | null;
}
export interface ProfileUpdate { profile: ProviderProfile; accepted: boolean; speedAccepted: boolean; reasons: string[] }
export interface PerformanceEstimate {
  firstContentMs: number | null;
  firstTextMs: number | null;
  visibleTps: number | null;
  totalCallMs: number;
  sourceKind: SourceKind;
  sourceId: string;
  samples: number;
  speedSamples: number;
  match: 'exact' | 'same-provider-model' | 'public-prior' | 'heuristic';
  /** Observed is a provenance label, never a calibrated statistical confidence. */
  trust: 'observed' | 'reference';
  metricOrigins: { firstContent: SourceKind; firstText: SourceKind; speed: SourceKind; total: SourceKind };
  firstTextWaitSamplesMs: number[];
  totalCallSamplesMs: number[];
  reasons: string[];
}

export function endpointFingerprint(endpoint: string): string {
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('Expected HTTP(S) endpoint');
  // All query/fragment/user-info is omitted; the fingerprint never exposes a path either.
  const canonical = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  let hash = 14695981039346656037n;
  for (const character of canonical) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * 1099511628211n);
  return `endpoint-${hash.toString(16).padStart(16, '0')}`;
}

export function profileKey(route: RouteIdentity): string {
  for (const key of ['providerId', 'endpointFingerprint', 'modelId', 'requestMode', 'reasoningEffort', 'serviceTier'] as const) {
    if (typeof route[key] !== 'string' || !route[key]) throw new TypeError(`Missing route ${key}; use an explicit unknown value when unavailable`);
  }
  return JSON.stringify([route.providerId, route.endpointFingerprint, route.modelId, route.requestMode, route.reasoningEffort, route.serviceTier, route.inputBucket ?? 'unknown', route.cacheBucket ?? 'unknown', route.concurrencyBucket ?? 'unknown', route.mixedRoute ?? false]);
}

export function heuristicPerformance(config: Partial<EstimatorConfig> = {}): PerformancePrior {
  const c = validateConfig(config);
  return { id: 'engineering-startup-v1', sourceKind: 'heuristic', firstContentMs: null, firstTextMs: c.heuristicFirstTextMs, visibleTps: c.heuristicVisibleTps, totalCallMs: c.heuristicTotalCallMs };
}

export function createProfile(route: RouteIdentity, prior = heuristicPerformance()): ProviderProfile {
  for (const key of ['firstContentMs', 'firstTextMs', 'visibleTps'] as const) if (prior[key] !== null) nonnegative(prior[key]!, key);
  if (prior.visibleTps === 0) throw new TypeError('visibleTps must be positive or unknown');
  nonnegative(prior.totalCallMs, 'totalCallMs');
  return {
    key: profileKey(route), route: { ...route }, prior: structuredClone(prior),
    firstContentMs: prior.firstContentMs, firstTextMs: prior.firstTextMs, totalCallMs: prior.totalCallMs,
    decayedVisibleTokens: prior.visibleTps ?? 0, decayedVisibleSeconds: prior.visibleTps === null ? 0 : 1,
    realVisibleTokens: 0, realVisibleSeconds: 0, totalCallSamples: 0, firstContentSamples: 0, firstTextSamples: 0,
    speedSamples: 0, approximateSpeedSamples: 0, failedCalls: 0, exclusions: {}, firstTextWaitSamplesMs: [], totalCallSamplesMs: [], observedAttemptIds: [], lastLocalAtMs: null,
  };
}

export function updateProfile(existing: ProviderProfile, observation: CallObservation, config: Partial<EstimatorConfig> = {}): ProfileUpdate {
  const c = validateConfig(config);
  if (existing.key !== profileKey(observation.route)) throw new TypeError('Observation belongs to a different provider/configuration bucket');
  const profile = structuredClone(existing);
  if (profile.observedAttemptIds.includes(observation.attemptId)) return { profile, accepted: false, speedAccepted: false, reasons: ['duplicate-attempt'] };
  if (!observation.attemptId) throw new TypeError('An attempt identity is required');
  profile.observedAttemptIds.push(observation.attemptId);
  profile.observedAttemptIds = profile.observedAttemptIds.slice(-c.maxSamplesPerBucket);
  const reasons: string[] = [];
  const exclude = (reason: string) => { reasons.push(reason); profile.exclusions[reason] = (profile.exclusions[reason] ?? 0) + 1; };
  const { startedAtMs: start, endedAtMs: end, firstContentAtMs: content, firstTextAtMs: text, lastContentAtMs: last } = observation;
  if (![start, end].every(Number.isFinite) || end < start || [content, text, last].some(value => value !== null && (!Number.isFinite(value) || value < start || value > end)) || (content !== null && text !== null && content > text) || (text !== null && last !== null && text > last)) {
    exclude('invalid-timing');
    return { profile, accepted: false, speedAccepted: false, reasons };
  }
  if (observation.outcome !== 'completed') {
    profile.failedCalls++;
    exclude(`outcome:${observation.outcome}`);
    return { profile, accepted: false, speedAccepted: false, reasons };
  }
  if ((observation.userPausedMs ?? 0) > 0 || (observation.processGapMs ?? 0) > 0) {
    exclude((observation.userPausedMs ?? 0) > 0 ? 'manual-wait' : 'process-gap');
    return { profile, accepted: false, speedAccepted: false, reasons };
  }
  const a = c.performanceAlpha;
  profile.totalCallMs = ewma(profile.totalCallMs, end - start, a);
  profile.totalCallSamples++;
  profile.totalCallSamplesMs = [...profile.totalCallSamplesMs, end - start].slice(-c.maxSamplesPerBucket);
  profile.lastLocalAtMs = end;
  if (content !== null) {
    profile.firstContentMs = profile.firstContentMs === null ? content - start : ewma(profile.firstContentMs, content - start, a);
    profile.firstContentSamples++;
  }
  if (text !== null && !observation.toolOnly) {
    profile.firstTextMs = profile.firstTextMs === null ? text - start : ewma(profile.firstTextMs, text - start, a);
    profile.firstTextSamples++;
    profile.firstTextWaitSamplesMs = [...profile.firstTextWaitSamplesMs, text - start].slice(-c.maxSamplesPerBucket);
  }
  if (!observation.streaming) exclude('non-streaming');
  if (observation.buffered) exclude('buffered-release');
  if (!observation.hiddenReasoningSeparable) exclude('reasoning-unseparated');
  if (observation.toolOnly) exclude('tool-only');
  const tokens = observation.visibleTextTokens;
  if (tokens === null || !Number.isSafeInteger(tokens) || tokens <= 0) exclude('visible-tokens-unavailable');
  const windowMs = text === null || last === null ? null : last - text;
  if (windowMs === null) exclude('text-window-unavailable');
  else if (windowMs < c.minGenerationWindowMs || windowMs === 0) exclude('short-generation-window');
  else if (tokens !== null && tokens / (windowMs / 1000) > c.maxVisibleTps) exclude('extreme-visible-speed');
  const speedAccepted = reasons.length === 0;
  if (speedAccepted) {
    const seconds = windowMs! / 1000;
    profile.decayedVisibleTokens = (1 - a) * profile.decayedVisibleTokens + a * tokens!;
    profile.decayedVisibleSeconds = (1 - a) * profile.decayedVisibleSeconds + a * seconds;
    profile.realVisibleTokens += tokens!;
    profile.realVisibleSeconds += seconds;
    profile.speedSamples++;
    if (observation.tokenMeasurement === 'tokenizer-approximate') profile.approximateSpeedSamples++;
  }
  return { profile, accepted: true, speedAccepted, reasons };
}

export function overallVisibleTps(profiles: ProviderProfile[]): { tokens: number; seconds: number; tps: number | null; samples: number } {
  const tokens = profiles.reduce((sum, profile) => sum + profile.realVisibleTokens, 0);
  const seconds = profiles.reduce((sum, profile) => sum + profile.realVisibleSeconds, 0);
  return { tokens, seconds, tps: seconds > 0 ? tokens / seconds : null, samples: profiles.reduce((sum, profile) => sum + profile.speedSamples, 0) };
}

export function selectPerformance(route: RouteIdentity, profiles: ProviderProfile[], priors: PerformancePrior[] = [], nowMs = Date.now(), config: Partial<EstimatorConfig> = {}): PerformanceEstimate {
  const c = validateConfig(config);
  nonnegative(nowMs, 'nowMs');
  const key = profileKey(route);
  const stale = (profile: ProviderProfile) => profile.lastLocalAtMs === null || nowMs - profile.lastLocalAtMs > c.profileStaleDays * 86_400_000;
  const exact = profiles.find(profile => profile.key === key && !stale(profile));
  const compatible = (profile: ProviderProfile) => profile.route.providerId === route.providerId && profile.route.modelId === route.modelId && profile.route.requestMode === route.requestMode && profile.route.reasoningEffort === route.reasoningEffort && profile.route.serviceTier === route.serviceTier && !!profile.route.mixedRoute === !!route.mixedRoute;
  const alternative = route.providerId === 'unknown' ? undefined : profiles.filter(profile => compatible(profile) && !stale(profile)).sort((a, b) => b.lastLocalAtMs! - a.lastLocalAtMs!)[0];
  const selected = exact ?? alternative;
  const reasons: string[] = [];
  if (profiles.some(profile => profile.key === key && stale(profile))) reasons.push('stale-profile-retained-for-audit');
  if (route.mixedRoute) reasons.push('mixed-route-upstream-unknown');
  if (route.endpointFingerprint === 'unknown') reasons.push('endpoint-identity-unknown');
  if (route.providerId === 'unknown') reasons.push('provider-identity-unknown');
  if (selected) return {
    firstContentMs: selected.firstContentMs, firstTextMs: selected.firstTextMs,
    visibleTps: selected.decayedVisibleSeconds > 0 ? selected.decayedVisibleTokens / selected.decayedVisibleSeconds : null,
    totalCallMs: selected.totalCallMs, sourceKind: 'local-measured', sourceId: selected.key,
    samples: selected.totalCallSamples, speedSamples: selected.speedSamples, match: exact ? 'exact' : 'same-provider-model',
    trust: exact && !route.mixedRoute && [route.providerId, route.endpointFingerprint, route.modelId, route.reasoningEffort, route.serviceTier].every(value => value !== 'unknown') ? 'observed' : 'reference',
    metricOrigins: { firstContent: selected.firstContentSamples ? 'local-measured' : selected.prior.metricOrigins?.firstContent ?? selected.prior.sourceKind, firstText: selected.firstTextSamples ? 'local-measured' : selected.prior.metricOrigins?.firstText ?? selected.prior.sourceKind, speed: selected.speedSamples ? 'local-measured' : selected.prior.metricOrigins?.speed ?? selected.prior.sourceKind, total: 'local-measured' },
    firstTextWaitSamplesMs: [...selected.firstTextWaitSamplesMs], totalCallSamplesMs: [...selected.totalCallSamplesMs],
    reasons: [...reasons, ...(!exact ? ['same-provider-model-fallback'] : []), ...(selected.speedSamples === 0 ? ['visible-speed-still-prior'] : []), ...(route.reasoningEffort === 'unknown' ? ['reasoning-mode-unknown'] : [])],
  };
  const applies = (prior: PerformancePrior) => prior.appliesTo && Object.entries(prior.appliesTo).every(([field, value]) => value === undefined || value === '*' || route[field as keyof RouteIdentity] === value);
  const prior = priors.find(prior => prior.sourceKind === 'public-measured' && prior.appliesTo?.modelId === route.modelId && prior.appliesTo.endpointFingerprint !== undefined && !['*', 'unknown'].includes(prior.appliesTo.endpointFingerprint) && applies(prior));
  if (!prior && priors.some(item => item.sourceKind === 'public-measured' && item.appliesTo?.modelId === route.modelId)) reasons.push('public-prior-endpoint-or-configuration-not-matched');
  const engineeringPrior = priors.find(prior => prior.sourceKind === 'heuristic' && applies(prior));
  const chosen = prior ?? engineeringPrior ?? heuristicPerformance(c);
  return { firstContentMs: chosen.firstContentMs, firstTextMs: chosen.firstTextMs, visibleTps: chosen.visibleTps, totalCallMs: chosen.totalCallMs, sourceKind: chosen.sourceKind, sourceId: chosen.id, samples: 0, speedSamples: 0, match: prior ? 'public-prior' : 'heuristic', trust: 'reference', metricOrigins: chosen.metricOrigins ?? { firstContent: chosen.sourceKind, firstText: chosen.sourceKind, speed: chosen.sourceKind, total: chosen.sourceKind }, firstTextWaitSamplesMs: [], totalCallSamplesMs: [], reasons: [...reasons, ...(prior ? ['public-endpoint-reference'] : ['engineering-assumption']), ...(route.reasoningEffort === 'unknown' ? ['reasoning-mode-unknown'] : [])] };
}
