import * as React from 'react';
import type { EstimateSnapshot } from '../shared/wire.ts';
import { costSummary, formatCoverage, formatDuration, formatEta, formatLatency, formatMoneyRanges, formatNumber, formatOrigin, formatTaskType, formatTokenRange, localTiming } from './format.ts';
import type { MessageKey, Translate } from './locale.ts';

function Facts({ rows }: { rows: ReadonlyArray<readonly [string, React.ReactNode]> }) {
  return <dl className="dte-facts">{rows.map(([label, value], index) => <React.Fragment key={`${label}-${index}`}><dt>{label}</dt><dd>{value}</dd></React.Fragment>)}</dl>;
}

const reasonKeys: Record<string, MessageKey> = {
  'engineering-assumption': 'reasonHeuristic', 'engineering-workload-template': 'reasonWorkloadTemplate',
  'local-workload-ewma': 'reasonLocalWorkload', 'local-workload-distribution': 'reasonWorkloadDistribution', 'public-endpoint-reference': 'reasonPublicEndpoint',
  'reference-range-not-calibrated-confidence': 'reasonReferenceRange', 'conditional-samples-insufficient': 'reasonFewSamples',
  'reference-range-exhausted-reassessing': 'reasonReassessing', 'output-budget-exhausted-task-still-running': 'reasonBudgetExhausted',
  'waiting-for-model-response': 'reasonWaitingModel', 'mixed-route-upstream-unknown': 'reasonMixedRoute',
  'same-provider-model-fallback': 'reasonRouteFallback', 'visible-speed-still-prior': 'reasonSpeedPrior',
  'stale-profile-retained-for-audit': 'reasonStale', 'reasoning-mode-unknown': 'reasonReasoningUnknown',
  'no-matching-price': 'reasonNoPrice', 'billing-identity-unknown': 'reasonBillingUnknown',
  'future-input-cache-split-unknown': 'reasonCacheUnknown', 'future-reasoning-budget-unknown': 'reasonFutureReasoning',
  'public-reference-price-not-provider-bill': 'reasonReferencePrice', 'user-explicit-same-as-reference': 'reasonSameAs',
  'price-multiplier-condition-unknown': 'reasonPriceCondition', 'forecast-scenario-reference': 'reasonForecastScenario',
  'text-stage-no-repeat-wait': 'reasonNoRepeatWait', 'reasoning-already-in-first-text-wait': 'reasonReasoningIncluded',
  'first-text-plus-body': 'reasonFirstTextBody', 'same-mode-total-call-fallback': 'reasonTotalFallback',
  'conditional-observed-remaining-range': 'reasonConditional', 'classification:heuristic': 'reasonClassification',
  'explicit-artifact-count': 'reasonArtifactCount', 'observable-plan-steps': 'reasonPlanSteps',
  'file-batch-assumption': 'reasonFileBatch', 'explicit-output-token-budget': 'reasonOutputBudget',
  'requested-length-token-conversion:heuristic': 'reasonLengthConversion', 'observable-attachments': 'reasonAttachments',
  'no-classification-match': 'reasonNoClassification', 'task-scope-changed': 'reasonScopeChanged',
  'workload-data-incomplete': 'reasonIncompleteWorkload', 'request-completed': 'reasonRequestCompleted',
  'endpoint-identity-unknown': 'reasonEndpointUnknown', 'endpoint-unresolved-mixed-route': 'reasonEndpointUnknown',
  'continuation-local-task-history': 'reasonContinuationHistory', 'continuation-history-insufficient': 'reasonContinuationUnknown',
  'ai-workload-plan-reference': 'reasonAiPlan', 'ai-plan-needs-refresh': 'reasonScopeChanged',
};
export function reasonText(reason: string, t: Translate): string {
  if (reasonKeys[reason]) return t(reasonKeys[reason]);
  if (reason.startsWith('classification-rule:')) return t('reasonClassificationRule', { value: reason.slice('classification-rule:'.length) });
  return t('reasonCode', { value: reason });
}

