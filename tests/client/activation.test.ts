import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import * as registry from '@deepseek-ai/dsh-typert-registry/client';
import * as gateway from '@deepseek-ai/dsh-api-gateway/client';
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol';
import { remoteContribution } from '../../src/shared/remote-contract.ts';
import type { EstimatorRemote } from '../../src/shared/wire.ts';

/** Real SDK services; the physical carrier fails closed and must remain unused. */
async function gatewayFixture(t: TestContext) {
  const root = new Context();
  let ioAttempts = 0;
  const rejectIo = () => { ioAttempts++; throw new Error('activation test forbids transport I/O'); };
  t.after(async () => {
    await root.fiber.dispose();
    assert.equal(ioAttempts, 0, 'activation and cleanup must not contact a Host or model');
  });
  await root.plugin({ name: 'activation-test-connection', apply(ctx: Context) {
    installConnection(ctx, { interactions: 'none', transport: { fetch: rejectIo, openStream: rejectIo } });
  } });
  await root.plugin(registry);
  await root.plugin(gateway);
  return root;
}

// Gateway/Cordis activation only: no Client apply, rendered slots, or DOM acceptance.
test('Gateway mount does not make parent-only injection authorize namespace property access', async (t) => {
  const root = await gatewayFixture(t);
  const consumer = root.plugin({ name: 'namespace-consumer', inject: ['remote'], async apply(ctx: Context) {
    const remote = ctx.get('remote') as TypertClientRemote;
    await remote.$mount(remoteContribution);
    const namespace = ctx.get('remote.taskEstimator') as EstimatorRemote;
    assert.equal(typeof namespace.snapshot, 'function');
    assert.equal(typeof namespace.manage, 'function');
    assert.throws(() => Reflect.get(remote, 'taskEstimator'), /cannot get property "remote\.taskEstimator" without inject/);
    assert.throws(() => Reflect.get(Reflect.get(ctx, 'remote'), 'taskEstimator'), /cannot get property "remote\.taskEstimator" without inject/);
    await ctx.inject(['remote.taskEstimator'], (child: Context) => {
      assert.equal(typeof Reflect.get(child.get('remote') as object, 'taskEstimator').snapshot, 'function');
    });
  } });
  await consumer;
  assert.ok(root.get('remote.taskEstimator'), 'awaited mount installs the actual namespace service');
  await consumer.dispose();
  assert.equal(root.get('remote.taskEstimator'), undefined, 'caller disposal owns the mount');
  assert.equal(root.get('typert')?.remotes.get('taskEstimator/snapshot'), undefined);
});

test('Gateway consumer teardown and re-enable replace the namespace without reviving old methods', async (t) => {
  const root = await gatewayFixture(t);
  let namespace: EstimatorRemote | undefined;
  const plugin = { name: 'repeatable-namespace-consumer', inject: ['remote'], async apply(ctx: Context) {
    await (ctx.get('remote') as TypertClientRemote).$mount(remoteContribution);
    namespace = ctx.get('remote.taskEstimator') as EstimatorRemote;
    assert.equal(typeof namespace.snapshot, 'function');
    assert.equal(typeof namespace.manage, 'function');
  } };
  const first = root.plugin(plugin);
  await first;
  assert.ok(namespace);
  const retiredSnapshot = namespace.snapshot;
  assert.deepEqual(root.get('typert')?.remotes.list().map(item => item.namespace + '/' + item.method).sort(), ['taskEstimator/manage', 'taskEstimator/snapshot']);
  await first.dispose();
  assert.equal(root.get('remote.taskEstimator'), undefined);
  assert.deepEqual(root.get('typert')?.remotes.list(), []);

  const second = root.plugin(plugin);
  await second;
  assert.ok(root.get('remote.taskEstimator'));
  assert.deepEqual(root.get('typert')?.remotes.list().map(item => item.namespace + '/' + item.method).sort(), ['taskEstimator/manage', 'taskEstimator/snapshot']);
  const retiredResult = await retiredSnapshot('session-not-sent', null, new AbortController().signal);
  assert.equal(retiredResult.ok, false);
  if (retiredResult.ok) assert.fail('a disposed namespace method cannot revive on re-enable');
  assert.equal(retiredResult.error.code, 'gateway/internal');
  assert.match(retiredResult.error.message, /no longer mounted/);

  await second.dispose();
  assert.equal(root.get('remote.taskEstimator'), undefined);
  assert.deepEqual(root.get('typert')?.remotes.list(), []);
});
