import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { durableStreamStats, foldFacts, initialFacts } from '../../src/host/facts.ts';
const header = { id: 's', version: 4, createdAt: 1_000, isSeeded: false } as SessionHeader;
function event(type: string, seq: number, time: number, data: unknown): SessionEvent { return { type, seq, time, data } as SessionEvent; }
const classify = () => 'writing' as const;
function active() { return foldFacts(initialFacts(header, 0), event('turn/start', 0, 1_000, { turn: 1 }), classify); }
test('T12: local analysis completion and text silence never close a turn', () => {
  let state = active();
  state = foldFacts(state, event('assistant/message', 1, 2_000, { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'a', model: 'm' }, content: [{ type: 'text', text: '已完成分析' }] }, stream: [] }), classify);
  assert.equal(state.tasks['1'].state, 'running');
  state = foldFacts(state, event('turn/end', 2, 3_000, { turn: 1, reason: { kind: 'completed' } }), classify);
  assert.equal(state.tasks['1'].state, 'completed');
});
test('C05: replaying the same committed sequence does not add usage', () => {
  const settlement = event('assistant/message', 1, 2_000, { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'a', model: 'm' }, content: [] }, stream: [], usage: { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000, outputTokens: 500 } });
  const first = foldFacts(active(), settlement, classify);
  assert.equal(foldFacts(first, settlement, classify), first);
  assert.equal(first.tasks['1'].calls.length, 1);
  assert.equal(first.tasks['1'].calls[0].usage?.inputTokens, 1000);
});
test('inherited fork history does not become a second task or cost source', () => {
  const state = initialFacts(header, 10);
  assert.equal(foldFacts(state, event('turn/start', 1, 1_000, { turn: 1 }), classify), state);
});
test('plugin projection stores prompt features without content or credentials', () => {
  const prompt = '写1000字故事 private-value-DoNotStore';
  const state = foldFacts(active(), event('user/message', 1, 1_100, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }), classify);
  const json = JSON.stringify(state);
  assert.equal(state.tasks['1'].promptChars, prompt.length);
  assert.equal(state.tasks['1'].explicitOutputWords, 1000);
  assert.ok(!json.includes('private-value'));
});
test('R01: unsuccessful turn endings retain accounting and do not become completed', () => {
  for (const [kind, expected] of [['aborted', 'cancelled'], ['error', 'failed'], ['max-tokens', 'failed'], ['interrupted', 'interrupted'], ['forked', 'interrupted']]) {
    const state = foldFacts(active(), event('turn/end', 1, 3_000, { turn: 1, reason: { kind } }), classify);
    assert.equal(state.tasks['1'].state, expected);
    assert.equal(state.tasks['1'].endedAt, 3_000);
  }
});
test('compact stream timing uses incremental gaps and the last usage replaces previous', () => {
  const stats = durableStreamStats([
    { type: 'reasoning-chunks', time0: 1_000, index: 0, dt: [500], texts: ['hidden', 'more'] },
    { type: 'text-chunks', time0: 2_000, index: 1, dt: [200, 300], texts: ['a', 'b', 'c'] },
    { type: 'chunk', time: 2_600, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } } },
    { type: 'chunk', time: 2_700, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 30 } } },
  ]);
  assert.equal(stats.firstContentAt, 1_000); assert.equal(stats.firstTextAt, 2_000);
  assert.equal(stats.lastContentAt, 2_500); assert.equal(stats.usage?.outputTokens, 30);
  assert.equal(stats.textChars, 3);
});
test('ignored events preserve projection identity', () => {
  const state = active();
  assert.equal(foldFacts(state, event('command/run', 1, 3_000, {}), classify), state);
});
