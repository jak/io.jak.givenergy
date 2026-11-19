import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAbove, roseAbove, droppedBelow, METRICS, ThresholdTracker,
} from '../lib/threshold.ts';

test('isAbove is strictly greater than', () => {
  assert.equal(isAbove(7001, 7000), true);
  assert.equal(isAbove(7000, 7000), false);
  assert.equal(isAbove(6999, 7000), false);
});

test('roseAbove fires only on the false -> true transition', () => {
  assert.equal(roseAbove({ previous: 800, current: 8000 }, 7000), true);
  assert.equal(roseAbove({ previous: 7000, current: 7001 }, 7000), true);
  assert.equal(roseAbove({ previous: 7500, current: 8000 }, 7000), false, 'stays above');
  assert.equal(roseAbove({ previous: 800, current: 900 }, 7000), false, 'stays below');
  assert.equal(roseAbove({ previous: 6000, current: 7000 }, 7000), false, 'reaching threshold is not above');
  assert.equal(roseAbove({ previous: 8000, current: 800 }, 7000), false, 'wrong direction');
});

test('droppedBelow fires only on the true -> false transition', () => {
  assert.equal(droppedBelow({ previous: 8000, current: 800 }, 7000), true);
  assert.equal(droppedBelow({ previous: 7001, current: 7000 }, 7000), true);
  assert.equal(droppedBelow({ previous: 800, current: 600 }, 7000), false, 'stays below');
  assert.equal(droppedBelow({ previous: 8000, current: 7500 }, 7000), false, 'stays above');
  assert.equal(droppedBelow({ previous: 800, current: 8000 }, 7000), false, 'wrong direction');
});

test('rose/dropped alternate strictly over a noisy series', () => {
  const series = [500, 800, 7000, 8100, 8050, 7000, 7001, 900, 7000, 600];
  const events: string[] = [];
  for (let i = 1; i < series.length; i++) {
    const c = { previous: series[i - 1], current: series[i] };
    if (roseAbove(c, 7000)) events.push('rose');
    if (droppedBelow(c, 7000)) events.push('dropped');
  }
  assert.deepEqual(events, ['rose', 'dropped', 'rose', 'dropped']);
});

test('works with negative thresholds (grid importing)', () => {
  // grid_power: negative = importing. "dropped below -5000" = started importing > 5 kW
  assert.equal(droppedBelow({ previous: -300, current: -7000 }, -5000), true);
  assert.equal(roseAbove({ previous: -7000, current: -300 }, -5000), true);
});

test('METRICS covers every capability with a threshold card', () => {
  assert.deepEqual(
    METRICS.map((m) => m.id).sort(),
    ['grid_frequency', 'grid_power', 'grid_voltage', 'load_power'],
  );
});

test('ThresholdTracker fires both cards on change, nothing on first value or no change', () => {
  const calls: [string, { value: number }, { previous: number; current: number }][] = [];
  const tracker = new ThresholdTracker((cardId, tokens, state) => calls.push([cardId, tokens, state]));

  tracker.update({ load_power: 800, grid_voltage: 240 });
  assert.equal(calls.length, 0, 'no previous value yet');

  tracker.update({ load_power: 800, grid_voltage: 240 });
  assert.equal(calls.length, 0, 'unchanged');

  tracker.update({ load_power: 8000, grid_voltage: 240 });
  assert.deepEqual(calls, [
    ['load_power_rose_above', { value: 8000 }, { previous: 800, current: 8000 }],
    ['load_power_dropped_below', { value: 8000 }, { previous: 800, current: 8000 }],
  ]);
});

test('ThresholdTracker ignores NaN/undefined and keeps last good value', () => {
  const calls: string[] = [];
  const tracker = new ThresholdTracker((cardId) => calls.push(cardId));
  tracker.update({ load_power: 800 });
  tracker.update({ load_power: Number.NaN });
  tracker.update({ load_power: undefined });
  assert.equal(calls.length, 0);
  tracker.update({ load_power: 900 });
  assert.equal(calls.length, 2);
});
