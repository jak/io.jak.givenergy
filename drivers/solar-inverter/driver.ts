'use strict';

import Homey from 'homey';
import { setupPairSession } from '../../lib/pairing';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPair(session: any) {
    setupPairSession(session, this, (serialNumber, generation) => {
      return `GivEnergy ${serialNumber} (${generation})`;
    });
  }
};
