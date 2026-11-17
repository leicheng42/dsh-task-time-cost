import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateCopyText } from '../../src/shared/copy-estimate.ts';

test('the copied line repeats the panel in the same order', () => {
  const text = estimateCopyText({ sentence: '大概还要 8–15 分钟', finish: '预计 17:32–17:49 完成', spent: '已用 37m', cost: 'USD 0.14', tokens: '23.2M' });
  assert.equal(text, '大概还要 8–15 分钟 · 预计 17:32–17:49 完成 · 已用 37m · USD 0.14 · 23.2M');
});

test('missing facts are skipped instead of printed as placeholders', () => {
  assert.equal(estimateCopyText({ sentence: '还在跑，已经 37 分钟', spent: '已用 37m', cost: null, tokens: null }), '还在跑，已经 37 分钟 · 已用 37m');
  assert.equal(estimateCopyText({ sentence: '本轮用时 12m', spent: '已用 12m', done: true }), '本轮用时 12m · 已用 12m');
});
