import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCalibration } from '../../src/shared/calibration.ts';

test('the ledger counts finished turns against their first estimate', () => {
  const summary = summarizeCalibration([
    { initialHighMs: 600_000, actualMs: 900_000, completed: true },
    { initialHighMs: 600_000, actualMs: 300_000, completed: true },
    { initialHighMs: 600_000, actualMs: 1_200_000, completed: true },
    { initialHighMs: 600_000, actualMs: 10_000, completed: false },
    { initialHighMs: null, actualMs: 10_000, completed: true },
  ]);
  assert.equal(summary.samples, 3, 'only finished turns with an initial estimate count');
  assert.equal(summary.medianRatio, 1.5, 'median of 0.5, 1.5 and 2');
  assert.equal(summary.underestimated, 2, 'two turns took longer than promised');
});

test('an empty ledger reports nothing instead of zero accuracy', () => {
  assert.deepEqual(summarizeCalibration([]), { samples: 0, medianRatio: null, underestimated: 0 });
});
