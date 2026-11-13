import type { EstimatorRemote, ManagementAction, ManagementResult, RemoteResult } from '../shared/wire.ts';
import type { Translate } from './locale.ts';

export class RemoteCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RemoteCallError';
  }
}
export interface ClientError { code: string; message: string }

export function errorInfo(error: unknown): ClientError {
  if (error instanceof RemoteCallError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: error.name || 'ERROR', message: error.message };
  return { code: 'ERROR', message: typeof error === 'string' ? error : '' };
}

export function errorText(error: ClientError, t: Translate): string {
  if (error.code === 'TIMEOUT') return t('requestTimeout');
  if (error.code === 'ABORTED') return t('requestCancelled');
  return t('errorDetail', { message: error.message || t('operationFailed'), code: error.code });
}

export function unwrapRemote<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new RemoteCallError(result.error.code, result.error.message);
  return result.value;
}

/** Propagate RPC refusals, thrown transport errors, cancellation, and a bounded timeout. */
export async function requestRemote<T>(call: (signal: AbortSignal) => Promise<RemoteResult<T>>, parent?: AbortSignal, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: ((error: RemoteCallError) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    controller.abort();
    rejectAbort?.(new RemoteCallError('ABORTED', ''));
  };
  parent?.addEventListener('abort', onAbort, { once: true });
  try {
    if (parent?.aborted) throw new RemoteCallError('ABORTED', '');
    if (timeoutMs > 0) timer = setTimeout(() => {
      controller.abort();
      rejectAbort?.(new RemoteCallError('TIMEOUT', ''));
    }, timeoutMs);
    return unwrapRemote(await Promise.race([call(controller.signal), aborted]));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener('abort', onAbort);
  }
}

export async function manageRemote(remote: EstimatorRemote, action: ManagementAction, payload: string, signal?: AbortSignal): Promise<ManagementResult> {
  const result = await requestRemote((abort) => remote.manage(action, payload, abort), signal);
  if (!result.ok) throw new RemoteCallError('MANAGEMENT', result.message);
  return result;
}
