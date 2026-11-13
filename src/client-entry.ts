import type { Context } from '@deepseek-ai/cordis';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteContribution } from './shared/remote-contract.ts';
import { applyClient } from './client/index.tsx';
export const inject = ['slots', 'locale', 'remote'];
export async function apply(ctx: Context): Promise<void> {
  const remote = ctx.get('remote') as TypertClientRemote | undefined;
  if (!remote) throw new Error('Estimator requires the DSH Remote service');
  // $mount owns its disposer in the caller's fiber and resolves after the namespace is ready.
  await remote.$mount(remoteContribution);
  applyClient(ctx);
}
