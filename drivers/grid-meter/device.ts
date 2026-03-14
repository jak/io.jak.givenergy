'use strict';

import Homey from 'homey';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;

module.exports = class GridMeterDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: any) => void;
  private lastGridVoltage?: number;
  private lastGridFrequency?: number;

  async onInit() {
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

    // Library: positive = exporting, negative = importing
    // Homey cumulative sensor: positive = consuming (importing)
    this.setCapabilityValue('measure_power', -snapshot.gridPower).catch(this.error);
    this.setCapabilityValue('meter_power.imported', snapshot.gridImportEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('meter_power.exported', snapshot.gridExportEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('grid_voltage', snapshot.gridVoltage).catch(this.error);
    this.setCapabilityValue('grid_frequency', snapshot.gridFrequency).catch(this.error);

    this.fireGridQualityTriggers(snapshot.gridVoltage, snapshot.gridFrequency);
    this.lastGridVoltage = snapshot.gridVoltage;
    this.lastGridFrequency = snapshot.gridFrequency;
  }

  private fireGridQualityTriggers(voltage: number, frequency: number) {
    const prev = { voltage: this.lastGridVoltage, frequency: this.lastGridFrequency };

    if (prev.voltage !== undefined && prev.voltage >= voltage) {
      (this.homey.flow.getDeviceTriggerCard('grid_voltage_dropped_below') as any)
        .trigger(this, {}, { voltage })
        .catch(this.error);
    }
    if (prev.voltage !== undefined && prev.voltage <= voltage) {
      (this.homey.flow.getDeviceTriggerCard('grid_voltage_rose_above') as any)
        .trigger(this, {}, { voltage })
        .catch(this.error);
    }
    if (prev.frequency !== undefined && prev.frequency >= frequency) {
      (this.homey.flow.getDeviceTriggerCard('grid_frequency_dropped_below') as any)
        .trigger(this, {}, { frequency })
        .catch(this.error);
    }
    if (prev.frequency !== undefined && prev.frequency <= frequency) {
      (this.homey.flow.getDeviceTriggerCard('grid_frequency_rose_above') as any)
        .trigger(this, {}, { frequency })
        .catch(this.error);
    }
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
