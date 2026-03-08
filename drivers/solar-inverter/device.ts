'use strict';

import Homey from 'homey';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;
type InverterMode = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterMode;
type TimeSlotInput = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).TimeSlotInput;

module.exports = class SolarInverterDevice extends Homey.Device {
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
      // No data yet, will update on first 'data' event
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

    this.setCapabilityValue('measure_power', -snapshot.solarPower).catch(this.error);
    this.setCapabilityValue('meter_power', snapshot.pvEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('grid_power', snapshot.gridPower).catch(this.error);
    this.setCapabilityValue('load_power', snapshot.loadPower).catch(this.error);
    this.setCapabilityValue('grid_import_energy', snapshot.gridImportEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('grid_export_energy', snapshot.gridExportEnergyTotalKwh).catch(this.error);
  }

  async onSettings({ newSettings, changedKeys }: { newSettings: Record<string, any>; changedKeys: string[] }) {
    if (!this.inverter) throw new Error('Not connected to inverter');

    for (const key of changedKeys) {
      switch (key) {
        case 'inverter_mode':
          await this.inverter.setMode(newSettings.inverter_mode as InverterMode);
          break;
        case 'charge_schedule_enabled':
          await this.inverter.setChargeScheduleEnabled(newSettings.charge_schedule_enabled);
          break;
        case 'discharge_schedule_enabled':
          await this.inverter.setDischargeScheduleEnabled(newSettings.discharge_schedule_enabled);
          break;
        case 'charge_rate':
          await this.inverter.setChargeRate(newSettings.charge_rate);
          break;
        case 'discharge_rate':
          await this.inverter.setDischargeRate(newSettings.discharge_rate);
          break;
        case 'charge_slot1_start':
        case 'charge_slot1_end':
        case 'charge_slot1_target_soc': {
          const config: TimeSlotInput = {
            start: newSettings.charge_slot1_start,
            end: newSettings.charge_slot1_end,
            targetStateOfCharge: newSettings.charge_slot1_target_soc,
          };
          await this.inverter.setChargeSlot(0, config);
          break;
        }
        case 'discharge_slot1_start':
        case 'discharge_slot1_end':
        case 'discharge_slot1_target_soc': {
          const config: TimeSlotInput = {
            start: newSettings.discharge_slot1_start,
            end: newSettings.discharge_slot1_end,
            targetStateOfCharge: newSettings.discharge_slot1_target_soc,
          };
          await this.inverter.setDischargeSlot(0, config);
          break;
        }
        case 'export_limit': {
          const { Gen3Inverter } = await import('givenergy-modbus');
          if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Export limit is only supported on Gen3 inverters');
          await this.inverter.setExportLimit(newSettings.export_limit);
          break;
        }
        case 'battery_pause_mode': {
          const { Gen3Inverter } = await import('givenergy-modbus');
          if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Battery pause mode is only supported on Gen3 inverters');
          await this.inverter.setBatteryPauseMode(newSettings.battery_pause_mode);
          break;
        }
      }
    }
  }

  async onUninit() {
    if (this.inverter && this.dataHandler) {
      this.inverter.removeListener('data', this.dataHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
