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

    // Action cards
    this.homey.flow.getActionCard('set_inverter_mode')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setMode(args.mode);
      });

    this.homey.flow.getActionCard('enable_charge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setChargeScheduleEnabled(args.action === 'enable');
      });

    this.homey.flow.getActionCard('enable_discharge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setDischargeScheduleEnabled(args.action === 'enable');
      });

    this.homey.flow.getActionCard('set_charge_rate')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setChargeRate(args.watts);
      });

    this.homey.flow.getActionCard('set_discharge_rate')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setDischargeRate(args.watts);
      });

    // Gen3-specific action cards
    this.homey.flow.getActionCard('set_export_limit')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(inverter instanceof Gen3Inverter)) throw new Error('Export limit is only supported on Gen3 inverters');
        await inverter.setExportLimit(args.watts);
      });

    this.homey.flow.getActionCard('set_battery_pause_mode')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(inverter instanceof Gen3Inverter)) throw new Error('Battery pause mode is only supported on Gen3 inverters');
        await inverter.setBatteryPauseMode(args.mode);
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
