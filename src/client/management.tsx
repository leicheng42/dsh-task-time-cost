import * as React from 'react';
import type { EstimatorRemote, ManagementAction, ManagementView } from '../shared/wire.ts';
import { formatDate, formatDuration, formatMoneyList, formatNumber, formatProfileMetrics, formatState } from './format.ts';
import { errorInfo, errorText, manageRemote, RemoteCallError } from './remote.ts';
import type { ClientError } from './remote.ts';
import type { MessageKey, Translate } from './locale.ts';
import type { SnapshotStore } from './store.ts';

const pendingLabels: Record<ManagementAction, MessageKey> = {
  read: 'pendingRead', saveConfig: 'pendingSave', importBaselines: 'pendingImport', estimatorModel: 'pendingSave', export: 'pendingExport', resetCalibration: 'pendingReset', goalForecast: 'pendingSave',
};
const successLabels: Record<ManagementAction, MessageKey> = {
  read: 'reloaded', saveConfig: 'saved', importBaselines: 'imported', estimatorModel: 'saved', export: 'exported', resetCalibration: 'resetDone', goalForecast: 'saved',
};

interface Props { remote: EstimatorRemote; store: SnapshotStore; t: Translate; locale: string }

export function Management({ remote, store, t, locale }: Props) {
  const id = React.useId();
  const [data, setData] = React.useState<ManagementView | null>(null);
  const [pending, setPending] = React.useState<ManagementAction | null>(null);
  const [error, setError] = React.useState<ClientError | null>(null);
  const [success, setSuccess] = React.useState<MessageKey | null>(null);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const activeRequest = React.useRef<AbortController | null>(null);
  const downloadAnchor = React.useRef<HTMLAnchorElement>(null);
  const downloadUrl = React.useRef<string | null>(null);
  const resetButton = React.useRef<HTMLButtonElement>(null);

  const adopt = React.useCallback((next: ManagementView) => {
    setData(next);
    store.configure(next.config);
  }, [store]);

  const run = React.useCallback(async (action: ManagementAction, payload = '', initial = false) => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    setPending(action);
    setError(null);
    setSuccess(null);
    try {
      const result = await manageRemote(remote, action, payload, controller.signal);
      if (controller.signal.aborted) return;
      if (action === 'export') {
        if (result.exported === undefined) throw new RemoteCallError('EXPORT_EMPTY', '');
        if (!downloadAnchor.current) throw new RemoteCallError('DOWNLOAD_UNAVAILABLE', '');
        if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
        downloadUrl.current = URL.createObjectURL(new Blob([result.exported], { type: 'application/json;charset=utf-8' }));
        downloadAnchor.current.href = downloadUrl.current;
        downloadAnchor.current.download = t('exportedFilename');
        downloadAnchor.current.click();
      }
      if (result.data) adopt(result.data);
      if (action === 'read' && !result.data) throw new RemoteCallError('MANAGEMENT_EMPTY', '');
      if (action === 'saveConfig' || action === 'importBaselines' || action === 'resetCalibration') store.invalidate();
      if (!initial) setSuccess(successLabels[action]);
      if (action === 'resetCalibration') { setConfirmReset(false); resetButton.current?.focus(); }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorInfo(failure));
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        if (!controller.signal.aborted) setPending(null);
      }
    }
  }, [remote, store, adopt, t]);

  React.useEffect(() => {
    void run('read', '', true);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
      if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      downloadUrl.current = null;
    };
  }, [run]);

  // Calibration rows are ordered by their newest real observation, so a route
  // that was never measured sinks below routes with local evidence.
  const orderedProfiles = [...(data?.profiles ?? [])].sort((left, right) => (right.testedAt ?? 0) - (left.testedAt ?? 0));
  const shownProfiles = orderedProfiles.slice(0, 8);


  return <section aria-label={t('settings')}>
    <p className="dte-muted dte-small">{t('settingsHint')}</p>
    <div className="dte-toolbar">
      <button type="button" disabled={pending !== null} onClick={() => void run('read')}>{t('read')}</button>
      {data && <span className="dte-muted dte-small">{t('profiles')}{t('listSeparator')}{formatNumber(data.profiles.length, locale, t)}</span>}
    </div>
    <div className="dte-status" role="status" aria-live="polite">{pending ? t(pendingLabels[pending]) : success ? <span className="dte-success">{t(success)}</span> : null}</div>
    {error && <p className="dte-error" role="alert">{errorText(error, t)}</p>}
    {data?.storage === 'unavailable' && <p className="dte-warn" role="status">{t('storageUnavailable')}</p>}
    {data && <>
      <details className="dte-subsection">
        <summary>{t('performanceProfiles')}</summary>
        <p className="dte-muted dte-small">{t('profilesHint')}</p>
        {!orderedProfiles.length ? <p className="dte-muted">{t('noProfiles')}</p> : <ul className="dte-profiles">
          {shownProfiles.map((profile) => {
            const metrics = formatProfileMetrics(profile, locale, t);
            const buckets = [profile.inputBucket, profile.cacheBucket, profile.concurrencyBucket].filter((value): value is string => !!value && value !== 'unknown');
            // Historical unresolved buckets keep their recorded identity segment, so two
            // rows of the same model stay distinguishable; resolved endpoints use a suffix.
            const fingerprint = profile.endpointFingerprint;
            const endpointBit = fingerprint && fingerprint !== 'unknown'
              ? fingerprint.startsWith('unresolved-') ? fingerprint.split('-')[1]?.slice(0, 6) ?? null : fingerprint.slice(-6)
              : null;
            const routeBits = [profile.providerId, profile.requestMode, profile.reasoningEffort,
              profile.serviceTier && profile.serviceTier !== 'unknown' ? profile.serviceTier : null,
              endpointBit, profile.mixedRoute ? t('mixedRouteShort') : null, ...buckets].filter((value): value is string => !!value);
            return <li key={profile.key}>
              <span>{profile.modelId}</span>
              <span className="dte-muted dte-small">{routeBits.join(t('listSeparator'))}</span>
              <span className="dte-small dte-tabular">{t('firstText')}{t('labelSeparator')}{metrics.latency}{t('listSeparator')}{t('visibleSpeed')}{t('labelSeparator')}{metrics.speed}</span>
              <span className="dte-muted dte-small dte-tabular">{metrics.samples}{t('listSeparator')}{metrics.measured}{t('listSeparator')}{metrics.source}</span>
            </li>;
          })}
        </ul>}
        {orderedProfiles.length > shownProfiles.length && <p className="dte-muted dte-small">{t('profilesShown', { shown: formatNumber(shownProfiles.length, locale, t), total: formatNumber(orderedProfiles.length, locale, t) })}</p>}
      </details>
      <details className="dte-subsection">
        <summary>{t('data')}</summary>
        <div className="dte-actions">
          <button type="button" disabled={pending !== null} onClick={() => void run('export')}>{t('export')}</button>
        </div>
        <div className="dte-actions">
          <button ref={resetButton} type="button" className="dte-danger" disabled={pending !== null}
            aria-expanded={confirmReset} aria-controls={`${id}-reset`} onClick={() => setConfirmReset((value) => !value)}>{t('reset')}</button>
        </div>
        {confirmReset && <div className="dte-confirm" id={`${id}-reset`} role="group" aria-label={t('reset')}>
          <p>{t('resetWarning')}</p>
          <div className="dte-actions">
            <button type="button" className="dte-danger" disabled={pending !== null} onClick={() => void run('resetCalibration')}>{t('confirmReset')}</button>
            <button type="button" disabled={pending !== null} onClick={() => { setConfirmReset(false); resetButton.current?.focus(); }}>{t('cancel')}</button>
          </div>
        </div>}
      </details>
      <details className="dte-subsection">
        <summary>{t('history')}</summary>
        {!data.history.length ? <p className="dte-muted">{t('noHistory')}</p> : <div className="dte-table-wrap"><table>
          <thead><tr><th scope="col">{t('timestamp')}</th><th scope="col">{t('status')}</th><th scope="col">{t('duration')}</th><th scope="col">{t('knownCost')}</th></tr></thead>
          <tbody>{data.history.slice(-20).reverse().map((item) => <tr key={item.taskKey}>
            <td>{formatDate(item.startedAt, locale, t)}</td><td>{formatState(item.state, t)}</td>
            <td>{formatDuration(item.elapsedActiveMs, t)}</td><td>{formatMoneyList(item.knownCost, locale, t)}</td>
          </tr>)}</tbody>
        </table></div>}
      </details>
      <details className="dte-subsection">
        <summary>{t('diagnostics')}</summary>
        {!data.diagnostics.length ? <p className="dte-muted">{t('noDiagnostics')}</p> : <ul>{data.diagnostics.slice(-20).reverse().map((item, index) =>
          <li key={`${item.time}-${index}`}><span className="dte-muted">{formatDate(item.time, locale, t)}{t('listSeparator')}{item.code}</span><br />{t('rawDetail', { message: item.message })}</li>)}</ul>}
      </details>
    </>}
    <a ref={downloadAnchor} hidden tabIndex={-1} aria-hidden="true" />
  </section>;
}
