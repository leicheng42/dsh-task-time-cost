import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { RuntimeObservations } from '../../src/host/runtime.ts';
import { observeHumanWaits } from '../../src/host/user-wait.ts';

for (const fails of [false, true]) test(`human wait wraps an already registered claiming answerer, failure=${fails}`, async () => {
  const ctx = new Context(), agent = { id: 'question-owner' } as unknown as Agent;
  let now = 1_000;
  const runtime = new RuntimeObservations({ wall: () => now, monotonic: () => now });
  runtime.task(agent.id, 1);
  ctx.on('user-questions/request', async () => {
    now += 10_000;
    if (fails) throw new Error('answerer cancelled');
    return { answers: [] };
  });
  observeHumanWaits(ctx, owner => runtime.pause(owner.id, 1));
  const invoke = () => ctx.waterfall('user-questions/request', { questions: [{ id: 'q', question: 'integration fixture' }], agent }, async () => ({ answers: [] }));
  if (fails) await assert.rejects(invoke, /answerer cancelled/); else await invoke();
  assert.equal(runtime.pausedMs(agent.id, 1, 1_000, now), 10_000);
  assert.equal(runtime.task(agent.id, 1).pauseOwners.size, 0, 'Always release the owner after answer/cancellation');
});

test('durable and live pause intervals form a clipped union', () => {
  let now = 0;
  const runtime = new RuntimeObservations({ wall: () => now, monotonic: () => now });
  runtime.task('overlap', 1);
  now = 10_000; const resume = runtime.pause('overlap', 1);
  now = 20_000; resume(); now = 40_000;
  const durable = [{ start: 15_000, end: 25_000 }, { start: 27_000, end: 30_000 }];
  assert.equal(runtime.pausedMs('overlap', 1, 0, now, durable), 18_000);
  assert.equal(runtime.pausedMs('overlap', 1, 12_000, 28_000, durable), 14_000);
});
