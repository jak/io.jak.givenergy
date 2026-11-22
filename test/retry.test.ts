import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../lib/retry.ts';

/** Homey timers that fire at once, recording each delay. */
function fakeHomey() {
  const delays: number[] = [];
  return {
    delays,
    setTimeout(callback: () => void, ms: number) {
      delays.push(ms);
      callback();
    },
  };
}

test('retries inverter timeouts on Homey timers, then succeeds', async () => {
  const homey = fakeHomey();
  const logs: string[] = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('Request timeout');
    return 'ok';
  }, { homey, log: (m) => logs.push(m) });
  assert.equal(result, 'ok');
  assert.deepEqual(homey.delays, [5_000, 15_000]);
  assert.equal(logs.length, 2);
});

test('gives up after three retries, and never retries other errors', async () => {
  const homey = fakeHomey();
  await assert.rejects(withRetry(async () => {
    throw new Error('timeout');
  }, { homey }), /timeout/);
  assert.deepEqual(homey.delays, [5_000, 15_000, 30_000]);

  const other = fakeHomey();
  await assert.rejects(withRetry(async () => {
    throw new Error('Not supported');
  }, { homey: other }), /Not supported/);
  assert.deepEqual(other.delays, []);
});
