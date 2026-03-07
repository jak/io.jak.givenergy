'use strict';

import Homey from 'homey';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;

module.exports = class BatteryDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();

    try {
      this.inverter = await (this.homey.app as any).getConnection(serialNumber, host);
    } catch (err) {
      this.setUnavailable(`Cannot connect to inverter at ${host}`).catch(this.error);
      return;
    }

    this.setAvailable().catch(this.error);

    const inverter = this.inverter!;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.updateCapabilities(snapshot);
    };

    inverter.on('data', this.dataHandler);

    inverter.on('lost', () => {
      this.setUnavailable('Connection to inverter lost').catch(this.error);
    });

    try {
      const snapshot = inverter.getData();
      this.updateCapabilities(snapshot);
    } catch {
      // No data yet
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

    this.setCapabilityValue('measure_power', snapshot.batteryPower).catch(this.error);
    this.setCapabilityValue('measure_battery', snapshot.stateOfCharge).catch(this.error);
    this.setCapabilityValue('meter_power.charged', snapshot.batteryChargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('meter_power.discharged', snapshot.batteryDischargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('measure_temperature', snapshot.batteryTemperature).catch(this.error);
  }

  async onUninit() {
    if (this.inverter && this.dataHandler) {
      this.inverter.removeListener('data', this.dataHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
