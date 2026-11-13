import assert from 'node:assert/strict';
import test from 'node:test';
import { placeStatPanel } from '../../src/client/placement.ts';

test('stat panel keeps the native gap above its trigger and stays inside the right edge', () => {
  const placed = placeStatPanel({ left: 900, top: 650, bottom: 674 }, { width: 440, height: 280 }, { width: 1280, height: 720, topInset: 32 });
  assert.equal(placed.left, 828);
  assert.equal(placed.top, 362);
  assert.equal(placed.top + placed.height, 642);
});

test('tall calibration content scrolls within the viewport instead of crossing the top', () => {
  const placed = placeStatPanel({ left: 300, top: 590, bottom: 616 }, { width: 440, height: 1200 }, { width: 360, height: 640, topInset: 40 });
  assert.deepEqual(placed, { left: 12, top: 40, width: 336, height: 542, maxHeight: 542 });
});

test('a trigger near the title bar opens below and anchors outside the visible area remain safe', () => {
  const below = placeStatPanel({ left: 20, top: 60, bottom: 84 }, { width: 300, height: 200 }, { width: 600, height: 500, topInset: 40 });
  assert.equal(below.top, 92);
  for (const top of [-1000, 0, 60, 590, 2000]) {
    for (const height of [30, 200, 1200]) {
      const placed = placeStatPanel({ left: 800, top, bottom: top + 24 }, { width: 440, height }, { width: 360, height: 640, topInset: 40 });
      assert(placed.left >= 12 && placed.left + placed.width <= 348);
      assert(placed.top >= 40 && placed.top + placed.height <= 628);
    }
  }
});
