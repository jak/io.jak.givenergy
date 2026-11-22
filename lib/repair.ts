'use strict';

import type Homey from 'homey';
import { connectErrorMessage } from './errors.ts';
import type { PairSession } from './types.ts';

const IDENTIFY_TIMEOUT_MS = 10_000;
const IDENTIFY_RETRIES = 1;

/** `device` is the device being repaired, as Homey passes it to `Driver#onRepair`. */
export function setupRepairSession(session: PairSession, device: Homey.Device, driver: Homey.Driver) {
  session.setHandler('get_current_ip', async () => device.getStore().host ?? '');

  session.setHandler('manual_connect', async (data: { host: string }) => {
    const host = data.host?.trim();
    if (!host) throw new Error('Please enter an IP address');

    const expectedSerial = device.getData().id;

    driver.log(`Repair: verifying inverter at ${host} (expecting ${expectedSerial})...`);

    const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');

    let identity;
    try {
      identity = await Inverter.identify({
        host,
        timeout: IDENTIFY_TIMEOUT_MS,
        retries: IDENTIFY_RETRIES,
      });
    } catch (err) {
      throw new Error(connectErrorMessage(host, err));
    }

    if (identity.serialNumber !== expectedSerial) {
      throw new Error(
        `This inverter has a different serial number (${identity.serialNumber}). Expected ${expectedSerial}.`,
      );
    }

    driver.log(`Repair: verified serial ${identity.serialNumber}, updating store...`);

    // Update this device's store
    await device.setStoreValue('host', host);

    // Update label_ip_address setting if the device has it (solar inverter)
    try {
      await device.setSettings({ label_ip_address: host });
    } catch {
      // Not all devices have this setting — ignore
    }

    // Cascade to sibling devices across all drivers
    const driverIds = ['solar-inverter', 'battery', 'grid-meter'];
    for (const driverId of driverIds) {
      let siblingDriver;
      try {
        siblingDriver = driver.homey.drivers.getDriver(driverId);
      } catch {
        continue;
      }
      for (const sibling of siblingDriver.getDevices()) {
        if (sibling === device) continue;
        if (sibling.getData().id !== expectedSerial) continue;

        driver.log(`Repair: cascading IP update to ${driverId} device`);
        await sibling.setStoreValue('host', host);
        try {
          await sibling.setSettings({ label_ip_address: host });
        } catch {
          // Not all devices have this setting — ignore
        }
      }
    }

    driver.log('Repair: complete');
  });
}
