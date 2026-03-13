'use strict';

const IDENTIFY_TIMEOUT_MS = 10_000;
const IDENTIFY_RETRIES = 1;

export function setupRepairSession(
  session: any,
  driver: {
    log: (...args: any[]) => void;
    error: (...args: any[]) => void;
    homey: any;
  },
) {
  session.setHandler('get_current_ip', async () => {
    const device = session.getDevice();
    return device.getStore().host ?? '';
  });

  session.setHandler('manual_connect', async (data: { host: string }) => {
    const host = data.host?.trim();
    if (!host) throw new Error('Please enter an IP address');

    const device = session.getDevice();
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
    } catch (err: any) {
      throw new Error(`Could not connect to inverter at ${host}: ${err?.message ?? err}`);
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
