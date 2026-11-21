'use strict';

import Homey from 'homey';
import { withRetry } from '../../lib/retry';
import { ThresholdTracker } from '../../lib/threshold';
import { solarInverterValues } from '../../lib/snapshot';
import { LEGACY_PAUSE_MODES, PAUSE_MODE_TO_LEGACY } from '../../lib/legacy';
import { featureMarkers, markerChanges } from '../../lib/features';
import { syncStore } from '../../lib/store';
import { scheduleInverter, setBuySlot, setSellSlot } from '../../lib/schedule';
import type {
  Inverter as GivEnergyInverter, InverterSnapshot, SinglePhaseInverter, TimeSlotInput,
} from '../../lib/types';

type SlotConfig = InverterSnapshot['schedules']['charge'][number];

/** Drop undefined values: v3 omits settings a model doesn't report. */
function defined(obj: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

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
      label_generation: this.inverter!.model,
      label_ip_address: host,
    }).catch(this.error);

    const inverter = this.inverter!;
    let modelCodeSet = false;

    this.dataHandler = (snapshot: InverterSnapshot) => {
      this.log(`Data received: solar=${snapshot.solar.power}W grid=${snapshot.grid.power}W`);
      this.updateCapabilities(snapshot);
      // Capabilities can drop at runtime (blocks the inverter never answered), e.g. after a reconnect
      this.syncFeatureMarkers().catch(this.error);
      if (!modelCodeSet) {
        modelCodeSet = true;
        this.setSettings({ label_model_code: String(snapshot.identity.deviceTypeCode) }).catch(this.error);
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

  private syncSettings(snapshot: InverterSnapshot) {
    const now = Date.now();
    if (now - this.lastSettingsSyncMs < 60_000) return;
    this.lastSettingsSyncMs = now;

    const slot = (list: SlotConfig[], n: number) => list.find((x) => x.slot === n);
    const cs = (n: number) => slot(snapshot.schedules.charge, n);
    const ds = (n: number) => slot(snapshot.schedules.discharge, n);
    const isGen3 = snapshot.capabilities.perSlotTargets;
    const { settings: inv } = snapshot;

    const settings: Record<string, any> = {
      eco_mode: snapshot.layout === 'single_phase' ? snapshot.settings.ecoMode : undefined,
      timed_export: inv.dcDischarge,
      charge_schedule_enabled: inv.acCharge,

      // Charge slot 1 — all generations
      charge_slot1_start: cs(1)?.start ?? '00:00',
      charge_slot1_end: cs(1)?.end ?? '00:00',

      // Charge slots 2-3 — Gen3 only, "Unsupported" on Gen2
      charge_slot2_start: isGen3 ? (cs(2)?.start ?? '00:00') : 'Unsupported',
      charge_slot2_end: isGen3 ? (cs(2)?.end ?? '00:00') : 'Unsupported',
      charge_slot3_start: isGen3 ? (cs(3)?.start ?? '00:00') : 'Unsupported',
      charge_slot3_end: isGen3 ? (cs(3)?.end ?? '00:00') : 'Unsupported',

      // Discharge slot 1 — all generations
      discharge_slot1_start: ds(1)?.start ?? '00:00',
      discharge_slot1_end: ds(1)?.end ?? '00:00',

      // Discharge slot 2 — Gen2 supports 2 discharge slots
      discharge_slot2_start: ds(2)?.start ?? '00:00',
      discharge_slot2_end: ds(2)?.end ?? '00:00',

      // Discharge slot 3 — Gen3 only
      discharge_slot3_start: isGen3 ? (ds(3)?.start ?? '00:00') : 'Unsupported',
      discharge_slot3_end: isGen3 ? (ds(3)?.end ?? '00:00') : 'Unsupported',

      charge_rate: inv.inverterChargePowerPercent,
      discharge_rate: inv.inverterDischargePowerPercent,
    };

    if (isGen3) {
      settings.charge_slot1_target_soc = cs(1)?.targetStateOfCharge ?? 100;
      settings.charge_slot2_target_soc = cs(2)?.targetStateOfCharge ?? 100;
      settings.charge_slot3_target_soc = cs(3)?.targetStateOfCharge ?? 100;
      settings.discharge_slot1_target_soc = ds(1)?.targetStateOfCharge ?? 0;
      settings.discharge_slot2_target_soc = ds(2)?.targetStateOfCharge ?? 0;
      settings.discharge_slot3_target_soc = ds(3)?.targetStateOfCharge ?? 0;
      const pauseMode = snapshot.layout === 'single_phase' ? snapshot.schedules.batteryPause?.mode : undefined;
      settings.battery_pause_mode = pauseMode ? PAUSE_MODE_TO_LEGACY[pauseMode] : undefined;
    } else {
      settings.charge_slot1_target_soc = inv.acChargeUpperLimit;
    }

    this.setSettings(defined(settings)).catch(this.error);
  }

  /** Write a charge target: per slot where supported, otherwise the global AC charge upper limit. */
  private async writeChargeSlot(slot: number, config: TimeSlotInput) {
    const inverter = this.inverter!;
    const { targetStateOfCharge, ...times } = config;
    if (inverter.capabilities.perSlotTargets) {
      await inverter.setChargeSlot(slot, config);
      return;
    }
    await inverter.setChargeSlot(slot, times);
    if (targetStateOfCharge !== undefined) {
      await inverter.setSetting('acChargeUpperLimit', targetStateOfCharge);
    }
  }

  private async writeDischargeSlot(slot: number, config: TimeSlotInput) {
    const inverter = this.inverter!;
    const { targetStateOfCharge, ...times } = config;
    await inverter.setDischargeSlot(slot, inverter.capabilities.perSlotTargets ? config : times);
  }

  private singlePhase(feature: string): SinglePhaseInverter {
    const inverter = this.inverter!;
    if (inverter.layout !== 'single_phase') throw new Error(`${feature} is not supported on three-phase inverters`);
    return inverter;
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
    if (!this.inverter) throw new Error('Not connected to inverter');

    // Validate synchronously before returning (catches gen2 unsupported slots etc.)
    this.validateSettings(newSettings, changedKeys);

    // Apply in background with retry — return immediately so Homey doesn't timeout
    // syncSettings will correct the UI from inverter state on the next poll cycle
    this.applySettingsInBackground(newSettings, changedKeys);
  }

  private validateSettings(newSettings: Record<string, any>, changedKeys: string[]) {
    const isGen3 = this.inverter!.capabilities.perSlotTargets;
    for (const key of changedKeys) {
      if (key.startsWith('charge_slot') && !key.includes('slot1') && !isGen3) {
        const slotNum = key.match(/slot(\d)/)?.[1];
        throw new Error(`Charge slot ${slotNum} is not supported on Gen2 inverters`);
      }
      if (key.startsWith('discharge_slot3') && !isGen3) {
        throw new Error('Discharge slot 3 is not supported on Gen2 inverters');
      }
      if (key === 'discharge_schedule_enabled' && !isGen3) {
        throw new Error('Discharge schedule is only supported on Gen3 inverters');
      }
      if (key === 'export_limit') {
        throw new Error('Setting the export limit is no longer supported');
      }
      if (key === 'battery_pause_mode' && !isGen3) {
        throw new Error('Battery pause mode is only supported on Gen3 inverters');
      }
    }
  }

  private applySettingsInBackground(newSettings: Record<string, any>, changedKeys: string[]) {
    withRetry(() => this.applySettings(newSettings, changedKeys), this.log.bind(this))
      .then(() => this.log('Settings applied to inverter successfully'))
      .catch((err: any) => {
        this.error('Failed to apply settings to inverter:', err?.message ?? err);
      });
  }

  private async applySettings(newSettings: Record<string, any>, changedKeys: string[]) {
    const inverter = this.inverter!;
    const handled = new Set<string>();

    const handleChargeSlot = async (slot: number) => {
      const prefix = `charge_slot${slot}`;
      [`${prefix}_start`, `${prefix}_end`, `${prefix}_target_soc`].forEach((k) => handled.add(k));

      const config: TimeSlotInput = {
        start: newSettings[`${prefix}_start`],
        end: newSettings[`${prefix}_end`],
        targetStateOfCharge: newSettings[`${prefix}_target_soc`],
      };
      // Without per-slot targets, the target goes to the global AC charge upper limit (HR 116)
      await this.writeChargeSlot(slot, config);
    };

    const handleDischargeSlot = async (slot: number) => {
      const prefix = `discharge_slot${slot}`;
      [`${prefix}_start`, `${prefix}_end`, `${prefix}_target_soc`].forEach((k) => handled.add(k));

      const config: TimeSlotInput = {
        start: newSettings[`${prefix}_start`],
        end: newSettings[`${prefix}_end`],
        targetStateOfCharge: newSettings[`${prefix}_target_soc`],
      };
      await this.writeDischargeSlot(slot, config);
    };

    for (const key of changedKeys) {
      if (handled.has(key)) continue;

      switch (key) {
        case 'eco_mode':
          await this.singlePhase('Eco mode').setSetting('ecoMode', newSettings.eco_mode);
          break;
        case 'timed_export':
          await inverter.setSetting('dcDischarge', newSettings.timed_export);
          break;
        case 'charge_schedule_enabled':
          await inverter.setSetting('acCharge', newSettings.charge_schedule_enabled);
          break;
        case 'discharge_schedule_enabled':
          await this.singlePhase('Discharge schedule').setBatteryPause({
            mode: newSettings.discharge_schedule_enabled ? 'discharge' : 'off',
          });
          break;
        case 'charge_rate':
          await inverter.setSetting('inverterChargePowerPercent', newSettings.charge_rate);
          break;
        case 'discharge_rate':
          await inverter.setSetting('inverterDischargePowerPercent', newSettings.discharge_rate);
          break;

        // Charge slots 1-3
        case 'charge_slot1_start':
        case 'charge_slot1_end':
        case 'charge_slot1_target_soc':
          await handleChargeSlot(1);
          break;
        case 'charge_slot2_start':
        case 'charge_slot2_end':
        case 'charge_slot2_target_soc':
          await handleChargeSlot(2);
          break;
        case 'charge_slot3_start':
        case 'charge_slot3_end':
        case 'charge_slot3_target_soc':
          await handleChargeSlot(3);
          break;

        // Discharge slots 1-3
        case 'discharge_slot1_start':
        case 'discharge_slot1_end':
        case 'discharge_slot1_target_soc':
          await handleDischargeSlot(1);
          break;
        case 'discharge_slot2_start':
        case 'discharge_slot2_end':
        case 'discharge_slot2_target_soc':
          await handleDischargeSlot(2);
          break;
        case 'discharge_slot3_start':
        case 'discharge_slot3_end':
        case 'discharge_slot3_target_soc':
          await handleDischargeSlot(3);
          break;

        case 'battery_pause_mode':
          await this.singlePhase('Battery pause mode').setBatteryPause({
            mode: LEGACY_PAUSE_MODES[newSettings.battery_pause_mode],
          });
          break;
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
