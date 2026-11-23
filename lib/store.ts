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

/** True for a device paired by 1.x whose store hasn't been migrated yet (it still has `generation`). */
export function pairedBy1x(store: Record<string, unknown>): boolean {
  return 'generation' in store;
}

/**
 * Fill in `acChargeUpperLimitEnabled` (HR 20) on a force charge restore record that has none: one
 * saved by 2.0.0, or saved before HR 20 was read. HR 20 is only changed once the record holds it,
 * so the inverter's current value is the one to restore. Returns the completed record, or null
 * when there's nothing to add.
 */
export function completeForceChargeRestore<T extends { acChargeUpperLimitEnabled?: boolean }>(
  saved: T,
  acChargeUpperLimitEnabled: boolean | undefined,
): T | null {
  if (saved.acChargeUpperLimitEnabled !== undefined || acChargeUpperLimitEnabled === undefined) return null;
  return { ...saved, acChargeUpperLimitEnabled };
}
