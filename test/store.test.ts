import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStore } from '../lib/store.ts';

function fakeDevice(store: Record<string, unknown>) {
  const writes: string[] = [];
  return {
    writes,
    store,
    getStore: () => store,
    async setStoreValue(key: string, value: unknown) {
      writes.push(`set ${key}`); store[key] = value;
    },
    async unsetStoreValue(key: string) {
      writes.push(`unset ${key}`); delete store[key];
    },
  };
}

test('a 1.x device swaps generation for model and layout', async () => {
  const device = fakeDevice({ host: '10.0.0.2', generation: 'gen3' });
  await syncStore(device, { model: 'hybrid_gen3', layout: 'single_phase' });
  assert.deepEqual(device.store, { host: '10.0.0.2', model: 'hybrid_gen3', layout: 'single_phase' });
});

test('an up-to-date store is left alone', async () => {
  const device = fakeDevice({ host: '10.0.0.2', model: 'hybrid_gen3', layout: 'single_phase' });
  await syncStore(device, { model: 'hybrid_gen3', layout: 'single_phase' });
  assert.deepEqual(device.writes, []);
});

test('the model follows the inverter (e.g. firmware update to ten slots)', async () => {
  const device = fakeDevice({ host: 'h', model: 'hybrid_gen3', layout: 'single_phase' });
  await syncStore(device, { model: 'hybrid_gen3_plus', layout: 'single_phase' });
  assert.deepEqual(device.writes, ['set model']);
});
