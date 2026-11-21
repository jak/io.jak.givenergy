import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesiredSchedule } from '../lib/schedule-request.ts';

test('parses a full schedule', () => {
  assert.deepEqual(parseDesiredSchedule({
    buy: [{
      slot: 1, start: '23:30', end: '05:30', target: 100,
    }, { start: '13:00', end: '14:00' }],
    sell: [{ start: '17:30', end: '18:00', target: 4 }],
    pause: { mode: 'both', start: '18:00', end: '18:30' },
    ecoMode: true,
    chargeTarget: 90,
  }), {
    buy: [{
      slot: 1, start: '23:30', end: '05:30', target: 100,
    }, { start: '13:00', end: '14:00' }],
    sell: [{ start: '17:30', end: '18:00', target: 4 }],
    pause: { mode: 'both', start: '18:00', end: '18:30' },
    ecoMode: true,
    chargeTarget: 90,
  });
});

test('optional parts may be missing; pause defaults to none', () => {
  assert.deepEqual(parseDesiredSchedule({ buy: [], sell: [] }), { buy: [], sell: [], pause: null });
});

test('pause mode without a window (Gen1/AC)', () => {
  assert.deepEqual(parseDesiredSchedule({ buy: [], sell: [], pause: { mode: 'charge' } }).pause, { mode: 'charge' });
});

test('drops unknown fields', () => {
  const d = parseDesiredSchedule({ buy: [{ start: '01:00', end: '02:00', extra: 1 }], sell: [], hack: true });
  assert.deepEqual(d, { buy: [{ start: '01:00', end: '02:00' }], sell: [], pause: null });
});

test('rejects malformed input', () => {
  assert.throws(() => parseDesiredSchedule(null), /schedule/);
  assert.throws(() => parseDesiredSchedule({ buy: 'x', sell: [] }), /buy/);
  assert.throws(() => parseDesiredSchedule({ buy: [{ start: 1, end: '02:00' }], sell: [] }), /start/);
  assert.throws(() => parseDesiredSchedule({ buy: [{ start: '01:00', end: '02:00', target: '50' }], sell: [] }), /target/);
  assert.throws(() => parseDesiredSchedule({ buy: [{ slot: 1.5, start: '01:00', end: '02:00' }], sell: [] }), /slot/);
  assert.throws(() => parseDesiredSchedule({ buy: [], sell: [], pause: { mode: 'sideways' } }), /mode/);
  assert.throws(() => parseDesiredSchedule({ buy: [], sell: [], ecoMode: 'yes' }), /ecoMode/);
  assert.throws(() => parseDesiredSchedule({ buy: new Array(21).fill({ start: '01:00', end: '02:00' }), sell: [] }), /buy/);
});
