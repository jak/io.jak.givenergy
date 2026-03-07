'use strict';

import Homey from 'homey';

module.exports = class BatteryDriver extends Homey.Driver {

  async onInit() {
    this.log('BatteryDriver initialized');
  }

  async onPairListDevices() {
    const solarDriver = this.homey.drivers.getDriver('solar-inverter');
    const solarDevices = solarDriver.getDevices();

    return solarDevices.map((device) => {
      const { id: serialNumber } = device.getData();
      const { host } = device.getStore();
      return {
        name: `GivEnergy Battery (${serialNumber})`,
        data: { id: serialNumber },
        store: { host },
      };
    });
  }
};
