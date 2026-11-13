import type { EstimateSnapshot, Money, MoneyRange, ProfileSummary, Span, TaskState } from '../shared/wire.ts';
import type { MessageKey, Translate } from './locale.ts';

export function numberLocale(locale: string): string {
  return locale.startsWith('zh') ? 'zh-CN' : locale || 'en';
}

export function formatNumber(value: number | null | undefined, locale: string, t: Translate, fractionDigits = 0): string {
  if (value == null || !Number.isFinite(value) || value < 0) return t('unknown');
  return new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: fractionDigits }).format(value);
}

/**
 * Durations use unit letters so every row keeps the same narrow footprint in
 * both locales; above ten minutes the seconds are dropped because a one-line
 * ETA is read as "about how long", not as a stopwatch.
 */
export function formatDuration(milliseconds: number | null | undefined, t: Translate): string {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return t('unknown');
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return t('durationSeconds', { value: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    if (rest === 0) return t('durationMinutesOnly', { value: minutes });
    return minutes >= 10 ? t('durationMinutesOnly', { value: minutes }) : t('durationMinutes', { value: minutes, seconds: rest });
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (restMinutes === 0) return t('durationHoursOnly', { value: hours });
  return hours >= 10 ? t('durationHoursOnly', { value: hours }) : t('durationHours', { value: hours, minutes: restMinutes });
}

export function formatLatency(milliseconds: number | null | undefined, locale: string, t: Translate): string {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return t('unknown');
  if (milliseconds < 1_000) return t('durationMilliseconds', { value: formatNumber(milliseconds, locale, t, 1) });
  if (milliseconds < 60_000) return t('durationSeconds', { value: formatNumber(milliseconds / 1_000, locale, t, 2) });
  return formatDuration(milliseconds, t);
}

export function validSpan(range: Span | null | undefined): range is Span {
  return !!range && Number.isFinite(range.low) && Number.isFinite(range.high) && range.low >= 0 && range.low <= range.high;
}

export function formatDurationRange(range: Span | null | undefined, t: Translate): string {
  if (!validSpan(range)) return t('unknown');
  const low = formatDuration(range.low, t);
  const high = formatDuration(range.high, t);
  return low === high ? low : t('range', { low, high });
}

/**
 * Rounding steps for a forecast. An estimate is not a stopwatch: a minute-level
 * figure such as "8m–30m" is what a reader acts on, while "8m 30s" claims a
 * precision the model does not have. Bounds deliberately snap outward so the
 * printed interval never looks narrower than the computed one.
 */
const ETA_STEPS: ReadonlyArray<readonly [number, number]> = [
  [60_000, 15_000], [600_000, 60_000], [3_600_000, 300_000], [Number.POSITIVE_INFINITY, 900_000],
];
function roundEta(milliseconds: number, direction: 'down' | 'up'): number {
  const step = ETA_STEPS.find(([limit]) => milliseconds < limit)![1];
  const rounded = direction === 'down' ? Math.floor(milliseconds / step) * step : Math.ceil(milliseconds / step) * step;
  return Math.max(0, rounded);
}
/** Coarse duration: whole minutes above a minute, so no bound prints stray seconds. */
function formatCoarse(ms: number, t: Translate): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return t('durationSeconds', { value: Math.round(ms / 1_000) });
  if (minutes < 60) return t('durationMinutesOnly', { value: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t('durationHoursOnly', { value: hours }) : t('durationHours', { value: hours, minutes: rest });
}

/** Wide early references should not masquerade as a useful countdown. */
export function isWideEta(range: Span | null | undefined): boolean {
  return validSpan(range) && range.high - range.low >= 300_000 && range.high >= Math.max(60_000, range.low) * 4;
}

/** Compact ETA for the one-line display: coarse bounds, latin units, stable width. */
export function formatEta(range: Span | null | undefined, t: Translate): string {
  if (!validSpan(range)) return t('unknown');
  const roundedLow = roundEta(range.low, 'down');
  const low = formatCoarse(roundedLow, t);
  const high = formatCoarse(roundEta(range.high, 'up'), t);
  if (range.high > 0 && roundedLow === 0) return t('upTo', { value: high });
  return low === high ? low : t('range', { low, high });
}

/** A readable central reference; full bounds remain independently available. */
export function formatEtaPoint(range: Span | null | undefined, t: Translate, typicalMs?: number | null): string {
  if (!validSpan(range)) return t('unknown');
  const nominal = typicalMs != null && Number.isFinite(typicalMs) && typicalMs >= range.low && typicalMs <= range.high
    ? typicalMs : range.low + (range.high - range.low) / 2;
  const step = ETA_STEPS.find(([limit]) => nominal < limit)![1];
  const rounded = Math.max(nominal > 0 ? 1_000 : 0, Math.round(nominal / step) * step);
  return t('aboutDuration', { value: formatCoarse(rounded, t) });
}

/** Compact counts retain separate observed and forecast labels in the summary. */
export function compactTokens(value: number | null | undefined, t: Translate): string {
  if (value == null || !Number.isFinite(value) || value < 0) return t('unknown');
  if (value < 1_000) return String(Math.round(value));
  const divisor = value < 1_000_000 ? 1_000 : 1_000_000;
  const scaled = value / divisor;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${divisor === 1_000 ? 'k' : 'M'}`;
}
export function compactTokenRange(range: Span | null | undefined, t: Translate): string {
  if (!validSpan(range)) return t('unknown');
  const low = compactTokens(range.low, t), high = compactTokens(range.high, t);
  return low === high ? low : t('range', { low, high });
}

export function formatTokenRange(range: Span | null | undefined, locale: string, t: Translate): string {
  if (!validSpan(range)) return t('unknown');
  const low = formatNumber(range.low, locale, t);
  const high = formatNumber(range.high, locale, t);
  return t('tokenCount', { value: low === high ? low : t('range', { low, high }) });
}

/** Format the decimal string exactly: tiny prices and values above 2^53 never round through Number. */
export function formatDecimal(amount: string, locale: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return null;
  const integer = new Intl.NumberFormat(numberLocale(locale), { maximumFractionDigits: 0 }).format(BigInt(match[1]));
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (!fraction) return integer;
  const point = new Intl.NumberFormat(numberLocale(locale)).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return `${integer}${point}${fraction}`;
}

export function formatMoney(value: Money, locale: string, t: Translate): string {
  const amount = formatDecimal(value.amount, locale);
  return amount === null || !value.currency ? t('unknown') : t('money', { currency: value.currency, value: amount });
}

export function formatMoneyList(values: readonly Money[] | null | undefined, locale: string, t: Translate): string {
  if (!values?.length) return t('unknown');
  return values.map((value) => formatMoney(value, locale, t)).join(t('listSeparator'));
}

export function formatMoneyRanges(values: readonly MoneyRange[] | null | undefined, locale: string, t: Translate): string {
  if (!values?.length) return t('unknown');
  return values.map((value) => {
    const low = formatDecimal(value.range.low, locale);
    const high = formatDecimal(value.range.high, locale);
    if (low === null || high === null || !value.currency) return t('unknown');
    return low === high
      ? t('money', { currency: value.currency, value: low })
      : t('moneyRange', { currency: value.currency, low, high });
  }).join(t('listSeparator'));
}

export function isLive(state: TaskState): boolean {
  return state === 'running' || state === 'queued';
}

export function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted';
}

const states: Record<TaskState, MessageKey> = {
  queued: 'stateQueued', running: 'stateRunning', waiting_user: 'stateWaiting', completed: 'stateCompleted',
  failed: 'stateFailed', cancelled: 'stateCancelled', interrupted: 'stateInterrupted',
};
export function formatState(state: TaskState, t: Translate): string { return t(states[state]); }

const origins: Record<EstimateSnapshot['estimateOrigin'], MessageKey> = {
  heuristic: 'originHeuristic', 'public-measured': 'originPublic', 'local-measured': 'originLocal', mixed: 'originMixed',
};
export function formatOrigin(origin: EstimateSnapshot['estimateOrigin'], t: Translate): string { return t(origins[origin]); }

const taskTypes: Record<string, MessageKey> = {
  question: 'taskQuestion', writing: 'taskWriting', 'file-analysis': 'taskFileAnalysis', code: 'taskCode', research: 'taskResearch', unknown: 'taskUnknown',
};
export function formatTaskType(type: string, t: Translate): string { return t(taskTypes[type] ?? 'taskUnknown'); }

export function formatCoverage(status: string, t: Translate): string {
  const keys: Record<string, MessageKey> = { complete: 'costComplete', partial: 'costPartial', unpriced: 'costUnpriced', free: 'free', reference: 'costReference', unavailable: 'costUnavailable', unknown: 'unknown' };
  return t(keys[status] ?? 'unknown');
}

/**
 * True when no price applies at all: nothing observed is priced and nothing
 * forecast is priced. That is a configuration fact, not a failed calculation,
 * so the UI must say "prices are not configured" instead of an error sentence.
 */
export function costUnconfigured(snapshot: EstimateSnapshot): boolean {
  if (snapshot.observedCostStatus === 'free' || snapshot.forecastCostStatus === 'free') return false;
  return snapshot.priceSources.length === 0 && snapshot.knownCost.length === 0 && (snapshot.estimatedTotalCost?.length ?? 0) === 0;
}

export function costSummary(snapshot: EstimateSnapshot, locale: string, t: Translate): string {
  if (snapshot.observedCostStatus === 'free') return t('free');
  if (!snapshot.knownCost.length) return t('unknown');
  const value = formatMoneyList(snapshot.knownCost, locale, t);
  return snapshot.observedCostStatus === 'complete' ? value : t('partialKnown', { value });
}

/** Advance text only between Host snapshots. Waiting freezes active time and the remaining range. */
export function localTiming(snapshot: EstimateSnapshot, receivedAt: number, now: number) {
  const delta = Math.max(0, now - receivedAt);
  const activeDelta = snapshot.state === 'running' ? delta : 0;
  const wallDelta = isTerminal(snapshot.state) ? 0 : delta;
  return {
    activeMs: snapshot.elapsedActiveMs + activeDelta,
    pausedMs: snapshot.elapsedPausedMs + (snapshot.state === 'waiting_user' ? delta : 0),
    wallMs: snapshot.elapsedWallMs + wallDelta,
    remaining: validSpan(snapshot.remainingMs) ? {
      low: Math.max(0, snapshot.remainingMs.low - activeDelta),
      high: Math.max(0, snapshot.remainingMs.high - activeDelta),
    } : null,
  };
}

export function remainingSummary(snapshot: EstimateSnapshot, receivedAt: number, now: number, t: Translate): string {
  const { remaining } = localTiming(snapshot, receivedAt, now);
  if (!remaining) return t('unknownRemaining');
  if (snapshot.state === 'running' && remaining.high === 0) return t('overdue');
  return t('estimatedRemaining', { value: formatDurationRange(remaining, t) });
}

export function formatDate(time: number, locale: string, t: Translate): string {
  if (!Number.isFinite(time) || time <= 0) return t('unknown');
  return new Intl.DateTimeFormat(numberLocale(locale), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(time);
}

export interface ProfileMetricsText { latency: string; speed: string; samples: string; measured: string; source: string }

/**
 * One calibration row. A metric is printed plainly only when local samples back
 * it; prior-only values stay visibly marked as reference so a heuristic prior is
 * never read as a measurement. Missing values remain unknown, never zero.
 */
export function formatProfileMetrics(profile: ProfileSummary, locale: string, t: Translate): ProfileMetricsText {
  const latency = formatLatency(profile.firstTextMs, locale, t);
  const speedValue = profile.visibleTps == null ? null : t('tokensPerSecond', { value: formatNumber(profile.visibleTps, locale, t, 1) });
  const priorSpeed = profile.priorVisibleTps == null ? null : t('tokensPerSecond', { value: formatNumber(profile.priorVisibleTps, locale, t, 1) });
  return {
    latency: profile.firstTextMs !== null && profile.firstTextSamples === 0 ? t('referenceValue', { value: latency }) : latency,
    speed: profile.visibleTps != null && profile.speedSamples > 0 ? speedValue! : priorSpeed === null ? t('unknown') : t('referenceValue', { value: priorSpeed }),
    samples: t('profileSamples', { value: formatNumber(profile.totalCallSamples, locale, t) }),
    measured: profile.testedAt === null || profile.testedAt <= 0 ? t('profileNotMeasured') : t('profileMeasuredAt', { value: formatDate(profile.testedAt, locale, t) }),
    source: t('sourceDetail', { value: formatOrigin(profile.sourceKind, t) }),
  };
}
