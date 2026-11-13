import { Context } from '@deepseek-ai/cordis';
import { Storage } from '@deepseek-ai/dsh-storage';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/host/repository.ts';

/** Use the actual shipped domain + backend; never relax their filename or durability contracts. */
export async function storageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-estimator-test-'));
  const resolvedRoot = await realpath(root);
  const resolvedParent = await realpath(tmpdir());
  const ctx = new Context();
  new Storage(ctx);
  const backend = new JsonStorageBackend(resolvedRoot);
  const unregister = ctx.storage.backend.register('json', backend);
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} });
  const messages: string[] = [];
  const repositories: Repository[] = [];
  async function open(now?: () => number) {
    const repository = new Repository(message => messages.push(message), now);
    repositories.push(repository);
    await repository.open(facility);
    return repository;
  }
  async function close() {
    for (const repository of repositories) await repository.close();
    await facility.closeAll(); unregister(); await backend.close(); await ctx.fiber.dispose();
    // Refuse cleanup outside the unique directory this fixture just created.
    if (resolve(dirname(resolvedRoot)) !== resolve(resolvedParent) || !basename(resolvedRoot).startsWith('dsh-task-estimator-test-')) throw new Error('Unexpected test directory');
    await rm(resolvedRoot, { recursive: true, force: true });
  }
  return { root: resolvedRoot, ctx, facility, backend, messages, open, close };
}
