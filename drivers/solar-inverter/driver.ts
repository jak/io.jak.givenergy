'use strict';

import Homey from 'homey';
import { setupPairSession } from '../../lib/pairing';
import { setupRepairSession } from '../../lib/repair';
import type { PairSession } from '../../lib/types';

module.exports = class SolarInverterDriver extends Homey.Driver {

  async onInit() {
    this.log('SolarInverterDriver initialized');
  }

  async onPair(session: PairSession) {
    setupPairSession(session, this, (serialNumber, model) => {
      return `GivEnergy ${serialNumber} (${model})`;
    });
  }

  async onRepair(session: PairSession, device?: Homey.Device) {
    setupRepairSession(session, device, this);
  }
};
