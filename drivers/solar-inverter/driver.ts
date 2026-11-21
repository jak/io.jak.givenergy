'use strict';

import Homey from 'homey';
import { setupPairSession } from '../../lib/pairing';
import { setupRepairSession } from '../../lib/repair';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPair(session: any) {
    setupPairSession(session, this, (serialNumber, model) => {
      return `GivEnergy ${serialNumber} (${model})`;
    });
  }

  async onRepair(session: any) {
    setupRepairSession(session, this);
  }
};
