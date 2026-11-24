'use strict';

import Homey from 'homey';
import { batteryValues } from '../../lib/snapshot';
import type { Inverter as GivEnergyInverter, InverterSnapshot } from '../../lib/types';
import { syncStore } from '../../lib/store';
import { userMessage } from '../../lib/errors';

module.exports = class BatteryDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: unknown) => void;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();
    this.log(`Initializing battery device ${serialNumber} at ${host}`);

    try {
      this.log('Requesting connection...');
      this.inverter = await this.homey.app.getConnection(serialNumber, host);
      this.log('Connection established');
    } catch (err) {
      this.error(`Cannot connect to inverter at ${host}:`, userMessage(err));
      this.setUnavailable(`Cannot connect to inverter at ${host}`).catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);
    await syncStore(this, this.inverter!).catch(this.error);

    // Add capabilities that may not exist on devices paired before this version
    for (const cap of ['battery_charge_energy_today', 'battery_discharge_energy_today']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    const inverter = this.inverter!;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.log(`Data received: battery=${snapshot.battery.power}W soc=${snapshot.battery.stateOfCharge}%`);
      this.updateCapabilities(snapshot);
    };

    this.lostHandler = (err: unknown) => {
      this.error('Connection lost:', userMessage(err));
      this.setUnavailable('Connection to inverter lost').catch(this.error);
    };

    inverter.on('data', this.dataHandler);
    inverter.on('lost', this.lostHandler);

    try {
      const snapshot = inverter.getData();
      this.log('Initial snapshot available');
      this.updateCapabilities(snapshot);
    } catch {
      this.log('No initial snapshot yet, waiting for first data event...');
    }
  }

  getInverterSnapshot(): InverterSnapshot | null {
    try {
      return this.inverter?.getData() ?? null;
    } catch {
      return null;
    }
  }

  private updateCapabilities(snapshot: InverterSnapshot) {
    this.setAvailable().catch(this.error);

    for (const [id, value] of Object.entries(batteryValues(snapshot))) {
      this.setCapabilityValue(id, value).catch(this.error);
    }
  }

  async onUninit() {
    if (this.inverter) {
      if (this.dataHandler) this.inverter.removeListener('data', this.dataHandler);
      if (this.lostHandler) this.inverter.removeListener('lost', this.lostHandler);
    }
    const { id: serialNumber } = this.getData();
    await this.homey.app.releaseConnection(serialNumber);
  }
};
