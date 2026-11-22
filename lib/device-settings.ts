'use strict';

/**
 * Solar inverter device settings: read-only inverter details plus the few settings that are not
 * part of a schedule. Buy/Sell/Pause slots live on the app's Schedules page instead.
 */

import { scheduleSupport } from './schedule.ts';

type InverterSnapshot = import('givenergy-modbus', { with: { 'resolution-mode': 'import' } }).InverterSnapshot;
type InverterModel = InverterSnapshot['model'];

const MODEL_NAMES: Record<InverterModel, string> = {
  hybrid_gen1: 'Hybrid Gen1',
  hybrid_gen2: 'Hybrid Gen2',
  hybrid_gen3: 'Hybrid Gen3',
  hybrid_gen3_plus: 'Hybrid Gen3+',
  hybrid_gen4: 'Hybrid Gen4',
  hybrid_hv_gen3: 'Hybrid HV Gen3',
  polar: 'Polar',
  pv: 'PV',
  ac: 'AC Coupled',
  all_in_one: 'All in One',
  all_in_one_hybrid: 'All in One Hybrid',
  hybrid_3ph: 'Hybrid 3-phase',
  ac_3ph: 'AC Coupled 3-phase',
  all_in_one_commercial: 'Commercial All in One',
};

export function modelName(model: string): string {
  return MODEL_NAMES[model as InverterModel] ?? model;
}

/** Editable device settings and the library setting each one writes. */
const EDITABLE = {
  eco_mode: { key: 'ecoMode', label: 'Eco mode' },
  battery_reserve: { key: 'batteryReserve', label: 'Battery reserve' },
  charge_power: { key: 'inverterChargePowerPercent', label: 'Charge power' },
  discharge_power: { key: 'inverterDischargePowerPercent', label: 'Discharge power' },
} as const;

export type SettingKey = typeof EDITABLE[keyof typeof EDITABLE]['key'];

function supportText(s: InverterSnapshot): string {
  const support = scheduleSupport(s.capabilities, s.layout);
  const parts = [`${support.buySlots} Buy`, `${support.sellSlots} Sell`];
  if (support.pause === 'window') parts.push('pause window');
  if (support.pause === 'mode') parts.push('pause mode');
  return parts.join(' · ');
}

/** Device settings values from a snapshot; settings the model doesn't report are left out. */
export function settingsFromSnapshot(s: InverterSnapshot): Record<string, string | number | boolean> {
  const { firmware } = s.identity;
  const settings = s.settings as Partial<Record<SettingKey, number | boolean>>;
  const out: Record<string, string | number | boolean> = {
    label_model: modelName(s.model),
    label_firmware: `ARM ${firmware.arm} / DSP ${firmware.dsp}`,
    label_schedule_support: supportText(s),
  };
  for (const [id, { key }] of Object.entries(EDITABLE)) {
    const value = settings[key];
    if (value !== undefined) out[id] = value;
  }
  return out;
}

/**
 * The library writes for changed device settings, in a fixed order. Throws before any write if
 * one of them isn't supported, so a rejected save changes nothing.
 */
export function settingWrites(
  changedKeys: readonly string[],
  newSettings: Record<string, unknown>,
  supports: (key: SettingKey) => boolean,
): [SettingKey, number | boolean][] {
  const writes: [SettingKey, number | boolean][] = [];
  for (const [id, { key, label }] of Object.entries(EDITABLE)) {
    if (!changedKeys.includes(id)) continue;
    if (!supports(key)) throw new Error(`${label} is not supported on this inverter`);
    writes.push([key, newSettings[id] as number | boolean]);
  }
  return writes;
}
