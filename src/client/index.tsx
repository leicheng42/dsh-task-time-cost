import * as React from 'react';
import { createPortal } from 'react-dom';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatSnapshot, TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { EstimatorRemote } from '../shared/wire.ts';
import { EstimateDetails } from './details.tsx';
import { clockRange, compactTokens, compactTokenRange, costUnconfigured, formatClock, formatDuration, formatEta, formatEtaPoint, formatMoneyCompact, formatMoneyRangesCompact, isAssessing, isTerminal, localTiming, progressShare, remainingCostRanges, validSpan } from './format.ts';
import { en, zh, LOCALE_NAMESPACE } from './locale.ts';
import type { Translate } from './locale.ts';
import { Management } from './management.tsx';
import { errorText } from './remote.ts';
import { SnapshotStore } from './store.ts';
import { styles } from './styles.ts';
import { usePanelPlacement } from './use-panel-placement.ts';

// Narrow structural surfaces mirror inspected SDK contracts; only Cordis Context is imported.
interface ProjectionMarker { revision: number; currentTurn: number | null }
interface SlotProps {
  sessionId: string;
  useProjection: (key: string) => unknown;
  turn?: { turn: number; status: 'open' | 'closed' | 'unknown' };
  seq?: number;
  messageId?: string;
  useChat: <T>(selector: (snapshot: ChatSnapshot) => T) => T;
}
interface Slots {
  inject(key: string, install: () => unknown): unknown;
  register(options: { name: string; id?: string; order?: number }, component: React.ComponentType<SlotProps>): unknown;
}
interface LocaleSnapshot { active: string; revision: number }
interface LocaleService {
  register(namespace: string, locale: string, dictionary: Record<string, string>): () => void;
  bind(namespace: string): Translate;
  subscribe(listener: () => void): () => void;
  getSnapshot(): LocaleSnapshot;
}

