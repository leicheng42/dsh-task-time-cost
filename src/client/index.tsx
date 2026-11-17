import * as React from 'react';
import { createPortal } from 'react-dom';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatSnapshot, TurnTailChatData } from '@deepseek-ai/dsh-client-ui-chat/client';
import type { EstimatorRemote } from '../shared/wire.ts';
import { EstimateDetails } from './details.tsx';
import { formatNumber } from './format.ts';
import { clockRange, compactTokens, compactTokenRange, costUnconfigured, formatClock, formatDuration, formatEta, formatEtaPoint, formatMoneyCompact, formatMoneyRangesCompact, isAssessing, isTerminal, localTiming, progressShare, remainingCostRanges, validSpan } from './format.ts';
import { allowsPointEstimate } from '../shared/confidence.ts';
import { progressState } from '../shared/progress-state.ts';
import type { ProgressState } from '../shared/progress-state.ts';
import type { ForecastConfidence } from '../shared/confidence.ts';
import { en, zh, LOCALE_NAMESPACE } from './locale.ts';
import type { Translate } from './locale.ts';
import { Management } from './management.tsx';
import { errorText, manageRemote } from './remote.ts';
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

  /** A small "what is this?" marker: native title plus an accessible popover on hover/focus. */
  function Hint({ id, text, label }: { id: string; text: string; label: string }) {
    return <span className="dte-hint-wrap">
      <button type="button" className="dte-hint" aria-label={label} aria-describedby={id} data-hint={text} onClick={event => event.stopPropagation()}>?</button>
      <span className="dte-hint-bubble" id={id} role="tooltip">{text}</span>
    </span>;
  }

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
    // An overrun makes the retained number a lie: show the elapsed fact instead.
    const overrun = !!snapshot?.reasons.includes('initial-forecast-exceeded') || !!snapshot?.reasons.includes('plan-below-observed-effort');
    // A fallback band is a range, not a plan: say where it came from.
    const banded = !!snapshot?.reasons.includes('initial-band-fallback') || !!snapshot?.reasons.includes('elapsed-only-band');
    const displayedRemaining = assessing ? null : sessionRemaining ?? (overrun ? null : retained?.remainingMs);
    const range = formatEta(displayedRemaining, t);
    // Only a stable forecast may collapse into one number; everything else keeps
    // the range so a long task never opens with a confident-looking minute.
    const confidence: ForecastConfidence = snapshot?.confidence ?? (validSpan(displayedRemaining) ? 'preliminary' : 'assessing');
    const pointAllowed = allowsPointEstimate(confidence);
    const eta = pointAllowed ? formatEtaPoint(displayedRemaining, t, sessionRemaining !== null ? snapshot?.remainingTypicalMs : retained?.remainingTypicalMs) : range;
    // Keep the last time reference while the new plan is unavailable. It is
    // frozen and labelled in the dialog, never used as a current cost budget.
    const initialScope = snapshot?.reasons.includes('scope-engineering-prior') ?? false;
    const line = tail || terminal ? t('doneElapsed', { elapsed })
      : assessing ? t('assessing')
      : (active && sessionRemaining !== null || retained) ? t(retained ? 'etaRetained' : initialScope ? 'etaInitial' : snapshot?.forecastScope === 'whole_goal' ? 'etaGoal' : 'etaEstimate', { value: eta })
      : active ? t('computingShort') : t('titleShort');
    const progress = progressState({ ended: terminal, elapsedMs: snapshot?.elapsedActiveMs ?? 0,
      remainingHighMs: validSpan(displayedRemaining) ? displayedRemaining.high : null,
      trail: (snapshot?.forecastTrail ?? []).map(point => point.highMs), completedCalls: snapshot?.calls.completed ?? 0 });
    // One sentence answers "should I keep waiting"; the number is evidence inside it.
    function showsStatusNumber(state: ProgressState): boolean { return state !== 'done' && state !== 'starting' && state !== 'unknown'; }
    const statusLabel: Record<ProgressState, string> = {
      done: t('stateDone', { elapsed }), starting: t('stateStarting'), unknown: t('stateUnknown'),
      finishing: t('stateFinishing', { value: range }), faster: t('stateFaster', { value: range }),
      slower: t('stateSlower', { value: range }), onTrack: t('stateOnTrack', { value: range }),
    };
    const rounds = snapshot?.goalRounds ?? null;
    const roundsLeft = rounds ? Math.max(0, rounds.max - rounds.started) : null;
    const budgetSpent = !!snapshot?.reasons.includes('goal-round-budget-spent');
    const budgetClose = !!snapshot?.reasons.includes('goal-round-budget-close');
    // A band inferred from elapsed time is not a plan: say so in the sentence.
    const statusText = budgetSpent && rounds
      ? t('stateRoundBudgetSpent', { started: formatNumber(rounds.started, localeSnapshot.active, t), max: formatNumber(rounds.max, localeSnapshot.active, t) })
      : banded && showsStatusNumber(progress.state) ? t('stateBanded', { value: range }) : statusLabel[progress.state];
    const showsNumber = showsStatusNumber(progress.state);
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
        <p className={showsNumber ? 'dte-status dte-tabular' : 'dte-status dte-status-plain'}>{statusText}{showsNumber && <Hint id={`${id}-range-hint`} text={t('hintRange')} label={t('hintRangeLabel')} />}</p>
        {progress.state !== 'done' && progress.state !== 'starting' && (finishClock
          ? <p className="dte-finish">{t('finishAt', { time: finishClock })}</p>
          : <p className="dte-finish dte-muted">{t('noFinishTime')}</p>)}
        {progress.state === 'done' && doneClock && <p className="dte-finish">{t('finishedAt', { time: doneClock })}</p>}
        {budgetClose && !budgetSpent && roundsLeft !== null && progress.state !== 'done' && <p className="dte-finish dte-muted">{t('roundBudgetClose', { left: formatNumber(roundsLeft, localeSnapshot.active, t) })}</p>}
        {banded && progress.state !== 'done' && <p className="dte-finish dte-muted">{t('bandNote')}</p>}
        {overrun && progress.state !== 'done' && <p className="dte-finish dte-muted">{t('estimateStale')}</p>}
        {snapshot && !terminal && (() => {
          const buckets = snapshot.activity ?? [];
          const quiet = buckets.every(value => value === 0);
          const max = Math.max(...buckets, 1);
          return <div className="dte-activity" role="img" aria-label={t('activityLabel')} title={t('hintActivity')}>
            <span className="dte-activity-counts dte-tabular">{t('activityCounts', { calls: formatNumber(snapshot.calls.completed, localeSnapshot.active, t), steps: formatNumber(snapshot.tools.completed, localeSnapshot.active, t) })}</span>
            <Hint id={`${id}-activity-hint`} text={t('hintActivity')} label={t('hintActivityLabel')} />
            {quiet
              ? <span className="dte-activity-quiet">{t('activityQuiet')}</span>
              : <span className="dte-activity-band" aria-hidden="true">{buckets.map((value, index) => <i key={index} style={{ height: `${Math.max(12, Math.round(value / max * 100))}%` }} />)}</span>}
          </div>;
        })()}
        {snapshot && <p className="dte-facts dte-tabular" title={t('hintFacts')}>
          <span>{t('factUsed')}<b>{elapsed}</b></span>
          <span>{costUsed}</span>
          <span>{tokenUsed}</span>
        </p>}
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
