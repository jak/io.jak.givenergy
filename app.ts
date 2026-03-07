'use strict';

import Homey from 'homey';

// Import type with resolution-mode to bridge ESM package from CJS context.
type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;

module.exports = class GivEnergyApp extends Homey.App {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();

  async onInit() {
    this.log('GivEnergy app initialized');

    // Condition cards
    this.homey.flow.getConditionCard('solar_generating')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.solarPower > 0 : false;
      });

    this.homey.flow.getConditionCard('battery_charging')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.batteryPower < 0 : false;
      });

    this.homey.flow.getConditionCard('battery_discharging')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.batteryPower > 0 : false;
      });

    this.homey.flow.getConditionCard('grid_importing')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.gridPower < 0 : false;
      });

    this.homey.flow.getConditionCard('grid_exporting')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.gridPower > 0 : false;
      });
  }

  async getConnection(serialNumber: string, host: string): Promise<GivEnergyInverter> {
    const existing = this.connections.get(serialNumber);
    if (existing) {
      existing.refCount++;
      return existing.inverter;
    }

    const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');
    const inverter = await Inverter.connect({ host });
    this.connections.set(serialNumber, { inverter, refCount: 1 });
    return inverter;
  }

  async releaseConnection(serialNumber: string): Promise<void> {
    const entry = this.connections.get(serialNumber);
    if (!entry) return;

    entry.refCount--;
    if (entry.refCount <= 0) {
      await entry.inverter.stop();
      this.connections.delete(serialNumber);
    }
  }

  getInverter(serialNumber: string): GivEnergyInverter | undefined {
    return this.connections.get(serialNumber)?.inverter;
  }
};
