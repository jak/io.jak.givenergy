'use strict';

import Homey from 'homey';
import { setupPairSession } from '../../lib/pairing';
import { setupRepairSession } from '../../lib/repair';

module.exports = class BatteryDriver extends Homey.Driver {

  async onInit() {
    this.log('BatteryDriver initialized');
  }

  async onPair(session: any) {
    // If solar inverters are already paired, use them directly
    const solarDriver = this.homey.drivers.getDriver('solar-inverter');
    const solarDevices = solarDriver.getDevices();

    if (solarDevices.length > 0) {
      const devices = solarDevices.map((device) => {
        const { id: serialNumber } = device.getData();
        const { host, generation } = device.getStore();
        return {
          name: `GivEnergy Battery (${serialNumber})`,
          data: { id: serialNumber },
          store: { host, generation },
        };
      });

      session.setHandler('list_devices', async () => devices);

      session.setHandler('start_discover', async () => {
        await session.showView('list_devices');
      });
    } else {
      // No solar inverters paired — run full discovery
      setupPairSession(session, this, (serialNumber) => {
        return `GivEnergy Battery (${serialNumber})`;
      });
    }
  }

  async onRepair(session: any) {
    setupRepairSession(session, this);
  }
};
