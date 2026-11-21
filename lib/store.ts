'use strict';

/** The parts of a Homey device the store migration uses. */
export interface StoreDevice {
  getStore(): Record<string, unknown>;
  setStoreValue(key: string, value: unknown): Promise<void>;
  unsetStoreValue(key: string): Promise<void>;
}

/**
 * Keep a device's store in step with the live inverter: `model` and `layout` replace the 1.x
 * `generation` ('gen2' / 'gen3' / 'three_phase'), and follow the inverter after a firmware update.
 * The store is informational (pairing copies it to sibling drivers); behaviour reads the live inverter.
 */
export async function syncStore(device: StoreDevice, inverter: { model: string; layout: string }): Promise<void> {
  const store = device.getStore();
  if (store.model !== inverter.model) await device.setStoreValue('model', inverter.model);
  if (store.layout !== inverter.layout) await device.setStoreValue('layout', inverter.layout);
  if ('generation' in store) await device.unsetStoreValue('generation');
}
