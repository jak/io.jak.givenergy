'use strict';

import Homey from 'homey';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPairListDevices() {
    const { discover, GivEnergyInverter } = await import('givenergy-modbus');
    const discovered = await discover();

    const devices = await Promise.all(
      discovered.map(async (d) => {
        try {
          const inverter = await GivEnergyInverter.connect({ host: d.host });
          const snapshot = inverter.getData();
          const gen = snapshot.generation;
          const name = `GivEnergy ${snapshot.serialNumber} (${gen})`;
          const device = {
            name,
            data: { id: snapshot.serialNumber },
            store: { host: d.host, generation: gen },
          };
          await inverter.stop();
          return device;
        } catch {
          return null;
        }
      })
    );

    return devices.filter((d): d is NonNullable<typeof d> => d !== null);
  }

  async onPair(session: any) {
    session.setHandler('manual_entry', async (data: { host: string }) => {
      const { GivEnergyInverter } = await import('givenergy-modbus');
      const { host } = data;
      const inverter = await GivEnergyInverter.connect({ host });
      const snapshot = inverter.getData();
      const gen = snapshot.generation;
      const device = {
        name: `GivEnergy ${snapshot.serialNumber} (${gen})`,
        data: { id: snapshot.serialNumber },
        store: { host, generation: gen },
      };
      await inverter.stop();
      return device;
    });
  }
};
