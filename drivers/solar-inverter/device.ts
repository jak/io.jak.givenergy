'use strict';

import Homey from 'homey';

type GivEnergyInverter = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).GivEnergyInverter;
type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;
type TimeSlotInput = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).TimeSlotInput;

module.exports = class SolarInverterDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: any) => void;
  private debugHandler?: (msg: string) => void;
  private lastGridVoltage?: number;
  private lastGridFrequency?: number;

  async onInit() {
    const { host } = this.getStore();
    const { id: serialNumber } = this.getData();
    this.log(`Initializing solar inverter device ${serialNumber} at ${host}`);

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
    for (const cap of ['grid_voltage', 'grid_frequency']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    await this.setSettings({
      label_serial_number: serialNumber,
      label_generation: this.getStore().generation ?? '-',
      label_ip_address: host,
    }).catch(this.error);

    const inverter = this.inverter!;
    let modelCodeSet = false;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.log(`Data received: solar=${snapshot.solarPower}W grid=${snapshot.gridPower}W`);
      this.updateCapabilities(snapshot);
      if (!modelCodeSet) {
        modelCodeSet = true;
        this.setSettings({ label_model_code: String(snapshot.modelCode) }).catch(this.error);
      }
    };

    this.debugHandler = (msg: string) => this.log(`[modbus] ${msg}`);
    this.lostHandler = (err: any) => {
      this.error('Connection lost:', err?.message ?? err);
      this.setUnavailable('Connection to inverter lost').catch(this.error);
    };

    inverter.on('data', this.dataHandler);
    inverter.on('debug', this.debugHandler);
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

    this.setCapabilityValue('measure_power', snapshot.solarPower).catch(this.error);
    this.setCapabilityValue('meter_power', snapshot.pvEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('grid_power', snapshot.gridPower).catch(this.error);
    this.setCapabilityValue('load_power', snapshot.loadPower).catch(this.error);
    this.setCapabilityValue('grid_import_energy', snapshot.gridImportEnergyTotalKwh).catch(this.error);
    this.setCapabilityValue('grid_export_energy', snapshot.gridExportEnergyTotalKwh).catch(this.error);
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

  async onSettings({ newSettings, changedKeys }: { newSettings: Record<string, any>; changedKeys: string[] }) {
    if (!this.inverter) throw new Error('Not connected to inverter');

    const chargeSlotKeys = ['charge_slot1_start', 'charge_slot1_end', 'charge_slot1_target_soc'];
    const dischargeSlotKeys = ['discharge_slot1_start', 'discharge_slot1_end', 'discharge_slot1_target_soc'];
    const handled = new Set<string>();

    for (const key of changedKeys) {
      if (handled.has(key)) continue;

      switch (key) {
        case 'eco_mode':
          await this.inverter.setEcoMode(newSettings.eco_mode);
          break;
        case 'timed_export':
          await this.inverter.setTimedExport(newSettings.timed_export);
          break;
        case 'charge_schedule_enabled':
          await this.inverter.setTimedCharge(newSettings.charge_schedule_enabled);
          break;
        case 'discharge_schedule_enabled': {
          const { Gen3Inverter } = await import('givenergy-modbus');
          if (!(this.inverter instanceof Gen3Inverter)) throw new Error('Discharge schedule is only supported on Gen3 inverters');
          await this.inverter.setTimedDischarge(newSettings.discharge_schedule_enabled);
          break;
        }
        case 'charge_rate':
          await this.inverter.setChargeRate(newSettings.charge_rate);
          break;
        case 'discharge_rate':
          await this.inverter.setDischargeRate(newSettings.discharge_rate);
          break;
        case 'charge_slot1_start':
        case 'charge_slot1_end':
        case 'charge_slot1_target_soc': {
          chargeSlotKeys.forEach((k) => handled.add(k));
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
          dischargeSlotKeys.forEach((k) => handled.add(k));
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
    if (this.inverter) {
      if (this.dataHandler) this.inverter.removeListener('data', this.dataHandler);
      if (this.debugHandler) this.inverter.removeListener('debug', this.debugHandler);
      if (this.lostHandler) this.inverter.removeListener('lost', this.lostHandler);
    }
    const { id: serialNumber } = this.getData();
    await (this.homey.app as any).releaseConnection(serialNumber);
  }
};
