'use strict';

import Homey from 'homey';

// Import type with resolution-mode to bridge ESM package from CJS context.
type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;

module.exports = class GivEnergyApp extends Homey.App {
  private connections = new Map<string, { inverter: GivEnergyInverter; refCount: number }>();
  private pending = new Map<string, Promise<GivEnergyInverter>>();

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

    this.homey.flow.getConditionCard('eco_mode_enabled')
      .registerRunListener(async (args: any) => {
        const snapshot = args.device.getInverterSnapshot();
        return snapshot ? snapshot.ecoMode : false;
      });

    // Action cards
    this.homey.flow.getActionCard('toggle_eco_mode')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setEcoMode(args.action === 'enable');
      });

    this.homey.flow.getActionCard('toggle_timed_export')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setTimedExport(args.action === 'enable');
      });

    this.homey.flow.getActionCard('enable_charge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        await inverter.setTimedCharge(args.action === 'enable');
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
    this.homey.flow.getActionCard('enable_discharge_schedule')
      .registerRunListener(async (args: any) => {
        const inverter = this.getInverter(args.device.getData().id);
        if (!inverter) throw new Error('Inverter not connected');
        const { Gen3Inverter } = await import('givenergy-modbus');
        if (!(inverter instanceof Gen3Inverter)) throw new Error('Discharge schedule is only supported on Gen3 inverters');
        await inverter.setTimedDischarge(args.action === 'enable');
      });

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

    // Force charge/discharge action cards
    this.homey.flow.getActionCard('force_charge')
      .registerRunListener(async (args: any) => {
        await args.device.forceCharge(args.target_soc, args.charge_rate);
      });

    this.homey.flow.getActionCard('stop_force_charge')
      .registerRunListener(async (args: any) => {
        await args.device.stopForceCharge();
      });

    this.homey.flow.getActionCard('force_discharge')
      .registerRunListener(async (args: any) => {
        await args.device.forceDischarge(args.discharge_rate, args.battery_reserve);
      });

    this.homey.flow.getActionCard('stop_force_discharge')
      .registerRunListener(async (args: any) => {
        await args.device.stopForceDischarge();
      });
  }

  async getConnection(serialNumber: string, host: string): Promise<GivEnergyInverter> {
    const existing = this.connections.get(serialNumber);
    if (existing) {
      existing.refCount++;
      return existing.inverter;
    }

    // Deduplicate concurrent connect calls for the same serial
    const inflight = this.pending.get(serialNumber);
    if (inflight) {
      const inverter = await inflight;
      const entry = this.connections.get(serialNumber);
      if (entry) entry.refCount++;
      return inverter;
    }

    const connectPromise = (async () => {
      const { GivEnergyInverter: Inverter } = await import('givenergy-modbus');
      return Inverter.connect({ host });
    })();

    this.pending.set(serialNumber, connectPromise);
    try {
      const inverter = await connectPromise;
      inverter.on('lost', () => this.handleConnectionLost(serialNumber, host));
      this.connections.set(serialNumber, { inverter, refCount: 1 });
      return inverter;
    } finally {
      this.pending.delete(serialNumber);
    }
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

  private handleConnectionLost(serialNumber: string, host: string) {
    this.error(`[connection-lost] inverter=${serialNumber} host=${host} timestamp=${new Date().toISOString()}`);
    const entry = this.connections.get(serialNumber);
    if (entry) {
      this.connections.delete(serialNumber);
    }
  }

  getInverter(serialNumber: string): GivEnergyInverter | undefined {
    return this.connections.get(serialNumber)?.inverter;
  }
};
