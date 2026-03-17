'use strict';

import Homey from 'homey';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;

module.exports = class BatteryDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: any) => void;
  private lastBatteryPower?: number;
  private lastSoc?: number;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();
    this.log(`Initializing battery device ${serialNumber} at ${host}`);

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
    for (const cap of ['battery_charge_energy_today', 'battery_discharge_energy_today']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    const inverter = this.inverter!;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.log(`Data received: battery=${snapshot.batteryPower}W soc=${snapshot.stateOfCharge}%`);
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

  getInverterSnapshot(): InverterSnapshot | null {
    try {
      return this.inverter?.getData() ?? null;
    } catch {
      return null;
    }
  }

  private updateCapabilities(snapshot: InverterSnapshot) {
    this.setAvailable().catch(this.error);

    this.setCapabilityValue('measure_power', -snapshot.batteryPower).catch(this.error);
    this.setCapabilityValue('measure_battery', snapshot.stateOfCharge).catch(this.error);
    this.setCapabilityValue('meter_power.charged', snapshot.batteryChargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('meter_power.discharged', snapshot.batteryDischargeEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('measure_temperature', snapshot.batteryTemperature).catch(this.error);
    this.setCapabilityValue('battery_charge_energy_today', snapshot.batteryChargeEnergyTodayKwh).catch(this.error);
    this.setCapabilityValue('battery_discharge_energy_today', snapshot.batteryDischargeEnergyTodayKwh).catch(this.error);

    this.fireEnergyTriggers(snapshot);
    this.lastBatteryPower = snapshot.batteryPower;
    this.lastSoc = snapshot.stateOfCharge;
  }

  private fireEnergyTriggers(snapshot: InverterSnapshot) {
    const prevPower = this.lastBatteryPower;
    const prevSoc = this.lastSoc;

    // SOC changed
    if (prevSoc !== undefined && prevSoc !== snapshot.stateOfCharge) {
      (this.homey.flow.getDeviceTriggerCard('battery_soc_changed') as any)
        .trigger(this, { soc: snapshot.stateOfCharge })
        .catch(this.error);
    }
    // Battery: power decreased (toward charging, batteryPower < 0 = charging)
    if (prevPower !== undefined && prevPower >= snapshot.batteryPower && snapshot.batteryPower < 0) {
      (this.homey.flow.getDeviceTriggerCard('battery_started_charging') as any)
        .trigger(this, {}, { power: Math.abs(snapshot.batteryPower) })
        .catch(this.error);
    }
    // Battery: power increased (toward discharging, batteryPower > 0 = discharging)
    if (prevPower !== undefined && prevPower <= snapshot.batteryPower && snapshot.batteryPower > 0) {
      (this.homey.flow.getDeviceTriggerCard('battery_started_discharging') as any)
        .trigger(this, {}, { power: snapshot.batteryPower })
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