function readMarker(value: unknown): ProjectionMarker | null {
  if (!value || typeof value !== 'object') return null;
  if (!('revision' in value) || typeof value.revision !== 'number') return null;
  if (!('currentTurn' in value) || !(value.currentTurn === null || typeof value.currentTurn === 'number')) return null;
  return { revision: value.revision, currentTurn: value.currentTurn };
}
const idleSubscribe = () => () => {};

  /**
   * Small clock that carries the task state by colour instead of by text: the
   * line itself must stay a single short ETA, so a dot plus a word would repeat
   * what the conversation already prints above the composer.
   */
  function ClockIcon({ state }: { state: string }) {
    const live = state === 'running' || state === 'queued';
    return <svg className="dte-icon" data-state={state} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.7v3.6l2.4 1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      {live && <circle className="dte-icon-ring" cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.6" />}
    </svg>;
  }

export const inject = ['slots', 'locale', 'remote'];

/** Lead wrapper mounts the RPC contribution before calling this function. No remote access occurs at module evaluation. */
export function applyClient(ctx: Context): void {
  const slots = ctx.get('slots') as Slots;
  const locale = ctx.get('locale') as LocaleService;
  // $mount creates an independent service. A traced root Remote property read
  // requires an inject declaration for that namespace; this bootstrap owns its
  // dynamic mount, so read the completed service explicitly instead.
  const namespace = ctx.get('remote.taskEstimator') as EstimatorRemote | undefined;
  if (!slots || !locale || !namespace) throw new Error('task-estimate: required Client services have not been mounted');
  const remote = namespace;
  const store = new SnapshotStore(remote);
  ctx.effect(() => () => store.dispose());
  ctx.effect(() => locale.register(LOCALE_NAMESPACE, 'en', en));
  ctx.effect(() => locale.register(LOCALE_NAMESPACE, 'zh', zh));
  const t = locale.bind(LOCALE_NAMESPACE);
  const subscribeLocale = (listener: () => void) => locale.subscribe(listener);
  const readLocale = () => locale.getSnapshot();

  function EstimateWidget({ props, tail }: { props: SlotProps; tail: boolean }) {
    const localeSnapshot = React.useSyncExternalStore(subscribeLocale, readLocale, readLocale);
    const marker = readMarker(props.useProjection('taskEstimator'));
    const targetTurn = tail ? props.turn?.turn ?? null : marker?.currentTurn ?? null;
    const revision = tail && marker?.currentTurn !== targetTurn ? props.seq ?? 0 : marker?.revision;
    const subscribe = React.useCallback((listener: () => void) => store.subscribe(props.sessionId, targetTurn, listener), [props.sessionId, targetTurn]);
    const read = React.useCallback(() => store.getSnapshot(props.sessionId, targetTurn), [props.sessionId, targetTurn]);
    const state = React.useSyncExternalStore(subscribe, read, read);
    React.useEffect(() => { store.projectionChanged(props.sessionId, targetTurn, revision); }, [props.sessionId, targetTurn, revision]);
    const snapshot = state.view?.snapshot ?? null;
    const ticking = !!snapshot && !isTerminal(snapshot.state);
    const frozenNow = React.useCallback(() => state.receivedAt, [state.receivedAt]);
    const now = React.useSyncExternalStore(ticking ? store.clock.subscribe : idleSubscribe, ticking ? store.clock.getSnapshot : frozenNow, frozenNow);
    const [expanded, setExpanded] = React.useState(false);
    const [view, setView] = React.useState<'summary' | 'more' | 'details' | 'settings'>('summary');
    const summary = React.useRef<HTMLButtonElement>(null);
    const panel = React.useRef<HTMLDivElement>(null);
    const firstAction = React.useRef<HTMLButtonElement>(null);
    const id = React.useId();
    // The body portal keeps the native surface; owned rectangles keep tall
    // management content inside the viewport as its size changes.
    usePanelPlacement(expanded, summary, panel, firstAction);
    const active = !!snapshot && !isTerminal(snapshot.state);
    // A settled turn has no remaining work, so an ETA row would print a
    // meaningless "5s" beside a finished duration.
    const terminal = !!snapshot && !active;
    const timing = snapshot ? localTiming(snapshot, state.receivedAt, now) : null;
    const refresh = () => { void store.refresh(props.sessionId, targetTurn); };
    // Escape closes the panel from anywhere inside it and returns focus to the
    // line that opened it, so the popover never traps a keyboard user.
    React.useEffect(() => {
      if (!expanded) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        setExpanded(false);
        setView('summary');
        summary.current?.focus();
      };
      const onOutside = (event: Event) => {
        const target = event.target as Node | null;
        if (!target || summary.current?.contains(target) || panel.current?.contains(target)) return;
        setExpanded(false);
        setView('summary');
      };
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('click', onOutside, true);
      return () => {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('click', onOutside, true);
      };
    }, [expanded]);

    if (tail && !snapshot && !state.error && !state.pending) return null;
    const sessionRemaining = snapshot?.sessionRemainingMs ?? snapshot?.remainingMs ?? null;
    const elapsed = formatDuration(timing?.activeMs ?? snapshot?.elapsedActiveMs, t);
    const retained = !tail && sessionRemaining === null && state.lastForecast
      && (!snapshot || state.lastForecast.taskKey === snapshot.taskKey) && (active || !snapshot && targetTurn !== null) ? state.lastForecast : null;
    // Until the executing agent has planned the work (or a local sample exists)
    // a number would be a guess, so the panel says what it is doing instead.
    const assessing = !!snapshot && isAssessing(snapshot) && sessionRemaining === null;
    const displayedRemaining = assessing ? null : sessionRemaining ?? retained?.remainingMs;
    const range = formatEta(displayedRemaining, t);
    const eta = formatEtaPoint(displayedRemaining, t, sessionRemaining !== null ? snapshot?.remainingTypicalMs : retained?.remainingTypicalMs);
    // Keep the last time reference while the new plan is unavailable. It is
    // frozen and labelled in the dialog, never used as a current cost budget.
    const initialScope = snapshot?.reasons.includes('scope-engineering-prior') ?? false;
    const line = tail || terminal ? t('doneElapsed', { elapsed })
      : assessing ? t('assessing')
      : (active && sessionRemaining !== null || retained) ? t(retained ? 'etaRetained' : initialScope ? 'etaInitial' : snapshot?.forecastScope === 'whole_goal' ? 'etaGoal' : 'etaEstimate', { value: eta })
      : active ? t('computingShort') : t('titleShort');
    const unconfigured = !!snapshot && costUnconfigured(snapshot);
    const referencePrice = snapshot?.reasons.includes('public-reference-price-not-provider-bill') ?? false;
    // A real timeline: the bar spans from task start to the latest predicted
    // finish, so "we are here" is a position rather than a range between two
    // numbers. The unspent part keeps its uncertainty as a lighter band.
    const timeline = (() => {
      if (terminal || !validSpan(displayedRemaining)) return null;
      const spent = timing?.activeMs ?? snapshot?.elapsedActiveMs ?? 0;
      const end = spent + displayedRemaining.high;
      if (!(end > 0)) return null;
      const pct = (value: number) => Math.min(100, Math.max(0, value / end * 100));
      const typical = sessionRemaining !== null ? snapshot?.remainingTypicalMs ?? null : retained?.remainingTypicalMs ?? null;
      return {
        now: pct(spent),
        bandFrom: pct(spent + displayedRemaining.low),
        bandTo: pct(end),
        marker: typical != null && Number.isFinite(typical) ? pct(spent + typical) : null,
        start: snapshot?.startedAt ? formatClock(snapshot.startedAt, localeSnapshot.active, now, t) : '',
        finish: formatClock(now + displayedRemaining.high, localeSnapshot.active, now, t),
      };
    })();
    const partialToken = snapshot?.observedTokenStatus === 'partial';
    const partialCost = !!snapshot && (snapshot.observedCostStatus === 'partial' || snapshot.forecastCostStatus === 'partial');
    const sourceTag = snapshot?.reasons.includes('ai-workload-plan-reference') ? t('sourceAiPlan')
      : snapshot && (snapshot.localPerformanceSamples > 0 || snapshot.workloadSamples > 0) ? t('sourceLocal') : t('sourcePrior');
    // Three dimensions share one shape: spent is a fact, left and total are
    // forecasts. A missing value prints a dash instead of a zero.
    const timeLeft = validSpan(displayedRemaining) ? range : t('dash');
    // A total below the elapsed time is never true: the work cannot finish in the
    // past, so the displayed lower bound follows the clock that has already run.
    const totalSpan = (() => {
      const span = snapshot?.estimatedTotalMs;
      if (!validSpan(span)) return null;
      const spent = timing?.activeMs ?? snapshot?.elapsedActiveMs ?? 0;
      return spent > span.low ? { low: spent, high: Math.max(spent, span.high) } : span;
    })();
    // A retained reference has no current forecast, so its old total must not be
    // printed next to a much larger elapsed time.
    const timeTotal = retained ? t('dash') : formatEta(totalSpan, t);
    const tokenUsed = snapshot?.observedTokens != null ? compactTokens(snapshot.observedTokens, t) : t('dash');
    const tokenLeft = snapshot?.estimatedRemainingOutputTokens ? compactTokenRange(snapshot.estimatedRemainingOutputTokens, t) : t('dash');
    const tokenTotal = snapshot?.estimatedTotalTokens ? compactTokenRange(snapshot.estimatedTotalTokens, t) : t('dash');
    const money = snapshot?.knownCost.length ? snapshot.knownCost.map(value => formatMoneyCompact(value, localeSnapshot.active, t)).join(t('listSeparator')) : null;
    const costUsed = unconfigured ? t('dash') : snapshot?.observedCostStatus === 'free' ? t('free') : money ?? t('dash');
    const costLeft = snapshot ? formatMoneyRangesCompact(remainingCostRanges(snapshot), localeSnapshot.active, t) : t('dash');
    const costTotal = snapshot ? formatMoneyRangesCompact(snapshot.estimatedTotalCost, localeSnapshot.active, t) : t('dash');
    // Each dimension gets the same bar: the filled part is what has already been
    // spent, so "how far in are we" is read without arithmetic.
    const numericMoney = (amounts: readonly { amount: string }[] | null | undefined): number | null => {
      if (!amounts?.length) return null;
      const sum = amounts.reduce((total, value) => total + (Number(value.amount) || 0), 0);
      return Number.isFinite(sum) ? sum : null;
    };
    const costRemaining = snapshot ? remainingCostRanges(snapshot) : null;
    const metrics = [
      { key: 'time', label: t('rowTime'), used: elapsed, left: timeLeft, total: timeTotal,
        fill: terminal ? 1 : progressShare(timing?.activeMs ?? snapshot?.elapsedActiveMs, displayedRemaining?.high) },
      { key: 'tokens', label: t('rowTokens'), used: tokenUsed, left: terminal ? t('dash') : tokenLeft, total: terminal ? t('dash') : tokenTotal,
        fill: terminal ? 1 : progressShare(snapshot?.observedTokens, snapshot?.estimatedRemainingOutputTokens?.high) },
      { key: 'cost', label: t('rowCost'), used: costUsed, left: terminal ? t('dash') : costLeft, total: terminal ? t('dash') : costTotal,
        fill: terminal ? 1 : progressShare(numericMoney(snapshot?.knownCost), costRemaining?.[0] ? Number(costRemaining[0].range.high) : null) },
    ];
    // The completion clock is what turns an estimate into a plan: "by when".
    const finishClock = !terminal && validSpan(displayedRemaining) ? clockRange(displayedRemaining, now, localeSnapshot.active, t) : null;
    // The entry line has room for one time, so it prints the central one.
    const finishPoint = !terminal && validSpan(displayedRemaining)
      ? formatClock(now + (sessionRemaining !== null ? snapshot?.remainingTypicalMs ?? displayedRemaining.high : retained?.remainingTypicalMs ?? displayedRemaining.high), localeSnapshot.active, now, t)
      : null;
    const doneClock = terminal && snapshot?.endedAt ? formatClock(snapshot.endedAt, localeSnapshot.active, now, t) : null;
    // One short line replaces the former stack of explanatory paragraphs; the
    // complete reasoning stays in the details view.
    const footnote = unconfigured ? t('unpricedHint') : partialCost ? t('footnoteIncomplete') : assessing ? t('assessingHint') : !terminal && !displayedRemaining && !retained ? t('footnoteReassessing') : referencePrice ? t('footnotePrice') : terminal ? null : t('footnoteRange');
    // Without a remaining range the useful fact is what has already been spent,
    // so the hero never prints a bare "unknown".
    const heroValue = terminal || !displayedRemaining ? elapsed : eta;
    const heroCaption = t(terminal || !displayedRemaining ? 'heroElapsed' : 'heroRemaining');
    const lineWithClock = finishPoint && !tail && !terminal ? t('etaWithClock', { value: line, clock: finishPoint }) : line;
    return <div className="dte" data-slot={tail ? 'assistant-actions' : 'composer-dock'}>
      <style>{styles}</style>
      <button type="button" className={tail ? 'dte-line dte-line-tail' : 'dte-line'} aria-haspopup="dialog" aria-expanded={expanded} aria-controls={`${id}-panel`}
        aria-label={lineWithClock} onClick={() => { setView('summary'); setExpanded((value) => !value); }} ref={summary}
        title={terminal ? line : snapshot || retained ? t('etaFull', { value: range }) : t('title')}>
        <ClockIcon state={snapshot?.state ?? 'idle'} />
        <span className="dte-line-text">{line}</span>
        {finishPoint && !tail && !terminal && <span className="dte-line-clock dte-tabular">{finishPoint}</span>}
      </button>
      {expanded && createPortal(<div className="dte" style={{ display: 'contents' }}
        onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}><div id={`${id}-panel`} className="dte-pop" role="dialog" data-window-drag-exclude=""
        aria-label={t(tail ? 'turnTimeTitle' : 'titleShort')} ref={panel}>
        <div className="dte-pop-head">
          <span className="dte-pop-title"><ClockIcon state={snapshot?.state ?? 'idle'} />{t(tail ? 'turnTimeTitle' : 'titleShort')}</span>
          <button type="button" ref={firstAction} className="dte-more" aria-label={t('more')} title={t('more')} aria-expanded={view !== 'summary'} aria-controls={`${id}-more`}
            onClick={() => setView(view === 'summary' ? 'more' : 'summary')}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="3" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="13" cy="8" r="1.2" fill="currentColor" /></svg>
          </button>
        </div>
        <div className="dte-hero">
          <span className="dte-hero-value dte-tabular">{snapshot ? heroValue : t('unknown')}</span>
          <span className="dte-hero-caption">{heroCaption}</span>
          {snapshot && !terminal && !assessing && <span className="dte-tag dte-source">{sourceTag}</span>}
        </div>
        {finishClock && <p className="dte-finish">{t('finishAt', { time: finishClock })}</p>}
        {doneClock && <p className="dte-finish">{t('finishedAt', { time: doneClock })}</p>}
        {timeline && <div className="dte-timeline" role="img" aria-label={`${elapsed} → ${range}`}>
          <div className="dte-timeline-track" aria-hidden="true">
            <span className="dte-timeline-done" style={{ width: `${timeline.now}%` }} />
            <span className="dte-timeline-band" style={{ left: `${timeline.bandFrom}%`, width: `${Math.max(1, timeline.bandTo - timeline.bandFrom)}%` }} />
            {timeline.marker != null && <span className="dte-timeline-dot" style={{ left: `${timeline.marker}%` }} />}
            <span className="dte-timeline-now" style={{ left: `${timeline.now}%` }} />
          </div>
          <div className="dte-timeline-labels" aria-hidden="true"><span>{timeline.start}</span><span>{timeline.finish}</span></div>
        </div>}
        {retained && <p className="dte-status-line">{t('retainedForecastHint', { time: new Date(retained.updatedAt).toLocaleTimeString(localeSnapshot.active, { hour: '2-digit', minute: '2-digit' }) })}</p>}
        {snapshot && <div className="dte-metrics">
          {metrics.map(metric => <div className="dte-metric" key={metric.key}>
            <div className="dte-metric-head">
              <span className="dte-metric-label">{metric.label}</span>
              {metric.fill != null && !terminal && <span className="dte-metric-share dte-tabular">{Math.round(metric.fill * 100)}%</span>}
            </div>
            <div className={metric.fill == null ? 'dte-bar dte-bar-unknown' : 'dte-bar'} aria-hidden="true">
              {metric.fill != null && <span className="dte-bar-fill" style={{ width: `${Math.max(2, Math.round(metric.fill * 100))}%` }} />}
            </div>
            <dl className="dte-metric-values">
              <div><dt>{t('colUsed')}</dt><dd>{metric.used}{metric.key === 'tokens' && partialToken && <span className="dte-tag">{t('partialTag')}</span>}{metric.key === 'cost' && partialCost && <span className="dte-tag">{t('partialTag')}</span>}</dd></div>
              {!terminal && <div><dt>{t('colLeft')}</dt><dd>{metric.left}</dd></div>}
              {!terminal && metric.total !== metric.left && <div><dt>{t('colTotal')}</dt><dd>{metric.total}</dd></div>}
            </dl>
          </div>)}
        </div>}
        {footnote && <p className="dte-footnote">{footnote}</p>}
        {state.error && <p className="dte-error dte-small" role="alert">{errorText(state.error, t)}</p>}
        <div id={`${id}-more`} className="dte-pop-actions" hidden={view === 'summary'}>
          <button type="button" className={view === 'details' ? 'dte-link dte-link-active' : 'dte-link'} aria-pressed={view === 'details'} onClick={() => setView(view === 'details' ? 'more' : 'details')}>{t('details')}</button>
          <button type="button" className={view === 'settings' ? 'dte-link dte-link-active' : 'dte-link'} aria-pressed={view === 'settings'} onClick={() => setView(view === 'settings' ? 'more' : 'settings')}>{t('settings')}</button>
          <span className="dte-spacer" />
          {view === 'details' && <button type="button" className="dte-link" disabled={state.pending} onClick={refresh}>{t('refresh')}</button>}
        </div>
        {view === 'details' && (snapshot ? <EstimateDetails snapshot={snapshot} timeReference={retained ?? undefined} receivedAt={state.receivedAt} now={now} locale={localeSnapshot.active} t={t} /> : <p className="dte-muted">{t(tail ? 'noSnapshot' : 'noTask')}</p>)}
        {view === 'settings' && <Management remote={remote} store={store} t={t} locale={localeSnapshot.active} />}
      </div></div>, document.body)}
    </div>;
  }

  function Activity(props: SlotProps) { return <EstimateWidget key={props.sessionId} props={props} tail={false} />; }
  function CompletedAction(props: SlotProps) {
    // Public Chat data identifies the footer's durable closing message. Reading
    // only its identity/Turn avoids attaching a full-Turn duration to each step.
    const closing = props.useChat(snapshot => snapshot.nodes.values().find(node => node.kind === 'turn-tail'
      && (node.data as TurnTailChatData).closing?.finalNode.messageId === props.messageId));
    if (closing?.kind !== 'turn-tail') return null;
    const turn = closing.location.kind === 'turn' || closing.location.kind === 'step' ? closing.location.turn : undefined;
    if (turn?.status !== 'closed') return null;
    return <EstimateWidget key={`${props.sessionId}:${turn.turn}`} props={{ ...props, turn, seq: closing.anchorSeq }} tail />;
  }
  slots.inject('conversation.composer.dock', () => slots.register({ name: 'conversation.composer.dock', id: 'task-estimate', order: 2 }, Activity));
  slots.inject('conversation.chat.assistant-actions', () => slots.register({ name: 'conversation.chat.assistant-actions', id: 'task-estimate', order: 20 }, CompletedAction));
}

export const apply = applyClient;
