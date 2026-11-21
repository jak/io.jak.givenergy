'use strict';

import Homey from 'homey';
import { withRetry } from '../../lib/retry';
import { ThresholdTracker } from '../../lib/threshold';
import { solarInverterValues } from '../../lib/snapshot';
import { featureMarkers, markerChanges } from '../../lib/features';
import { syncStore } from '../../lib/store';
import { scheduleInverter, setBuySlot, setSellSlot } from '../../lib/schedule';
import { userMessage } from '../../lib/errors';
import { settingsFromSnapshot, settingWrites } from '../../lib/device-settings';
import type { Inverter as GivEnergyInverter, InverterSnapshot } from '../../lib/types';

type SlotConfig = InverterSnapshot['schedules']['charge'][number];

module.exports = class SolarInverterDevice extends Homey.Device {
  private inverter?: GivEnergyInverter;
  private dataHandler?: (snapshot: InverterSnapshot) => void;
  private lostHandler?: (err: any) => void;
  private debugHandler?: (msg: string) => void;
  private thresholds?: ThresholdTracker;
  private lastSettingsSyncMs = 0;
  private featureKey?: string;
  private chargeSnapshot?: {
    acCharge?: boolean; chargeSlot?: SlotConfig; chargePowerPercent?: number; acChargeUpperLimit?: number;
  };

  private dischargeSnapshot?: {
    dcDischarge?: boolean; dischargeSlot?: SlotConfig; dischargePowerPercent?: number; batteryReserve?: number;
  };

  async onInit() {
    this.thresholds = new ThresholdTracker((cardId, tokens, state) => {
      this.homey.flow.getDeviceTriggerCard(cardId)
        .trigger(this, tokens, state)
        .catch(this.error);
    });

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
    for (const cap of ['grid_voltage', 'grid_frequency', 'pv_energy_today', 'grid_import_energy_today', 'grid_export_energy_today', 'consumption_energy_today']) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap).catch(this.error);
      }
    }

    await syncStore(this, this.inverter!).catch(this.error);
    await this.syncFeatureMarkers();

    await this.setSettings({
      label_serial_number: serialNumber,
      label_ip_address: host,
    }).catch(this.error);

    const inverter = this.inverter!;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.log(`Data received: solar=${snapshot.solar.power}W grid=${snapshot.grid.power}W`);
      this.updateCapabilities(snapshot);
      // Capabilities can drop at runtime (blocks the inverter never answered), e.g. after a reconnect
      this.syncFeatureMarkers().catch(this.error);
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

  /** Add/remove the hidden capabilities that gate flow cards, when the inverter's features change. */
  private async syncFeatureMarkers() {
    const wanted = featureMarkers(this.inverter!);
    const key = JSON.stringify(wanted);
    if (key === this.featureKey) return;
    this.featureKey = key;
    const { add, remove } = markerChanges(wanted, this.getCapabilities());
    for (const cap of add) await this.addCapability(cap).catch(this.error);
    for (const cap of remove) await this.removeCapability(cap).catch(this.error);
    if (add.length || remove.length) this.log(`Feature markers: +[${add.join(', ')}] -[${remove.join(', ')}]`);
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

    const values = solarInverterValues(snapshot);
    for (const [id, value] of Object.entries(values)) {
      this.setCapabilityValue(id, value).catch(this.error);
    }

    this.thresholds?.update({
      grid_voltage: values.grid_voltage ?? undefined,
      grid_frequency: values.grid_frequency ?? undefined,
      load_power: values.load_power ?? undefined,
      grid_power: values.grid_power ?? undefined,
    });

    this.syncSettings(snapshot);
  }

  /** Refresh device settings from the inverter at most once a minute. */
  private syncSettings(snapshot: InverterSnapshot) {
    const now = Date.now();
    if (now - this.lastSettingsSyncMs < 60_000) return;
    this.lastSettingsSyncMs = now;
    this.setSettings(settingsFromSnapshot(snapshot)).catch(this.error);
  }

  async forceCharge(targetSoc: number, chargeRate: number) {
    if (!this.inverter) throw new Error('Not connected to inverter');
    const { settings, schedules } = this.inverter.getData();

    // Keep the first snapshot: a retry, or a second force charge, must not record the forced state
    this.chargeSnapshot ??= {
      acCharge: settings.acCharge,
      chargeSlot: schedules.charge.find((x) => x.slot === 1),
      chargePowerPercent: settings.inverterChargePowerPercent,
      acChargeUpperLimit: settings.acChargeUpperLimit,
    };

    this.log(`Force charge: target=${targetSoc}% rate=${chargeRate}%`);
    await setBuySlot(scheduleInverter(this.inverter), 1, { start: '00:00', end: '23:59', target: targetSoc });
    await this.inverter.setSetting('inverterChargePowerPercent', chargeRate);
  }

  async stopForceCharge() {
    if (!this.inverter) throw new Error('Not connected to inverter');
    if (!this.chargeSnapshot) throw new Error('No force charge in progress');

    const {
      acCharge, chargeSlot, chargePowerPercent, acChargeUpperLimit,
    } = this.chargeSnapshot;
    this.log('Restoring charge settings');
    if (acCharge !== undefined) await this.inverter.setSetting('acCharge', acCharge);
    if (chargeSlot) await this.inverter.setChargeSlot(chargeSlot);
    if (!this.inverter.capabilities.perSlotTargets && acChargeUpperLimit !== undefined) {
      await this.inverter.setSetting('acChargeUpperLimit', acChargeUpperLimit);
    }
    if (chargePowerPercent !== undefined) await this.inverter.setSetting('inverterChargePowerPercent', chargePowerPercent);
    this.chargeSnapshot = undefined;
  }

  async forceDischarge(dischargeRate: number, batteryReserve: number) {
    if (!this.inverter) throw new Error('Not connected to inverter');
    const { settings, schedules } = this.inverter.getData();

    // Keep the first snapshot: a retry, or a second force discharge, must not record the forced state
    this.dischargeSnapshot ??= {
      dcDischarge: settings.dcDischarge,
      dischargeSlot: schedules.discharge.find((x) => x.slot === 1),
      dischargePowerPercent: settings.inverterDischargePowerPercent,
      batteryReserve: settings.batteryReserve,
    };

    this.log(`Force discharge: rate=${dischargeRate}% reserve=${batteryReserve}%`);
    await setSellSlot(scheduleInverter(this.inverter), 1, { start: '00:00', end: '23:59' });
    await this.inverter.setSetting('inverterDischargePowerPercent', dischargeRate);
    await this.inverter.setSetting('batteryReserve', batteryReserve);
  }

  async stopForceDischarge() {
    if (!this.inverter) throw new Error('Not connected to inverter');
    if (!this.dischargeSnapshot) throw new Error('No force discharge in progress');

    const {
      dcDischarge, dischargeSlot, dischargePowerPercent, batteryReserve,
    } = this.dischargeSnapshot;
    this.log('Restoring discharge settings');
    if (dcDischarge !== undefined) await this.inverter.setSetting('dcDischarge', dcDischarge);
    if (dischargeSlot) await this.inverter.setDischargeSlot(dischargeSlot);
    if (dischargePowerPercent !== undefined) {
      await this.inverter.setSetting('inverterDischargePowerPercent', dischargePowerPercent);
    }
    if (batteryReserve !== undefined) await this.inverter.setSetting('batteryReserve', batteryReserve);
    this.dischargeSnapshot = undefined;
  }

  async onSettings({ newSettings, changedKeys }: { newSettings: Record<string, any>; changedKeys: string[] }) {
    const { inverter } = this;
    if (!inverter) throw new Error('Not connected to inverter');

    // Validate synchronously, so Homey shows the error and keeps the old values
    const writes = settingWrites(changedKeys, newSettings, (key) => inverter.supports(key));
    if (writes.length === 0) return;

    // Apply in the background with retry, returning straight away so Homey doesn't time out.
    // syncSettings corrects the page from the inverter if a write fails.
    withRetry(async () => {
      // setSetting is typed per layout; supports() above already checked each key on this inverter
      for (const [key, value] of writes) await inverter.setSetting(key as never, value as never);
    }, this.log.bind(this))
      .then(() => this.log(`Settings applied: ${writes.map(([k, v]) => `${k}=${v}`).join(', ')}`))
      .catch((err: any) => {
        this.error('Failed to apply settings to inverter:', userMessage(err));
        this.lastSettingsSyncMs = 0;
      });
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