export function EstimateDetails({ snapshot, receivedAt, now, locale, t }: { snapshot: EstimateSnapshot; receivedAt: number; now: number; locale: string; t: Translate }) {
  const timing = localTiming(snapshot, receivedAt, now);
  const performance = snapshot.performance;
  const text = (value: string | null | undefined) => value || t('unknown');
  const number = (value: number | null | undefined, fraction = 0) => formatNumber(value, locale, t, fraction);
  const referencePrice = snapshot.reasons.includes('public-reference-price-not-provider-bill');
  const knownCost = costSummary(snapshot, locale, t);
  const forecast = snapshot.forecastCostStatus === 'free' ? t('free') : formatMoneyRanges(snapshot.estimatedTotalCost, locale, t);
  const partial = snapshot.forecastCostStatus === 'partial' || snapshot.forecastCostStatus === 'unavailable' || snapshot.observedCostStatus === 'partial' || snapshot.observedCostStatus === 'unpriced';

  return <section aria-label={t('details')}>
    <p className="dte-muted dte-small">{t('scope')}</p>
    <Facts rows={[
      [t('activeTime'), formatDuration(timing.activeMs, t)], [t('pausedTime'), formatDuration(timing.pausedMs, t)],
      [t('wallTime'), formatDuration(timing.wallMs, t)], [t('remaining'), formatEta(timing.remaining, t)],
      [t('estimatedTotal'), formatEta(snapshot.estimatedTotalMs, t)],
      [t('tokenForecast'), formatTokenRange(snapshot.estimatedTotalTokens, locale, t)],
      [t('tokenRemainingOutput'), formatTokenRange(snapshot.estimatedRemainingOutputTokens, locale, t)],
      [t(referencePrice ? 'referenceCost' : 'knownCost'), costSummary(snapshot, locale, t)],
      [t('estimatedCost'), snapshot.forecastCostStatus === 'partial' ? t('partialKnown', { value: forecast }) : forecast],
      [t('observedCostStatus'), formatCoverage(snapshot.observedCostStatus, t)], [t('forecastCostStatus'), formatCoverage(snapshot.forecastCostStatus, t)],
    ]} />
    {snapshot.estimatedRemainingOutputTokens != null && <p className="dte-muted dte-small">{t('tokenRemainingNote')}</p>}
    {partial && <p className="dte-warn dte-small">{t('incompleteCostDetail')}</p>}
    {snapshot.unpricedCalls > 0 && <p className="dte-muted dte-small">{t('noPrice', { count: number(snapshot.unpricedCalls) })}</p>}
    {snapshot.incompleteForecastUnits > 0 && <p className="dte-muted dte-small">{t('incompleteForecast', { count: number(snapshot.incompleteForecastUnits) })}</p>}

    <details className="dte-subsection">
      <summary>{t('tokenTotal')}</summary>
      <Facts rows={[
        [t('tokenTotal'), number(snapshot.observedTokens)], [t('tokenCoverage'), formatCoverage(snapshot.observedTokenStatus, t)],
        [t('tokenInput'), number(snapshot.tokens.input)], [t('tokenCacheRead'), number(snapshot.tokens.cacheRead)],
        [t('tokenCacheWrite'), number(snapshot.tokens.cacheWrite)], [t('tokenOutput'), number(snapshot.tokens.output)],
        [t('tokenReasoning'), number(snapshot.tokens.reasoning)],
      ]} />
      <p className="dte-muted dte-small">{t('tokensNote')}</p>
    </details>
    <details className="dte-subsection">
      <summary>{t('basis')}</summary>
      <Facts rows={[
        [t('origin'), formatOrigin(snapshot.estimateOrigin, t)], [t('taskType'), formatTaskType(snapshot.taskType, t)],
        [t('localSamples'), number(snapshot.localPerformanceSamples)], [t('workloadSamples'), number(snapshot.workloadSamples)],
        [t('calls'), t('callCounts', { completed: number(snapshot.calls.completed), active: number(snapshot.calls.active), failed: number(snapshot.calls.failed) })],
        [t('tools'), t('toolCounts', { completed: number(snapshot.tools.completed), active: number(snapshot.tools.active) })],
        [t('toolTime'), formatDuration(snapshot.tools.workMs, t)], [t('algorithm'), snapshot.algorithmVersion],
      ]} />
    </details>
    <details className="dte-subsection">
      <summary>{t('performance')}</summary>
      {!performance ? <p className="dte-muted">{t('notAvailable')}</p> : <>
        <Facts rows={[
          [t('provider'), text(performance.providerId)], [t('model'), text(performance.modelId)], [t('endpoint'), text(performance.endpointFingerprint)],
          [t('requestMode'), text(performance.requestMode)], [t('reasoningEffort'), text(performance.reasoningEffort)], [t('serviceTier'), text(performance.serviceTier)],
          [t('firstContent'), formatLatency(performance.firstContentMs, locale, t)], [t('firstText'), formatLatency(performance.firstTextMs, locale, t)],
          [t('visibleSpeed'), performance.visibleTps == null ? t('unknown') : t('tokensPerSecond', { value: number(performance.visibleTps, 2) })],
          [t('callDuration'), formatLatency(performance.totalCallMs, locale, t)], [t('origin'), text(performance.source)],
          [t('performanceTrust'), performance.trust === 'observed' ? t('performanceObserved') : t('performanceReference')],
          [t('firstContentSource'), performance.metricOrigins ? formatOrigin(performance.metricOrigins.firstContent, t) : t('unknown')],
          [t('firstTextSource'), performance.metricOrigins ? formatOrigin(performance.metricOrigins.firstText, t) : t('unknown')],
          [t('speedSource'), performance.metricOrigins ? formatOrigin(performance.metricOrigins.speed, t) : t('unknown')],
          [t('totalSource'), performance.metricOrigins ? formatOrigin(performance.metricOrigins.total, t) : t('unknown')],
        ]} />
        {performance.stale && <p className="dte-warn">{t('staleProfile')}</p>}
      </>}
    </details>
    <details className="dte-subsection">
      <summary>{t('initialComparison')}</summary>
      <Facts rows={[
        [t('initialTime'), formatEta(snapshot.initial?.estimatedTotalMs, t)],
        [t('initialCost'), formatMoneyRanges(snapshot.initial?.estimatedTotalCost, locale, t)],
        [t('activeTime'), formatDuration(timing.activeMs, t)], [t('knownCost'), knownCost],
      ]} />
    </details>
    <details className="dte-subsection">
      <summary>{t('priceSources')}</summary>
      {!snapshot.priceSources.length ? <p className="dte-muted">{t('noPriceSources')}</p> : <ul>{snapshot.priceSources.map((source, index) => {
        let href: string | null = null;
        try { const url = new URL(source); if (url.protocol === 'http:' || url.protocol === 'https:') href = url.href; } catch { /* A catalog id is valid source data, not a URL. */ }
        return <li key={`${index}-${source}`}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{source}</a> : t('sourceDetail', { value: source })}</li>;
      })}</ul>}
    </details>
    <details className="dte-subsection">
      <summary>{t('reasons')}</summary>
      {!snapshot.reasons.length ? <p className="dte-muted">{t('noReasons')}</p> : <ul>{snapshot.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reasonText(reason, t)}</li>)}</ul>}
    </details>
  </section>;
}
