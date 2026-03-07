'use strict';

import Homey from 'homey';

// Import type with resolution-mode to bridge ESM package from CJS context.
type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;

module.exports = class GivEnergyApp extends Homey.App {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();

  async onInit() {
    this.log('GivEnergy app initialized');
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
