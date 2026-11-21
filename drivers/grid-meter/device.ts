'use strict';

import Homey from 'homey';
import { ThresholdTracker } from '../../lib/threshold';
import { gridMeterValues } from '../../lib/snapshot';
import type { Inverter as GivEnergyInverter, InverterSnapshot } from '../../lib/types';

module.exports = class GridMeterDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: any) => void;
  private thresholds?: ThresholdTracker;

  async onInit() {
    this.thresholds = new ThresholdTracker((cardId, tokens, state) => {
      this.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(this, tokens, state)
        .catch(this.error);
    });

    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();
    this.log(`Initializing grid meter device ${serialNumber} at ${host}`);

    try {
      this.log('Requesting connection...');
      this.inverter = await (this.homey.app as any).getConnection(serialNumber, host);
      this.log('Connection established');
    } catch (err: any) {
      this.error(`Cannot connect to inverter at ${host}:`, err?.message ?? err);
      this.setUnavailable(`Cannot connect to inverter at ${host}`).catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);

    // Add capabilities that may not exist on devices paired before this version
    for (const cap of ['grid_voltage', 'grid_frequency', 'grid_import_energy_today', 'grid_export_energy_today']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    const inverter = this.inverter!;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.updateCapabilities(snapshot);
    };

    this.lostHandler = (err: any) => {
      this.error('Connection lost:', err?.message ?? err);
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

  private updateCapabilities(snapshot: InverterSnapshot) {
    this.setAvailable().catch(this.error);

    // Sign conventions are converted in lib/snapshot.ts.
    const values = gridMeterValues(snapshot);
    for (const [id, value] of Object.entries(values)) {
      this.setCapabilityValue(id, value).catch(this.error);
    }

    this.thresholds?.update({
      grid_voltage: values.grid_voltage ?? undefined,
      grid_frequency: values.grid_frequency ?? undefined,
    });
  }

  async onUninit() {
    if (this.inverter) {
      if (this.dataHandler) this.inverter.removeListener('data', this.dataHandler);
      if (this.lostHandler) this.inverter.removeListener('lost', this.lostHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
