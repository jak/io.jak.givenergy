'use strict';

import Homey from 'homey';
import { setupPairSession } from '../../lib/pairing';
import { setupRepairSession } from '../../lib/repair';
import type { PairSession } from '../../lib/types';

module.exports = class GridMeterDriver extends Homey.Driver {

  async onInit() {
    this.log('GridMeterDriver initialized');
  }

  async onPair(session: PairSession) {
    // If solar inverters are already paired, use them directly
    const solarDriver = this.homey.drivers.getDriver('solar-inverter');
    const solarDevices = solarDriver.getDevices();

    if (solarDevices.length > 0) {
      const devices = solarDevices.map((device) => {
        const { id: serialNumber } = device.getData();
        const { host, model, layout } = device.getStore();
        return {
          name: `GivEnergy Grid Meter (${serialNumber})`,
          data: { id: serialNumber },
          store: { host, model, layout },
        };
      });

      session.setHandler('list_devices', async () => devices);

      session.setHandler('start_discover', async () => {
        await session.showView('list_devices');
      });
    } else {
      // No solar inverters paired — run full discovery
      setupPairSession(session, this, (serialNumber) => {
        return `GivEnergy Grid Meter (${serialNumber})`;
      });
    }
  }

  async onRepair(session: PairSession, device?: Homey.Device) {
    setupRepairSession(session, device, this);
  }
};
