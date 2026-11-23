import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStore, pairedBy1x, completeForceChargeRestore } from '../lib/store.ts';

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

test('pairedBy1x spots a 1.x store until it is migrated', async () => {
  const device = fakeDevice({ host: '10.0.0.2', generation: 'gen2' });
  assert.equal(pairedBy1x(device.store), true);
  await syncStore(device, { model: 'hybrid_gen2', layout: 'single_phase' });
  assert.equal(pairedBy1x(device.store), false);
  assert.equal(pairedBy1x({ host: '10.0.0.2', model: 'hybrid_gen3', layout: 'single_phase' }), false);
});

test('a force charge record from 2.0.0 gets the current HR 20 state', () => {
  const saved: { chargeSlot: object; acChargeUpperLimitEnabled?: boolean } = { chargeSlot: { slot: 1, start: '23:30', end: '05:30' } };
  assert.deepEqual(completeForceChargeRestore(saved, true), { ...saved, acChargeUpperLimitEnabled: true });
});

test('a force charge record that has HR 20 state, or a model without HR 20, is left alone', () => {
  assert.equal(completeForceChargeRestore({ acChargeUpperLimitEnabled: false }, true), null);
  assert.equal(completeForceChargeRestore({}, undefined), null);
});
