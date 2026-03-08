'use strict';

import Homey from 'homey';

module.exports = class GridMeterDriver extends Homey.Driver {

  async onInit() {
    this.log('GridMeterDriver initialized');
  }

  async onPairListDevices() {
    const solarDriver = this.homey.drivers.getDriver('solar-inverter');
    const solarDevices = solarDriver.getDevices();

    return solarDevices.map((device) => {
      const { id: serialNumber } = device.getData();
      const { host } = device.getStore();
      return {
        name: `GivEnergy Grid Meter (${serialNumber})`,
        data: { id: serialNumber },
        store: { host },
      };
    });
  }
};
